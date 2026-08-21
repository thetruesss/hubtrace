/* Hub Trace · интерфейс. */

const STORAGE_SETTINGS = "hubTraceSettings";
const STORAGE_FINISHED = "hubTraceFinished";

const MODE_HINTS = {
  turbo: "Максимум скорости: больше вкладок, минимум перепроверок. Для длинных списков.",
  balance: "По умолчанию. Быстрый путь плюс сверка с обходом DOM и один повтор на неполные ответы.",
  deep: "Только обход страницы, максимум терпения и повторов. Когда результат вызывает сомнения."
};

const MODE_LABELS = { turbo: "Турбо", balance: "Баланс", deep: "Глубокий" };
const MODE_THREADS = { turbo: 8, balance: 5, deep: 3 };
const STEP_INDEX = { input: 0, scan: 1, result: 2 };

const $ = (id) => document.getElementById(id);
const $$ = (selector, root) => [...(root || document).querySelectorAll(selector)];

const postingsEl = $("postings");
const warehouseEl = $("warehouse");
const inputError = $("input-error");

const screens = {
  input: $("screen-input"),
  scan: $("screen-scan"),
  result: $("screen-result")
};

const settings = {
  mode: "balance",
  threads: 5,
  focusMode: true,
  useApi: true
};

const ui = {
  jobId: null,
  byIndex: new Map(),
  hits: 0,
  misses: 0,
  issues: 0,
  total: 0,
  blips: [],
  running: false,
  paused: false,
  stopping: false,
  hasResults: false,
  currentStep: "input",
  apiState: "unknown",
  /* Ответы сервера на каждый вариант запроса — показываем, когда быстрый
     путь не завёлся: иначе непонятно, что чинить. */
  apiProbe: [],
  apiTune: null,
  apiLastReason: "",
  apiNote: "",
  elapsedMs: 0,
  elapsedAt: 0,
  rate: 0,
  etaMs: null,
  workers: [],
  lists: { hits: [], misses: [], issues: [] },
  finished: null,
  reportSaved: false,
  recentWarehouses: [],
  rates: {}
};

/* ------------------------------------------------------------------ */
/* служебное                                                           */
/* ------------------------------------------------------------------ */

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(payload) {
  return new Promise((resolve) => chrome.storage.local.set(payload, resolve));
}

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (reply) => {
        void chrome.runtime.lastError;
        resolve(reply || null);
      });
    } catch (_err) {
      resolve(null);
    }
  });
}

let keepAlivePort = null;
let keepAliveTimer = null;

function ensureKeepAlive() {
  if (!keepAlivePort) {
    try {
      keepAlivePort = chrome.runtime.connect({ name: "hub-trace-keepalive" });
      keepAlivePort.onDisconnect.addListener(() => {
        keepAlivePort = null;
      });
    } catch (_err) {
      keepAlivePort = null;
    }
  }
  if (keepAliveTimer) return;
  keepAliveTimer = window.setInterval(() => {
    if (!keepAlivePort) {
      ensureKeepAlive();
      return;
    }
    try {
      keepAlivePort.postMessage({ ping: Date.now() });
    } catch (_err) {
      keepAlivePort = null;
    }
  }, 20000);
}

function pad(value) {
  return String(value).padStart(2, "0");
}

function fmtDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const total = Math.round(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

function fmtRate(perMin) {
  if (!perMin) return "—";
  if (perMin >= 100) return `${Math.round(perMin)}/мин`;
  return `${perMin.toFixed(1)}/мин`;
}

function plural(count, forms) {
  const n = Math.abs(count) % 100;
  const tail = n % 10;
  if (n > 10 && n < 20) return forms[2];
  if (tail > 1 && tail < 5) return forms[1];
  if (tail === 1) return forms[0];
  return forms[2];
}

/* ------------------------------------------------------------------ */
/* разбор номеров                                                      */
/* ------------------------------------------------------------------ */

function parsePostings(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  /* В строке из Excel колонок несколько, и ID далеко не всегда первый:
     рядом стоят номер отправления, дата, склад. Берём ту часть, которая
     похожа на ID; не нашлось — оставляем прежнее поведение. */
  const firstId = (parts) => parts.find((part) => sheetReader.looksLikeId(part));

  const tokens = [];
  for (const line of lines) {
    if (line.includes("\t")) {
      const parts = line.split("\t").map((part) => part.trim()).filter(Boolean);
      tokens.push(firstId(parts) || parts[0] || "");
      continue;
    }
    if (/[,;]/.test(line)) {
      const parts = line.split(/[,;]+/).map((part) => part.trim()).filter(Boolean);
      const id = firstId(parts);
      if (id) tokens.push(id);
      else tokens.push(...parts);
      continue;
    }
    const parts = line.split(/\s+/);
    const id = firstId(parts);
    if (id) tokens.push(id);
    else if (parts.length > 1 && parts.every((part) => /^[A-Za-z0-9:_-]+$/.test(part))) tokens.push(...parts);
    else tokens.push(parts[0]);
  }

  const out = [];
  const seen = new Set();
  let duplicates = 0;
  for (let token of tokens) {
    const fromUrl = token.match(/stock\/item\/Lozon:([^?&#/]+)/i);
    if (fromUrl) token = decodeURIComponent(fromUrl[1]);
    token = token.replace(/^Lozon:/i, "").trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) {
      duplicates += 1;
      continue;
    }
    seen.add(key);
    out.push(token);
  }
  out.duplicates = duplicates;
  return out;
}

/* ------------------------------------------------------------------ */
/* дек управления                                                      */
/* ------------------------------------------------------------------ */

function mountDecks() {
  const template = $("tpl-deck");
  for (const mount of $$("[data-deck]")) {
    mount.innerHTML = "";
    mount.appendChild(template.content.cloneNode(true));
  }
}

function writeDecks() {
  for (const deck of $$("[data-deck]")) {
    const seg = deck.querySelector('[data-ctl="mode"]');
    if (seg) {
      const keys = Object.keys(MODE_LABELS);
      seg.style.setProperty("--seg-index", String(Math.max(0, keys.indexOf(settings.mode))));
      seg.dataset.mode = settings.mode;
      for (const btn of $$(".seg__btn", seg)) btn.classList.toggle("is-on", btn.dataset.mode === settings.mode);
    }

    const hint = deck.querySelector("[data-mode-hint]");
    if (hint) hint.textContent = MODE_HINTS[settings.mode] || "";

    const range = deck.querySelector('[data-ctl="threads"]');
    if (range) {
      range.value = String(settings.threads);
      const min = Number(range.min) || 1;
      const max = Number(range.max) || 12;
      const fill = ((settings.threads - min) / Math.max(1, max - min)) * 100;
      range.style.setProperty("--fill", `${fill}%`);
    }

    const value = deck.querySelector("[data-threads-value]");
    if (value) value.textContent = String(settings.threads);

    const api = deck.querySelector('[data-ctl="api"]');
    if (api) api.checked = settings.useApi;
    const focus = deck.querySelector('[data-ctl="focus"]');
    if (focus) focus.checked = settings.focusMode;
  }

  const badge = $("live-mode-badge");
  if (badge) badge.textContent = MODE_LABELS[settings.mode] || settings.mode;
  renderApiBadge();
  renderBrief();
}

let settingsSaveTimer = null;
/* Пока идёт наш собственный апдейт, не даём фону откатить переключатель. */
let settingsDirtyUntil = 0;

async function setSetting(patch, { pushLive = true } = {}) {
  settingsDirtyUntil = Date.now() + 900;
  Object.assign(settings, patch);
  settings.threads = Math.max(1, Math.min(12, Number(settings.threads) || 5));
  writeDecks();

  window.clearTimeout(settingsSaveTimer);
  settingsSaveTimer = window.setTimeout(async () => {
    const saved = await storageGet([STORAGE_SETTINGS]);
    await storageSet({ [STORAGE_SETTINGS]: { ...(saved[STORAGE_SETTINGS] || {}), ...settings } });
  }, 250);

  if (pushLive && ui.running) {
    const reply = await send({ action: "updateSettings", settings: { ...settings } });
    if (reply?.settings) {
      Object.assign(settings, reply.settings);
      settingsDirtyUntil = 0;
      writeDecks();
    }
  }
}

document.addEventListener("click", (event) => {
  const btn = event.target.closest(".seg__btn[data-mode]");
  if (!btn) return;
  const mode = btn.dataset.mode;
  if (mode === settings.mode) return;
  void setSetting({ mode, threads: MODE_THREADS[mode] || settings.threads });
  toast("ok", `Режим: ${MODE_LABELS[mode]}${ui.running ? " — применён на ходу" : ""}`);
});

document.addEventListener("input", (event) => {
  const target = event.target;
  if (target.matches('[data-ctl="threads"]')) {
    void setSetting({ threads: Number(target.value) });
  }
});

document.addEventListener("change", (event) => {
  const target = event.target;
  if (target.matches('[data-ctl="api"]')) void setSetting({ useApi: target.checked });
  else if (target.matches('[data-ctl="focus"]')) void setSetting({ focusMode: target.checked });
});

/* ------------------------------------------------------------------ */
/* тосты                                                               */
/* ------------------------------------------------------------------ */

function toast(kind, text) {
  const host = $("toasts");
  if (!host || !text) return;
  const node = document.createElement("div");
  node.className = `toast toast--${kind}`;
  node.textContent = text;
  host.appendChild(node);
  while (host.children.length > 4) host.firstElementChild.remove();
  window.setTimeout(() => {
    node.classList.add("is-out");
    window.setTimeout(() => node.remove(), 320);
  }, 5200);
}

/* ------------------------------------------------------------------ */
/* шаги                                                                */
/* ------------------------------------------------------------------ */

function stepAvailable(name) {
  if (name === "result") return ui.hasResults;
  return true;
}

function syncSteps() {
  const steps = document.querySelector(".steps");
  if (steps) steps.style.setProperty("--step-index", String(STEP_INDEX[ui.currentStep] ?? 0));
  for (const btn of $$(".step")) {
    const step = btn.dataset.step;
    btn.classList.toggle("is-active", step === ui.currentStep);
    btn.disabled = !stepAvailable(step);
  }
}

function setStep(name) {
  if (!stepAvailable(name)) return;
  ui.currentStep = name;
  for (const [key, el] of Object.entries(screens)) el.hidden = key !== name;
  syncSteps();
  renderFab();
}

/* ------------------------------------------------------------------ */
/* классификация                                                       */
/* ------------------------------------------------------------------ */

function classify(item) {
  if (item?.found) return "hit";
  if (item?.status === "partial") return "issue";
  if (["complete", "missing"].includes(item?.status)) return "miss";
  if (item?.ok) return "miss";
  return "issue";
}

const STATUS_LABELS = {
  complete: "нет",
  missing: "нет страницы",
  partial: "мало строк",
  auth: "нет входа",
  no_history: "нет истории",
  no_counter: "нет счётчика",
  bad_input: "нет склада",
  timeout: "таймаут",
  stopped: "стоп",
  paused: "пауза",
  tab_error: "вкладка",
  script_error: "скрипт",
  exception: "ошибка"
};

function statusLabel(item) {
  if (item?.found) return "есть";
  return STATUS_LABELS[item?.status] || item?.status || "ошибка";
}

/* ------------------------------------------------------------------ */
/* радар                                                               */
/* ------------------------------------------------------------------ */

function blipDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function randomBlipPoint(minR, maxR) {
  const angle = Math.random() * Math.PI * 2;
  const radius = minR + Math.random() * (maxR - minR);
  return { x: 0.5 + Math.cos(angle) * radius, y: 0.5 + Math.sin(angle) * radius };
}

function placeRadarBlip() {
  const dishR = 30 / 64;
  const minR = dishR * 0.4;
  const maxR = dishR * 0.86;
  const minDist = Math.max(0.048, 0.078 - ui.blips.length * 0.0007);

  for (let i = 0; i < 60; i += 1) {
    const point = randomBlipPoint(minR, maxR);
    if (ui.blips.every((other) => blipDistance(point, other) >= minDist)) return point;
  }

  let best = randomBlipPoint(minR, maxR);
  let bestGap = -1;
  for (let i = 0; i < 40; i += 1) {
    const point = randomBlipPoint(minR, maxR);
    const gap = ui.blips.reduce((min, other) => Math.min(min, blipDistance(point, other)), Infinity);
    if (gap > bestGap) {
      bestGap = gap;
      best = point;
    }
  }
  return best;
}

function addRadarBlip(kind) {
  const root = $("radar-blips");
  if (!root) return;
  if (root.children.length > 60) return;
  const point = placeRadarBlip();
  ui.blips.push(point);

  const blip = document.createElement("span");
  blip.className = `radar__blip radar__blip--${kind}`;
  blip.style.left = `${point.x * 100}%`;
  blip.style.top = `${point.y * 100}%`;
  const core = document.createElement("span");
  core.className = "radar__blip-core";
  blip.appendChild(core);
  root.appendChild(blip);

  window.setTimeout(() => {
    blip.classList.add("is-gone");
    window.setTimeout(() => {
      blip.remove();
      ui.blips = ui.blips.filter((item) => item !== point);
    }, 1800);
  }, 5000);
}

function resetRadarBlips() {
  ui.blips = [];
  const root = $("radar-blips");
  if (root) root.innerHTML = "";
}

/* ------------------------------------------------------------------ */
/* лента и вкладки                                                     */
/* ------------------------------------------------------------------ */

function renderFeed(item) {
  if (!item) return;
  const kind = classify(item);
  const li = document.createElement("li");

  const tag = document.createElement("span");
  tag.className = `tag tag--${kind}`;
  tag.textContent = statusLabel(item);

  const code = document.createElement("code");
  code.textContent = item.posting;

  const via = document.createElement("span");
  via.className = `feed__via${item.via === "api" ? " feed__via--api" : ""}`;
  via.textContent = item.via === "api" ? "api" : "dom";

  const count = document.createElement("span");
  count.className = "feed__count";
  count.textContent = `${item.loaded || 0}/${item.expected || 0}`;

  li.append(tag, code, via, count);

  const feed = $("feed");
  feed.prepend(li);
  while (feed.children.length > 120) feed.lastElementChild.remove();
  $("feed-empty").hidden = true;
}

const PHASE_LABELS = {
  idle: "ждёт",
  open: "открывает",
  history: "история",
  rows: "строки",
  api: "запрос"
};

function renderLanes() {
  const list = $("lanes");
  const empty = $("lanes-empty");
  const count = $("lanes-count");
  if (!list) return;

  count.textContent = String(ui.workers.length);
  empty.hidden = ui.workers.length > 0;
  list.innerHTML = "";

  for (const worker of ui.workers) {
    const li = document.createElement("li");
    const busy = worker.phase && worker.phase !== "idle";
    li.className = `lane${busy ? " is-busy" : ""}${worker.via === "api" ? " is-api" : worker.via === "dom" ? " is-dom" : ""}`;

    const id = document.createElement("span");
    id.className = "lane__id";
    id.textContent = String(worker.id);

    const posting = document.createElement("span");
    posting.className = "lane__posting";
    posting.textContent = worker.posting || "—";

    const phase = document.createElement("span");
    phase.className = "lane__phase";
    phase.textContent = PHASE_LABELS[worker.phase] || worker.phase || "ждёт";

    li.append(id, posting, phase);
    list.appendChild(li);
  }
}

/* ------------------------------------------------------------------ */
/* HUD проверки                                                        */
/* ------------------------------------------------------------------ */

function bump(kind, delta) {
  if (kind === "hit") ui.hits += delta;
  else if (kind === "miss") ui.misses += delta;
  else ui.issues += delta;
}

function applyItem(index, item) {
  const prev = ui.byIndex.get(index);
  if (prev) bump(classify(prev), -1);
  ui.byIndex.set(index, item);
  bump(classify(item), 1);
}

function dropItem(index) {
  const prev = ui.byIndex.get(index);
  if (!prev) return;
  bump(classify(prev), -1);
  ui.byIndex.delete(index);
}

function updateScanHud() {
  const total = ui.total;
  const processed = ui.byIndex.size;
  const pct = total ? Math.round((processed / total) * 100) : 0;

  $("progress-pct").textContent = `${pct}%`;
  $("progress-label").textContent = `${processed} из ${total}`;
  $("scan-hits").textContent = String(ui.hits);
  $("scan-misses").textContent = String(ui.misses);
  $("scan-issues").textContent = String(ui.issues);
  $("progress-hit").style.width = total ? `${(ui.hits / total) * 100}%` : "0%";
  $("progress-miss").style.width = total ? `${(ui.misses / total) * 100}%` : "0%";
  $("progress-issue").style.width = total ? `${(ui.issues / total) * 100}%` : "0%";
}

function scanMode() {
  if (ui.stopping) return "stopping";
  if (ui.paused) return "paused";
  if (ui.running) return "live";
  return "idle";
}

function renderApiBadge() {
  const badge = $("api-badge");
  if (badge) {
    const on = settings.useApi && ui.apiState === "trusted";
    badge.hidden = !on;
    badge.textContent = "быстрый путь";
  }

  /* Всплывашка живёт пять секунд, а знать состояние надо всё время. */
  let text = "";
  let tone = "";
  if (!settings.useApi) {
    text = "выключен вручную";
  } else if (ui.apiState === "trusted") {
    text = "включён — история читается запросом";
    tone = "is-on";
  } else if (ui.apiState === "blocked") {
    text = ui.apiNote || ui.apiLastReason || "отключён, работаю через DOM";
    tone = "is-off";
  } else if (ui.running) {
    text = "пробую первый запрос";
  }

  for (const el of $$("[data-api-state]")) {
    el.hidden = !text;
    el.textContent = text;
    el.classList.toggle("is-on", tone === "is-on");
    el.classList.toggle("is-off", tone === "is-off");
  }

  renderApiProbe();
}

/*
 * Что именно ответил Hub на каждый вариант запроса. Пока быстрый путь
 * работает, это лишний шум — показываем только когда он не завёлся или
 * когда пользователь сам раскрыл подробности.
 */
function renderApiProbe() {
  const box = $("api-probe");
  if (!box) return;

  const lines = ui.apiProbe || [];
  const failed = ui.apiState === "blocked" || (settings.useApi && !ui.apiTune && lines.length > 0);
  const show = lines.length > 0 && failed;

  box.hidden = !show;
  if (!show) return;

  box.innerHTML = "";
  const title = document.createElement("b");
  title.textContent = "Ответы Hub на быстрый путь";
  box.appendChild(title);

  const list = document.createElement("ul");
  for (const line of lines.slice(0, 12)) {
    const item = document.createElement("li");
    item.textContent = line;
    list.appendChild(item);
  }
  box.appendChild(list);

  const hint = document.createElement("em");
  hint.textContent = "Пришлите это разработчику — по строкам видно, что именно не принял сервер.";
  box.appendChild(hint);
}

function renderRunState() {
  const mode = scanMode();
  const screen = screens.scan;
  screen.classList.toggle("is-live", mode === "live");
  screen.classList.toggle("is-paused", mode === "paused");
  screen.classList.toggle("is-stopping", mode === "stopping");
  screen.classList.toggle("is-idle", mode === "idle");

  const radar = $("radar");
  if (radar) radar.classList.toggle("is-live", mode === "live");

  const status = $("scan-status");
  status.classList.toggle("badge--live", mode === "live");
  status.classList.toggle("badge--paused", mode === "paused");
  status.textContent =
    mode === "live" ? "идёт" : mode === "paused" ? "пауза" : mode === "stopping" ? "стоп" : "ожидание";

  const live = $("live");
  live.hidden = !ui.running && !ui.hasResults;
  live.classList.toggle("is-live", mode === "live");
  live.classList.toggle("is-paused", mode === "paused");
  live.classList.toggle("is-stopping", mode === "stopping");
  $("live-state").textContent =
    mode === "live" ? "проверяю" : mode === "paused" ? "на паузе" : mode === "stopping" ? "останавливаю" : "готово";

  const pause = $("btn-pause");
  pause.disabled = !ui.running || ui.stopping;
  pause.classList.toggle("btn--wait", ui.paused);
  pause.querySelector("[data-pause-label]").textContent = ui.paused ? "Продолжить" : "Пауза";
  $("btn-stop").disabled = !ui.running;

  const empty = $("feed-empty");
  const hasItems = $("feed").children.length > 0;
  empty.hidden = hasItems;
  if (!hasItems) {
    empty.textContent =
      mode === "live"
        ? "Жду первые результаты…"
        : mode === "paused"
          ? "Пауза. Очередь ждёт."
          : mode === "stopping"
            ? "Останавливаю проверку…"
            : "Сейчас ничего не проверяется";
  }

  if (mode === "idle" && !ui.running) {
    $("scan-current").textContent = hasItems ? "Проверка не идёт" : "Сейчас ничего не проверяется";
  } else if (mode === "paused") {
    $("scan-current").textContent = "Пауза — текущие вкладки дорабатывают";
  }

  updateFormState();
  renderApiBadge();
}

function tickLive() {
  if (!ui.running) return;
  const drift = ui.paused ? 0 : Date.now() - ui.elapsedAt;
  const elapsed = ui.elapsedMs + drift;
  $("live-elapsed").textContent = fmtDuration(elapsed);

  const processed = ui.byIndex.size;
  const rate = elapsed > 1500 && processed ? (processed / elapsed) * 60000 : 0;
  $("live-rate").textContent = fmtRate(rate);

  const left = ui.total - processed;
  $("live-eta").textContent = ui.paused ? "пауза" : rate && left > 0 ? fmtDuration((left / rate) * 60000) : left <= 0 ? "0:00" : "—";
}

window.setInterval(tickLive, 500);

function resetScanHud(total) {
  ui.byIndex = new Map();
  ui.hits = 0;
  ui.misses = 0;
  ui.issues = 0;
  ui.total = total;
  ui.workers = [];
  ui.elapsedMs = 0;
  ui.elapsedAt = Date.now();
  resetRadarBlips();
  $("feed").innerHTML = "";
  $("scan-current").textContent = "Открываю историю…";
  renderLanes();
  updateScanHud();
  renderRunState();
}

/* ------------------------------------------------------------------ */
/* форма ввода                                                         */
/* ------------------------------------------------------------------ */

function renderBrief() {
  const list = $("brief");
  if (!list) return;
  const count = parsePostings(postingsEl.value).length;
  const rate = Number(ui.rates[settings.mode]) || 0;

  const rows = [
    ["", `<b>${count}</b> ${plural(count, ["номер", "номера", "номеров"])} в очереди`],
    ["", `<b>${settings.threads}</b> ${plural(settings.threads, ["вкладка", "вкладки", "вкладок"])} сразу`],
    ["", `Режим <b>${MODE_LABELS[settings.mode]}</b>`]
  ];
  if (count && rate) rows.push(["", `Примерно <b>${fmtDuration((count / rate) * 60000)}</b> по прошлым запускам`]);
  rows.push([
    "is-hint",
    "<kbd>Ctrl</kbd><kbd>↵</kbd><i>старт</i><kbd>Space</kbd><i>пауза</i><kbd>Esc</kbd><i>стоп</i>"
  ]);

  list.innerHTML = "";
  for (const [cls, html] of rows) {
    const li = document.createElement("li");
    if (cls) li.className = cls;
    const text = document.createElement("span");
    text.innerHTML = html;
    li.appendChild(text);
    list.appendChild(li);
  }
}

function updateCount() {
  const parsed = parsePostings(postingsEl.value);
  $("count-badge").textContent = String(parsed.length);
  const stats = $("input-stats");
  if (!parsed.length) stats.textContent = "Пока пусто";
  else if (parsed.duplicates) stats.textContent = `${parsed.length} уникальных · ${parsed.duplicates} дублей убрано`;
  else stats.textContent = `${parsed.length} уникальных номеров`;
  renderBrief();
  updateFormState();
}

function updateFormState() {
  const hasPostings = parsePostings(postingsEl.value).length > 0;
  const hasWarehouse = warehouseEl.value.trim().length > 0;
  $("btn-start").disabled = ui.running || !(hasPostings && hasWarehouse);
  $("btn-clear").disabled = !postingsEl.value.trim();

  for (const name of ["hits", "misses", "issues"]) {
    const filled = $(name).value.trim().length > 0;
    const button = document.querySelector(`[data-copy="${name}"]`);
    if (button) button.disabled = !filled;
    const col = document.querySelector(`.result-col[data-col="${name}"]`);
    if (col) col.classList.toggle("is-empty", !filled);
  }
  $("btn-copy").disabled = !$("hits").value.trim();
  renderFab();
}

/*
 * Кнопка выгрузки живёт в правом нижнем углу и пульсирует, пока отчёт не
 * скачали: после долгого прогона это единственное, что осталось сделать.
 */
function renderFab() {
  const fab = $("btn-xlsx");
  if (!fab) return;
  const ready = Boolean(ui.finished) && ui.currentStep === "result";
  fab.hidden = !ready;
  fab.classList.toggle("is-waiting", ready && !ui.reportSaved);
  fab.classList.toggle("is-done", ready && ui.reportSaved);

  const note = $("fab-note");
  if (!note) return;
  if (ui.reportSaved) {
    note.textContent = "Скачано · нажмите ещё раз";
    return;
  }
  const rows = (ui.finished?.results || []).filter(Boolean).length;
  const details = (ui.finished?.results || []).filter((item) => item?.report?.lastRows?.length).length;
  note.textContent = details ? `${rows} строк · детали по ${details}` : `${rows} строк`;
}

function showError(message) {
  inputError.hidden = !message;
  inputError.textContent = message || "";
}

/* ------------------------------------------------------------------ */
/* результат                                                           */
/* ------------------------------------------------------------------ */

function splitResults(results) {
  const hits = [];
  const misses = [];
  const issues = [];
  for (const item of results) {
    if (!item) continue;
    const kind = classify(item);
    if (kind === "hit") hits.push(item.posting);
    else if (kind === "miss") misses.push(item.posting);
    else issues.push(`${item.posting}\t${statusLabel(item)}\t${item.loaded || 0}/${item.expected || 0}`);
  }
  return { hits, misses, issues };
}

function renderList(name) {
  const filterEl = document.querySelector(`[data-filter="${name}"]`);
  const needle = (filterEl?.value || "").trim().toLowerCase();
  const rows = ui.lists[name] || [];
  const shown = needle ? rows.filter((row) => row.toLowerCase().includes(needle)) : rows;
  $(name).value = shown.join("\n");
  const counts = { hits: "hit-count", misses: "miss-count", issues: "issue-count" };
  $(counts[name]).textContent = needle ? `${shown.length}/${rows.length}` : String(rows.length);
  updateFormState();
}

function renderResults(payload) {
  const results = (payload?.results || []).filter(Boolean);
  ui.finished = payload || null;
  ui.reportSaved = false;
  ui.lists = splitResults(results);

  const inputCount = payload?.inputCount || results.length;
  const hits = ui.lists.hits.length;
  $("result-title").textContent = `Было ${inputCount}, нашлось ${hits}`;
  $("result-sub").textContent = payload?.error
    ? payload.error
    : payload?.warehouse
      ? `Склад ${payload.warehouse} есть в истории этих номеров.`
      : "Номера, у которых этот склад есть в истории.";

  const meta = $("result-meta");
  meta.innerHTML = "";
  const chips = [];
  if (payload?.durationMs) chips.push(["Время", fmtDuration(payload.durationMs)]);
  if (payload?.durationMs && results.length) {
    chips.push(["Скорость", fmtRate((results.length / payload.durationMs) * 60000)]);
  }
  if (payload?.mode) chips.push(["Режим", MODE_LABELS[payload.mode] || payload.mode]);
  const apiCount = results.filter((item) => item?.via === "api").length;
  if (apiCount) chips.push(["Быстрым путём", `${apiCount} из ${results.length}`]);
  if (payload?.stopped) chips.push(["Статус", "остановлено"]);
  for (const [label, value] of chips) {
    const chip = document.createElement("span");
    chip.className = "chip";
    chip.append(document.createTextNode(`${label} `));
    const bold = document.createElement("b");
    bold.textContent = value;
    chip.appendChild(bold);
    meta.appendChild(chip);
  }

  for (const name of ["hits", "misses", "issues"]) {
    const filterEl = document.querySelector(`[data-filter="${name}"]`);
    if (filterEl) filterEl.value = "";
    renderList(name);
  }

  buildDetailIndex(results);
  resetDetailFilters();
  fillFilterOptions();
  setResultView("list");
  renderDetail();

  /* Плашка сверху после финиша должна показывать итог, а не последний
     тик живого таймера. */
  const duration = Number(payload?.durationMs) || 0;
  $("live-elapsed").textContent = duration ? fmtDuration(duration) : "—";
  $("live-rate").textContent = fmtRate(duration && results.length ? (results.length / duration) * 60000 : 0);
  $("live-eta").textContent = payload?.stopped ? "остановлено" : "—";

  ui.hasResults = true;
  updateFormState();
  setStep("result");

  if (duration > 4000 && results.length >= 5 && payload?.mode && !payload?.stopped) {
    const measured = (results.length / duration) * 60000;
    ui.rates = { ...ui.rates, [payload.mode]: measured };
    void storageGet([STORAGE_SETTINGS]).then((saved) =>
      storageSet({ [STORAGE_SETTINGS]: { ...(saved[STORAGE_SETTINGS] || {}), rates: ui.rates } })
    );
  }
}

const REPORT_SHEET = "Отчёт";
const DETAIL_SHEET = "Последние операции";

const REPORT_COLUMNS = [
  { title: "Номер отправления", width: 22 },
  { title: "ID отправления", width: 22 },
  { title: "Результат", width: 12 },
  { title: "Статус", width: 26 },
  { title: "Полнота проверки", width: 18 },
  { title: "Корзинка", width: 12 },
  /* Путь ячейки Hub пишет через «/», а переезд — через «→»: строка длинная. */
  { title: "Последняя ячейка", width: 52 },
  { title: "Подробнее", width: 14 }
];

/* Дата в Hub приходит как «15.08.2026, 09:18:58»; с быстрого пути может
   прилететь ISO — принимаем оба. */
function parseHubDate(raw) {
  const text = String(raw || "").trim();
  if (!text) return null;
  const match = text.match(/(\d{2})\.(\d{2})\.(\d{4})[,\s]+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (match) {
    return new Date(
      Number(match[3]), Number(match[2]) - 1, Number(match[1]),
      Number(match[4]), Number(match[5]), Number(match[6] || 0)
    );
  }
  const stamp = Date.parse(text);
  return Number.isFinite(stamp) ? new Date(stamp) : null;
}

const BUCKETS = [
  { upTo: 4, label: "0–4 ч" },
  { upTo: 12, label: "4–12 ч" },
  { upTo: 24, label: "12–24 ч" },
  { upTo: 48, label: "24–48 ч" }
];

/* Порядок корзинок для сортировки в фильтре. */
const BUCKET_ORDER = [...BUCKETS.map((bucket) => bucket.label), "48 ч+"];

/* Возраст верхней строки с искомым складом. */
function bucketOf(raw, now) {
  const date = parseHubDate(raw);
  if (!date) return "";
  const hours = (now - date.getTime()) / 3600000;
  if (hours < 0) return BUCKETS[0].label;
  for (const bucket of BUCKETS) if (hours < bucket.upTo) return bucket.label;
  return "48 ч+";
}

function hubUrl(posting) {
  const clean = String(posting || "").trim().replace(/^Lozon:/i, "");
  return `https://hub.o3t.ru/management/stock/item/Lozon:${encodeURIComponent(clean)}?&tab=history`;
}

/* Технический статус проверки, не тот, что на странице Hub. */
const CHECK_STATUS = {
  complete: "проверено",
  partial: "мало строк",
  missing: "нет страницы",
  auth: "нет входа",
  no_history: "нет истории",
  no_counter: "нет счётчика",
  bad_input: "не указан склад",
  timeout: "таймаут",
  stopped: "остановлено",
  paused: "пауза",
  tab_error: "ошибка вкладки",
  script_error: "ошибка скрипта",
  exception: "ошибка"
};

/*
 * Кнопки внутри xlsx не бывает: макросы требуют .xlsm, а Excel блокирует их
 * по умолчанию. Тот же переход одним кликом даёт внутренняя гиперссылка —
 * «смотреть» прыгает на второй лист к блоку этого отправления, а оттуда
 * ссылка возвращает обратно в ту же строку отчёта.
 */
function buildXlsx() {
  const results = (ui.finished?.results || []).filter(Boolean);
  const now = Date.now();

  const detailRows = [];
  const anchors = new Map();

  results.forEach((item, index) => {
    const report = item.report;
    if (!report?.lastRows?.length) return;

    const reportRow = index + 2;
    anchors.set(index, `'${DETAIL_SHEET}'!A${detailRows.length + 1}`);

    /* Номер отправления и ID — в разные ячейки, как в самом отчёте:
       склеенные в одну строку, они не ищутся и не сортируются. */
    detailRows.push([
      { text: report.number || "", style: xlsxStyles.STYLE_TITLE },
      /* Стиль не задаём: ячейка со ссылкой сама получает вид ссылки. */
      { text: item.posting, link: hubUrl(item.posting) },
      { text: "← к отчёту", anchor: `'${REPORT_SHEET}'!A${reportRow}`, style: xlsxStyles.STYLE_BACK }
    ]);

    const columns = report.columns?.length
      ? report.columns
      : Array.from({ length: report.lastRows[0].length }, (_, i) => `Колонка ${i + 1}`);
    detailRows.push(columns.map((title2) => ({ text: title2, style: xlsxStyles.STYLE_HEAD })));

    for (const row of report.lastRows) detailRows.push(row.map((value) => ({ text: value })));
    detailRows.push([]);
  });

  const reportRows = [REPORT_COLUMNS.map((col) => ({ text: col.title, style: xlsxStyles.STYLE_HEAD }))];
  results.forEach((item, index) => {
    const report = item.report || {};
    const anchor = anchors.get(index);
    reportRows.push([
      { text: report.number || "" },
      { text: item.posting, link: hubUrl(item.posting) },
      { text: item.found ? "есть" : "нет" },
      { text: report.status || "" },
      { text: CHECK_STATUS[item.status] || item.status || "" },
      { text: bucketOf(report.warehouseAt, now) },
      { text: report.warehouseCell || "" },
      anchor ? { text: "смотреть →", anchor, style: xlsxStyles.STYLE_JUMP } : { text: "" }
    ]);
  });

  /* Колонки листа деталей идут в порядке таблицы Hub: тип изменения, дата,
     пользователь, изменения (самая длинная), описание. */
  const detailWidths = [
    { width: 24 }, { width: 22 }, { width: 30 }, { width: 72 },
    { width: 40 }, { width: 40 }, { width: 40 }, { width: 40 }
  ];

  return buildXlsxBlob({
    sheets: [
      {
        name: REPORT_SHEET,
        columns: REPORT_COLUMNS,
        rows: reportRows,
        headRow: 0,
        freeze: 1,
        autoFilter: true
      },
      {
        name: DETAIL_SHEET,
        columns: detailWidths,
        rows: detailRows,
        headRow: -1,
        freeze: 0,
        autoFilter: false
      }
    ]
  });
}

function saveBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function exportName(extension) {
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `hub-trace-${stamp}.${extension}`;
}

/* ------------------------------------------------------------------ */
/* запуск / пауза / стоп                                               */
/* ------------------------------------------------------------------ */

async function rememberWarehouse(value) {
  const clean = String(value || "").trim();
  if (!clean) return;
  ui.recentWarehouses = [clean, ...ui.recentWarehouses.filter((item) => item !== clean)].slice(0, 8);
  renderRecentWarehouses();
  const saved = await storageGet([STORAGE_SETTINGS]);
  await storageSet({
    [STORAGE_SETTINGS]: { ...(saved[STORAGE_SETTINGS] || {}), recentWarehouses: ui.recentWarehouses }
  });
}

function renderRecentWarehouses() {
  const list = $("warehouse-recent");
  if (!list) return;
  list.innerHTML = "";
  for (const value of ui.recentWarehouses) {
    const option = document.createElement("option");
    option.value = value;
    list.appendChild(option);
  }
}

async function startScan() {
  const postings = parsePostings(postingsEl.value);
  const warehouse = warehouseEl.value.trim();
  showError("");
  if (!postings.length || !warehouse) {
    updateFormState();
    return;
  }

  ui.jobId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  ui.running = true;
  ui.paused = false;
  ui.stopping = false;
  ui.hasResults = false;
  ui.finished = null;
  ui.reportSaved = false;
  ui.apiState = "unknown";
  ui.apiNote = "";

  const saved = await storageGet([STORAGE_SETTINGS]);
  await storageSet({
    [STORAGE_SETTINGS]: {
      ...(saved[STORAGE_SETTINGS] || {}),
      ...settings,
      warehouse,
      lastPostings: postingsEl.value
    }
  });
  void rememberWarehouse(warehouse);

  ensureKeepAlive();
  resetScanHud(postings.length);
  setStep("scan");

  const reply = await send({
    action: "startScan",
    jobId: ui.jobId,
    postings: [...postings],
    warehouse,
    lastPostings: postingsEl.value,
    settings: { ...settings }
  });

  if (!reply) {
    ui.running = false;
    renderRunState();
    setStep("input");
    showError("Фон не отвечает. Перезагрузите расширение на chrome://extensions.");
    return;
  }
  if (reply.ok === false) {
    ui.running = false;
    renderRunState();
    setStep("input");
    showError(reply.error || "Не получилось запустить.");
  }
}

function togglePause() {
  if (!ui.running || ui.stopping) return;
  const next = !ui.paused;
  ui.paused = next;
  renderRunState();
  void send({ action: "pauseScan", paused: next });
  toast("ok", next ? "Пауза: очередь придержана" : "Продолжаю проверку");
}

function requestStop() {
  if (!ui.running || ui.stopping) return;
  ui.stopping = true;
  ui.paused = false;
  renderRunState();
  $("scan-current").textContent = "Останавливаю…";
  void send({ action: "stopScan" });
}

/* ------------------------------------------------------------------ */
/* события                                                             */
/* ------------------------------------------------------------------ */

postingsEl.addEventListener("input", updateCount);
warehouseEl.addEventListener("input", updateFormState);
warehouseEl.addEventListener("change", () => void rememberWarehouse(warehouseEl.value));

$("btn-clear").addEventListener("click", () => {
  postingsEl.value = "";
  updateCount();
});

$("btn-paste").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    postingsEl.value = postingsEl.value.trim() ? `${postingsEl.value.trim()}\n${text}` : text;
    updateCount();
  } catch (_err) {
    showError("Нет доступа к буферу обмена.");
  }
});

$("btn-file").addEventListener("click", () => $("file-input").click());
$("file-input").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) void readFile(file);
  event.target.value = "";
});

