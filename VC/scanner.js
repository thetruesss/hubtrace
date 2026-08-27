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

  // отладочная трасса: пишем только когда прогон запущен с отладкой,
  // иначе всё это — пустые вызовы
  let dbgOn = false;
  let dbgTrace = [];
  let journalCursor = 0;

  function dbg(kind, data) {
    if (!dbgOn) return;
    try {
      dbgTrace.push({ t: Date.now(), kind, ...data });
      if (dbgTrace.length > 220) dbgTrace.shift();
    } catch {}
  }

  function dbgStart(job) {
    dbgOn = Boolean(job?.debug);
    dbgTrace = [];
    if (dbgOn) {
      try {
        window.postMessage({ channel: CHANNEL, type: "debugOn" }, ORIGIN);
      } catch {}
    }
  }

  function askJournal() {
    if (!dbgOn) return Promise.resolve([]);
    return new Promise((resolve) => {
      const ticket = `j${++ticketSeq}`;
      const timer = setTimeout(() => {
        replayWaiters.delete(ticket);
        resolve([]);
      }, 700);
      replayWaiters.set(ticket, (data) => {
        clearTimeout(timer);
        resolve(Array.isArray(data.entries) ? data.entries : []);
      });
      window.postMessage({ channel: CHANNEL, type: "askJournal", ticket, after: journalCursor }, ORIGIN);
    });
  }

  async function dbgFinish() {
    if (!dbgOn) return null;
    const hub = await askJournal();
    for (const entry of hub) {
      if (entry.id > journalCursor) journalCursor = entry.id;
      dbgTrace.push({ kind: "hub", ...entry });
    }
    return dbgTrace.slice(0, 260);
  }

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
    if (data.type === "replayResult" || data.type === "journal") {
      const waiter = replayWaiters.get(data.ticket);
      if (!waiter) return;
      replayWaiters.delete(data.ticket);
      waiter(data);
    }
  });

  // отладка включается ещё до первого задания, чтобы журнал застал
  // собственные запросы страницы при загрузке
  try {
    chrome.storage.local.get("hubTraceSettings", (data) => {
      if (data?.hubTraceSettings?.debugMode === true) {
        window.postMessage({ channel: CHANNEL, type: "debugOn" }, ORIGIN);
      }
    });
  } catch {}

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

  function beatsRecipe(next, current, currentScore) {
    const score = Number(next.score) || 0;
    if (score > currentScore) return true;
    return score >= currentScore && (Number(next.capturedAt) || 0) > (Number(current?.capturedAt) || 0);
  }

  function adoptRecipe(next, share) {
    if (!next || !next.url || !next.itemId) return;
    if (!carriesId(next)) return;
    if (!beatsRecipe(next, recipe, recipeScore)) return;

    recipe = next;
    recipeScore = Number(next.score) || 0;
    rememberHints(next);
    if (share) void toBackground({ action: "ht:recipe", recipe: next });
  }

  function adoptCardRecipe(next, share) {
    if (!next || !next.url || !next.itemId) return;
    if (!carriesId(next)) return;
    if (!beatsRecipe(next, cardRecipe, cardScore)) return;

    cardRecipe = next;
    cardScore = Number(next.score) || 0;
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

  const STAMP_RE = /(\d{2})\.(\d{2})\.(\d{4})[,\s]+(\d{2}):(\d{2})(?::(\d{2}))?/;

  let cutoffAt = 0;

  function setCutoff(raw) {
    const at = Number(raw);
    cutoffAt = Number.isFinite(at) && at > 0 ? at : 0;
  }

  function shownStamp(text) {
    const parts = String(text || "").match(STAMP_RE);
    if (!parts) return null;
    const at = new Date(
      Number(parts[3]),
      Number(parts[2]) - 1,
      Number(parts[1]),
      Number(parts[4]),
      Number(parts[5]),
      Number(parts[6] || 0)
    ).getTime();
    return Number.isFinite(at) ? at : null;
  }

  function underCutoff(stamp) {
    if (!cutoffAt) return true;
    return stamp == null || stamp <= cutoffAt;
  }

  function stampOf(value) {
    const text = String(value || "").trim();
    if (!text) return null;
    const shown = shownStamp(text);
    if (shown != null) return shown;
    const at = Date.parse(text);
    return Number.isFinite(at) ? at : null;
  }

  function recordStamp(record) {
    if (!record || typeof record !== "object") return null;
    const direct = stampOf(record.eventTime);
    if (direct != null) return direct;
    const flat = flattenRow(record, "", {}, 0);
    for (const key of Object.keys(flat)) {
      if (!DATE_KEY_RE.test(key)) continue;
      const at = stampOf(flat[key]);
      if (at != null) return at;
    }
    return null;
  }

  function recordUnderCutoff(record) {
    if (!cutoffAt) return true;
    return underCutoff(recordStamp(record));
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

  const TRANSITION_TYPES = ["InnerWarehouse", "OnWarehouse", "InTripContainer", "InContainer", "OnCell"];
  let auditTypes = TRANSITION_TYPES.slice();

  function adoptAuditTypes(next) {
    if (!Array.isArray(next) || !next.length) return false;
    const clean = next.map((value) => String(value || "")).filter(Boolean);
    if (!clean.length) return false;
    if (!clean.every((code) => TRANSITION_TYPES.includes(code))) return false;
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

  const POSTING_REJECT = new Set([400, 404, 422]);

  function rejectsPosting(response) {
    return Boolean(response) && !response.error && POSTING_REJECT.has(Number(response.status));
  }

  function looksLikeItemId(value) {
    return /^[0-9]{10,}$/.test(String(value || ""));
  }

  const REJECT_STREAK = 8;
  const ODD_ANSWER_STREAK = 3;
  const PROBE_REJECT_STREAK = 3;

  let rejectStreak = 0;
  let oddStreak = 0;
  let probeRejects = 0;
  let lastGoodPosting = "";

  function missingPosting() {
    return {
      ok: true,
      via: "api",
      status: "missing",
      found: false,
      expected: 0,
      loaded: 0,
      complete: true,
      sample: "",
      digest: "",
      report: null
    };
  }

  const PROBE_ATTEMPT_MS = 4000;

  let probeOnlyRejects = false;

  async function tuneApi(posting, budgetMs) {
    if (apiTune) return { tune: apiTune, json: null };
    readBuildVars();
    apiProbeLog = [];
    probeOnlyRejects = false;
    const until = Date.now() + Math.max(4000, budgetMs);
    let onlyRejects = true;

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
        if (response && (response.status === 401 || response.status === 403)) return null;
        if (!rejectsPosting(response)) onlyRejects = false;
        continue;
      }
      if (!json.records.length && Number(json.totalCount) > 0) {
        apiProbeLog.push(`${describe(tune)} → 200, но список пуст при итоге ${json.totalCount}`);
        onlyRejects = false;
        continue;
      }

      apiTune = { ...tune, version: appVersion || "", appName };
      apiProbeLog.push(`${describe(tune)} → подошёл`);
      void toBackground({ ...hintPayload(), probe: apiProbeLog.slice() });
      return { tune: apiTune, json, text: response.text, posting };
    }
    probeOnlyRejects = onlyRejects;
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

  let hubClock = null;

  function formatEventTime(raw) {
    if (!raw) return "";
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) return String(raw);
    try {
      if (!hubClock) {
        hubClock = new Intl.DateTimeFormat("ru-RU", {
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

  const LOGIN_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
  const LOGIN_KEYS = ["login", "userName", "username", "email", "uiName", "id", "name"];

  function loginFrom(raw) {
    const value = String(raw || "").trim();
    if (!value) return "";
    const at = value.indexOf("@");
    const head = at > 0 ? value.slice(0, at) : value;
    return LOGIN_RE.test(head) ? head : "";
  }

  function userText(record) {
    const user = record?.userInfo;
    if (!user) return "—";
    for (const key of LOGIN_KEYS) {
      const login = loginFrom(user[key]);
      if (login) return login;
    }
    const id = String(user.id || "").trim();
    return /^\d+$/.test(id) ? id : "—";
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

  function pickCellRecord(records) {
    for (const record of records) {
      if (auditCell(record)) return record;
    }
    return null;
  }

  function recordMatches(record, needle) {
    if (!record) return false;
    try {
      return JSON.stringify(record).toLowerCase().includes(needle);
    } catch (_err) {
      return false;
    }
  }

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

  // ближайшее перемещение выше среза: под срезом записей не осталось,
  // и самое раннее из того, что выше, — лучшее, что мы знаем о предмете
  function edgeAboveCutoff(rows, best) {
    if (!cutoffAt || !Array.isArray(rows)) return best || null;
    let edge = best || null;
    for (const record of rows) {
      if (!isMove(record)) continue;
      const at = recordStamp(record);
      if (at == null || at <= cutoffAt) continue;
      if (edge && edge.at <= at) continue;
      const place = placeOfRecord(record);
      if (!place) continue;
      edge = { at, name: place.name, warehouse: place.warehouse };
    }
    return edge;
  }

  // почему в ответе пусто: перемещений не было вовсе или они все выше среза
  function emptyReason(sawRow, sawMove, sawUnder) {
    if (sawRow && !sawMove) return "no_history";
    if (cutoffAt && sawMove && !sawUnder) return "later";
    return "";
  }

  function moveScanFlags(raw, kept, flags) {
    if (!Array.isArray(raw) || !raw.length) return flags;
    flags.sawRow = true;
    if (!looksLikeAudit(raw)) return flags;
    flags.sawAudit = true;
    if (raw.some(isMove)) flags.sawMove = true;
    if (kept.length) flags.sawUnder = true;
    return flags;
  }

  // вердикты «нет истории» и «позже потолка» позволены только на знакомой
  // форме ответа — по чужой судить, были ли перемещения, нельзя
  function scanStatus(found, flags) {
    if (found || !flags.sawAudit) return "";
    return emptyReason(flags.sawRow, flags.sawMove, flags.sawUnder);
  }

  function typeHisto(rows) {
    const out = {};
    for (const row of rows || []) {
      const key = String(row?.changeType || "?");
      out[key] = (out[key] || 0) + 1;
    }
    return out;
  }

  function slotHisto(rows) {
    const out = {};
    for (const row of rows || []) {
      const changes = row?.stateChanges;
      if (!changes || typeof changes !== "object") continue;
      for (const key of Object.keys(changes)) {
        if (changes[key] != null) out[key] = (out[key] || 0) + 1;
      }
    }
    return out;
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
      hits: matched.slice(0, 12).map(hitOf).filter((hit) => hit.at),
      lastPlace: ""
    };
  }

  function hitOf(record) {
    return { at: formatEventTime(record?.eventTime), cell: auditCell(record) || "" };
  }

  const CARD_KEYS = ["postingName", "stateName", "postingNumber"];

  function walkJson(json, visit) {
    const queue = [{ node: json, depth: 0 }];
    while (queue.length) {
      const { node, depth } = queue.shift();
      if (!node || typeof node !== "object" || depth > 6) continue;
      if (visit(node)) return;
      if (Array.isArray(node)) {
        for (const entry of node.slice(0, 40)) queue.push({ node: entry, depth: depth + 1 });
        continue;
      }
      for (const key of Object.keys(node)) queue.push({ node: node[key], depth: depth + 1 });
    }
  }

  function findPostingInfo(json) {
    let found = null;
    let loose = null;
    walkJson(json, (node) => {
      if (Array.isArray(node)) return false;
      const own = CARD_KEYS.filter((key) => node[key] != null && node[key] !== "");
      if (own.length >= 2) {
        found = node;
        return true;
      }
      if (own.length === 1 && !loose) loose = node;
      return false;
    });
    return found || loose;
  }

  function cardFrom(info) {
    if (!info) return null;
    const out = {
      number: String(info.postingName || info.postingNumber || info.name || ""),
      status: String(info.stateName || info.statusName || info.state || ""),
      cmn: String(info.destinationPlaceName || info.destinationPlace?.name || "")
    };
    return out.number || out.status || out.cmn ? out : null;
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
    return { number: "", status: "", cmn: "" };
  }

  // ЦМН из блока «Где находится». Ищем по имени поля, а не по виду значения:
  // не найдём — столбец останется пустым, но не соврёт чужим складом


  function cardFilled(card) {
    return Boolean(card && (card.number || card.status));
  }

  function fillCard(card, from) {
    if (!from) return card;
    for (const key of Object.keys(card)) card[key] = card[key] || from[key] || "";
    return card;
  }

  function cardComplete(card) {
    return Boolean(card.number && card.status);
  }

  let cardPlaceless = null;

  async function nativeCard(posting, timeoutMs) {
    if (!placeId) {
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
      const tuned = await tuneApi(lastGoodPosting || posting, Math.floor((deadline - Date.now()) * 0.6));
      if (!tuned) {
        const reason = apiProbeLog.length ? apiProbeLog[apiProbeLog.length - 1] : "ручка не отвечает";
        if (probeOnlyRejects && probeRejects < PROBE_REJECT_STREAK) {
          probeRejects += 1;
          return { ok: false, reason };
        }
        probeRejects = 0;
        return { ok: false, missing: true, reason, probe: apiProbeLog.slice() };
      }
      probeRejects = 0;
      if (tuned.json && tuned.posting === posting) primed = tuned;
    }

    let loaded = 0;
    let total = null;
    let found = false;
    const flags = { sawRow: false, sawMove: false, sawAudit: false, sawUnder: false };
    let sample = "";
    let digest = "";
    const head = [];
    const hits = [];
    let foundAt = -1;
    let lastPlace = "";
    let loosePlace = "";
    let edge = null;
    let stateUnder = "";
    let stateOver = "";
    let size = apiTune.pageSize;
    let retuned = false;
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
        if (!retuned) {
          retuned = true;
          apiTune = null;
          const again = await tuneApi(lastGoodPosting || posting, Math.floor((deadline - Date.now()) * 0.5));
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
        if (page === 0 && rejectsPosting(response)) {
          rejectStreak += 1;
          if (rejectStreak >= REJECT_STREAK) {
            apiTune = null;
            rejectStreak = 0;
            return { ok: false, reason: snippet(response) };
          }
          if (!looksLikeItemId(posting)) return missingPosting();
          return { ok: false, reason: snippet(response) };
        }
        if (response.ok) {
          oddStreak += 1;
          if (oddStreak >= ODD_ANSWER_STREAK) {
            apiTune = null;
            oddStreak = 0;
          }
        }
        return { ok: false, reason: snippet(response) };
      }
      rejectStreak = 0;
      oddStreak = 0;
      lastGoodPosting = posting;

      const raw = Array.isArray(json.records) ? json.records : [];
      const records = keepTransitions(raw);
      // перемещения считаем до среза: срез сужает картину, но не отменяет
      // того, что история движения у предмета вообще есть
      moveScanFlags(raw, records, flags);
      if (records.length !== raw.length) trimmed = true;
      edge = edgeAboveCutoff(raw, edge);
      if (dbgOn) {
        dbg("api-page", {
          path: "native",
          page,
          size,
          status: response.status,
          chars: (response.text || "").length,
          records: raw.length,
          kept: records.length,
          total,
          types: typeHisto(raw),
          slots: slotHisto(raw)
        });
      }

      if (cutoffAt) {
        for (const record of raw) {
          const change = record?.stateChanges?.status;
          if (!change) continue;
          if (recordUnderCutoff(record)) {
            if (!stateUnder) stateUnder = itemState(change.to);
          } else {
            stateOver = itemState(change.from);
          }
        }
      }

      if (page === 0) {
        digest = digestOf(response.text);
        if (Number.isFinite(json.totalCount)) total = Number(json.totalCount);
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

      if (found && (pickCellRecord(hits) || page > foundAt)) break;
      if (!raw.length) break;
      if (total != null && read >= total) break;
      if (total == null && raw.length < size) break;
    }

    const report = reportFromAudit(head, hits);
    // ниже среза перемещений не нашлось — берём склад из ближайшей
    // записи сверху: на момент среза предмет числился там
    const edgeWarehouse = edge?.warehouse ? edge.name : "";
    report.lastPlace = lastPlace || edgeWarehouse || loosePlace || edge?.name || "";
    const card = await collectCard(posting, deadline, null);
    if (dbgOn) {
      dbg("api-done", {
        path: "native",
        found,
        loaded,
        total,
        trimmed,
        flags: { ...flags },
        edge: edge ? { at: edge.at, name: edge.name } : null,
        lastPlace: report.lastPlace,
        card
      });
    }
    report.number = card.number;
    report.cmn = card.cmn;
    report.status = cutoffAt ? stateUnder || stateOver : card.status;

    return {
      ok: true,
      via: "api",
      found,
      status: scanStatus(found, flags),
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

  function findRows(json) {
    let best = null;
    let bestLen = -1;
    walkJson(json, (node) => {
      if (!Array.isArray(node)) return false;
      const objects = node.filter((entry) => entry && typeof entry === "object").length;
      if (node.length && objects >= node.length / 2 && node.length > bestLen) {
        best = node;
        bestLen = node.length;
      }
      return false;
    });
    return best;
  }

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

  function looksLikeAudit(rows) {
    const first = rows?.[0];
    if (!first || typeof first !== "object" || Array.isArray(first)) return false;
    return "eventTime" in first && ("changeType" in first || "stateChanges" in first);
  }

  const DATE_KEY_RE = /(date|time|дата|created|moment|stamp)/i;

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

  const MOVE_SLOTS = ["location", "container", "cell"];

  function isMove(record) {
    const changes = record?.stateChanges;
    if (changes && typeof changes === "object") {
      return MOVE_SLOTS.some((slot) => changes[slot] != null);
    }
    return auditTypes.includes(String(record?.changeType || ""));
  }

  function keepTransitions(rows) {
    if (!Array.isArray(rows) || !rows.length) return rows || [];
    if (!looksLikeAudit(rows)) return rows.filter(recordUnderCutoff);
    // считаем только перемещения: пусто здесь — это ответ «перемещений нет»,
    // а не повод взять записи об изменении свойств
    return rows.filter(isMove).filter(recordUnderCutoff);
  }

  function reportFromRows(rows, needle) {
    if (!looksLikeAudit(rows)) return reportFromApiRows(rows, needle);
    const hits = rows.filter((record) => recordMatches(record, needle)).slice(0, 12);
    const report = reportFromAudit(rows.slice(0, 3), hits);
    report.lastPlace = topPlaceFrom(rows);
    return report;
  }

  const NATIVE_RETRY_MS = 120000;
  let nativeOffAt = 0;

  function nativeOff() {
    if (!nativeOffAt) return false;
    if (Date.now() - nativeOffAt < NATIVE_RETRY_MS) return true;
    nativeOffAt = 0;
    return false;
  }

  function withNative(result, nativeReport) {
    if (!result || result.ok) return result;
    return { ...nativeReport, ...result };
  }

  async function apiScan(job) {
    setCutoff(job.cutoff);
    dbgStart(job);
    let nativeFail = null;
    if (!nativeOff()) {
      const native = await nativeScan(job);
      if (native.ok || native.auth) return native;
      if (native.missing) nativeOffAt = Date.now();
      nativeFail = native;
      dbg("api-native-fail", {
        reason: String(native.reason || "").slice(0, 300),
        missing: Boolean(native.missing)
      });
    }

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
    if (dbgOn && recipe) {
      dbg("api-recipe", {
        url: String(recipe.url || ""),
        method: String(recipe.method || ""),
        body: String(recipe.body || "").slice(0, 4000)
      });
    }

    for (const pageSize of sizeModes) {
      let loaded = 0;
      let total = null;
      let found = false;
      const flags = { sawRow: false, sawMove: false, sawAudit: false, sawUnder: false };
      let edge = null;
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
            return withNative(
              { ok: false, auth: true, status: response.status, reason: `ответ ${response.status}` },
              nativeReport
            );
          } else if (page === 0 && rejectsPosting(response)) {
            rejectStreak += 1;
            if (rejectStreak >= REJECT_STREAK) rejectStreak = 0;
            else if (!looksLikeItemId(posting)) return missingPosting();
            failure = `ответ ${response.status}`;
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
        rejectStreak = 0;

        const rows = keepTransitions(raw);
        moveScanFlags(raw, rows, flags);
        if (rows.length !== raw.length) filtered = true;
        edge = edgeAboveCutoff(raw, edge);
        if (dbgOn) {
          dbg("api-page", {
            path: "recipe",
            page,
            status: response.status,
            chars: (response.text || "").length,
            records: raw.length,
            kept: rows.length,
            total,
            audit: looksLikeAudit(raw),
            types: typeHisto(raw),
            slots: slotHisto(raw)
          });
        }

        if (page === 0) {
          digest = digestOf(response.text);
          firstJson = json;
        }
        if (allRows.length < 60) allRows.push(...rows.slice(0, 60 - allRows.length));

        const haystack = JSON.stringify(rows).toLowerCase();
        if (!found && haystack.includes(needle)) {
          found = true;
          const match = rows.find((row) => JSON.stringify(row).toLowerCase().includes(needle));
          sample = match ? JSON.stringify(match).slice(0, 280) : "";
          if (match && !allRows.includes(match)) allRows.push(match);
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
      if (!report.lastPlace && edge) report.lastPlace = edge.name;

      const card = await collectCard(posting, deadline, firstJson);
      if (dbgOn) {
        dbg("api-done", {
          path: "recipe",
          found,
          loaded,
          total,
          filtered,
          flags: { ...flags },
          edge: edge ? { at: edge.at, name: edge.name } : null,
          lastPlace: report.lastPlace,
          card
        });
      }
      report.number = card.number;
      report.cmn = card.cmn;
      report.status = cutoffAt ? "" : card.status;

      return {
        ok: true,
        via: "api",
        found,
        status: scanStatus(found, flags),
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

  // на странице ЦМН подписан прямо словом, поэтому ищем по подписи,
  // а не по классам вёрстки
  function readCmnFromPage() {
    const nodes = document.querySelectorAll("span,div,b,strong,p,a");
    for (let i = 0; i < nodes.length && i < 1200; i += 1) {
      const label = nodes[i];
      if (label.children.length || norm(label.textContent) !== "ЦМН") continue;
      const box = label.parentElement;
      if (!box) continue;
      const text = norm(box.textContent).replace(/^ЦМН\s*/, "");
      const name = text.split(/\s*ID\s+\d/)[0].trim();
      if (name && name.length <= 80) return name;
    }
    return "";
  }

  function readItemCard() {
    const exact = readItemCardExact();
    const guess = exact.number && exact.status ? exact : readItemCardByGuess();
    return {
      number: exact.number || guess.number,
      status: exact.status || guess.status,
      cmn: readCmnFromPage()
    };
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

  // то же для строк таблицы: из «Местоположение: A → B» берём тот конец,
  // который таблица показывает как склад строки
  function placeFromCells(cells) {
    let loose = "";
    for (const cell of cells || []) {
      const text = String(cell || "");
      const at = text.indexOf("Местоположение:");
      if (at < 0) continue;
      const value = text.slice(at + "Местоположение:".length).split(";")[0];
      const sides = value.split("\u2192").map((side) => side.trim()).filter(Boolean);
      for (let i = sides.length - 1; i >= 0; i -= 1) {
        const side = sides[i];
        if (!side || side === "—") continue;
        const warehouse = side.match(/^(.*?)\s*·\s*Склад$/);
        if (warehouse) return warehouse[1].trim();
        if (!loose) loose = side.replace(/\s*·\s*[^·]+$/, "").trim();
      }
    }
    return loose;
  }

  function placeAboveCutoff(rows, words, at) {
    if (!cutoffAt) return "";
    const titles = tableColumns();
    const foreign = words || foreignWords();
    const column = at == null ? typeColumnAt() : at;
    let bestAt = null;
    let name = "";
    for (const row of rows || []) {
      if (foreign.size && foreign.has(rowTypeText(row, column))) continue;
      const stamp = shownStamp(rowDate(row, titles));
      if (stamp == null || stamp <= cutoffAt) continue;
      if (bestAt != null && bestAt <= stamp) continue;
      const place = placeFromCells(rowCells(row));
      if (!place) continue;
      bestAt = stamp;
      name = place;
    }
    return name;
  }

  function keepTransitionRows(rows, words, at) {
    let list = [...rows];
    if (!list.length) return list;
    if (cutoffAt) {
      const titles = tableColumns();
      list = list.filter((row) => underCutoff(shownStamp(rowDate(row, titles))));
    }
    const foreign = words || foreignWords();
    if (!foreign.size) return list;
    const column = at == null ? typeColumnAt() : at;
    return list.filter((row) => !foreign.has(rowTypeText(row, column)));
  }

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

  const TRANSITION_LABELS = ["перемещения", "история перемещений"];
  const HISTORY_LABELS = ["история"];

  function findTabLabelled(wanted) {
    for (const el of document.querySelectorAll(HUB.tab)) {
      const label = textOf(el).toLowerCase();
      if (label === wanted || label.startsWith(wanted)) return el;
    }
    return null;
  }

  function tabIsActive(el) {
    if (el.getAttribute("aria-selected") === "true") return true;
    if (el.disabled) return true;
    if (/active|filled/i.test(String(el.className))) return true;
    return Boolean(el.querySelector(HUB.tabActive));
  }

  function currentTabParam() {
    try {
      return String(new URLSearchParams(location.search).get("tab") || "");
    } catch (_err) {
      return "";
    }
  }

  function pickTab(labels, lookOnly) {
    for (const wanted of labels) {
      const el = findTabLabelled(wanted);
      if (!el) continue;
      if (tabIsActive(el)) return "active";
      if (lookOnly) return "waiting";
      el.click();
      return "clicked";
    }
    return null;
  }

  async function cardOnlyReport(posting, deadline) {
    const page = readItemCard();
    let api = emptyCard();
    if (!abortFlag) {
      try {
        api = await collectCard(posting, deadline, null);
      } catch (_err) {
        api = emptyCard();
      }
    }
    return {
      number: page.number || api.number || "",
      cmn: page.cmn || api.cmn || "",
      status: cutoffAt ? "" : page.status || api.status || "",
      columns: [],
      lastRows: [],
      hits: []
    };
  }

  async function domScan(job) {
    const needle = String(job.warehouse || "").toLowerCase();
    if (!needle) return { ok: false, status: "bad_input", found: false, expected: 0, loaded: 0 };

    const deadline = Date.now() + Math.max(8000, Number(job.timeoutMs) || 45000);
    const left = () => deadline - Date.now();
    const dead = () => abortFlag || left() <= 0;

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
    const hitRows = new Map();

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
        const cell = fields["Ячейка"] || findCell(rowCells(rows[i]));
        if (!found) {
          found = true;
          sample = value.slice(0, 280);
          warehouseCells = rowCells(rows[i]);
          warehouseFields = fields;
          warehouseDate = rowDate(rows[i]);
        }
        if (!warehouseCell) warehouseCell = cell;
        if (hitRows.size < 12 && !hitRows.has(key)) {
          const at = rowDate(rows[i]);
          if (at) hitRows.set(key, { at, cell: cell || "" });
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

    const TAB_SWITCH_MS = 4000;
    const TAB_LOOK_MS = 800;
    const TAB_RECLICK_MS = 1200;
    let tabSettled = false;
    let clickedOwnAt = 0;
    let openedHistory = false;
    let onTransitions = false;
    let gridAt = 0;

    const ready = await waitFor(() => {
      const grid = historyReady();
      if (grid && !gridAt) gridAt = Date.now();
      if (tabSettled || !document.body) return grid;

      // после клика ждём, но недолго: страница любит перерисовать вкладки
      // и потерять наше нажатие, тогда жмём ещё раз
      const settling = clickedOwnAt && Date.now() - clickedOwnAt < TAB_RECLICK_MS;
      const own = pickTab(TRANSITION_LABELS, settling);
      if (own === "active") {
        tabSettled = true;
        onTransitions = true;
        return grid;
      }
      if (own === "clicked") {
        clickedOwnAt = Date.now();
        return false;
      }
      if (!own && !openedHistory && pickTab(HISTORY_LABELS) === "clicked") {
        openedHistory = true;
        return false;
      }
      if (!gridAt || Date.now() - gridAt < (own ? TAB_SWITCH_MS : TAB_LOOK_MS)) return false;
      tabSettled = true;
      return grid;
    }, Math.min(20000, left()));

    if (!ready) {
      if (detectAuth()) return { ok: false, status: "auth", found: false, expected: 0, loaded: 0 };
      if (detectMissing()) return { ok: false, status: "missing", found: false, expected: 0, loaded: 0 };
      if (abortFlag) return { ok: false, status: "paused", found: false, expected: 0, loaded: 0 };
      return {
        ok: false,
        status: "no_history",
        found: false,
        expected: 0,
        loaded: 0,
        via: "dom",
        report: await cardOnlyReport(job.posting, deadline)
      };
    }

    // хаб сам переписывает адрес под открытую вкладку — запоминаем,
    // чтобы следующие отправления открывались на «Перемещениях» сразу
    const tabParam = currentTabParam();

    if (dbgOn) {
      const labels = [];
      for (const el of document.querySelectorAll(HUB.tab)) {
        if (labels.length >= 12) break;
        labels.push(`${textOf(el)}${tabIsActive(el) ? " *" : ""}`);
      }
      dbg("dom-tabs", { tab: tabParam, onTransitions, labels });
    }

    // вкладку «Перемещения» открыть не вышло — значит перед нами «Все»,
    // и строить по ней отчёт нельзя: там свойства, а не перемещения.
    // Карточку предмета всё же забираем — номер, статус и ЦМН к ней не привязаны
    if (!onTransitions && pickTab(TRANSITION_LABELS, true) !== "active") {
      const offered = TRANSITION_LABELS.some((wanted) => findTabLabelled(wanted));
      dbg("dom-guard", { offered, tab: tabParam });
      return {
        // вкладки нет вовсе — это ответ хаба, повторять нечего;
        // есть, но не открылась — сбой, пусть перепроверка попробует ещё
        ok: !offered,
        status: "no_history",
        found: false,
        expected: 0,
        loaded: 0,
        via: "dom",
        tab: tabParam,
        report: await cardOnlyReport(job.posting, deadline)
      };
    }

    let total = parseCounter();
    if (total == null) {
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

    const sweep = () => {
      harvest();
      if (found || cutoffAt || !fallbackHistoryText().includes(needle)) return;
      found = true;
      sample = needle;
    };

    reportPhase("rows", job.posting);
    ensureScrollCss();
    sweep();

    const needMore = () => total == null || seenAll.size < total;
    let drained = !needMore();

    if (!found && needMore()) {
      scrollReached = 0;
      let stall = 0;

      while (!dead() && !found && needMore()) {
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

    sweep();

    const card = readItemCard();
    let api = emptyCard();
    if (!dead()) {
      try {
        api = await collectCard(job.posting, deadline, null);
      } catch (_err) {
        api = emptyCard();
      }
    }
    const words = foreignWords();
    const tableRows = keepTransitionRows(rowNodes(), words, typeColumn());
    if (dbgOn) {
      dbg("dom-done", {
        found,
        total,
        loaded: seen.size,
        rows: prevLength,
        kept: tableRows.length,
        trimmed: domTrimmed,
        tab: tabParam,
        card,
        api
      });
    }
    const report = {
      lastPlace: tableRows.length ? "" : placeAboveCutoff(rowNodes(), words, typeColumn()),
      number: card.number || api.number || "",
      cmn: card.cmn || api.cmn || "",
      status: cutoffAt ? "" : card.status || api.status || "",
      columns: tableColumns(),
      lastRows: [...tableRows].slice(0, 3).map(rowCells),
      warehouseAt: warehouseDate || (warehouseCells ? findDate(warehouseCells) : ""),
      warehouseCell:
        warehouseFields?.["Ячейка"] || warehouseCell || (warehouseCells ? findCell(warehouseCells) : ""),
      hits: [...hitRows.values()]
    };

    const loaded = seen.size;
    const complete = found || (total != null ? seenAll.size >= total : drained);
    let expected = 0;
    if (domTrimmed) expected = complete ? loaded : 0;
    else if (total != null) expected = total;
    else if (complete) expected = loaded;

    if (abortFlag && !found && !complete) {
      return { ok: false, status: "paused", found, expected, loaded, via: "dom", report, tab: tabParam };
    }

    return {
      ok: complete,
      report,
      status: complete ? (report.lastPlace && cutoffAt && !tableRows.length ? "later" : "complete") : "partial",
      via: "dom",
      found,
      expected,
      loaded,
      sample,
      tab: tabParam
    };
  }

  function normalizeReport(report) {
    if (!report || typeof report !== "object") return null;
    const rows = Array.isArray(report.lastRows) ? report.lastRows.slice(0, 3) : [];
    return {
      codes: (Array.isArray(report.codes) ? report.codes : []).slice(0, 3).map((value) => String(value || "")),
      number: String(report.number || ""),
      cmn: String(report.cmn || ""),
      status: String(report.status || ""),
      warehouseAt: String(report.warehouseAt || ""),
      warehouseCell: String(report.warehouseCell || ""),
      hits: (Array.isArray(report.hits) ? report.hits : []).slice(0, 12).map((hit) => ({
        at: String(hit?.at || ""),
        cell: String(hit?.cell || "")
      })),
      lastPlace: String(report.lastPlace || ""),
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
        status: raw.status || (raw.complete ? "complete" : "partial"),
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
      tab: String(raw.tab || ""),
      report: normalizeReport(raw.report)
    };
  }

  async function runDomJob(job) {
    abortFlag = false;
    setCutoff(job.cutoff);
    dbgStart(job);
    try {
      const raw = await domScan(job);
      const out = normalizeResult(raw);
      const trace = await dbgFinish();
      if (trace) out.debug = trace;
      return out;
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
      if (message.nativeApi === false && !nativeOffAt) nativeOffAt = Date.now();
      else if (message.nativeApi === true) nativeOffAt = 0;
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
        .then(async (raw) => {
          const trace = await dbgFinish();
          if (!raw?.ok) {
            sendResponse({
              ok: false,
              reason: raw?.reason || "api_failed",
              auth: Boolean(raw?.auth),
              nativeMissing: Boolean(raw?.nativeMissing),
              notReady: Boolean(raw?.notReady),
              probe: raw?.probe || [],
              debug: trace || undefined
            });
            return;
          }
          const result = normalizeResult(raw);
          if (trace) result.debug = trace;
          sendResponse({ ok: true, result });
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
