// Сканер страницы. Два пути: повтор запроса истории и обход таблицы в DOM как страховка.
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

  function norm(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  // textContent, а не innerText: innerText форсирует reflow
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
    if (data.type === "hint") {
      let changed = false;
      if (data.appVersion && data.appVersion !== appVersion) {
        appVersion = String(data.appVersion);
        changed = true;
      }
      if (data.placeId && !placeId) {
        placeId = String(data.placeId);
        changed = true;
      }
      if (changed) void toBackground(hintPayload());
      return;
    }
    if (data.type === "replayResult") {
      const waiter = replayWaiters.get(data.ticket);
      if (!waiter) return;
      replayWaiters.delete(data.ticket);
      waiter(data);
    }
  });

  // Без ID предмета в рецепте подставлять номер некуда — на все номера приедет одна история.
  function carriesId(recipe) {
    const id = String(recipe?.itemId || "");
    if (!id) return false;
    const hay = `${recipe.url || ""}\n${recipe.body || ""}`;
    if (hay.includes(id)) return true;
    try {
      return hay.includes(encodeURIComponent(id));
    } catch (_err) {
      return false;
    }
  }

  function adoptRecipe(next, share) {
    if (!next || !next.url || !next.itemId) return;
    if (!carriesId(next)) return;
    const score = Number(next.score) || 0;
    const captured = Number(next.capturedAt) || 0;
    const currentCaptured = Number(recipe?.capturedAt) || 0;

    const better = score > recipeScore;
    const fresher = score >= recipeScore && captured > currentCaptured;
    if (!better && !fresher) return;

    recipe = next;
    recipeScore = score;
    rememberHints(next);
    if (share) void toBackground({ action: "ht:recipe", recipe: next });
  }

  function adoptCardRecipe(next, share) {
    if (!next || !next.url || !next.itemId) return;
    if (!carriesId(next)) return;
    const score = Number(next.score) || 0;
    const captured = Number(next.capturedAt) || 0;
    const currentCaptured = Number(cardRecipe?.capturedAt) || 0;
    if (!(score > cardScore || (score >= cardScore && captured > currentCaptured))) return;
    cardRecipe = next;
    cardScore = score;
    rememberHints(next);
    if (share) void toBackground({ action: "ht:cardRecipe", recipe: next });
  }

  const POSTING_NUMBER_RE = /\d{6,}-\d{2,}-\d{1,3}/;
  const ROW_DATE_RE = /\d{2}\.\d{2}\.\d{4}[,\s]+\d{2}:\d{2}(?::\d{2})?/;
  const ROW_LABELS = [
    "Лог. контейнер",
    "Ячейка",
    "Местоположение",
    "Статус предмета",
    "Тайм-слот",
    "Свойство",
    "Значение"
  ];

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
    } catch {}
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

  const AUDIT_PATH = "/p-api/scms-article-gateway/v1/articles/{id}/auditV3";

  // Пустой список типов = вся история, поэтому «Перемещения» фильтруем телом запроса.
  const TRANSITION_TYPES = ["InnerWarehouse", "OnWarehouse", "InTripContainer", "InContainer", "OnCell"];
  let auditTypes = TRANSITION_TYPES.slice();
  let typesConfirmed = false;

  // Рецепт мог сняться со «Свойств»: их типы с перемещениями не пересекаются, и мы запросим чужой срез.
  function adoptAuditTypes(next) {
    if (!Array.isArray(next) || !next.length) return false;
    const clean = next.map((value) => String(value || "")).filter(Boolean);
    if (!clean.length) return false;
    if (!clean.some((code) => TRANSITION_TYPES.includes(code))) return false;
    if (clean.join("|") === auditTypes.join("|")) return false;
    auditTypes = clean;
    return true;
  }

  function typesFromBody(body) {
    if (typeof body !== "string" || !body.includes("changeType")) return null;
    try {
      const parsed = JSON.parse(body);
      const list = parsed?.filters?.changeType;
      return Array.isArray(list) && list.length ? list : null;
    } catch (_err) {
      return null;
    }
  }
  const BOXES_PATH = "/p-api/scms-article-gateway/v3/boxes/getBoxesFromTopologyAndContent";

  // Без x-o3-app-name/version сервер может не ответить; значения лежат в __FE_VARS__ страницы.
  let appVersion = "";
  let appName = "scms";
  let varsRead = false;

  function readBuildVars() {
    if (varsRead || !document.scripts) return;
    for (const script of document.scripts) {
      if (script.src) continue;
      const text = script.textContent;
      if (!text || text.length > 300000 || !text.includes("__FE_VARS__")) continue;
      const branch = text.match(/"GIT_BRANCH"\s*:\s*"([^"]+)"/);
      const service = text.match(/"O3_SERVICE_NAME"\s*:\s*"([^"]+)"/);
      if (branch && !appVersion) appVersion = branch[1];
      if (service && service[1]) appName = service[1];
      varsRead = true;
      return;
    }
  }
  let placeId = "";

  function rememberHints(source) {
    adoptAuditTypes(typesFromBody(source?.body));
    const headers = source?.headers || {};
    for (const key of Object.keys(headers)) {
      if (key.toLowerCase() === "x-o3-app-version" && headers[key]) appVersion = String(headers[key]);
    }
    if (!placeId && source?.body) {
      const match = String(source.body).match(/"placeId"\s*:\s*"?(\d{6,})"?/);
      if (match) placeId = match[1];
    }
    if (!placeId && source?.url) {
      const match = String(source.url).match(/[?&](?:warehouse|placeId|place_id)=(\d{6,})/i);
      if (match) placeId = match[1];
    }
  }

  function hintPayload() {
    return { action: "ht:hints", appVersion, placeId, apiTune, auditTypes, cardPlaceless };
  }

  function readPlaceFromLocation() {
    try {
      const value = new URLSearchParams(location.search).get("warehouse");
      if (value && /^\d{6,}$/.test(value)) placeId = value;
    } catch {}
  }

  // Сервер может не принять страницу в 500 строк, нумерацию с единицы или запрос без версии —
  // перебираем варианты на первом запросе и дальше ходим тем, что прошёл.
  const PAGE_SIZES = [500, 100, 20];
  const HEADER_SETS = ["full", "noVersion", "plain"];

  let apiTune = null;
  let apiProbeLog = [];

  function variants() {
    const out = [];
    for (const headers of HEADER_SETS) {
      const sizes = headers === "full" ? PAGE_SIZES : [20];
      for (const pageSize of sizes) {
        for (const base of [1, 0]) out.push({ pageSize, headers, base });
      }
    }
    return out;
  }

  // версию кладём в сам вариант: свежая вкладка могла не видеть ни одного запроса Hub
  function apiHeaders(tune) {
    const kind = typeof tune === "string" ? tune : tune?.headers;
    const version = (typeof tune === "object" && tune?.version) || appVersion;
    const out = {
      accept: "application/json, text/plain, */*",
      "content-type": "application/json"
    };
    if (kind === "plain") return out;
    out["x-o3-app-name"] = (typeof tune === "object" && tune?.appName) || appName;
    if (kind !== "noVersion" && version) out["x-o3-app-version"] = version;
    return out;
  }

  function auditRequest(posting, pageIndex, tune) {
    const use = tune || apiTune || { pageSize: PAGE_SIZES[0], headers: "full", base: 1 };
    return {
      url: ORIGIN + AUDIT_PATH.replace("{id}", encodeURIComponent(posting)),
      method: "POST",
      headers: apiHeaders(use),
      body: JSON.stringify({
        filters: {
          changeType: auditTypes,
          users: [],
          encryptedUsers: [],
          timeRange: { startTime: null, endTime: null }
        },
        pagination: { pageNumber: pageIndex + use.base, pageSize: use.pageSize }
      })
    };
  }

  function describe(tune) {
    return `страница ${tune.pageSize}, заголовки ${tune.headers}, нумерация с ${tune.base}`;
  }

  function snippet(response) {
    if (!response) return "нет ответа";
    if (response.error) return `сеть: ${response.error}`;
    const text = String(response.text || "").replace(/\s+/g, " ").trim();
    return `${response.status || "?"}${text ? ` · ${text.slice(0, 160)}` : ""}`;
  }

  function readAudit(response) {
    if (!response || !response.ok || !response.text) return null;
    let json;
    try {
      json = JSON.parse(response.text);
    } catch (_err) {
      return null;
    }
    if (!json || !Array.isArray(json.records)) return null;
    return json;
  }

  // успех — не просто 200, а ответ со списком
  const PROBE_ATTEMPT_MS = 4000;

  async function tuneApi(posting, budgetMs) {
    if (apiTune) return { tune: apiTune, json: null };
    readBuildVars();
    apiProbeLog = [];
    const until = Date.now() + Math.max(4000, budgetMs);

    for (const tune of variants()) {
      if (abortFlag) return null;
      const rest = until - Date.now();
      if (rest <= 500) {
        apiProbeLog.push("подбор прерван по времени");
        return null;
      }
      const response = await replay(auditRequest(posting, 0, tune), Math.min(PROBE_ATTEMPT_MS, rest));
      const json = readAudit(response);

      if (!json) {
        apiProbeLog.push(`${describe(tune)} → ${snippet(response)}`);
        // 401 не про вариант запроса, а про сессию
        if (response && (response.status === 401 || response.status === 403)) return null;
        continue;
      }
      // пустая страница при непустом итоге — нумерация не та
      if (!json.records.length && Number(json.totalCount) > 0) {
        apiProbeLog.push(`${describe(tune)} → 200, но список пуст при итоге ${json.totalCount}`);
        continue;
      }

      apiTune = { ...tune, version: appVersion || "", appName };
      apiProbeLog.push(`${describe(tune)} → подошёл`);
      void toBackground({ ...hintPayload(), probe: apiProbeLog.slice() });
      return { tune: apiTune, json, text: response.text, posting };
    }
    return null;
  }

  function boxesRequest(posting, place) {
    return {
      url: ORIGIN + BOXES_PATH,
      method: "POST",
      headers: apiHeaders(apiTune || "full"),
      body: JSON.stringify({
        placeId: Number(place ?? placeId) || 0,
        boxes: [{ boxId: String(posting), boxSource: "Lozon" }]
      })
    };
  }

  // Незнакомый код пишем как есть и доучиваем по странице.
  const CHANGE_TYPES = {
    InnerWarehouse: "Внутрискладское",
    OnWarehouse: "На склад",
    OnCell: "На ячейку",
    InContainer: "В контейнер",
    InTripContainer: "В рейс",
    TimeSlot: "Тайм-слот",
    Status: "Статус предмета",

    InCourier: "У курьера",
    InLoss: "В утере",
    InGut: "В ГУТ",
    FromGut: "Из ГУТ",
    LeftLogistics: "Вне логистики",
    SupervisorConfirmationRequest: "Запрос подтверждения",
    ArticlePickup: "Изъятие предмета",
    RemoveFromContainer: "Из контейнера",
    PutIntoContainer: "В контейнер",
    IdConvertedTo: "Смена ID",

    DestinationPlace: "Место назначения",
    SortingCenter: "Сортировочный центр",
    DeliveryVariant: "Способ доставки",
    Characteristic: "Характеристика",
    Flow: "Поток",
    USK: "УСК",
    Ovh: "ОВГ",
    IsSuspiciousC2CPosting: "Подозрительное C2C",
    SuspiciousC2CCheckingState: "Проверка C2C",
    CustomsState: "Состояние таможни"
  };

  let learnedTypes = {};

  function changeTypeLabel(code) {
    const key = String(code || "");
    return learnedTypes[key] || CHANGE_TYPES[key] || key || "—";
  }

  const AUDIT_COLUMNS = ["Тип изменения", "Дата", "Пользователь", "Изменения", "Описание"];

  // Ответ в UTC, Hub показывает московское. Без сдвига дата в отчёте разъедется со страницей.
  let hubClock = null;

  function formatEventTime(raw) {
    if (!raw) return "";
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) return String(raw);
    try {
      if (!hubClock) {
        hubClock = new Intl.DateTimeFormat("ru-RU", {
          timeZone: "Europe/Moscow",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
          hour: "2-digit",
          minute: "2-digit",
          second: "2-digit",
          hour12: false
        });
      }
      return hubClock.format(at).replace(/\s+/g, " ");
    } catch (_err) {
      return at.toISOString();
    }
  }

  function cellPath(side) {
    if (!side) return "—";
    const cells = side.nhlCell?.cells;
    if (Array.isArray(cells) && cells.length) {
      return cells.map((cell) => String(cell?.name || "—")).join(" / ");
    }
    const person = side.personCell;
    if (person) return String(person.name || person.id || "—");
    return anyText(side);
  }

  const PLACE_TYPES = { Warehouse: "Склад", Trip: "Рейс", Courier: "Курьер", Person: "Сотрудник" };

  function placeName(side) {
    if (!side) return "—";
    const name = side.name || (side.trip?.tripId ? String(side.trip.tripId) : "") || (side.id ? String(side.id) : "");
    if (!name) return "—";
    const type = PLACE_TYPES[side.type];
    return type ? `${name} · ${type}` : name;
  }

  function transition(from, to) {
    if (from === to) return from;
    return `${from} → ${to}`;
  }

  const NAME_KEYS = ["stringRepresentation", "name", "markup", "title", "value", "containerId", "id"];

  const FLAG_WORDS = {
    isReturn: ["Прямой", "Возврат"],
    suspicious: ["нет", "да"],
    isDeleted: ["нет", "да"],
    isMvd: ["нет", "да"]
  };

  const FIELD_NAMES = {
    isReturn: "направление",
    deliverySchema: "схема доставки",
    typeName: "тип",
    sysName: "система",
    code: "код",
    comment: "примечание"
  };

  function scalarText(key, value) {
    const words = FLAG_WORDS[key];
    if (words && typeof value === "boolean") return words[value ? 1 : 0];
    if (typeof value === "boolean") return value ? "да" : "нет";
    return String(value);
  }

  function anyText(value, depth) {
    const level = depth || 0;
    if (value == null) return "—";
    if (typeof value !== "object") return String(value);
    if (level > 3) return "—";

    if (Array.isArray(value)) {
      const parts = value.map((entry) => anyText(entry, level + 1)).filter((part) => part && part !== "—");
      return parts.length ? parts.join(" / ") : "—";
    }

    for (const key of NAME_KEYS) {
      const own = value[key];
      if (own == null) continue;
      if (typeof own === "object") {
        const nested = anyText(own, level + 1);
        if (nested !== "—") return nested;
        continue;
      }
      if (String(own).trim()) return String(own);
    }

    const scalars = Object.keys(value).filter((key) => value[key] != null && typeof value[key] !== "object");
    if (scalars.length === 1 && FLAG_WORDS[scalars[0]]) {
      return scalarText(scalars[0], value[scalars[0]]);
    }

    const parts = [];
    for (const key of scalars) {
      const own = scalarText(key, value[key]);
      if (own.trim()) parts.push(`${FIELD_NAMES[key] || key}: ${own}`);
      if (parts.length >= 4) break;
    }
    if (parts.length) return parts.join(", ");

    // подпись бывает уровнем глубже: {type:{value:"Forward", name:"Прямой"}}
    for (const key of Object.keys(value)) {
      const own = value[key];
      if (!own || typeof own !== "object") continue;
      const nested = anyText(own, level + 1);
      if (nested !== "—") return nested;
    }
    return "—";
  }

  function pairText(node, side) {
    if (node && typeof node === "object" && ("from" in node || "to" in node)) {
      const render = side || anyText;
      return transition(render(node.from), render(node.to));
    }
    return anyText(node);
  }

  const CHANGE_LABELS = {
    container: "Лог. контейнер",
    cell: "Ячейка",
    location: "Местоположение",
    status: "Статус предмета",
    timeSlot: "Тайм-слот",

    destinationPlace: "Место назначения",
    sortingCenter: "Сортировочный центр",
    deliveryVariant: "Способ доставки",
    characteristic: "Характеристика",
    flow: "Поток",
    usk: "УСК",
    ovh: "ОВГ",
    suspiciousFlag: "Подозрительное C2C",
    suspiciousState: "Проверка C2C",
    customState: "Состояние таможни"
  };

  const ITEM_STATES = {
    Forming: "Формируется",
    Banded: "Сформирован",
    Taken: "Прибыл в место назначения"
  };

  function itemState(value) {
    if (value == null) return "—";
    const code = String(value);
    return ITEM_STATES[code] || code;
  }

  const CHANGE_ORDER = ["container", "cell", "timeSlot", "status", "destinationPlace", "location"];

  const CHANGE_SIDES = {
    cell: cellPath,
    location: placeName,
    destinationPlace: placeName,
    sortingCenter: placeName,
    status: itemState
  };

  function changeLabel(key) {
    return CHANGE_LABELS[key] || key;
  }

  function changesText(record) {
    const state = record?.stateChanges || {};
    const parts = [];
    const done = new Set();

    const push = (key) => {
      if (done.has(key) || state[key] == null) return;
      done.add(key);
      parts.push(`${changeLabel(key)}: ${pairText(state[key], CHANGE_SIDES[key])}`);
    };

    for (const key of CHANGE_ORDER) push(key);
    for (const key of Object.keys(state)) push(key);

    if (!done.has("location") && record?.placeInfo?.name) {
      parts.push(`Местоположение: ${placeName(record.placeInfo)}`);
    }

    return parts.join("; ");
  }

  function userText(record) {
    const user = record?.userInfo;
    if (!user) return "—";
    const parts = [user.name, user.id, user.uiName].filter((value) => value && String(value).trim());
    return parts.length ? [...new Set(parts.map(String))].join(" · ") : "—";
  }

  function descriptionText(record) {
    for (const value of [record?.formattedDescription, record?.description]) {
      if (typeof value === "string" && value.trim()) return value;
      if (value && typeof value === "object") {
        const text = anyText(value);
        if (text !== "—") return text;
      }
    }
    return "—";
  }

  function auditRow(record) {
    return [
      changeTypeLabel(record?.changeType),
      formatEventTime(record?.eventTime),
      userText(record),
      changesText(record) || "—",
      descriptionText(record)
    ];
  }

  function auditCell(record) {
    const cell = record?.stateChanges?.cell;
    if (cell) {
      const moved = transition(cellPath(cell.from), cellPath(cell.to));
      if (moved && moved !== "—") return moved;
    }

    // Переезда не было, но ячейку Hub всё равно отдаёт рядом с местом операции. Форму приводим
    // к той, что понимает cellPath: общий разбор вернул бы «Warehouse» или соседнее поле.
    const sides = [];
    const cellInfo = record?.cellInfo;
    if (Array.isArray(cellInfo?.cells)) sides.push({ nhlCell: cellInfo });
    else if (Array.isArray(cellInfo?.nhlCell?.cells)) sides.push(cellInfo);
    if (cellInfo?.personCell) sides.push({ personCell: cellInfo.personCell });
    if (Array.isArray(record?.placeInfo?.nhlCell?.cells)) sides.push({ nhlCell: record.placeInfo.nhlCell });
    if (record?.placeInfo?.personCell) sides.push({ personCell: record.placeInfo.personCell });

    for (const side of sides) {
      const text = cellPath(side);
      if (text && text !== "—") return text;
    }
    return "";
  }

  // Дата — из верхней строки о складе, ячейка — из первой, где она есть: приход на склад
  // ячейку не показывает, а переезд по ячейкам — да.
  function pickCellRecord(records) {
    for (const record of records) {
      if (auditCell(record)) return record;
    }
    return null;
  }

  // ищем по всей записи, как обход страницы ищет по тексту строки: сузишь до полей места —
  // пути начнут расходиться на пограничных номерах
  function recordMatches(record, needle) {
    if (!record) return false;
    try {
      return JSON.stringify(record).toLowerCase().includes(needle);
    } catch (_err) {
      return false;
    }
  }

  // верхнее место по всем движениям: интерфейс выводил его из трёх строк отчёта и промахивался
  function placeOfRecord(record) {
    const move = record?.stateChanges?.location;
    for (const side of [move?.to, move?.from, record?.placeInfo]) {
      if (!side || typeof side !== "object") continue;
      const name = String(side.name || "").trim();
      if (!name) continue;
      return { name, warehouse: side.type === "Warehouse" };
    }
    return null;
  }

  function topPlaceFrom(records) {
    let fallback = "";
    for (const record of records || []) {
      const place = placeOfRecord(record);
      if (!place) continue;
      if (place.warehouse) return place.name;
      if (!fallback) fallback = place.name;
    }
    return fallback;
  }

  function reportFromAudit(head, hits) {
    const rows = head.slice(0, 3);
    const matched = Array.isArray(hits) ? hits : hits ? [hits] : [];
    const top = matched[0] || null;
    const withCell = pickCellRecord(matched);
    return {
      columns: AUDIT_COLUMNS.slice(),
      lastRows: rows.map(auditRow),
      codes: rows.map((record) => String(record?.changeType || "")),
      warehouseAt: top ? formatEventTime(top.eventTime) : "",
      warehouseCell: withCell ? auditCell(withCell) : "",
      lastPlace: ""
    };
  }

  // «Цена реализации» — это moneyPrice, «Цена» — fairPrice.
  function priceText(value, symbol) {
    const number = Number(value);
    if (!Number.isFinite(number)) return "";
    let text;
    try {
      text = new Intl.NumberFormat("ru-RU", {
        maximumFractionDigits: 2,
        minimumFractionDigits: 2
      }).format(number);
    } catch (_err) {
      text = number.toFixed(2);
    }
    const sign = String(symbol || "").trim();
    return sign ? `${text} ${sign}` : text;
  }

  function cardMoney(info) {
    return {
      price: priceText(info?.moneyPrice, info?.moneyCurrencySymbol),
      fairPrice: priceText(info?.fairPrice, info?.fairCurrencySymbol)
    };
  }

  // Ищем карточку по признакам, а не по пути items[0].postingInfo: положат чуть иначе —
  // и пропадут номер, статус и обе суммы.
  const CARD_KEYS = ["postingName", "stateName", "moneyPrice", "fairPrice", "postingNumber"];

  function findPostingInfo(json) {
    const queue = [{ node: json, depth: 0 }];
    let loose = null;
    while (queue.length) {
      const { node, depth } = queue.shift();
      if (!node || typeof node !== "object" || depth > 6) continue;
      if (Array.isArray(node)) {
        for (const entry of node.slice(0, 40)) queue.push({ node: entry, depth: depth + 1 });
        continue;
      }
      const own = CARD_KEYS.filter((key) => node[key] != null && node[key] !== "");
      if (own.length >= 2) return node;
      if (own.length === 1 && !loose) loose = node;
      for (const key of Object.keys(node)) queue.push({ node: node[key], depth: depth + 1 });
    }
    return loose;
  }

  function cardFrom(info) {
    if (!info) return null;
    const out = {
      number: String(info.postingName || info.postingNumber || info.name || ""),
      status: String(info.stateName || info.statusName || info.state || ""),
      ...cardMoney(info)
    };
    return out.number || out.status || out.price || out.fairPrice ? out : null;
  }

  function readCard(response) {
    if (!response?.ok || !response.text) return null;
    try {
      return cardFrom(findPostingInfo(JSON.parse(response.text)));
    } catch (_err) {
      return null;
    }
  }

  function emptyCard() {
    return { number: "", status: "", price: "", fairPrice: "" };
  }

  function cardFilled(card) {
    return Boolean(card && (card.number || card.status || card.price || card.fairPrice));
  }

  // не затираем уже добытое: у путей разные сильные стороны
  function fillCard(card, from) {
    if (!from) return card;
    for (const key of Object.keys(card)) card[key] = card[key] || from[key] || "";
    return card;
  }

  function cardComplete(card) {
    return Boolean(card.number && card.status);
  }

  // Карточка отдаётся со складом оператора или без. Удачный вариант запоминаем, но второй
  // не хороним: раньше одна неудача снимала его навсегда и весь прогон шёл без цен.
  let cardPlaceless = null;

  async function nativeCard(posting, timeoutMs) {
    if (!placeId) {
      // склад оператора Hub дописывает в адрес уже после загрузки
      readPlaceFromLocation();
      if (placeId) void toBackground(hintPayload());
    }

    const order = [];
    if (cardPlaceless === true) order.push(0);
    else if (cardPlaceless === false && placeId) order.push(null);
    if (placeId && !order.includes(null)) order.push(null);
    if (!order.includes(0)) order.push(0);

    const budget = Math.max(1500, Math.floor(timeoutMs / order.length));
    for (const place of order) {
      const card = readCard(await replay(boxesRequest(posting, place), budget));
      if (!card) continue;
      const placeless = place === 0;
      if (cardPlaceless !== placeless) {
        cardPlaceless = placeless;
        void toBackground(hintPayload());
      }
      return card;
    }
    return emptyCard();
  }

  async function collectCard(posting, deadline, firstJson) {
    const left = () => Math.max(1500, Math.min(8000, deadline - Date.now()));
    const card = emptyCard();

    fillCard(card, await nativeCard(posting, left()));
    if (!cardComplete(card) && cardRecipe) fillCard(card, await fetchCard(posting, left()));
    if (!cardFilled(card) && firstJson) fillCard(card, extractCardFrom(firstJson));
    return card;
  }

  async function nativeScan(job) {
    const posting = String(job.posting || "").trim();
    const needle = String(job.warehouse || "").toLowerCase();
    if (!posting || !needle) return { ok: false, reason: "нет данных задания" };

    const deadline = Date.now() + Math.max(4000, Number(job.timeoutMs) || 20000);
    const left = () => Math.max(2000, deadline - Date.now());

    let primed = null;
    if (!apiTune) {
      const tuned = await tuneApi(posting, Math.floor((deadline - Date.now()) * 0.6));
      if (!tuned) {
        return {
          ok: false,
          missing: true,
          reason: apiProbeLog.length ? apiProbeLog[apiProbeLog.length - 1] : "ручка не отвечает",
          probe: apiProbeLog.slice()
        };
      }
      if (tuned.json && tuned.posting === posting) primed = tuned;
    }

    let loaded = 0;
    let total = null;
    let found = false;
    let sample = "";
    let digest = "";
    const head = [];
    const hits = [];
    let foundAt = -1;
    let lastPlace = "";
    let loosePlace = "";
    let size = apiTune.pageSize;
    let retuned = false;
    // сервер не принял список типов и отдал лишнее, «Всего» тогда не про наш срез
    let trimmed = false;
    let read = 0;

    for (let page = 0; page < MAX_API_PAGES; page += 1) {
      if (abortFlag || Date.now() > deadline) return { ok: false, reason: "aborted" };

      let response;
      if (page === 0 && primed) {
        response = { ok: true, status: 200, text: primed.text };
        primed = null;
      } else {
        response = await replay(auditRequest(posting, page, { ...apiTune, pageSize: size }), left());
      }

      if (!response) return { ok: false, reason: "нет ответа" };
      if (response.status === 401 || response.status === 403) {
        // 403 приходит и когда серверу не хватило заголовка; общий вариант мог подобрать другая вкладка
        if (!retuned) {
          retuned = true;
          apiTune = null;
          const again = await tuneApi(posting, Math.floor((deadline - Date.now()) * 0.5));
          if (again) {
            primed = again.json && again.posting === posting ? again : null;
            size = apiTune.pageSize;
            page -= 1;
            continue;
          }
        }
        return { ok: false, auth: true, status: response.status, reason: `ответ ${response.status}` };
      }

      const json = readAudit(response);
      if (!json) {
        apiTune = null;
        return { ok: false, missing: true, reason: snippet(response) };
      }

      const raw = Array.isArray(json.records) ? json.records : [];
      const records = keepTransitions(raw);
      if (records.length !== raw.length) trimmed = true;
      if (page === 0) {
        digest = digestOf(response.text);
        if (Number.isFinite(json.totalCount)) total = Number(json.totalCount);
        // сервер режет страницу по своему пределу, дальше идём его шагом
        if (raw.length && raw.length < size && total != null && total > raw.length) {
          size = raw.length;
        }
      }

      for (const record of records) {
        if (head.length < 3) head.push(record);
        if (!lastPlace) {
          const place = placeOfRecord(record);
          if (place?.warehouse) lastPlace = place.name;
          else if (place && !loosePlace) loosePlace = place.name;
        }
        if (!recordMatches(record, needle)) continue;
        if (hits.length < 12) hits.push(record);
      }

      loaded += records.length;
      read += raw.length;
      if (!found && hits.length) {
        found = true;
        foundAt = page;
        sample = JSON.stringify(hits[0]).slice(0, 280);
      }

      // нашли склад — дальше не больше одной страницы: гоняться за ячейкой по всей истории
      // это минуты на каждый номер
      if (found && (pickCellRecord(hits) || page > foundAt)) break;
      // листаем по тому, что отдал сервер: страница целиком из не-перемещений не повод бросить чтение
      if (!raw.length) break;
      if (total != null && read >= total) break;
      if (total == null && raw.length < size) break;
    }

    const report = reportFromAudit(head, hits);
    report.lastPlace = lastPlace || loosePlace;
    const card = await collectCard(posting, deadline, null);
    report.number = card.number;
    report.status = card.status;
    report.price = card.price;
    report.fairPrice = card.fairPrice;

    return {
      ok: true,
      via: "api",
      found,
      expected: trimmed || total == null ? loaded : total,
      loaded,
      complete: trimmed || total == null || loaded >= total || found,
      sample,
      digest,
      report
    };
  }

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

  // Раз на 401 пробуем тот же запрос без токена: если сессия держится на cookie, протухать нечему.
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

  // свой список типов в подсмотренное тело: рецепт мог сняться со вкладки «Все»
  function forceTypes(node, depth) {
    if (!node || typeof node !== "object" || depth > 4) return false;
    let touched = false;
    for (const key of Object.keys(node)) {
      if (key === "changeType" || key === "changeTypes") {
        if (Array.isArray(node[key])) {
          node[key] = auditTypes.slice();
          touched = true;
        }
        continue;
      }
      if (node[key] && typeof node[key] === "object") {
        touched = forceTypes(node[key], depth + 1) || touched;
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
        forceTypes(parsed, 0);
        body = JSON.stringify(parsed);
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

  // самый крупный массив объектов в ответе — это и есть строки истории
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

  // дешёвый отпечаток: по нему фон замечает одинаковые ответы на разные номера
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

  function extractCardFrom(json) {
    const out = emptyCard();
    if (!json) return out;
    const info = findPostingInfo(json);
    if (info) Object.assign(out, cardMoney(info));
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
    if (!cardRecipe) return emptyCard();
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
    if (!response?.ok || !response.text) return emptyCard();
    try {
      const json = JSON.parse(response.text);
      return fillCard(cardFrom(findPostingInfo(json)) || emptyCard(), extractCardFrom(json));
    } catch (_err) {
      return emptyCard();
    }
  }

  // Запись истории узнаём по форме, а не по тому, каким путём достали. Иначе в отчёт уезжали
  // operationContextId и placeInfo.type, а «последней ячейкой» становилось слово Warehouse.
  function looksLikeAudit(rows) {
    const first = rows?.[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return false;
    return "eventTime" in first && ("changeType" in first || "stateChanges" in first);
  }

  const DATE_KEY_RE = /(date|time|дата|created|moment|stamp)/i;

  // Форма незнакомая, колонки под неё придумывать нельзя — в отчёт попадёт сырая раскладка JSON.
  // Берём только дату: она нужна для корзинки.
  function reportFromApiRows(rows, needle) {
    const flat = rows.map((row) => flattenRow(row, "", {}, 0));
    const hit = flat.find((row) => Object.values(row).join(" ").toLowerCase().includes(needle));

    let warehouseAt = "";
    if (hit) {
      for (const key of Object.keys(hit)) {
        if (DATE_KEY_RE.test(key) && String(hit[key]).trim()) {
          warehouseAt = String(hit[key]);
          break;
        }
      }
      if (!warehouseAt) warehouseAt = findDate(Object.values(hit));
    }
    return { columns: [], lastRows: [], warehouseAt, warehouseCell: "", lastPlace: "" };
  }

  // Пусто при непустом входе: либо перемещений правда нет, либо наш список типов разошёлся
  // с Hub. Различаем по памяти прогона.
  function keepTransitions(rows) {
    if (!Array.isArray(rows) || !rows.length) return rows || [];
    if (!looksLikeAudit(rows)) return rows;
    const kept = rows.filter((record) => auditTypes.includes(String(record?.changeType || "")));
    if (kept.length) {
      typesConfirmed = true;
      return kept;
    }
    return typesConfirmed ? kept : rows;
  }

  function reportFromRows(rows, needle) {
    if (!looksLikeAudit(rows)) return reportFromApiRows(rows, needle);
    const hits = rows.filter((record) => recordMatches(record, needle)).slice(0, 12);
    const report = reportFromAudit(rows.slice(0, 3), hits);
    report.lastPlace = topPlaceFrom(rows);
    return report;
  }

  let nativeOff = false;

  function withNative(result, nativeReport) {
    if (!result || result.ok) return result;
    return { ...nativeReport, ...result };
  }

  async function apiScan(job) {
    let nativeFail = null;
    if (!nativeOff) {
      const native = await nativeScan(job);
      if (native.ok || native.auth) return native;
      if (native.missing) nativeOff = true;
      nativeFail = native;
    }

    // про мёртвую ручку фон должен узнать в любом случае, иначе каждая вкладка ходит за ней заново
    const nativeReport = nativeFail
      ? {
          nativeMissing: Boolean(nativeFail.missing),
          probe: nativeFail.probe || apiProbeLog.slice()
        }
      : {};

    if (!recipe) {
      return {
        ok: false,
        reason: nativeFail?.reason || "no_recipe",
        ...nativeReport,
        // ни ручки, ни рецепта: это «пока нечем», а не провал
        notReady: true
      };
    }
    const posting = String(job.posting || "").trim();
    if (!posting) return { ok: false, reason: "no_posting" };
    const needle = String(job.warehouse || "").toLowerCase();
    if (!needle) return { ok: false, reason: "no_warehouse" };

    const deadline = Date.now() + Math.max(4000, Number(job.timeoutMs) || 20000);
    const sizeModes = [DEFAULT_PAGE_SIZE, null];
    let failure = "";

    for (const pageSize of sizeModes) {
      let loaded = 0;
      let total = null;
      let found = false;
      let sample = "";
      let pageable = true;
      let failed = false;
      let digest = "";
      let filtered = false;
      let read = 0;
      const allRows = [];
      let firstJson = null;

      for (let page = 0; page < MAX_API_PAGES && !failed; page += 1) {
        if (abortFlag || Date.now() > deadline) return withNative({ ok: false, reason: "aborted" }, nativeReport);

        const built = buildRequest(posting, page, pageSize, Math.max(2000, deadline - Date.now()));
        pageable = built.pageable;
        const response = await replayPage(built.request, built.timeoutMs);

        if (!response || !response.ok || !response.text) {
          if (!response) failure = "нет ответа";
          else if (response.error) failure = `сеть: ${response.error}`;
          else if (response.status === 401 || response.status === 403) {
            // токен в рецепте протух — нужен свежий захват, а не повтор
            return withNative(
              { ok: false, auth: true, status: response.status, reason: `ответ ${response.status}` },
              nativeReport
            );
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

        const raw = findRows(json);
        if (!raw) {
          failure = "в ответе не нашлось списка строк";
          failed = true;
          break;
        }

        const rows = keepTransitions(raw);
        if (rows.length !== raw.length) filtered = true;

        if (page === 0) {
          digest = digestOf(response.text);
          firstJson = json;
        }
        if (allRows.length < 60) allRows.push(...rows.slice(0, 60 - allRows.length));

        // пере-сериализуем: сервер может отдавать кириллицу \u-эскейпами
        const haystack = JSON.stringify(rows).toLowerCase();
        if (!found && haystack.includes(needle)) {
          found = true;
          const match = rows.find((row) => JSON.stringify(row).toLowerCase().includes(needle));
          sample = match ? JSON.stringify(match).slice(0, 280) : "";
        }

        loaded += rows.length;
        read += raw.length;
        const pageTotal = findTotal(json);
        if (pageTotal != null) total = pageTotal;

        if (found) break;
        if (!raw.length) break;
        if (total != null && read >= total) break;
        if (!pageable) break;
      }

      if (failed) continue;

      const expected = filtered || total == null ? loaded : total;
      const report = reportFromRows(allRows, needle);

      // номер, статус и суммы — из карточки: в истории их нет, а регуляркой поймаешь что угодно похожее
      const card = await collectCard(posting, deadline, firstJson);
      report.number = card.number;
      report.status = card.status;
      report.price = card.price;
      report.fairPrice = card.fairPrice;

      return {
        ok: true,
        via: "api",
        found,
        expected,
        loaded,
        complete: filtered || total == null ? true : loaded >= total || found,
        sample,
        digest,
        report
      };
    }

    return withNative({ ok: false, reason: failure || "запрос не подошёл" }, nativeReport);
  }

  // Откат, если селекторы не нашли строк. На document.body тут нельзя: в шапке Hub стоит
  // кнопка с текущим складом, и совпадение находилось на каждом номере.
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

  // Страница на CSS-модулях, у каждого класса свой хвост-хеш (ozi__data-grid__row__vhPt-),
  // и хеш меняется от сборки к сборке — держимся за стабильную часть имени.
  const HUB = {
    history: '[class*="_history_"]',
    grid: '[class*="ozi__data-grid__dataGrid__"]',
    scroller: '[class*="ozi__data-grid__scroller__"], [class*="ozi__scroller__scroller__"]',
    viewport: "[data-overlayscrollbars-viewport]",
    table: 'table[class*="ozi__data-grid__table__"], table[class*="ozi__table__table__"]',
    row: 'tr[class*="ozi__data-grid__row__"]',
    cell: 'td[class*="ozi__data-grid__cell__"]',
    headTitle: '[class*="ozi__data-grid__truncate__"]',
    counter: '[class*="table-tools__counter"]',
    heading: '[class*="_headingGroup_"]',
    headingName: '[class*="_articleName_"]',
    headingText: '[class*="_headingText_"]',
    badgeLabel: '[class*="ozi__badge__label__"]',
    changes: '[class*="_stateChanges_"]',
    changeLabel: '[class*="_left_"]',
    changeValue: '[class*="_right_"]',
    tab: '[class*="ozi__tab__tab__"], button, a, [role="tab"]',
    tabActive: '[class*="active"], [class*="Active"], [class*="selected"], [class*="Selected"], [class*="filled"]'
  };

  function historyContainer() {
    const own = document.querySelector(HUB.history);
    if (own) return own;

    const grid = document.querySelector(HUB.grid);
    if (grid) {
      let node = grid.parentElement;
      for (let hop = 0; node && hop < 4; hop += 1) {
        if (node.querySelector(HUB.counter)) return node;
        node = node.parentElement;
      }
      return grid;
    }
    return document.querySelector('[class*="data-grid"]') || null;
  }

  function fallbackHistoryText() {
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

  let cachedTable = null;

  function rowsTable() {
    if (cachedTable && cachedTable.isConnected) return cachedTable;
    cachedTable =
      document.querySelector(HUB.table) ||
      [...document.querySelectorAll("table")].find((item) => item.querySelector(`tbody tr, ${HUB.row}`)) ||
      document.querySelector("table") ||
      null;
    return cachedTable;
  }

  function bodyRows(table) {
    const own = table.querySelectorAll(HUB.row);
    if (own.length) return own;
    return table.querySelectorAll("tbody tr");
  }

  function rowNodes() {
    const table = rowsTable();
    if (table) {
      const rows = bodyRows(table);
      if (rows.length) return rows;
    }
    return document.querySelectorAll(HUB.row);
  }

  // «Всего: 1 234» — разряды через пробел или nbsp, поэтому чистим нецифры
  const TOTAL_RE = new RegExp("Всего:\\s*([0-9][0-9\\s\\u00a0\\u202f\\u2009]*)", "i");

  function readTotal(el) {
    if (!el) return null;
    const match = textOf(el).match(TOTAL_RE);
    if (!match) return null;
    const digits = match[1].replace(/[^0-9]/g, "");
    return digits ? Number(digits) : null;
  }

  function parseCounter() {
    const own = readTotal(document.querySelector(HUB.counter));
    if (own != null) return own;

    for (const node of document.querySelectorAll(
      '[class*="counter"], [class*="Counter"], [class*="total"], [class*="Total"]'
    )) {
      const value = readTotal(node);
      if (value != null) return value;
    }
    return readTotal(historyContainer());
  }

  function historyReady() {
    return Boolean(
      document.querySelector(HUB.history) ||
        document.querySelector(HUB.grid) ||
        document.querySelector(HUB.counter) ||
        document.querySelector(HUB.table) ||
        rowNodes().length
    );
  }

  // textContent склеил бы «ЯчейкаСОРТ 1 Степ / — / 05H», поэтому обходим узлы сами
  // и расставляем разделители по разметке.
  const RICH_SKIP = new Set(["script", "style", "button", "input", "textarea", "select", "svg"]);
  const RICH_BLOCK = new Set([
    "div",
    "p",
    "ul",
    "ol",
    "li",
    "dl",
    "dt",
    "dd",
    "section",
    "article",
    "table",
    "tr",
    "td",
    "th",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6"
  ]);
  // слабый разделитель не затирает сильный, иначе div внутри li подменял «; »
  const RICH_RANK = { "": 0, " ": 1, " · ": 2, "; ": 3, ": ": 4, " → ": 4 };
  const RICH_NODE_LIMIT = 4000;

  function richText(root) {
    if (!root) return "";
    const out = [];
    let sep = "";
    let budget = RICH_NODE_LIMIT;

    const emit = (raw) => {
      const value = norm(raw);
      if (!value) return;
      if (out.length) out.push(sep || " ");
      out.push(value);
      sep = "";
    };
    const mark = (value) => {
      if (!out.length) return;
      if ((RICH_RANK[value] || 0) > (RICH_RANK[sep] || 0)) sep = value;
    };

    const walk = (node) => {
      for (const child of node.childNodes) {
        if (budget-- <= 0) return;
        if (child.nodeType === 3) {
          emit(child.nodeValue);
          continue;
        }
        if (child.nodeType !== 1) continue;

        const tag = (child.tagName || "").toLowerCase();
        if (RICH_SKIP.has(tag)) {
          if (tag === "svg" && out.length && child.closest?.(HUB.changeValue)) sep = " → ";
          continue;
        }
        if (child.matches?.(HUB.changeLabel)) {
          emit(child.textContent);
          sep = ": ";
          continue;
        }
        if (tag === "li") mark("; ");
        else if (RICH_BLOCK.has(tag)) mark(" · ");
        walk(child);
      }
    };

    try {
      walk(root);
    } catch (_err) {
      return norm(root.textContent || "");
    }
    const text = norm(out.join(""));
    return text || norm(root.textContent || "");
  }

  function readItemCardExact() {
    const out = { number: "", status: "" };
    const head = document.querySelector(HUB.headingName) || document.querySelector(HUB.heading);
    if (!head) return out;

    const number = norm(head.querySelector(HUB.headingText)?.textContent || "");
    if (number) out.number = (number.match(POSTING_NUMBER_RE) || [number])[0];

    // такой же класс носят бейджи в строках истории, ищем строго в заголовке
    const status = norm(head.querySelector(HUB.badgeLabel)?.textContent || "");
    if (status && status.length <= 60) out.status = status;
    return out;
  }

  function readItemCardByGuess() {
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

    // вкладки «О предмете / Состав / История» тоже подходят под описание статуса,
    // поэтому берём ближайшее к номеру и с фоном
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

  function readItemCard() {
    const exact = readItemCardExact();
    if (exact.number && exact.status) return exact;
    const guess = readItemCardByGuess();
    return { number: exact.number || guess.number, status: exact.status || guess.status };
  }

  function tableColumns() {
    const table = rowsTable();
    const head = table?.querySelector("thead");
    if (!head) return [];
    return [...head.querySelectorAll("th, td")]
      .map((cell) => norm((cell.querySelector(HUB.headTitle) || cell).textContent))
      .filter(Boolean);
  }

  function rowCellNodes(row) {
    const own = row.querySelectorAll?.(HUB.cell);
    if (own?.length) return own;
    return row.querySelectorAll?.("td, th") || [];
  }

  function rowCells(row) {
    const cells = rowCellNodes(row);
    if (cells.length) return [...cells].map((cell) => richText(cell));
    return [richText(row)];
  }

  function rowFields(row) {
    const out = {};
    const items = row.querySelectorAll?.(`${HUB.changes} li`);
    if (!items?.length) return out;
    for (const item of items) {
      const label = norm(item.querySelector(HUB.changeLabel)?.textContent || "");
      if (!label || out[label]) continue;
      const value = item.querySelector(HUB.changeValue);
      const text = value ? richText(value) : "";
      if (text) out[label] = text;
    }
    return out;
  }

  // Запретный список, а не разрешительный: разрешительный отбросил бы незнакомый вид
  // перемещения — тот самый, подпись которого мы учим.
  function foreignWords() {
    const words = new Set();
    const mine = new Set(auditTypes);
    const collect = (table) => {
      for (const code of Object.keys(table)) {
        if (mine.has(code)) continue;
        const label = norm(table[code]).toLowerCase();
        if (label) words.add(label);
      }
    };
    collect(CHANGE_TYPES);
    collect(learnedTypes);
    for (const code of mine) words.delete(norm(changeTypeLabel(code)).toLowerCase());
    return words;
  }

  function typeColumnAt(columns) {
    const titles = columns || tableColumns();
    const at = titles.findIndex((title) => /^тип/i.test(title));
    return at >= 0 ? at : 0;
  }

  function rowTypeText(row, at) {
    const own = row.children;
    let cell = own && own[at];
    if (!cell || (cell.tagName !== "TD" && cell.tagName !== "TH")) {
      const cells = rowCellNodes(row);
      cell = cells[at] || cells[0];
    }
    return cell ? norm(cell.textContent).toLowerCase() : "";
  }

  function keepTransitionRows(rows, words, at) {
    const list = [...rows];
    if (!list.length) return list;
    const foreign = words || foreignWords();
    if (!foreign.size) return list;
    const column = at == null ? typeColumnAt() : at;
    return list.filter((row) => !foreign.has(rowTypeText(row, column)));
  }

  // дата из колонки «Дата»: в «Описании» тоже встречаются даты
  function rowDate(row, columns) {
    const titles = columns || tableColumns();
    const at = titles.findIndex((title) => /^дата/i.test(title));
    if (at >= 0) {
      const cells = rowCellNodes(row);
      const text = norm(cells[at]?.textContent || "");
      const match = text.match(ROW_DATE_RE);
      if (match) return match[0];
      if (text && text.length <= 40) return text;
    }
    return findDate(rowCells(row));
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
      // подписка на весь документ дёргает колбэк на каждый чих SPA
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
    // Плавную прокрутку отключаем: с ней scrollTop анимируется и позиция плывёт.
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

  // Контейнер прокрутки ищем от строки вверх по родителям. Угадывание по списку селекторов
  // попадало то во внешнюю обёртку, то в документ — оттуда и дёрганье.
  function findScroller() {
    const rows = rowNodes();

    if (rows.length) {
      let node = rows[rows.length - 1];
      while (node && node !== document.documentElement) {
        node = node.parentElement;
        if (scrolls(node)) return node;
      }
      return null;
    }

    // строк ещё нет: пустая таблица не прокручивается, а поиск по родителям уходил во внешнюю обёртку
    for (const selector of [
      `${HUB.grid} ${HUB.viewport}`,
      `${HUB.scroller} ${HUB.viewport}`,
      HUB.viewport,
      HUB.scroller
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

  let scrollReached = 0;

  // scrollIntoView двигает все прокручиваемые родители разом, включая окно, и вместе
  // с нашим scrollTop давал качание.
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
      // bubbles: false обязателен — всплывающий дубль будил обработчики внешних обёрток.
      scroller.dispatchEvent(new Event("scroll", { bubbles: false }));
      return true;
    }

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

  const HISTORY_LABELS = ["перемещения", "история перемещений", "история"];

  // «уже открыта» и «не нашлось» — разные ответы: спутаешь, и на открытых «Перемещениях»
  // пойдёшь дальше по списку и кликнешь «Все»
  function clickHistoryTab() {
    for (const wanted of HISTORY_LABELS) {
      const state = clickTabLabelled(wanted);
      if (state === "active") return false;
      if (state === "clicked") return true;
    }
    return false;
  }

  function clickTabLabelled(wanted) {
    for (const el of document.querySelectorAll(HUB.tab)) {
      const label = textOf(el).toLowerCase();
      if (label !== wanted && !label.startsWith(wanted)) continue;
      // активную вкладку Hub помечает на вложенном узле, а активную фишку фильтра —
      // классом filled и атрибутом disabled
      if (el.getAttribute("aria-selected") === "true") return "active";
      if (el.disabled) return "active";
      if (/active|filled/i.test(String(el.className))) return "active";
      if (el.querySelector(HUB.tabActive)) return "active";
      el.click();
      return "clicked";
    }
    return null;
  }

  async function domScan(job) {
    const needle = String(job.warehouse || "").toLowerCase();
    if (!needle) return { ok: false, status: "bad_input", found: false, expected: 0, loaded: 0 };

    const deadline = Date.now() + Math.max(8000, Number(job.timeoutMs) || 45000);
    const left = () => deadline - Date.now();
    const dead = () => abortFlag || left() <= 0;

    // seen — перемещения, seenAll — вообще все: счётчик «Всего» считает всё подряд
    const seen = new Set();
    const seenAll = new Set();
    let domTrimmed = false;
    let prevLength = 0;
    let found = false;
    let sample = "";
    let warehouseCells = null;
    let warehouseFields = null;
    let warehouseDate = "";
    let warehouseCell = "";

    let typeAt = null;
    function typeColumn() {
      if (typeAt == null) {
        const columns = tableColumns();
        if (columns.length) typeAt = typeColumnAt(columns);
      }
      return typeAt == null ? 0 : typeAt;
    }

    function harvest() {
      const rows = rowNodes();
      const keep = new Set(keepTransitionRows(rows, foreignWords(), typeColumn()));
      if (keep.size !== rows.length) domTrimmed = true;
      const length = rows.length;
      let start;
      if (length > prevLength) start = Math.max(0, prevLength - OVERLAP);
      else if (length < prevLength || length <= FULL_PASS_LIMIT) start = 0;
      else start = Math.max(0, length - 120);
      if (length < prevLength) {
        seen.clear();
        seenAll.clear();
      }

      for (let i = start; i < length; i += 1) {
        const raw = rows[i].textContent;
        if (!raw) continue;
        const value = norm(raw);
        if (!value) continue;
        const key = value.length > 320 ? value.slice(0, 320) : value;
        if (seenAll.has(key)) continue;
        seenAll.add(key);
        if (!keep.has(rows[i])) continue;
        seen.add(key);
        if (!value.toLowerCase().includes(needle)) continue;
        const fields = rowFields(rows[i]);
        if (!found) {
          found = true;
          sample = value.slice(0, 280);
          warehouseCells = rowCells(rows[i]);
          warehouseFields = fields;
          warehouseDate = rowDate(rows[i]);
        }
        if (!warehouseCell) warehouseCell = fields["Ячейка"] || findCell(rowCells(rows[i]));
      }
      prevLength = length;
      return found;
    }

    function waitRowGrowth(before, ms) {
      const table = rowsTable();
      return waitFor(() => rowNodes().length > before, ms, table || undefined);
    }

    reportPhase("history", job.posting);

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

    // Ноль в счётчике «Всего» обычно значит «данные ещё не приехали», поэтому total бывает null:
    // тогда догружаем, пока список не перестанет расти.
    let total = parseCounter();
    if (total == null) {
      // ждём счётчик, но не дольше появления строк: стоять по 10 секунд на каждом номере нельзя
      await waitFor(() => {
        total = parseCounter();
        return total != null || rowNodes().length > 0;
      }, Math.min(10000, left()));
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
      if (!hasRows()) return { ok: false, status: "no_counter", found: false, expected: 0, loaded: 0 };
    } else if (total === 0 && hasRows()) {
      // счётчик говорит «ноль», а строки на месте — значит он не про историю
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

    const needMore = () => total == null || seenAll.size < total;
    let drained = !needMore();

    if (!found && needMore()) {
      scrollReached = 0;
      let stall = 0;

      while (!dead() && !found && needMore()) {
        // ищем контейнер на каждом круге: пока строк не было, его могло не быть
        const scroller = findScroller();
        const before = rowNodes().length;
        const moved = jumpToBottom(scroller);

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
    let money = emptyCard();
    if (!dead()) {
      try {
        money = await collectCard(job.posting, deadline, null);
      } catch (_err) {
        money = emptyCard();
      }
    }
    const tableRows = keepTransitionRows(rowNodes(), foreignWords(), typeColumn());
    const report = {
      number: card.number || money.number || "",
      status: card.status || money.status || "",
      columns: tableColumns(),
      lastRows: [...tableRows].slice(0, 3).map(rowCells),
      warehouseAt: warehouseDate || (warehouseCells ? findDate(warehouseCells) : ""),
      warehouseCell:
        warehouseFields?.["Ячейка"] || warehouseCell || (warehouseCells ? findCell(warehouseCells) : ""),
      price: money.price || "",
      fairPrice: money.fairPrice || ""
    };

    const loaded = seen.size;
    const complete = found || (total != null ? seenAll.size >= total : drained);
    // Итог неизвестен: список вычитан или искомое нашлось — «всего» это сколько прочли.
    const expected = domTrimmed
      ? complete || found
        ? loaded
        : 0
      : total != null
        ? total
        : drained || found
          ? loaded
          : 0;

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

  function normalizeReport(report) {
    if (!report || typeof report !== "object") return null;
    const rows = Array.isArray(report.lastRows) ? report.lastRows.slice(0, 3) : [];
    return {
      codes: (Array.isArray(report.codes) ? report.codes : []).slice(0, 3).map((value) => String(value || "")),
      number: String(report.number || ""),
      status: String(report.status || ""),
      warehouseAt: String(report.warehouseAt || ""),
      warehouseCell: String(report.warehouseCell || ""),
      lastPlace: String(report.lastPlace || ""),
      price: String(report.price || ""),
      fairPrice: String(report.fairPrice || ""),
      columns: (Array.isArray(report.columns) ? report.columns : []).map((value) => String(value || "")),
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

    if (message.action === "ht:setLabels") {
      if (message.labels) learnedTypes = { ...learnedTypes, ...message.labels };
      sendResponse({ ok: true });
      return false;
    }

    if (message.action === "ht:setHints") {
      if (message.appVersion && !appVersion) appVersion = String(message.appVersion);
      if (message.placeId && !placeId) placeId = String(message.placeId);
      // content script поднимается заново после каждой загрузки и без этого
      // ходил бы за мёртвой ручкой снова
      if (message.nativeApi === false) nativeOff = true;
      if (message.apiTune && !apiTune) apiTune = message.apiTune;
      if (typeof message.cardPlaceless === "boolean" && cardPlaceless == null) {
        cardPlaceless = message.cardPlaceless;
      }
      if (message.labels) learnedTypes = { ...learnedTypes, ...message.labels };
      adoptAuditTypes(message.auditTypes);
      sendResponse({ ok: true });
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
            sendResponse({
              ok: false,
              reason: raw?.reason || "api_failed",
              auth: Boolean(raw?.auth),
              nativeMissing: Boolean(raw?.nativeMissing),
              notReady: Boolean(raw?.notReady),
              probe: raw?.probe || []
            });
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

  // склад оператора Hub дописывает в адрес уже после загрузки страницы
  function shareHints() {
    readBuildVars();
    readPlaceFromLocation();
    if (!appVersion && !placeId) return;
    void toBackground(hintPayload());
  }

  async function announce() {
    askProbeForRecipe();
    shareHints();
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
  setTimeout(askProbeForRecipe, 1200);
  setTimeout(askProbeForRecipe, 4000);
})();