function appendToField(text) {
  const current = postingsEl.value.trim();
  postingsEl.value = current ? `${current}\n${text}` : text;
  updateCount();
}

/*
 * Из файла берём только ID: и в .xlsx, и в выгрузке CSV нужный столбец
 * стоит где угодно, а рядом с ним — номера отправлений, даты, склады.
 * Раньше всё это целиком уезжало в поле вместе со знаками табуляции.
 */
async function readFile(file) {
  let result;
  try {
    result = await sheetReader.readIdsFromFile(file);
  } catch (_err) {
    showError("Не получилось прочитать файл.");
    return;
  }

  if (result.error) {
    showError(result.error);
    return;
  }

  if (result.ids.length) {
    appendToField(result.ids.join("\n"));
    toast("ok", `${file.name}: ${result.ids.length} ${plural(result.ids.length, ["ID", "ID", "ID"])}`);
    return;
  }

  /* ID по признаку не нашлись. Для .xlsx подсказать больше нечего, а
     текстовый файл отдаём как есть — вдруг там список в другом виде. */
  if (result.kind === "xlsx") {
    showError(`В ${file.name} не нашлось ни одного ID (от 10 цифр, в конце 000).`);
    return;
  }
  if (!result.text.trim()) {
    showError(`Файл ${file.name} пустой.`);
    return;
  }
  appendToField(result.text.trim());
  toast("warn", `В ${file.name} не видно ID — вставил текст как есть`);
}

