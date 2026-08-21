/*
 * Hub Trace · сканер страницы (ISOLATED world, document_start).
 *
 * Два пути получения истории:
 *   1) api  — повтор пойманного пробником запроса. Один round-trip, без
 *             рендера страницы. Именно он даёт основной прирост скорости.
 *   2) dom  — обход таблицы. Работает всегда, используется как страховка
 *             и как эталон при калибровке быстрого пути.
 *
 * Ключевые отличия DOM-обхода от прошлой версии:
 *   · textContent вместо innerText — innerText синхронно считает лейаут,
 *     на тысячах строк это были секунды чистого reflow;
 *   · инкрементальный сбор строк вместо полного пересчёта на каждом проходе
 *     (было O(n²) по тексту таблицы);
 *   · прыжок сразу в конец списка вместо шагов по 0.8 экрана;
 *   · ожидание по MutationObserver вместо фиксированных sleep(90).
 */
(() => {
  if (globalThis.__hubTraceScannerReady) return;
  globalThis.__hubTraceScannerReady = true;

  const CHANNEL = "hub-trace";
  const ORIGIN = location.origin;
  const OVERLAP = 8;
  const FULL_PASS_LIMIT = 400;
  const DEFAULT_PAGE_SIZE = 500;
  const MAX_API_PAGES = 40;

  let recipe = null;
  let recipeScore = -1;
  let cardRecipe = null;
  let cardScore = -1;
  let abortFlag = false;
  let currentPhase = "idle";

  /* ------------------------------------------------------------------ */
  /* мелочи                                                              */
  /* ------------------------------------------------------------------ */

  function norm(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  /* textContent, а не innerText: innerText форсирует reflow. */
  function textOf(el) {
    return norm(el ? el.textContent : "");
  }

  function itemIdFromHref(href) {
    const match = String(href || "").match(/\/stock\/item\/(?:Lozon:)?([^/?#]+)/i);
    if (!match) return "";
    try {
      return decodeURIComponent(match[1]);
    } catch (_err) {
      return match[1];
    }
  }

  function toBackground(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (reply) => {
          void chrome.runtime.lastError;
          resolve(reply || null);
        });
      } catch (_err) {
        resolve(null);
      }
    });
  }

  function reportPhase(phase, detail) {
    if (phase === currentPhase) return;
    currentPhase = phase;
    void toBackground({ action: "ht:phase", phase, detail: detail || "", posting: itemIdFromHref(location.href) });
  }

  /* ------------------------------------------------------------------ */
  /* канал с пробником (MAIN world)                                      */
  /* ------------------------------------------------------------------ */

  const replayWaiters = new Map();
  let ticketSeq = 0;

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    if (event.origin && event.origin !== ORIGIN) return;
    const data = event.data;
    if (!data || data.channel !== CHANNEL) return;

    if (data.type === "recipe" && data.recipe) {
      adoptRecipe(data.recipe, true);
      return;
    }
    if (data.type === "cardRecipe" && data.recipe) {
      adoptCardRecipe(data.recipe, true);
      return;
    }
    if (data.type === "replayResult") {
      const waiter = replayWaiters.get(data.ticket);
      if (!waiter) return;
      replayWaiters.delete(data.ticket);
      waiter(data);
    }
  });

  /*
   * Раньше здесь стояло score <= recipeScore -> выходим. Повторный захват
   * того же эндпоинта даёт ровно такой же score, поэтому свежий рецепт
   * всегда отвергался, а вместе с ним отвергался и свежий токен. Через
   * какое-то время сервер начинал отвечать 401, и починить это мог только
   * перезапуск расширения — там рецепта ещё нет и первый захват проходит.
   *
   * Теперь при равном качестве побеждает более свежий рецепт.
   */
  function adoptRecipe(next, share) {
    if (!next || !next.url || !next.itemId) return;
    const score = Number(next.score) || 0;
    const captured = Number(next.capturedAt) || 0;
    const currentCaptured = Number(recipe?.capturedAt) || 0;

    const better = score > recipeScore;
    const fresher = score >= recipeScore && captured > currentCaptured;
    if (!better && !fresher) return;

    recipe = next;
    recipeScore = score;
    if (share) void toBackground({ action: "ht:recipe", recipe: next });
  }

  function adoptCardRecipe(next, share) {
    if (!next || !next.url || !next.itemId) return;
    const score = Number(next.score) || 0;
    const captured = Number(next.capturedAt) || 0;
    const currentCaptured = Number(cardRecipe?.capturedAt) || 0;
    if (!(score > cardScore || (score >= cardScore && captured > currentCaptured))) return;
    cardRecipe = next;
    cardScore = score;
    if (share) void toBackground({ action: "ht:cardRecipe", recipe: next });
  }

  /* ------------------------------------------------------------------ */
  /* данные для отчёта                                                   */
  /* ------------------------------------------------------------------ */

  const POSTING_NUMBER_RE = /\d{6,}-\d{2,}-\d{1,3}/;
  const ROW_DATE_RE = /\d{2}\.\d{2}\.\d{4}[,\s]+\d{2}:\d{2}(?::\d{2})?/;
  /* Метки, которыми Hub подписывает значения внутри одной ячейки таблицы. */
  const ROW_LABELS = ["Лог. контейнер", "Ячейка", "Местоположение", "Свойство", "Значение"];

  function splitLabelled(text) {
    const found = [];
    for (const label of ROW_LABELS) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(label, from);
        if (at < 0) break;
        found.push({ label, at });
        from = at + label.length;
      }
    }
    found.sort((a, b) => a.at - b.at);

    const out = {};
    for (let i = 0; i < found.length; i += 1) {
      const start = found[i].at + found[i].label.length;
      const end = i + 1 < found.length ? found[i + 1].at : text.length;
      const value = norm(text.slice(start, end)).replace(/^[.:\s]+/, "");
      if (value && !out[found[i].label]) out[found[i].label] = value;
    }
    return out;
  }

  function findDate(values) {
    for (const value of values) {
      const match = String(value || "").match(ROW_DATE_RE);
      if (match) return match[0];
    }
    return "";
  }

  function findCell(values) {
    for (const value of values) {
      const fields = splitLabelled(String(value || ""));
      if (fields["Ячейка"]) return fields["Ячейка"];
    }
    return "";
  }

  function askProbeForRecipe() {
    try {
      window.postMessage({ channel: CHANNEL, type: "askRecipe" }, ORIGIN);
    } catch (_err) {
      /* ignore */
    }
  }

  function replay(request, timeoutMs) {
    const ticket = `t${++ticketSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        replayWaiters.delete(ticket);
        resolve({ ok: false, status: 0, error: "replay_timeout" });
      }, Math.max(1500, timeoutMs + 1500));

      replayWaiters.set(ticket, (result) => {
        clearTimeout(timer);
        resolve(result);
      });

      try {
        window.postMessage({ channel: CHANNEL, type: "replay", ticket, timeoutMs, ...request }, ORIGIN);
      } catch (_err) {
        clearTimeout(timer);
        replayWaiters.delete(ticket);
        resolve({ ok: false, status: 0, error: "postmessage_failed" });
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* быстрый путь: повтор запроса истории                                */
  /* ------------------------------------------------------------------ */

  function swapId(text, fromId, toId) {
    if (!text || !fromId || fromId === toId) return text;
    let out = String(text);
    const encFrom = encodeURIComponent(fromId);
    const encTo = encodeURIComponent(toId);
    if (encFrom !== fromId) out = out.split(encFrom).join(encTo);
    out = out.split(fromId).join(toId);
    return out;
  }

  const SIZE_KEYS = /^(limit|page_?size|per_?page|size|take|count|rows|row_?count)$/i;
  const PAGE_KEYS = /^(page|page_?number|page_?index|pageno|p)$/i;
  const OFFSET_KEYS = /^(offset|skip|from|start|start_?index)$/i;

  function tuneQuery(urlString, pageIndex, pageSize) {
    let url;
    try {
      url = new URL(urlString);
    } catch (_err) {
      return { url: urlString, touched: false };
    }
    let touched = false;
    for (const [key, value] of [...url.searchParams.entries()]) {
      if (SIZE_KEYS.test(key) && pageSize != null) {
        url.searchParams.set(key, String(pageSize));
        touched = true;
      } else if (PAGE_KEYS.test(key)) {
        const base = Number(value) === 0 ? 0 : 1;
        url.searchParams.set(key, String(pageIndex + base));
        touched = true;
      } else if (OFFSET_KEYS.test(key) && pageSize != null) {
        url.searchParams.set(key, String(pageIndex * pageSize));
        touched = true;
      }
    }
    return { url: url.toString(), touched };
  }

  function tuneJson(node, pageIndex, pageSize, depth) {
    if (!node || typeof node !== "object" || depth > 6) return false;
    let touched = false;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (value && typeof value === "object") {
        touched = tuneJson(value, pageIndex, pageSize, depth + 1) || touched;
        continue;
      }
      if (typeof value !== "number") continue;
      if (SIZE_KEYS.test(key) && pageSize != null) {
        node[key] = pageSize;
        touched = true;
      } else if (PAGE_KEYS.test(key)) {
        const base = value === 0 ? 0 : 1;
        node[key] = pageIndex + base;
        touched = true;
      } else if (OFFSET_KEYS.test(key) && pageSize != null) {
        node[key] = pageIndex * pageSize;
        touched = true;
      }
    }
    return touched;
  }

  /* Заголовки, в которых обычно и лежит протухающий токен. */
  const AUTH_HEADER_RE = /^(authorization|x-[\w-]*(token|auth)[\w-]*|[\w-]*-jwt)$/i;

  function withoutAuthHeaders(headers) {
    const out = {};
    let stripped = false;
    for (const key of Object.keys(headers || {})) {
      if (AUTH_HEADER_RE.test(key)) {
        stripped = true;
        continue;
      }
      out[key] = headers[key];
    }
    return stripped ? out : null;
  }

  /*
   * Один раз на 401 пробуем тот же запрос без токена: если сессия Hub
   * держится на cookie, токен вообще не нужен — и тогда протухать нечему.
   * Не сработало — возвращаем исходный 401, дальше фон обновит рецепт.
   */
  async function replayPage(request, timeoutMs) {
    const response = await replay(request, timeoutMs);
    if (!response || (response.status !== 401 && response.status !== 403)) return response;
    if (recipe?.stripAuth) return response;

    const bare = withoutAuthHeaders(request.headers);
    if (!bare) return response;

    const retry = await replay({ ...request, headers: bare }, timeoutMs);
    if (!retry?.ok || !retry.text) return response;

    recipe = { ...recipe, headers: bare, stripAuth: true, capturedAt: Date.now() };
    recipeScore = Number(recipe.score) || recipeScore;
    void toBackground({ action: "ht:recipe", recipe });
    return retry;
  }

  function buildRequest(posting, pageIndex, pageSize, timeoutMs) {
    const fromId = recipe.itemId;
    const tunedUrl = tuneQuery(swapId(recipe.url, fromId, posting), pageIndex, pageSize);
    let body = recipe.body ? swapId(recipe.body, fromId, posting) : null;
    let bodyTouched = false;

    if (body) {
      try {
        const parsed = JSON.parse(body);
        bodyTouched = tuneJson(parsed, pageIndex, pageSize, 0);
        if (bodyTouched) body = JSON.stringify(parsed);
      } catch (_err) {
        bodyTouched = false;
      }
    }

    return {
      request: {
        url: tunedUrl.url,
        method: recipe.method,
        headers: recipe.headers,
        body
      },
      pageable: tunedUrl.touched || bodyTouched,
      timeoutMs
    };
  }

  /* Ищем в ответе самый крупный массив объектов — это и есть строки истории. */
  function findRows(json) {
    let best = null;
    let bestLen = -1;
    const queue = [{ node: json, depth: 0 }];
    while (queue.length) {
      const { node, depth } = queue.shift();
      if (!node || typeof node !== "object" || depth > 6) continue;
      if (Array.isArray(node)) {
        const objects = node.filter((entry) => entry && typeof entry === "object").length;
        if (node.length && objects >= node.length / 2 && node.length > bestLen) {
          best = node;
          bestLen = node.length;
        }
        for (const entry of node.slice(0, 40)) queue.push({ node: entry, depth: depth + 1 });
        continue;
      }
      for (const key of Object.keys(node)) queue.push({ node: node[key], depth: depth + 1 });
    }
    return best;
  }

  /* Дешёвый отпечаток ответа: по нему фон замечает, что сервер отдаёт одно и
     то же на разные номера (значит подстановка номера не сработала). */
  function digestOf(text) {
    const head = text.slice(0, 4000);
    const tail = text.length > 6000 ? text.slice(-2000) : "";
    const body = head + tail;
    let hash = 5381;
    for (let i = 0; i < body.length; i += 1) hash = ((hash * 33) ^ body.charCodeAt(i)) >>> 0;
    return `${hash.toString(36)}:${text.length}`;
  }

  const TOTAL_KEYS = /^(total|total_?count|total_?rows|total_?items|count|row_?count|items_?count|all)$/i;

  function findTotal(json) {
    const queue = [{ node: json, depth: 0 }];
    while (queue.length) {
      const { node, depth } = queue.shift();
      if (!node || typeof node !== "object" || depth > 5) continue;
      if (Array.isArray(node)) continue;
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (typeof value === "number" && Number.isFinite(value) && TOTAL_KEYS.test(key)) return value;
        if (value && typeof value === "object") queue.push({ node: value, depth: depth + 1 });
      }
    }
    return null;
  }

  function flattenRow(node, prefix, out, depth) {
    if (!node || typeof node !== "object" || depth > 2) return out;
    for (const key of Object.keys(node)) {
      const value = node[key];
      const label = prefix ? `${prefix}.${key}` : key;
      if (value && typeof value === "object") flattenRow(value, label, out, depth + 1);
      else out[label] = value == null ? "" : String(value);
    }
    return out;
  }

  /* Номер отправления и статус — из карточки предмета, не из истории. */
  function extractCardFrom(json) {
    const out = { number: "", status: "" };
    if (!json) return out;
    const match = JSON.stringify(json).match(POSTING_NUMBER_RE);
    if (match) out.number = match[0];

    const queue = [{ node: json, depth: 0 }];
    while (queue.length && !out.status) {
      const { node, depth } = queue.shift();
      if (!node || typeof node !== "object" || depth > 4) continue;
      for (const key of Object.keys(node)) {
        const value = node[key];
        if (
          typeof value === "string" &&
          /^(status|state)(_?name)?$/i.test(key) &&
          /[А-Яа-яЁё]/.test(value) &&
          value.length <= 40
        ) {
          out.status = value;
          break;
        }
        if (value && typeof value === "object") queue.push({ node: value, depth: depth + 1 });
      }
    }
    return out;
  }

  async function fetchCard(posting, timeoutMs) {
    if (!cardRecipe) return { number: "", status: "" };
    const fromId = cardRecipe.itemId;
    const response = await replay(
      {
        url: swapId(cardRecipe.url, fromId, posting),
        method: cardRecipe.method,
        headers: cardRecipe.headers,
        body: cardRecipe.body ? swapId(cardRecipe.body, fromId, posting) : null
      },
      timeoutMs
    );
    if (!response?.ok || !response.text) return { number: "", status: "" };
    try {
      return extractCardFrom(JSON.parse(response.text));
    } catch (_err) {
      return { number: "", status: "" };
    }
  }

  const DATE_KEY_RE = /(date|time|дата|created|moment|stamp)/i;
  const CELL_KEY_RE = /(cell|ячей|slot|place)/i;

  function reportFromApiRows(rows, needle) {
    const flat = rows.map((row) => flattenRow(row, "", {}, 0));
    const columns = [];
    for (const row of flat.slice(0, 3)) {
      for (const key of Object.keys(row)) if (!columns.includes(key)) columns.push(key);
    }
    const lastRows = flat.slice(0, 3).map((row) => columns.map((key) => row[key] ?? ""));

    let warehouseAt = "";
    let warehouseCell = "";
    const hit = flat.find((row) => Object.values(row).join(" ").toLowerCase().includes(needle));
    if (hit) {
      for (const key of Object.keys(hit)) {
        if (!warehouseAt && DATE_KEY_RE.test(key) && String(hit[key]).trim()) warehouseAt = String(hit[key]);
        if (!warehouseCell && CELL_KEY_RE.test(key) && String(hit[key]).trim()) warehouseCell = String(hit[key]);
      }
      if (!warehouseAt) warehouseAt = findDate(Object.values(hit));
    }
    return { columns, lastRows, warehouseAt, warehouseCell };
  }

  async function apiScan(job) {
    if (!recipe) return { ok: false, reason: "no_recipe" };
    const posting = String(job.posting || "").trim();
    if (!posting) return { ok: false, reason: "no_posting" };
    const needle = String(job.warehouse || "").toLowerCase();
    if (!needle) return { ok: false, reason: "no_warehouse" };

    const deadline = Date.now() + Math.max(4000, Number(job.timeoutMs) || 20000);
    const sizeModes = [DEFAULT_PAGE_SIZE, null];
    /* Конкретная причина отказа: без неё в интерфейс уходило безликое
       «быстрый режим недоступен», и понять, что чинить, было нельзя. */
    let failure = "";

    for (const pageSize of sizeModes) {
      let loaded = 0;
      let total = null;
      let found = false;
      let sample = "";
      let pageable = true;
      let failed = false;
      let digest = "";
      const allRows = [];
      let firstJson = null;

      for (let page = 0; page < MAX_API_PAGES && !failed; page += 1) {
        if (abortFlag || Date.now() > deadline) return { ok: false, reason: "aborted" };

        const built = buildRequest(posting, page, pageSize, Math.max(2000, deadline - Date.now()));
        pageable = built.pageable;
        const response = await replayPage(built.request, built.timeoutMs);

        if (!response || !response.ok || !response.text) {
          if (!response) failure = "нет ответа";
          else if (response.error) failure = `сеть: ${response.error}`;
          else if (response.status === 401 || response.status === 403) {
            /* Токен в рецепте протух — нужен свежий захват, а не повтор. */
            return { ok: false, auth: true, status: response.status, reason: `ответ ${response.status}` };
          } else if (!response.ok) failure = `ответ ${response.status || "?"}`;
          else failure = "пустой ответ";
          failed = true;
          break;
        }

        let json;
        try {
          json = JSON.parse(response.text);
        } catch (_err) {
          failure = "ответ не JSON";
          failed = true;
          break;
        }

        const rows = findRows(json);
        if (!rows) {
          failure = "в ответе не нашлось списка строк";
          failed = true;
          break;
        }
        if (page === 0) {
          digest = digestOf(response.text);
          firstJson = json;
        }
        /* Для отчёта достаточно верхушки списка, всю историю не копим. */
        if (allRows.length < 60) allRows.push(...rows.slice(0, 60 - allRows.length));

        /* Пере-сериализуем: сервер может отдавать кириллицу \u-эскейпами. */
        const haystack = JSON.stringify(rows).toLowerCase();
        if (!found && haystack.includes(needle)) {
          found = true;
          const match = rows.find((row) => JSON.stringify(row).toLowerCase().includes(needle));
          sample = match ? JSON.stringify(match).slice(0, 280) : "";
        }

        loaded += rows.length;
        const pageTotal = findTotal(json);
        if (pageTotal != null) total = pageTotal;

        if (found) break;
        if (!rows.length) break;
        if (total != null && loaded >= total) break;
        if (!pageable) break;
      }

      if (failed) continue;

      const expected = total != null ? total : loaded;
      const report = reportFromApiRows(allRows, needle);
      const card = extractCardFrom(firstJson);
      if (!card.number || !card.status) {
        const extra = await fetchCard(posting, Math.max(2000, Math.min(8000, deadline - Date.now())));
        card.number = card.number || extra.number;
        card.status = card.status || extra.status;
      }
      report.number = card.number;
      report.status = card.status;

      return {
        ok: true,
        via: "api",
        found,
        expected,
        loaded,
        complete: total == null ? true : loaded >= total || found,
        sample,
        digest,
        report
      };
    }

    return { ok: false, reason: failure || "запрос не подошёл" };
  }

  /* ------------------------------------------------------------------ */
  /* надёжный путь: обход таблицы                                        */
  /* ------------------------------------------------------------------ */

  /*
   * Подстраховка на случай, если наши селекторы не нашли строки таблицы.
   *
   * Раньше здесь был откат на document.body — и это давало ложное «есть»:
   * в шапке Hub стоит кнопка с текущим складом («СЦ_Истра-ХАБ_Возвраты»),
   * и если искали именно его, совпадение находилось на каждом номере.
   * Теперь читаем только контейнер истории и вырезаем из него всю обвязку:
   * кнопки, поповеры, фильтры, панель инструментов таблицы.
   */
  const CHROME_SELECTOR = [
    "header",
    "nav",
    "button",
    "select",
    "input",
    "label",
    '[role="button"]',
    '[role="tablist"]',
    '[class*="header"]',
    '[class*="Header"]',
    '[class*="popover"]',
    '[class*="Popover"]',
    '[class*="dropdown"]',
    '[class*="table-tools"]',
    '[class*="toolbar"]',
    '[class*="Toolbar"]',
    '[class*="filter"]',
    '[class*="Filter"]',
    '[class*="breadcrumb"]',
    '[class*="__button__"]',
    '[class*="tabs"]'
  ].join(",");

  function historyContainer() {
    return (
      document.querySelector('[class*="_history_"]') ||
      document.querySelector('[class*="data-grid"]') ||
      null
    );
  }

  function fallbackHistoryText() {
    /* Строки нашлись — обходить контейнер целиком незачем. */
    if (rowNodes().length) return "";
    const root = historyContainer();
    if (!root) return "";
    let clone;
    try {
      clone = root.cloneNode(true);
    } catch (_err) {
      return "";
    }
    for (const node of clone.querySelectorAll(CHROME_SELECTOR)) node.remove();
    return norm(clone.textContent).toLowerCase();
  }

  /* Поиск таблицы стоит нескольких querySelectorAll по документу, а звать
     rowNodes() приходится на каждую пачку мутаций. Запоминаем найденное. */
  let cachedTable = null;

  function rowsTable() {
    if (cachedTable && cachedTable.isConnected) return cachedTable;
    cachedTable =
      document.querySelector("table.ozi__table__table__HAe8A") ||
      [...document.querySelectorAll("table")].find((item) =>
        item.querySelector("tbody tr, tr[class*='data-grid__row']")
      ) ||
      document.querySelector("table") ||
      null;
    return cachedTable;
  }

  function rowNodes() {
    const table = rowsTable();
    if (table) {
      const rows = table.querySelectorAll("tbody tr, tr[class*='data-grid__row']");
      if (rows.length) return rows;
    }
    return document.querySelectorAll('[class*="data-grid__row"]');
  }

  /* «Всего: 1 234» — число может идти с разрядами через пробел или nbsp,
     поэтому забираем всю группу и вычищаем из неё нецифры. */
  const TOTAL_RE = new RegExp("Всего:\\s*([0-9][0-9\\s\\u00a0\\u202f\\u2009]*)", "i");

  function readTotal(el) {
    if (!el) return null;
    const match = textOf(el).match(TOTAL_RE);
    if (!match) return null;
    const digits = match[1].replace(/[^0-9]/g, "");
    return digits ? Number(digits) : null;
  }

  function parseCounter() {
    const scoped = document.querySelectorAll(
      '[class*="table-tools__counter"], [class*="counter"], [class*="Counter"], [class*="total"], [class*="Total"]'
    );
    for (const node of scoped) {
      const value = readTotal(node);
      if (value != null) return value;
    }
    /* Только контейнер истории: «Всего» из чужого блока страницы дало бы
       неверный ориентир. */
    return readTotal(historyContainer());
  }

  function historyReady() {
    return Boolean(
      document.querySelector('[class*="_history_"]') ||
        document.querySelector('[class*="table-tools__counter"]') ||
        document.querySelector("table.ozi__table__table__HAe8A") ||
        rowNodes().length
    );
  }

  /*
   * Шапка карточки: номер отправления (0109673395-0032-1) и статус
   * («Сформирован») — их в истории нет, они только в шапке страницы.
   */
  function readItemCard() {
    const out = { number: "", status: "" };
    const leaves = [];
    const nodes = document.querySelectorAll("h1,h2,h3,h4,span,div,a,b,strong,p");
    for (let i = 0; i < nodes.length && i < 900; i += 1) {
      const el = nodes[i];
      if (el.children.length) continue;
      const text = norm(el.textContent);
      if (!text || text.length > 60) continue;
      leaves.push({ el, text });
    }

    const numberAt = leaves.findIndex((leaf) => POSTING_NUMBER_RE.test(leaf.text) && leaf.text.length <= 40);
    if (numberAt < 0) return out;
    out.number = (leaves[numberAt].text.match(POSTING_NUMBER_RE) || [""])[0];

    /* Статус ищем среди соседей номера: короткое кириллическое слово без
       цифр, желательно на цветной плашке. Вкладки «О предмете / Состав /
       История» тоже подходят под описание, поэтому берём ближайшее к
       номеру и предпочитаем то, у которого есть фон. */
    let best = null;
    for (let i = numberAt + 1; i < leaves.length && i <= numberAt + 12; i += 1) {
      const text = leaves[i].text;
      if (text.length < 3 || text.length > 30) continue;
      if (/\d/.test(text) || !/[А-Яа-яЁё]/.test(text)) continue;
      let painted = false;
      try {
        const background = getComputedStyle(leaves[i].el).backgroundColor;
        painted = Boolean(background) && background !== "transparent" && !/rgba\(0,\s*0,\s*0,\s*0\)/.test(background);
      } catch (_err) {
        painted = false;
      }
      const rank = (painted ? 0 : 100) + (i - numberAt);
      if (!best || rank < best.rank) best = { text, rank };
      if (painted && i - numberAt <= 3) break;
    }
    if (best) out.status = best.text;
    return out;
  }

  function tableColumns() {
    const table = rowsTable();
    const head = table?.querySelector("thead");
    if (!head) return [];
    return [...head.querySelectorAll("th, td")].map((cell) => norm(cell.textContent)).filter(Boolean);
  }

  function rowCells(row) {
    const cells = row.querySelectorAll("td, th");
    if (cells.length) return [...cells].map((cell) => norm(cell.textContent));
    return [norm(row.textContent)];
  }

  function detectAuth() {
    const href = location.href.toLowerCase();
    if (/login|sso|auth/.test(href)) return true;
    return Boolean(document.querySelector('input[type="password"]'));
  }

  function detectMissing() {
    const text = textOf(document.body).toLowerCase();
    return /не найден|не существует|нет данных по предмету|page not found/.test(text);
  }

  function waitFor(test, timeoutMs, target) {
    if (test()) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const finish = (value) => {
        if (done) return;
        done = true;
        observer.disconnect();
        clearInterval(poll);
        clearTimeout(cap);
        resolve(value);
      };
      const observer = new MutationObserver(() => {
        if (test()) finish(true);
      });
      /* Для ожидания новых строк достаточно смотреть на саму таблицу —
         подписка на весь документ дёргает колбэк на каждый чих SPA. */
      const root = target || document.documentElement || document;
      observer.observe(root, { childList: true, subtree: true, characterData: true });
      const poll = setInterval(() => {
        if (abortFlag) finish(false);
        else if (test()) finish(true);
      }, 40);
      const cap = setTimeout(() => finish(false), Math.max(50, timeoutMs));
    });
  }

  function ensureScrollCss() {
    let style = document.getElementById("hub-trace-expand");
    if (!style) {
      style = document.createElement("style");
      style.id = "hub-trace-expand";
      (document.head || document.documentElement).appendChild(style);
    }
    /*
     * Раньше здесь принудительно навешивались max-height и overflow на
     * контейнеры таблицы. Это создавало второй контейнер прокрутки вокруг
     * настоящего: мы крутили внешний, строки жили во внутреннем, список не
     * рос — и всё сваливалось в «мало строк».
     *
     * Оставляем только отключение плавной прокрутки: с ней присваивание
     * scrollTop анимируется и позиция «плывёт».
     */
    style.textContent = `
      html, body, [data-overlayscrollbars-viewport], [class*="scroller"], [class*="Scroller"] {
        scroll-behavior: auto !important;
      }
    `;
  }

  function room(el) {
    if (!el) return 0;
    return Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
  }

  function atBottom(el) {
    if (!el) return true;
    const max = room(el);
    return max < 8 || (el.scrollTop || 0) >= max - 4;
  }

  function scrolls(el) {
    if (!el || el.nodeType !== 1) return false;
    if (room(el) <= 4) return false;
    const overflow = getComputedStyle(el).overflowY;
    return overflow === "auto" || overflow === "scroll" || overflow === "overlay";
  }

  /*
   * Контейнер прокрутки берём от самой строки вверх по родителям, а не
   * угадыванием по списку селекторов с сортировкой по «запасу прокрутки».
   * Угадывание попадало то во внешнюю обёртку, то в документ — оттуда и
   * дёрганье: одно место крутили мы, другое — scrollIntoView.
   */
  function findScroller() {
    const rows = rowNodes();

    /* Путь от строки вверх — единственный надёжный: он гарантированно
       приводит в контейнер, в котором эта строка и лежит. */
    if (rows.length) {
      let node = rows[rows.length - 1];
      while (node && node !== document.documentElement) {
        node = node.parentElement;
        if (scrolls(node)) return node;
      }
      return null;
    }

    /*
     * Строк ещё нет. Подниматься по родителям здесь нельзя: пустая таблица
     * не прокручивается, и поиск уходил во внешнюю обёртку страницы — её и
     * начинали крутить. Поэтому только явные контейнеры списка.
     */
    for (const selector of [
      "[data-overlayscrollbars-viewport]",
      '[class*="data-grid__scroller"]',
      '[class*="ozi__scroller__scroller"]'
    ]) {
      const el = document.querySelector(selector);
      if (scrolls(el)) return el;
    }
    return null;
  }

  function fireWheel(el, deltaY) {
    if (!el || !(deltaY > 0)) return;
    const rect = el.getBoundingClientRect?.() || {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight
    };
    el.dispatchEvent(
      new WheelEvent("wheel", {
        deltaY,
        deltaMode: 0,
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: Math.round(rect.left + Math.max(24, rect.width / 2)),
        clientY: Math.round(rect.top + Math.max(24, rect.height / 2))
      })
    );
  }

  /* Максимум, куда уже доскроллили: назад не откатываемся никогда. */
  let scrollReached = 0;

  /*
   * Ровно один способ прокрутки — присваивание scrollTop выбранному
   * контейнеру. scrollIntoView убран: он двигает все прокручиваемые
   * родители сразу, включая окно, и вместе с нашим scrollTop давал
   * качание вверх-вниз. Колесо осталось только как запасной вариант,
   * если элемент не реагирует на присваивание.
   */
  function jumpToBottom(scroller) {
    if (!scroller) return false;

    const before = scroller.scrollTop || 0;
    const max = room(scroller);
    if (before >= max - 2) {
      scrollReached = Math.max(scrollReached, before);
      return false;
    }

    scroller.scrollTop = Math.max(max, scrollReached);
    const after = scroller.scrollTop || 0;
    scrollReached = Math.max(scrollReached, after);

    if (after > before) {
      /*
       * Нативное событие scroll приходит только на следующем обновлении
       * отрисовки, а в скрытой вкладке оно ещё и придушено — обход из-за
       * этого замедлялся в разы. Поэтому дублируем его синхронно.
       *
       * bubbles: false обязателен: настоящие scroll на элементах не
       * всплывают, а всплывающий дубль будил обработчики внешних обёрток.
       */
      scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
      return true;
    }

    /* Присваивание не сработало — пробуем колесом. */
    fireWheel(scroller, Math.max(600, (scroller.clientHeight || 400) * 1.5));
    return (scroller.scrollTop || 0) > before;
  }

  function clickUncheckCurrentOnly() {
    for (const label of document.querySelectorAll("label")) {
      if (!textOf(label).includes("Только по текущему складу")) continue;
      const input = label.querySelector('input[type="checkbox"]');
      if (input?.checked) {
        input.click();
        return true;
      }
    }
    return false;
  }

  function clickHistoryTab() {
    for (const el of document.querySelectorAll('button, a, [role="tab"]')) {
      const label = textOf(el).toLowerCase();
      if (label !== "история" && !label.startsWith("история")) continue;
      if (el.getAttribute("aria-selected") === "true" || String(el.className).includes("active")) return false;
      el.click();
      return true;
    }
    return false;
  }

  async function domScan(job) {
    const needle = String(job.warehouse || "").toLowerCase();
    if (!needle) return { ok: false, status: "bad_input", found: false, expected: 0, loaded: 0 };

    const deadline = Date.now() + Math.max(8000, Number(job.timeoutMs) || 45000);
    const left = () => deadline - Date.now();
    const dead = () => abortFlag || left() <= 0;

    const seen = new Set();
    let prevLength = 0;
    let found = false;
    let sample = "";
    /* Верхняя строка с искомым складом — из неё берём дату и ячейку. */
    let warehouseCells = null;

    function harvest() {
      const rows = rowNodes();
      const length = rows.length;
      let start;
      if (length > prevLength) start = Math.max(0, prevLength - OVERLAP);
      else if (length < prevLength || length <= FULL_PASS_LIMIT) start = 0;
      else start = Math.max(0, length - 120);
      if (length < prevLength) seen.clear();

      for (let i = start; i < length; i += 1) {
        const raw = rows[i].textContent;
        if (!raw) continue;
        const value = norm(raw);
        if (!value) continue;
        const key = value.length > 320 ? value.slice(0, 320) : value;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!found && value.toLowerCase().includes(needle)) {
          found = true;
          sample = value.slice(0, 280);
          warehouseCells = rowCells(rows[i]);
        }
      }
      prevLength = length;
      return found;
    }

    function waitRowGrowth(before, ms) {
      const table = rowsTable();
      return waitFor(() => rowNodes().length > before, ms, table || undefined);
    }

    reportPhase("history", job.posting);

    /* 1. Ждём саму историю. */
    let tabClicked = false;
    const ready = await waitFor(() => {
      if (historyReady()) return true;
      if (!tabClicked && document.body) tabClicked = clickHistoryTab();
      return false;
    }, Math.min(20000, left()));

    if (!ready) {
      if (detectAuth()) return { ok: false, status: "auth", found: false, expected: 0, loaded: 0 };
      if (detectMissing()) return { ok: false, status: "missing", found: false, expected: 0, loaded: 0 };
      if (abortFlag) return { ok: false, status: "paused", found: false, expected: 0, loaded: 0 };
      return { ok: false, status: "no_history", found: false, expected: 0, loaded: 0 };
    }

    /*
     * 2. Счётчик «Всего: N» — ориентир, дочитали ли мы список.
     *
     * Ноль в нём почти всегда означает «данные ещё не приехали». Раньше он
     * принимался за настоящий итог, и дальше вся загрузка пропускалась:
     * условие цикла было expected > 0. В ленте это видно как «N/0», а по
     * сути читалась только первая отрисованная страница истории.
     *
     * Теперь total может быть null — «неизвестно». В этом случае список
     * догружается до тех пор, пока он перестанет расти.
     */
    let total = parseCounter();
    if (total == null) {
      /* Ждём счётчик, но не дольше, чем до появления строк: без счётчика
         список всё равно можно вычитать, а вот стоять по 10 секунд на
         каждом номере нельзя. */
      await waitFor(() => {
        total = parseCounter();
        return total != null || rowNodes().length > 0;
      }, Math.min(10000, left()));
      /* Счётчик мог отрисоваться чуть позже строк — даём короткую отсрочку. */
      if (total == null) {
        await waitFor(() => (total = parseCounter()) != null, Math.min(600, Math.max(100, left())));
      }
    }
    if (total === 0) {
      await waitFor(() => {
        const next = parseCounter();
        if (next != null) total = next;
        return (next != null && next > 0) || rowNodes().length > 0;
      }, Math.min(2500, Math.max(200, left())));
    }

    const hasRows = () => rowNodes().length > 0;

    if (total == null) {
      if (detectMissing()) return { ok: false, status: "missing", found: false, expected: 0, loaded: 0 };
      /* Счётчика нет, но строки есть — ориентируемся по ним. */
      if (!hasRows()) return { ok: false, status: "no_counter", found: false, expected: 0, loaded: 0 };
    } else if (total === 0 && hasRows()) {
      /* Счётчик говорит «ноль», а строки на месте — значит он не про историю. */
      total = null;
    }

    if (job.uncheckCurrentOnly && clickUncheckCurrentOnly()) {
      const before = total;
      await waitFor(() => {
        const next = parseCounter();
        if (next != null && next !== before) {
          total = next;
          return true;
        }
        return false;
      }, Math.min(6000, left()));
    }

    reportPhase("rows", job.posting);
    ensureScrollCss();
    harvest();

    if (!found && fallbackHistoryText().includes(needle)) {
      found = true;
      sample = needle;
    }

    /* 3. Догружаем список прыжками в конец. */
    const needMore = () => total == null || seen.size < total;
    /* drained — список перестал расти, то есть прочитан до конца. */
    let drained = !needMore();

    if (!found && needMore()) {
      scrollReached = 0;
      let stall = 0;

      while (!dead() && !found && needMore()) {
        /* Ищем контейнер на каждом круге: пока строк не было, подходящего
           контейнера могло не существовать вовсе. */
        const scroller = findScroller();
        const before = rowNodes().length;
        const moved = jumpToBottom(scroller);

        /* Пока счётчик известен и до него не добрали — там точно должно
           приехать ещё, поэтому ждём заметно дольше. Медленный ответ Hub
           не должен превращаться в «мало строк». */
        const patient = total != null;
        const wait = moved ? (patient ? 1200 : 700) : patient ? 1500 : 900;
        const grew = await waitRowGrowth(before, Math.min(wait, Math.max(150, left())));
        harvest();
        if (found) break;

        if (grew) {
          stall = 0;
          continue;
        }

        stall += 1;

        if (total == null) {
          /* Итог неизвестен: внизу и не растёт — значит дочитали. */
          if (atBottom(scroller) && stall >= 2) {
            drained = true;
            break;
          }
          if (stall >= 4) {
            drained = true;
            break;
          }
        } else if (stall >= 6) {
          break;
        }
      }
      if (!drained && !needMore()) drained = true;
    }

    harvest();

    if (!found && fallbackHistoryText().includes(needle)) {
      found = true;
      sample = needle;
    }

    const card = readItemCard();
    const tableRows = rowNodes();
    const report = {
      number: card.number,
      status: card.status,
      columns: tableColumns(),
      lastRows: [...tableRows].slice(0, 3).map(rowCells),
      warehouseAt: warehouseCells ? findDate(warehouseCells) : "",
      warehouseCell: warehouseCells ? findCell(warehouseCells) : ""
    };

    const loaded = seen.size;
    /* Нашли — значит дочитали ровно столько, сколько было нужно. */
    const complete = found || (total != null ? loaded >= total : drained);
    /* Итог неизвестен: если список вычитан до конца или искомое уже нашлось,
       «всего» = сколько прочли. Ноль остаётся только там, где мы правда не
       дочитали — в ленте это и читается как «мало строк». */
    const expected = total != null ? total : drained || found ? loaded : 0;

    if (abortFlag && !found && !complete) {
      return { ok: false, status: "paused", found, expected, loaded, via: "dom", report };
    }

    return {
      ok: complete,
      report,
      status: complete ? "complete" : "partial",
      via: "dom",
      found,
      expected,
      loaded,
      sample
    };
  }

  /* ------------------------------------------------------------------ */
  /* обработка заданий                                                   */
  /* ------------------------------------------------------------------ */

  function normalizeReport(report) {
    if (!report || typeof report !== "object") return null;
    const rows = Array.isArray(report.lastRows) ? report.lastRows.slice(0, 3) : [];
    return {
      number: String(report.number || ""),
      status: String(report.status || ""),
      warehouseAt: String(report.warehouseAt || ""),
      warehouseCell: String(report.warehouseCell || ""),
      columns: (Array.isArray(report.columns) ? report.columns : []).map((value) => String(value || "")),
      /* Режем длинные значения: в отчёт идут три строки, а не вся история. */
      lastRows: rows.map((row) =>
        (Array.isArray(row) ? row : []).map((value) => String(value || "").slice(0, 600))
      )
    };
  }

  function normalizeResult(raw) {
    if (!raw) return { status: "script_error", found: false, expected: 0, loaded: 0, ok: false };
    if (raw.via === "api") {
      return {
        status: raw.complete ? "complete" : "partial",
        via: "api",
        found: Boolean(raw.found),
        expected: Number(raw.expected) || 0,
        loaded: Number(raw.loaded) || 0,
        ok: Boolean(raw.complete),
        sample: raw.sample || "",
        digest: raw.digest || "",
        report: normalizeReport(raw.report)
      };
    }
    return {
      status: raw.status || "script_error",
      via: raw.via || "dom",
      found: Boolean(raw.found),
      expected: Number(raw.expected) || 0,
      loaded: Number(raw.loaded) || 0,
      ok: Boolean(raw.ok),
      sample: raw.sample || "",
      report: normalizeReport(raw.report)
    };
  }

  async function runDomJob(job) {
    abortFlag = false;
    try {
      const raw = await domScan(job);
      return normalizeResult(raw);
    } catch (error) {
      return {
        status: "exception",
        via: "dom",
        found: false,
        expected: 0,
        loaded: 0,
        ok: false,
        error: String(error?.message || error)
      };
    } finally {
      reportPhase("idle");
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!message || typeof message.action !== "string") return false;

    if (message.action === "ht:ping") {
      sendResponse({
        ok: true,
        href: location.href,
        posting: itemIdFromHref(location.href),
        hasRecipe: Boolean(recipe),
        ready: historyReady()
      });
      return false;
    }

    if (message.action === "ht:setRecipe") {
      adoptRecipe(message.recipe, false);
      sendResponse({ ok: Boolean(recipe) });
      return false;
    }

    if (message.action === "ht:setCardRecipe") {
      adoptCardRecipe(message.recipe, false);
      sendResponse({ ok: Boolean(cardRecipe) });
      return false;
    }

    if (message.action === "ht:abort") {
      abortFlag = true;
      sendResponse({ ok: true });
      return false;
    }

    if (message.action === "ht:apiScan") {
      abortFlag = false;
      apiScan(message)
        .then((raw) => {
          if (!raw?.ok) {
            sendResponse({ ok: false, reason: raw?.reason || "api_failed", auth: Boolean(raw?.auth) });
            return;
          }
          sendResponse({ ok: true, result: normalizeResult(raw) });
        })
        .catch((error) => sendResponse({ ok: false, reason: String(error?.message || error) }));
      return true;
    }

    if (message.action === "ht:domScan") {
      runDomJob(message).then((result) => sendResponse({ ok: true, result }));
      return true;
    }

    return false;
  });

  /* Страница сама сообщает фону, что готова принять задание. */
  async function announce() {
    askProbeForRecipe();
    const posting = itemIdFromHref(location.href);
    if (!posting) return;

    const reply = await toBackground({ action: "ht:hello", posting, href: location.href });
    if (!reply?.run || !reply.job) return;

    const result = await runDomJob({ ...reply.job, posting });
    void toBackground({
      action: "ht:result",
      taskId: reply.job.taskId,
      posting,
      result
    });
  }

  void announce();
  /* Пробник мог поймать рецепт уже после нашей подписки. */
  setTimeout(askProbeForRecipe, 1200);
  setTimeout(askProbeForRecipe, 4000);
})();
