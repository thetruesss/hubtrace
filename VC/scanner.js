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
    if (data.type === "replayResult") {
      const waiter = replayWaiters.get(data.ticket);
      if (!waiter) return;
      replayWaiters.delete(data.ticket);
      waiter(data);
    }
  });

  function adoptRecipe(next, share) {
    if (!next || !next.url || !next.itemId) return;
    const score = Number(next.score) || 0;
    if (score <= recipeScore) return;
    recipe = next;
    recipeScore = score;
    if (share) void toBackground({ action: "ht:recipe", recipe: next });
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

  async function apiScan(job) {
    if (!recipe) return { ok: false, reason: "no_recipe" };
    const posting = String(job.posting || "").trim();
    if (!posting) return { ok: false, reason: "no_posting" };
    const needle = String(job.warehouse || "").toLowerCase();
    if (!needle) return { ok: false, reason: "no_warehouse" };

    const deadline = Date.now() + Math.max(4000, Number(job.timeoutMs) || 20000);
    const sizeModes = [DEFAULT_PAGE_SIZE, null];

    for (const pageSize of sizeModes) {
      let loaded = 0;
      let total = null;
      let found = false;
      let sample = "";
      let pageable = true;
      let failed = false;
      let digest = "";

      for (let page = 0; page < MAX_API_PAGES && !failed; page += 1) {
        if (abortFlag || Date.now() > deadline) return { ok: false, reason: "aborted" };

        const built = buildRequest(posting, page, pageSize, Math.max(2000, deadline - Date.now()));
        pageable = built.pageable;
        const response = await replay(built.request, built.timeoutMs);

        if (!response || !response.ok || !response.text) {
          failed = true;
          break;
        }

        let json;
        try {
          json = JSON.parse(response.text);
        } catch (_err) {
          failed = true;
          break;
        }

        const rows = findRows(json);
        if (!rows) {
          failed = true;
          break;
        }
        if (page === 0) digest = digestOf(response.text);

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
      return {
        ok: true,
        via: "api",
        found,
        expected,
        loaded,
        complete: total == null ? true : loaded >= total || found,
        sample,
        digest
      };
    }

    return { ok: false, reason: "api_unusable" };
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

  function parseCounter() {
    const nodes = document.querySelectorAll('[class*="table-tools__counter"]');
    for (const node of nodes) {
      const match = textOf(node).match(/Всего:\s*(\d+)/i);
      if (match) return Number(match[1]);
    }
    const history = document.querySelector('[class*="_history_"]');
    const match = textOf(history || document.body).match(/Всего:\s*(\d+)/i);
    return match ? Number(match[1]) : null;
  }

  function historyReady() {
    return Boolean(
      document.querySelector('[class*="_history_"]') ||
        document.querySelector('[class*="table-tools__counter"]') ||
        document.querySelector("table.ozi__table__table__HAe8A") ||
        rowNodes().length
    );
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
    style.textContent = `
      [class*="data-grid__scroller"],
      [data-overlayscrollbars="host"],
      [class*="ozi__scroller__scroller"] {
        max-height: 88vh !important;
        overflow: auto !important;
      }
      [data-overlayscrollbars-viewport] {
        overflow-y: scroll !important;
        overflow-x: hidden !important;
        max-height: 88vh !important;
      }
      * { scroll-behavior: auto !important; }
    `;
  }

  function room(el) {
    if (!el) return 0;
    return Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
  }

  function pickScroller() {
    const list = [];
    const add = (el) => {
      if (el && !list.includes(el)) list.push(el);
    };
    add(document.querySelector("[data-overlayscrollbars-viewport]"));
    add(document.querySelector('[data-overlayscrollbars="host"]'));
    add(document.querySelector('[class*="data-grid__scroller"]'));
    add(document.querySelector('[class*="ozi__scroller__scroller"]'));
    add(document.querySelector('[class*="_wrapperContainer"]'));
    add(document.querySelector('[class*="_history_"]'));
    const table = document.querySelector("table.ozi__table__table__HAe8A") || document.querySelector("table");
    add(table?.parentElement);
    add(table?.parentElement?.parentElement);
    add(document.scrollingElement);
    add(document.documentElement);
    add(document.body);

    const ranked = list.sort((a, b) => room(b) - room(a));
    return ranked.find((el) => room(el) > 8) || ranked[0] || document.scrollingElement;
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

  /* Один прыжок в конец списка вместо десятка мелких шагов. */
  function jumpToBottom(scroller, rows) {
    const last = rows.length ? rows[rows.length - 1] : null;
    if (last && typeof last.scrollIntoView === "function") {
      try {
        last.scrollIntoView({ block: "end", inline: "nearest" });
      } catch (_err) {
        /* ignore */
      }
    }
    if (!scroller) return;
    const max = room(scroller);
    scroller.scrollTop = max;
    try {
      scroller.scrollTo?.({ top: max, left: 0, behavior: "auto" });
    } catch (_err) {
      /* ignore */
    }
    scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    fireWheel(scroller, Math.max(600, (scroller.clientHeight || 400) * 1.5));
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

    /* 2. Счётчик «Всего: N» — нужен, чтобы понимать, дочитали ли мы список. */
    let expected = parseCounter();
    if (expected == null) {
      await waitFor(() => (expected = parseCounter()) != null, Math.min(10000, left()));
    }
    if (expected == null) {
      if (detectMissing()) return { ok: false, status: "missing", found: false, expected: 0, loaded: 0 };
      return { ok: false, status: "no_counter", found: false, expected: 0, loaded: 0 };
    }

    if (job.uncheckCurrentOnly && clickUncheckCurrentOnly()) {
      const before = expected;
      await waitFor(() => {
        const next = parseCounter();
        if (next != null && next !== before) {
          expected = next;
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
    if (!found && expected > 0 && seen.size < expected) {
      let scroller = pickScroller();
      let stall = 0;

      while (!dead() && !found && seen.size < expected) {
        const rows = rowNodes();
        const before = rows.length;
        jumpToBottom(scroller, rows);

        const grew = await waitRowGrowth(before, Math.min(stall ? 1200 : 600, Math.max(120, left())));
        harvest();
        if (found) break;

        if (grew) {
          stall = 0;
          continue;
        }

        stall += 1;
        if (stall === 2) scroller = pickScroller();
        if (stall >= 4) break;
      }
    }

    harvest();

    if (!found && fallbackHistoryText().includes(needle)) {
      found = true;
      sample = needle;
    }

    const loaded = seen.size;
    /* Нашли — значит дочитали ровно столько, сколько было нужно. */
    const complete = found || loaded >= expected;
    if (abortFlag && !found && !complete) {
      return { ok: false, status: "paused", found, expected, loaded, via: "dom" };
    }

    return {
      ok: complete,
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
        digest: raw.digest || ""
      };
    }
    return {
      status: raw.status || "script_error",
      via: raw.via || "dom",
      found: Boolean(raw.found),
      expected: Number(raw.expected) || 0,
      loaded: Number(raw.loaded) || 0,
      ok: Boolean(raw.ok),
      sample: raw.sample || ""
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
            sendResponse({ ok: false, reason: raw?.reason || "api_failed" });
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