const drop = $("drop");
["dragenter", "dragover"].forEach((type) =>
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    drop.classList.add("is-over");
  })
);
["dragleave", "drop"].forEach((type) =>
  drop.addEventListener(type, (event) => {
    event.preventDefault();
    if (type === "dragleave" && drop.contains(event.relatedTarget)) return;
    drop.classList.remove("is-over");
  })
);
drop.addEventListener("drop", (event) => {
  const file = event.dataTransfer?.files?.[0];
  if (file) void readFile(file);
});

$("btn-start").addEventListener("click", () => void startScan());
$("btn-pause").addEventListener("click", togglePause);
$("btn-stop").addEventListener("click", requestStop);
$("btn-again").addEventListener("click", () => {
  setStep("input");
  updateFormState();
});
$("btn-feed-clear").addEventListener("click", () => {
  $("feed").innerHTML = "";
  renderRunState();
});

for (const btn of $$(".step")) {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    setStep(btn.dataset.step);
  });
}

for (const filter of $$("[data-filter]")) {
  filter.addEventListener("input", () => renderList(filter.dataset.filter));
}

function flashCopied(button) {
  button.classList.add("is-copied");
  window.clearTimeout(button._copyTimer);
  button._copyTimer = window.setTimeout(() => button.classList.remove("is-copied"), 1400);
}

async function copyField(name, button) {
  const raw = $(name).value.trim();
  if (!raw) return;
  const text =
    name === "issues"
      ? raw
          .split(/\r?\n/)
          .map((line) => line.split("\t")[0].trim())
          .filter(Boolean)
          .join("\n")
      : raw;
  if (!text) return;
  await navigator.clipboard.writeText(text);
  flashCopied(button);
}

for (const button of $$("[data-copy]")) {
  button.addEventListener("click", (event) => void copyField(button.dataset.copy, event.currentTarget));
}
$("btn-copy").addEventListener("click", (event) => void copyField("hits", event.currentTarget));

$("btn-xlsx").addEventListener("click", () => {
  if (!ui.finished) return;
  try {
    saveBlob(buildXlsx(), exportName("xlsx"));
    ui.reportSaved = true;
    renderFab();
  } catch (error) {
    toast("error", `Не получилось собрать файл: ${String(error?.message || error)}`);
  }
});

document.addEventListener("keydown", (event) => {
  const inField = /^(INPUT|TEXTAREA)$/.test(event.target?.tagName || "");

  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (!$("btn-start").disabled) void startScan();
    return;
  }
  if (event.code === "Space" && !inField && ui.running) {
    event.preventDefault();
    togglePause();
    return;
  }
  if (event.key === "Escape" && ui.running) {
    event.preventDefault();
    requestStop();
  }
});

/* ------------------------------------------------------------------ */
/* сообщения от фона                                                   */
/* ------------------------------------------------------------------ */

function absorbState(next) {
  if (!next) return;
  ui.running = Boolean(next.running);
  ui.paused = Boolean(next.paused);
  ui.stopping = Boolean(next.stopping);
  ui.apiState = next.apiState || "unknown";
  ui.apiNote = next.apiNote || "";
  ui.apiProbe = Array.isArray(next.apiProbe) ? next.apiProbe : [];
  ui.apiTune = next.apiTune || null;
  ui.apiLastReason = next.apiLastReason || "";
  ui.workers = Array.isArray(next.workers) ? next.workers : [];
  ui.elapsedMs = Number(next.elapsedMs) || 0;
  ui.elapsedAt = Date.now();
  if (next.total) ui.total = next.total;

  const changed =
    settings.mode !== next.mode ||
    settings.threads !== next.threads ||
    settings.focusMode !== next.focusMode ||
    settings.useApi !== next.useApi;

  if (changed && next.mode && Date.now() > settingsDirtyUntil) {
    Object.assign(settings, {
      mode: next.mode,
      threads: next.threads,
      focusMode: next.focusMode,
      useApi: next.useApi
    });
    writeDecks();
  }

  renderLanes();
  renderRunState();
  updateScanHud();
  tickLive();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === "scanProgress") {
    if (message.total) ui.total = message.total;
    if (message.item && typeof message.index === "number" && message.index >= 0) {
      applyItem(message.index, message.item);
      renderFeed(message.item);
      if (ui.running && !ui.stopping) addRadarBlip(classify(message.item));
      $("scan-current").textContent = `${message.item.posting} · ${statusLabel(message.item)}`;
      ui.hasResults = true;
      syncSteps();
    }
    updateScanHud();
    return;
  }

  if (message?.action === "scanState") {
    absorbState(message.state);
    return;
  }

  if (message?.action === "scanNotice") {
    toast(message.level === "error" ? "error" : message.level === "api" ? "api" : "ok", message.text);
    if (message.level === "api") {
      ui.apiNote = message.text;
      renderApiBadge();
    }
    return;
  }

  if (message?.action === "scanRevalidate") {
    for (const index of message.indexes || []) dropItem(index);
    updateScanHud();
    toast("api", `Переснимаю ${message.indexes?.length || 0} номер(ов) обходом страницы`);
    return;
  }

  if (message?.action === "scanFinished") {
    ui.running = false;
    ui.paused = false;
    ui.stopping = false;
    renderRunState();
    if (message.finished?.results?.length) {
      renderResults(message.finished);
      return;
    }
    void storageGet([STORAGE_FINISHED]).then((saved) => {
      const finished = saved[STORAGE_FINISHED];
      if (finished?.results?.length) renderResults(finished);
      else {
        $("scan-current").textContent = "Сейчас ничего не проверяется";
        syncSteps();
      }
    });
  }
});

/* ------------------------------------------------------------------ */
/* старт                                                               */
/* ------------------------------------------------------------------ */

function applySavedSettings(saved) {
  if (!saved) return;
  Object.assign(settings, {
    mode: MODE_LABELS[saved.mode] ? saved.mode : settings.mode,
    threads: Math.max(1, Math.min(12, Number(saved.threads) || settings.threads)),
    focusMode: saved.focusMode !== false,
    useApi: saved.useApi !== false
  });
  if (saved.warehouse) warehouseEl.value = saved.warehouse;
  if (Array.isArray(saved.recentWarehouses)) ui.recentWarehouses = saved.recentWarehouses;
  if (saved.rates && typeof saved.rates === "object") ui.rates = saved.rates;
  if (saved.lastPostings) postingsEl.value = saved.lastPostings;
}

async function boot() {
  mountDecks();
  ensureKeepAlive();

  const version = chrome.runtime.getManifest?.()?.version;
  if (version) $("app-version").textContent = `v${version}`;

  const saved = await storageGet([STORAGE_SETTINGS, STORAGE_FINISHED]);
  applySavedSettings(saved[STORAGE_SETTINGS]);
  writeDecks();
  renderRecentWarehouses();
  updateCount();

  const live = await send({ action: "getScanState" });
  if (live?.running) {
    resetScanHud(live.total || 0);
    for (const entry of live.results || []) {
      applyItem(entry.index, entry.item);
      renderFeed(entry.item);
    }
    absorbState(live);
    setStep("scan");
    ui.hasResults = ui.byIndex.size > 0;
    updateScanHud();
    syncSteps();
    return;
  }

  const finished = saved[STORAGE_FINISHED];
  if (finished?.results?.length) {
    renderResults(finished);
  } else {
    renderRunState();
    syncSteps();
  }
}

/* ------------------------------------------------------------------ */
/* подпись автора                                                      */
/*                                                                     */
/* Логика показа: приветствие вскоре после открытия и дальше — только  */
/* когда приложение простаивает. Во время проверки и на скрытой        */
/* вкладке подпись не появляется, чтобы не лезть под руку.             */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* детализация                                                         */
/* ------------------------------------------------------------------ */

/*
 * Второе пространство экрана результата. Там же, что уходит вторым листом
 * в Excel, только на странице и с поиском: карточка на отправление,
 * заголовок как в Hub (номер, плашка статуса, ID ссылкой) и последние
 * операции таблицей.
 */
let detailQuery = [];
/* {item, hay} — строку для поиска собираем один раз на результат, а не на
   каждое нажатие клавиши. */
let detailIndex = [];
const detailFilters = { verdict: "", bucket: "", status: "", via: "" };

const VIA_LABELS = { api: "запрос", dom: "страница" };

function haystackOf(item) {
  const report = item.report || {};
  const kind = classify(item);
  return [
    item.posting,
    report.number,
    report.status,
    report.warehouseAt,
    report.warehouseCell,
    bucketOf(report.warehouseAt, Date.now()),
    kind === "hit" ? "есть склад" : kind === "miss" ? "нет склада" : "не вышло",
    CHECK_STATUS[item.status] || item.status,
    VIA_LABELS[item.via] || item.via,
    ...(report.columns || []),
    ...(report.lastRows || []).flat()
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function buildDetailIndex(results) {
  detailIndex = results.map((item) => ({ item, hay: haystackOf(item) }));
}

/* Списки значений в фильтрах — из того, что реально есть в прогоне. */
function fillFilterOptions() {
  const buckets = [];
  const statuses = [];
  for (const { item } of detailIndex) {
    const bucket = bucketOf(item.report?.warehouseAt, Date.now());
    if (bucket && !buckets.includes(bucket)) buckets.push(bucket);
    const status = item.report?.status;
    if (status && !statuses.includes(status)) statuses.push(status);
  }
  buckets.sort((a, b) => BUCKET_ORDER.indexOf(a) - BUCKET_ORDER.indexOf(b));
  statuses.sort((a, b) => a.localeCompare(b, "ru"));

  const fill = (id, values, anyLabel) => {
    const select = $(id);
    if (!select) return;
    const keep = select.value;
    select.innerHTML = "";
    const any = document.createElement("option");
    any.value = "";
    any.textContent = anyLabel;
    select.appendChild(any);
    for (const value of values) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = value;
      select.appendChild(option);
    }
    select.value = values.includes(keep) ? keep : "";
  };
  fill("filter-bucket", buckets, "любая");
  fill("filter-status", statuses, "любой");
}

function passesFilters(item) {
  if (detailFilters.verdict && classify(item) !== detailFilters.verdict) return false;
  if (detailFilters.via && item.via !== detailFilters.via) return false;
  if (detailFilters.status && item.report?.status !== detailFilters.status) return false;
  if (detailFilters.bucket && bucketOf(item.report?.warehouseAt, Date.now()) !== detailFilters.bucket) return false;
  return true;
}

function filtersActive() {
  return Object.values(detailFilters).some(Boolean) || detailQuery.length > 0;
}

let resultView = "list";
let viewSwapTimer = null;

/*
 * Смена пространства: уходящее гаснет, приходящее проявляется. Подсветка
 * вкладок едет за выбранной — за это отвечает --seg-index.
 */
function setResultView(view, animate) {
  const tabs = $("result-tabs");
  const grid = document.querySelector(".result-grid");
  const detail = $("result-detail");
  if (!tabs || !grid || !detail) return;

  const buttons = $$(".seg__btn", tabs);
  const at = buttons.findIndex((btn) => btn.dataset.view === view);
  tabs.style.setProperty("--seg-index", String(Math.max(0, at)));
  for (const btn of buttons) btn.classList.toggle("is-on", btn.dataset.view === view);

  const from = view === "list" ? detail : grid;
  const to = view === "list" ? grid : detail;
  const same = resultView === view;
  resultView = view;

  window.clearTimeout(viewSwapTimer);
  const show = () => {
    from.hidden = true;
    from.classList.remove("is-leaving");
    to.hidden = false;
    if (view === "detail") renderDetail();
  };

  if (!animate || same || from.hidden) {
    show();
    return;
  }
  from.classList.add("is-leaving");
  viewSwapTimer = window.setTimeout(show, 160);
}

/* Поиск принимает и один ID, и список: через пробел, запятую или строками. */
function parseDetailQuery(raw) {
  return String(raw || "")
    .split(/[\s,;]+/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function matchesDetail(entry) {
  if (!passesFilters(entry.item)) return false;
  if (!detailQuery.length) return true;
  /* Несколько значений — это «или»: так ищут списком ID. */
  return detailQuery.some((needle) => entry.hay.includes(needle));
}

function verdictOf(item) {
  const kind = classify(item);
  if (kind === "hit") return { className: "is-hit", text: "склад есть" };
  if (kind === "miss") return { className: "is-miss", text: "склада нет" };
  return { className: "is-issue", text: statusLabel(item) };
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

/* «Ячейка: A → B; Местоположение: C» — метки красим отдельно, как в Hub. */
function paintChange(td, text) {
  const parts = String(text).split("; ");
  parts.forEach((part, index) => {
    if (index) td.appendChild(document.createElement("br"));
    const at = part.indexOf(": ");
    if (at > 0 && at < 30) {
      td.appendChild(el("span", "card__label", `${part.slice(0, at)}: `));
      td.appendChild(document.createTextNode(part.slice(at + 2)));
    } else {
      td.appendChild(document.createTextNode(part));
    }
  });
}

function detailCard(item) {
  const report = item.report || {};
  const card = el("article", "card");

  const head = el("div", "card__head");
  head.appendChild(el("span", "card__number", report.number || "номер не прочитан"));
  if (report.status) head.appendChild(el("span", "card__badge", report.status));

  const id = el("a", "card__id", `ID ${item.posting}`);
  id.href = hubUrl(item.posting);
  id.target = "_blank";
  id.rel = "noopener noreferrer";
  head.appendChild(id);

  const verdict = verdictOf(item);
  head.appendChild(el("span", `card__verdict ${verdict.className}`, verdict.text));
  card.appendChild(head);

  const facts = el("div", "card__facts");
  const addFact = (label, value) => {
    if (!value) return;
    const fact = el("div", "card__fact");
    fact.appendChild(el("b", null, label));
    fact.appendChild(el("span", null, value));
    facts.appendChild(fact);
  };
  addFact("Корзинка", bucketOf(report.warehouseAt, Date.now()));
  addFact("Когда", report.warehouseAt);
  addFact("Последняя ячейка", report.warehouseCell);
  if (facts.childElementCount) card.appendChild(facts);

  const rows = report.lastRows || [];
  if (!rows.length) {
    card.appendChild(el("p", "card__none", "Строки истории не прочитались."));
    return card;
  }

  const columns = report.columns?.length
    ? report.columns
    : Array.from({ length: rows[0].length }, (_, i) => `Колонка ${i + 1}`);

  const box = el("div", "card__table");
  const table = document.createElement("table");
  const thead = document.createElement("thead");
  const headRow = document.createElement("tr");
  for (const title of columns) headRow.appendChild(el("th", null, title));
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement("tbody");
  for (const row of rows) {
    const tr = document.createElement("tr");
    columns.forEach((_, index) => {
      const value = row[index] == null ? "" : String(row[index]);
      const td = document.createElement("td");
      /* Первая колонка Hub — плашка типа, вторая — дата моноширинным. */
      if (index === 0 && value) td.appendChild(el("span", "card__type", value));
      else if (index === 1 && value) td.appendChild(el("span", "card__when", value));
      else if (value.includes(": ")) paintChange(td, value);
      else td.textContent = value;
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  box.appendChild(table);
  card.appendChild(box);
  return card;
}

function renderDetailChips() {
  const box = $("detail-chips");
  if (!box) return;
  box.innerHTML = "";
  if (detailQuery.length < 2) return;
  for (const value of detailQuery) {
    const chip = el("span", "detail__chip", value);
    const drop = el("button", null, "×");
    drop.type = "button";
    drop.title = "Убрать из поиска";
    drop.addEventListener("click", () => {
      detailQuery = detailQuery.filter((entry) => entry !== value);
      $("detail-search").value = detailQuery.join(" ");
      renderDetail();
    });
    chip.appendChild(drop);
    box.appendChild(chip);
  }
}

function renderDetail() {
  const list = $("detail-list");
  if (!list) return;

  const shown = detailIndex.filter(matchesDetail);
  const all = detailIndex.length;

  const count = $("detail-count");
  if (count) {
    count.textContent = filtersActive()
      ? `${shown.length} из ${all}`
      : `${all} ${plural(all, ["отправление", "отправления", "отправлений"])}`;
  }
  const reset = $("filter-reset");
  if (reset) reset.hidden = !filtersActive();
  renderDetailChips();

  list.innerHTML = "";
  if (!shown.length) {
    const empty = el("div", "detail__empty");
    empty.appendChild(el("b", null, all ? "Ничего не нашлось" : "Пока пусто"));
    empty.appendChild(
      el("span", null, all ? "Смягчите фильтры или очистите поиск." : "Запустите проверку — детали появятся здесь.")
    );
    list.appendChild(empty);
    return;
  }

  /* Больших прогонов это касается напрямую: рисовать тысячи карточек
     незачем, до них никто не долистает. */
  const LIMIT = 300;
  for (const entry of shown.slice(0, LIMIT)) list.appendChild(detailCard(entry.item));
  if (shown.length > LIMIT) {
    const more = el("div", "detail__empty");
    more.appendChild(el("b", null, `Показаны первые ${LIMIT}`));
    more.appendChild(el("span", null, "Сузьте поиск или фильтры, чтобы увидеть остальные."));
    list.appendChild(more);
  }
}

function mountDetail() {
  const tabs = $("result-tabs");
  if (tabs) {
    tabs.addEventListener("click", (event) => {
      const btn = event.target.closest("[data-view]");
      if (btn) setResultView(btn.dataset.view, true);
    });
  }

  const search = $("detail-search");
  if (search) {
    let timer = null;
    search.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        detailQuery = parseDetailQuery(search.value);
        renderDetail();
      }, 160);
    });
  }

  const bind = (id, key) => {
    const select = $(id);
    if (!select) return;
    select.addEventListener("change", () => {
      detailFilters[key] = select.value;
      renderDetail();
    });
  };
  bind("filter-verdict", "verdict");
  bind("filter-bucket", "bucket");
  bind("filter-status", "status");
  bind("filter-via", "via");

  $("filter-reset")?.addEventListener("click", () => {
    resetDetailFilters();
    renderDetail();
  });
}

function resetDetailFilters() {
  detailQuery = [];
  for (const key of Object.keys(detailFilters)) detailFilters[key] = "";
  const search = $("detail-search");
  if (search) search.value = "";
  for (const id of ["filter-verdict", "filter-bucket", "filter-status", "filter-via"]) {
    const select = $(id);
    if (select) select.value = "";
  }
}

mountDetail();

/*
 * Подпись автора.
 *
 * Раньше она разворачивалась на весь экран через несколько секунд после
 * запуска — ровно тогда, когда человек вставляет номера. Теперь это
 * плашка в левом нижнем углу: раз в десять минут появляется, сама гаснет
 * через несколько секунд, а пока на ней курсор — ждёт, чтобы по ссылке
 * можно было спокойно кликнуть.
 */
const CREDIT = {
  everyMs: 10 * 60 * 1000,
  showMs: 7000,
  /* После ухода курсора даём короткую отсрочку, а не гасим мгновенно. */
  afterHoverMs: 1500
};

let creditTimer = null;
let creditPending = false;

function hideCredit() {
  window.clearTimeout(creditTimer);
  creditTimer = null;
  $("credit")?.classList.remove("is-on");
}

function showCredit() {
  const el = $("credit");
  if (!el) return;
  /* Во вкладке, которую не видно, показывать нечего — покажем, когда
     на неё вернутся. */
  if (document.hidden) {
    creditPending = true;
    return;
  }
  creditPending = false;
  el.classList.add("is-on");
  window.clearTimeout(creditTimer);
  creditTimer = window.setTimeout(hideCredit, CREDIT.showMs);
}

function mountCredit() {
  const el = $("credit");
  if (!el) return;

  el.addEventListener("mouseenter", () => {
    if (!el.classList.contains("is-on")) return;
    window.clearTimeout(creditTimer);
    creditTimer = null;
  });
  el.addEventListener("mouseleave", () => {
    if (!el.classList.contains("is-on")) return;
    window.clearTimeout(creditTimer);
    creditTimer = window.setTimeout(hideCredit, CREDIT.afterHoverMs);
  });
  /* Ссылка открывается в новой вкладке — плашку сразу убираем. */
  el.querySelector(".credit__link")?.addEventListener("click", hideCredit);

  window.setInterval(showCredit, CREDIT.everyMs);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && creditPending) window.setTimeout(showCredit, 1200);
  });
}

mountCredit();

void boot();
