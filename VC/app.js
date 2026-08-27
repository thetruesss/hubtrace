const STORAGE_SETTINGS = "hubTraceSettings";
const STORAGE_FINISHED = "hubTraceFinished";
const STORAGE_RUNS = "hubTraceRuns";
const RUN_PREFIX = "hubTraceRun:";

const STEP_INDEX = { input: 0, scan: 1, result: 2 };

const $ = (id) => document.getElementById(id);
const $$ = (selector, root) => [...(root || document).querySelectorAll(selector)];

const postingsEl = $("postings");
const warehouseEl = $("warehouse");
const cutoffEl = $("cutoff");
const viewCutoffEl = $("view-cutoff");
const inputError = $("input-error");

const screens = {
  input: $("screen-input"),
  scan: $("screen-scan"),
  result: $("screen-result")
};

const settings = {
  mode: "balance",
  threads: 4,
  auto: true,
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
  elapsedMs: 0,
  elapsedAt: 0,
  workers: [],
  retryRound: 0,
  retryTotal: 0,
  retryLeft: 0,
  lists: { hits: [], misses: [], issues: [] },
  finished: null,
  viewCutoff: 0,
  reportSaved: false,
  recentWarehouses: [],
  rates: {},
  runs: [],
  openRun: "",
  rateLog: [],
  etaLog: []
};

const REDUCED_MOTION = window.matchMedia("(prefers-reduced-motion: reduce)");

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(payload) {
  return new Promise((resolve) => chrome.storage.local.set(payload, resolve));
}

const SETTINGS_IDLE_MS = 300;
const SETTINGS_MAX_WAIT_MS = 2000;

let settingsPatch = {};
let settingsFlushTimer = null;
let settingsPatchedAt = 0;
let settingsChain = Promise.resolve();

function flushSettings() {
  window.clearTimeout(settingsFlushTimer);
  settingsFlushTimer = null;
  settingsPatchedAt = 0;
  if (!Object.keys(settingsPatch).length) return settingsChain;
  const patch = settingsPatch;
  settingsPatch = {};
  settingsChain = settingsChain.then(async () => {
    const saved = await storageGet([STORAGE_SETTINGS]);
    await storageSet({ [STORAGE_SETTINGS]: { ...(saved[STORAGE_SETTINGS] || {}), ...patch } });
  });
  return settingsChain;
}

function patchSettings(patch) {
  Object.assign(settingsPatch, patch);
  const now = Date.now();
  if (!settingsPatchedAt) settingsPatchedAt = now;
  window.clearTimeout(settingsFlushTimer);
  const wait = Math.min(SETTINGS_IDLE_MS, Math.max(0, settingsPatchedAt + SETTINGS_MAX_WAIT_MS - now));
  settingsFlushTimer = window.setTimeout(flushSettings, wait);
}

window.addEventListener("pagehide", () => void flushSettings());
document.addEventListener("visibilitychange", () => {
  if (document.hidden) void flushSettings();
});

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

const CELL_SPLIT_RE = /[\t;,]/;

const TOKEN_RE = /^[A-Za-z0-9:_-]+$/;

function splitCells(line) {
  const by = CELL_SPLIT_RE.test(line) ? CELL_SPLIT_RE : /\s+/;
  return line.split(by).map((part) => part.trim()).filter(Boolean);
}

function tokenize(line) {
  const cells = splitCells(line);
  const id = cells.find(sheetReader.looksLikeId) || cells.find(sheetReader.looksLikeNumber);
  if (id) return [id];
  if (cells.length > 1 && cells.every((cell) => TOKEN_RE.test(cell))) return cells;
  return [line];
}

function parsePostings(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const out = [];
  const seen = new Set();
  let duplicates = 0;
  let odd = 0;
  for (const line of lines) {
    for (let token of tokenize(line)) {
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
      if (!sheetReader.looksLikeNumber(token)) odd += 1;
      out.push(token);
    }
  }
  out.duplicates = duplicates;
  out.odd = odd;
  return out;
}

const REVEAL_MS = 240;
const revealTimers = new WeakMap();

function reveal(node, show) {
  if (!node) return;
  window.clearTimeout(revealTimers.get(node));
  node.classList.add("reveal");
  if (REDUCED_MOTION.matches) {
    node.classList.toggle("is-out", !show);
    node.hidden = !show;
    return;
  }
  if (show) {
    if (node.hidden) {
      node.classList.add("is-out");
      node.hidden = false;
      void node.offsetWidth;
    }
    node.classList.remove("is-out");
    return;
  }
  if (node.hidden) {
    node.classList.add("is-out");
    return;
  }
  node.classList.add("is-out");
  revealTimers.set(
    node,
    window.setTimeout(() => {
      node.hidden = true;
    }, REVEAL_MS)
  );
}

function playSwap(node) {
  if (!node || REDUCED_MOTION.matches) return;
  node.classList.remove("is-swap");
  void node.offsetWidth;
  node.classList.add("is-swap");
}

const emptyTimers = new WeakMap();

function emptyLater(node, ms) {
  if (!node) return;
  window.clearTimeout(emptyTimers.get(node));
  if (REDUCED_MOTION.matches) {
    node.replaceChildren();
    return;
  }
  emptyTimers.set(
    node,
    window.setTimeout(() => node.replaceChildren(), ms == null ? REVEAL_MS : ms)
  );
}

function emptyNow(node) {
  if (!node) return;
  window.clearTimeout(emptyTimers.get(node));
  node.replaceChildren();
}

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

let stepSwapTimer = null;

function setStep(name) {
  if (!stepAvailable(name)) return;
  const from = screens[ui.currentStep];
  const to = screens[name];
  const same = ui.currentStep === name;
  ui.currentStep = name;
  syncSteps();
  renderFab();
  if (name === "input") renderRuns();
  if (!to) return;

  window.clearTimeout(stepSwapTimer);
  const show = () => {
    for (const [key, el] of Object.entries(screens)) {
      if (key === name) continue;
      el.hidden = true;
      el.classList.remove("is-leaving");
    }
    to.hidden = false;
  };

  if (same || !from || from === to || from.hidden || REDUCED_MOTION.matches) {
    show();
    return;
  }
  from.classList.add("is-leaving");
  stepSwapTimer = window.setTimeout(show, 160);
}

function classify(item) {
  if (item?.found) return "hit";
  if (item?.status === "partial") return "issue";
  if (["complete", "missing"].includes(item?.status)) return "miss";
  if (item?.ok) return "miss";
  return "issue";
}

const STATUS_LABELS = {
  complete: "нет",
  later: "позже потолка",
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

function renderFeed(item) {
  if (!item) return;
  const kind = classify(item);
  const li = document.createElement("li");

  const tag = document.createElement("span");
  tag.className = `tag tag--${kind}`;
  tag.textContent = statusLabel(item);

  const code = document.createElement("code");
  code.textContent = item.posting;

  li.append(tag, code);

  const feed = $("feed");
  feed.prepend(li);
  while (feed.children.length > 120) feed.lastElementChild.remove();
  reveal($("feed-empty"), false);
}

const PHASE_LABELS = {
  idle: "ждёт",
  open: "открывает",
  history: "проверяет",
  rows: "проверяет",
  api: "проверяет"
};

function renderLanes() {
  const list = $("lanes");
  const empty = $("lanes-empty");
  const count = $("lanes-count");
  if (!list) return;

  count.textContent = String(ui.workers.length);
  reveal(empty, ui.workers.length === 0);
  list.innerHTML = "";

  for (const worker of ui.workers) {
    const li = document.createElement("li");
    const busy = worker.phase && worker.phase !== "idle";
    li.className = `lane${busy ? " is-busy" : ""}`;

    const id = document.createElement("span");
    id.className = "lane__id";
    id.textContent = String(worker.id);

    const posting = document.createElement("span");
    posting.className = "lane__posting";
    posting.textContent = worker.posting || "—";

    const phase = document.createElement("span");
    phase.className = "lane__phase";
    phase.textContent = PHASE_LABELS[worker.phase] || "проверяет";

    li.append(id, posting, phase);
    list.appendChild(li);
  }
}

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
  const retryTotal = ui.running ? Math.max(0, ui.retryTotal) : 0;
  const retryLeft = ui.running ? Math.max(0, Math.min(ui.retryLeft, retryTotal)) : 0;

  const whole = total + retryTotal;
  const done = processed + (retryTotal - retryLeft);
  let pct = whole ? Math.round((done / whole) * 100) : 0;
  if (pct >= 100 && ui.running && (retryLeft > 0 || processed < total)) pct = 99;

  $("progress-pct").textContent = `${pct}%`;
  $("progress-label").textContent = retryLeft
    ? `дочитываю ${retryLeft} из ${retryTotal}`
    : `${processed} из ${total}`;

  const radar = $("radar");
  if (radar) radar.classList.toggle("is-retry", retryLeft > 0);

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

function renderRunState() {
  const mode = scanMode();
  const screen = screens.scan;
  screen.classList.toggle("is-live", mode === "live");
  screen.classList.toggle("is-paused", mode === "paused");
  screen.classList.toggle("is-stopping", mode === "stopping");
  screen.classList.toggle("is-idle", mode === "idle");

  const radar = $("radar");
  if (radar) radar.classList.toggle("is-live", mode === "live");

  const retrying = mode === "live" && ui.retryLeft > 0;
  const status = $("scan-status");
  status.classList.toggle("badge--live", mode === "live");
  status.classList.toggle("badge--paused", mode === "paused");
  status.textContent = retrying
    ? `добор · круг ${ui.retryRound}`
    : mode === "live"
      ? "идёт"
      : mode === "paused"
        ? "пауза"
        : mode === "stopping"
          ? "стоп"
          : "ожидание";

  const gauges = $("gauges");
  if (gauges) {
    gauges.classList.toggle("is-live", mode === "live");
    gauges.classList.toggle("is-paused", mode === "paused");
  }

  const pause = $("btn-pause");
  pause.disabled = !ui.running || ui.stopping;
  pause.classList.toggle("btn--wait", ui.paused);
  pause.querySelector("[data-pause-label]").textContent = ui.paused ? "Продолжить" : "Пауза";
  $("btn-stop").disabled = !ui.running;

  const empty = $("feed-empty");
  const hasItems = $("feed").children.length > 0;
  reveal(empty, !hasItems);
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
    $("scan-current").textContent = "Пауза — начатое доработается";
  }

  updateFormState();
}

function tickLive() {
  if (!ui.running) return;
  const drift = ui.paused ? 0 : Date.now() - ui.elapsedAt;
  const elapsed = ui.elapsedMs + drift;
  setText($("gauge-elapsed"), fmtDuration(elapsed));

  const processed = ui.byIndex.size;
  const rate = elapsed > 1500 && processed ? (processed / elapsed) * 60000 : 0;
  const left = ui.total - processed;
  const etaMs = rate && left > 0 ? (left / rate) * 60000 : left <= 0 ? 0 : null;

  setText($("gauge-rate"), rate ? fmtRate(rate) : "—");
  setText($("gauge-eta"), ui.paused ? "пауза" : etaMs == null ? "—" : fmtDuration(etaMs));

  if (!ui.paused && rate > 0) {
    pushSample(ui.rateLog, rate);
    if (etaMs != null) pushSample(ui.etaLog, etaMs);
    renderGauges();
  }
  renderTicks(elapsed);
}

const SAMPLE_LIMIT = 96;

function pushSample(log, value) {
  log.push(value);
  if (log.length > SAMPLE_LIMIT) log.shift();
}

function setText(node, text) {
  if (node && node.textContent !== text) node.textContent = text;
}

window.setInterval(tickLive, 500);

function drawSpark(lineId, fillId, samples, invert) {
  const line = $(lineId);
  const fill = $(fillId);
  if (!line || !fill) return;

  if (samples.length < 2) {
    line.setAttribute("points", "");
    fill.setAttribute("points", "");
    return;
  }

  const max = Math.max(...samples) || 1;
  const min = Math.min(...samples);
  const span = Math.max(max - min, max * 0.08, 0.0001);
  const points = samples
    .map((value, index) => {
      const x = (index / (samples.length - 1)) * 100;
      const norm = (value - min) / span;
      const y = 23 - (invert ? 1 - norm : norm) * 19;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    })
    .join(" ");
  line.setAttribute("points", points);
  fill.setAttribute("points", `0,26 ${points} 100,26`);
}

function renderGauges() {
  drawSpark("rate-line", "rate-fill", ui.rateLog, false);
  drawSpark("eta-line", "eta-fill", ui.etaLog, true);
}

function renderTicks(elapsed) {
  const host = $("gauge-ticks");
  if (!host) return;
  const minutes = Math.floor(elapsed / 60000);
  const want = Math.max(1, Math.min(12, minutes + 1));
  while (host.children.length < want) host.appendChild(document.createElement("i"));
  while (host.children.length > want) host.lastElementChild.remove();

  const from = Math.max(0, minutes + 1 - want);
  const part = ((elapsed % 60000) / 60000) * 100;
  for (let i = 0; i < host.children.length; i += 1) {
    const tick = host.children[i];
    const last = i === host.children.length - 1;
    tick.classList.toggle("is-now", last);
    tick.style.setProperty("--fill", last ? `${Math.max(6, Math.round(part))}%` : "100%");
    tick.title = `минута ${from + i + 1}`;
  }

  const note = $("gauge-elapsed-note");
  if (note) {
    setText(
      note,
      minutes >= 12
        ? `минуты прогона · показаны последние ${want}`
        : `${want} ${plural(want, ["минута", "минуты", "минут"])} прогона`
    );
  }
}

function resetScanHud(total) {
  ui.byIndex = new Map();
  ui.hits = 0;
  ui.misses = 0;
  ui.issues = 0;
  ui.total = total;
  ui.workers = [];
  ui.elapsedMs = 0;
  ui.elapsedAt = Date.now();
  ui.rateLog = [];
  ui.etaLog = [];
  ui.retryRound = 0;
  ui.retryTotal = 0;
  ui.retryLeft = 0;
  renderGauges();
  resetRadarBlips();
  $("feed").innerHTML = "";
  $("scan-current").textContent = "Открываю историю…";
  renderLanes();
  updateScanHud();
  renderRunState();
}

function renderBrief(parsed) {
  const list = $("brief");
  if (!list) return;
  const count = (parsed || parsePostings(postingsEl.value)).length;
  const rate = Number(ui.rates.auto) || Number(ui.rates[settings.mode]) || 0;

  const rows = [["", `<b>${count}</b> ${plural(count, ["номер", "номера", "номеров"])} в очереди`]];
  if (count && rate) rows.push(["", `Примерно <b>${fmtDuration((count / rate) * 60000)}</b> по прошлым запускам`]);
  rows.push(["", "Итог придёт списком, детализацией и аналитикой"]);
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
  if (!parsed.length) {
    stats.textContent = "Пока пусто";
  } else {
    const parts = [];
    if (parsed.duplicates) parts.push(`${parsed.duplicates} дублей убрано`);
    if (parsed.odd) parts.push(`${parsed.odd} не похожи на ID — проверю как есть`);
    const head = parts.length ? `${parsed.length} уникальных` : `${parsed.length} уникальных номеров`;
    stats.textContent = [head, ...parts].join(" · ");
  }
  renderBrief(parsed);
  updateFormState(parsed);
}

function updateFormState(parsed) {
  const hasPostings = (parsed || parsePostings(postingsEl.value)).length > 0;
  const hasWarehouse = warehouseEl.value.trim().length > 0;
  const cutoff = readCutoff(cutoffEl.value);
  cutoffEl.classList.toggle("is-bad", !cutoff.ok);
  $("btn-start").disabled = ui.running || !(hasPostings && hasWarehouse && cutoff.ok);
  $("btn-clear").disabled = !postingsEl.value.trim();

  for (const name of ["hits", "misses", "issues"]) {
    const filled = $(name).value.trim().length > 0;
    const button = document.querySelector(`[data-copy="${name}"]`);
    if (button) button.disabled = !filled;
    const col = document.querySelector(`.result-col[data-col="${name}"]`);
    if (col) col.classList.toggle("is-empty", !filled);
  }
  renderFab();
}

function renderFab() {
  const fab = $("btn-xlsx");
  if (!fab) return;
  const ready = Boolean(ui.finished) && ui.currentStep === "result";
  reveal(fab, ready);
  fab.classList.toggle("is-waiting", ready && !ui.reportSaved);
  fab.classList.toggle("is-done", ready && ui.reportSaved);

  const note = $("fab-note");
  if (!note || !ready) return;
  if (ui.reportSaved) {
    note.textContent = "Скачано · нажмите ещё раз";
    return;
  }
  const shown = statsIndex.filter((entry) => passesStats(entry));
  const details = shown.filter((entry) => entry.item?.report?.lastRows?.length).length;
  note.textContent = statsFiltersActive()
    ? `${shown.length} из ${statsIndex.length} · действия по ${details}`
    : `${shown.length} строк · действия по ${details}`;
}

function showError(message) {
  if (message) inputError.textContent = message;
  reveal(inputError, Boolean(message));
}

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

let changeLabels = {};

const LOGIN_RE = /^[A-Za-z][A-Za-z0-9._-]*$/;
const NAME_RE = /^[A-Z][a-z]*$/;

function findLogin(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";

  const chunks = text.split(/[\s()·,;|]+/).filter(Boolean);
  const mail = chunks.find((chunk) => chunk.indexOf("@") > 0);
  for (const chunk of mail ? [mail, ...chunks] : chunks) {
    const at = chunk.indexOf("@");
    const head = at > 0 ? chunk.slice(0, at) : chunk;
    if (!LOGIN_RE.test(head)) continue;
    if (at < 0 && (NAME_RE.test(head) || !/[a-z]/.test(head))) continue;
    return head;
  }
  return /^\d+$/.test(text) ? text : "";
}

function columnAt(report, mask, fallback) {
  const columns = report?.columns;
  if (!Array.isArray(columns)) return fallback;
  const at = columns.findIndex((title) => mask.test(String(title || "")));
  return at < 0 ? fallback : at;
}

function userColumnAt(report) {
  return columnAt(report, /^польз/i, 2);
}

function withLabels(report) {
  const rows = report?.lastRows;
  if (!Array.isArray(rows)) return [];
  const codes = report?.codes;
  const userAt = userColumnAt(report);
  return rows.map((row, index) => {
    if (!Array.isArray(row)) return row;
    const out = [...row];
    const label = Array.isArray(codes) ? changeLabels[codes[index]] : "";
    if (label && out.length && out[0] !== label) out[0] = label;
    if (userAt < out.length) out[userAt] = findLogin(out[userAt]) || "—";
    return out;
  });
}

function fmtAgo(at) {
  const diff = Date.now() - Number(at || 0);
  if (!Number.isFinite(diff) || diff < 0) return "";
  if (diff < 90000) return "только что";
  if (diff < 3600000) return `${Math.round(diff / 60000)} мин назад`;
  if (diff < 86400000) return `${Math.round(diff / 3600000)} ч назад`;
  if (diff < 172800000) return "вчера";
  const date = new Date(at);
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}`;
}

function runLine(run) {
  const item = el("div", "run");
  const open = ui.openRun === run.jobId;
  item.classList.toggle("is-open", open);

  const head = el("button", "run__head");
  head.type = "button";
  head.setAttribute("aria-expanded", String(open));
  head.title = open ? "Свернуть" : "Показать итог";

  const name = el("b", "run__place", run.warehouse || "без склада");
  name.title = run.warehouse || "";
  head.appendChild(name);
  head.appendChild(el("em", "run__ago", fmtAgo(run.at)));

  head.appendChild(caretIcon("run__caret"));

  head.addEventListener("click", () => {
    ui.openRun = ui.openRun === run.jobId ? "" : run.jobId;
    renderRuns();
  });
  item.appendChild(head);

  const body = el("div", "run__body");
  const inner = el("div", "run__inner");
  const rows = [
    ["hit", "склад есть", run.hits],
    ["miss", "склада нет", run.misses],
    ["issue", "не вышло", run.issues]
  ];
  const list = el("ul", "last__rows");
  for (const [mod, label, value] of rows) {
    const li = el("li", `last__row last__row--${mod}`);
    li.appendChild(el("b", null, String(Number(value) || 0)));
    li.appendChild(el("span", null, label));
    list.appendChild(li);
  }
  inner.appendChild(list);

  const total = Number(run.inputCount) || 0;
  const foot = [`из ${total} ${plural(total, ["номера", "номеров", "номеров"])}`];
  if (run.durationMs) foot.push(fmtDuration(run.durationMs));
  if (run.cutoffText) foot.push(`до ${run.cutoffText}`);
  if (run.stopped) foot.push("остановлено");
  inner.appendChild(el("p", "last__foot", foot.join(" · ")));

  const go = el("button", "btn btn--ghost btn--sm last__open", "Открыть результат");
  go.type = "button";
  go.addEventListener("click", () => void openRun(run.jobId));
  inner.appendChild(go);

  body.appendChild(inner);
  item.appendChild(body);
  return item;
}

function renderRuns() {
  const host = $("runs");
  const empty = $("runs-empty");
  const count = $("runs-count");
  if (!host) return;

  const runs = ui.runs;
  reveal(empty, runs.length === 0);
  if (count) {
    reveal(count, runs.length > 0);
    if (runs.length) count.textContent = String(runs.length);
  }
  $("last-run")?.classList.toggle("is-empty", runs.length === 0);

  if (runs.length && !runs.some((run) => run.jobId === ui.openRun)) ui.openRun = runs[0].jobId;

  host.innerHTML = "";
  for (const run of runs) host.appendChild(runLine(run));
}

async function openRun(jobId) {
  if (ui.finished?.jobId && ui.finished.jobId === jobId) {
    setStep("result");
    return;
  }
  const key = `${RUN_PREFIX}${jobId}`;
  const saved = await storageGet([key]);
  const payload = saved[key];
  if (!payload?.results?.length) {
    toast("error", "Итог этого прогона не сохранился — запустите проверку заново.");
    return;
  }
  ui.openRun = jobId;
  renderResults(payload);
}

async function loadRuns() {
  const saved = await storageGet([STORAGE_RUNS]);
  ui.runs = Array.isArray(saved[STORAGE_RUNS]) ? saved[STORAGE_RUNS].filter((run) => run?.jobId) : [];
  renderRuns();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_RUNS]) return;
  const next = changes[STORAGE_RUNS].newValue;
  ui.runs = Array.isArray(next) ? next.filter((run) => run?.jobId) : [];
  renderRuns();
});

function renderResultHead() {
  const payload = ui.finished;
  const total = (payload?.results || []).filter(Boolean).length;
  const inputCount = payload?.inputCount || total;
  $("result-title").textContent = `Было ${inputCount}, нашлось ${ui.lists.hits.length}`;

  const about = payload?.warehouse
    ? `Склад ${payload.warehouse} есть в истории этих номеров.`
    : "Номера, у которых этот склад есть в истории.";
  $("result-sub").textContent = payload?.error || about;

  const meta = $("result-meta");
  meta.innerHTML = "";
  const chips = [];
  if (payload?.durationMs) chips.push(["Время", fmtDuration(payload.durationMs)]);
  if (payload?.durationMs && total) {
    chips.push(["Скорость", fmtRate((total / payload.durationMs) * 60000)]);
  }
  if (payload?.cutoffText) chips.push(["Потолок", payload.cutoffText]);
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
}

function indexResults(keepFilters) {
  const results = shownResults();
  ui.lists = splitResults(results);

  for (const name of ["hits", "misses", "issues"]) {
    const filterEl = document.querySelector(`[data-filter="${name}"]`);
    if (filterEl && !keepFilters) filterEl.value = "";
    renderList(name);
  }

  buildDetailIndex(results);
  if (!keepFilters) resetDetailFilters();
  fillFilterOptions();
  syncDetailControls();
  buildStatsIndex(results);
  if (!keepFilters) resetStatsFilters();
  fillStatsOptions();
  renderDetail();
  if (resultView === "stats") renderStats();
  else renderFab();
}

function setViewCutoff(raw, quiet) {
  const cut = readCutoff(raw);
  const next = cut.ok ? cut.at : 0;
  const changed = next !== ui.viewCutoff;

  ui.viewCutoff = next;
  if (quiet) return;

  if (changed) indexResults(true);
  renderResultHead();
  renderViewCutoff();
}

const MONTH_NAMES = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь"
];
const WEEK_DAYS = ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"];
const WHEEL_ITEM = 30;
const WHEEL_NOTCH = 24;
const WHEEL_REST_MS = 240;
const YEARS_BACK = 5;
const YEARS_ON = 1;

const datePickers = new Map();
let openedDatePicker = null;

function stampText(date) {
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function maskStamp(raw) {
  const digits = String(raw || "").replace(/\D/g, "").slice(0, 14);
  if (!digits) return "";
  let out = [digits.slice(0, 2), digits.slice(2, 4), digits.slice(4, 8)].filter(Boolean).join(".");
  if (digits.length > 8) out += ` ${digits.slice(8, 10)}`;
  if (digits.length > 10) out += `:${digits.slice(10, 12)}`;
  if (digits.length > 12) out += `:${digits.slice(12, 14)}`;
  return out;
}

function sameDay(a, b) {
  return (
    a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate()
  );
}

function fillWheel(col, labels) {
  col.replaceChildren();
  labels.forEach((label, at) => {
    const item = el("span", "wheel__item", label);
    item.dataset.at = String(at);
    col.appendChild(item);
  });
  return col;
}

function wheelColumn(labels, mod) {
  return fillWheel(el("div", `wheel__col${mod ? ` wheel__col--${mod}` : ""}`), labels);
}

function padLabels(count) {
  return Array.from({ length: count }, (_, i) => pad(i));
}

function itemStep(col) {
  return col.firstElementChild?.offsetHeight || WHEEL_ITEM;
}

function wheelLast(col) {
  return Math.max(0, col.childElementCount - 1);
}

function wheelAt(col) {
  return Math.round(col.scrollTop / itemStep(col));
}

function paintWheel(col) {
  const at = wheelAt(col);
  const items = col.children;
  for (let i = 0; i < items.length; i += 1) items[i].classList.toggle("is-on", i === at);
}

function spinWheel(col, value) {
  const top = Math.max(0, Math.min(wheelLast(col), value)) * itemStep(col);
  if (Math.abs(col.scrollTop - top) > 1) col.scrollTop = top;
  paintWheel(col);
}

function rollWheel(col, to) {
  const at = Math.max(0, Math.min(wheelLast(col), to));
  col.scrollTo({ top: at * itemStep(col), behavior: "smooth" });
}

function bindWheel(col, onSettle) {
  let timer = null;
  let spin = 0;
  let spinAt = 0;

  col.addEventListener("scroll", () => {
    paintWheel(col);
    window.clearTimeout(timer);
    timer = window.setTimeout(() => onSettle(Math.max(0, Math.min(wheelLast(col), wheelAt(col)))), 110);
  });

  col.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const now = Date.now();
      if (now - spinAt > WHEEL_REST_MS) spin = 0;
      spinAt = now;
      spin += event.deltaY;
      if (Math.abs(spin) < WHEEL_NOTCH) return;
      rollWheel(col, wheelAt(col) + (spin > 0 ? 1 : -1));
      spin = 0;
    },
    { passive: false }
  );

  col.addEventListener("click", (event) => {
    const item = event.target.closest("[data-at]");
    if (item) rollWheel(col, Number(item.dataset.at));
  });
}

function wheelDeck(mod, ...columns) {
  const deck = el("div", `wheel__deck${mod ? ` wheel__deck--${mod}` : ""}`);
  deck.append(el("i", "wheel__band"), ...columns);
  return deck;
}

function buildDatePicker() {
  const pop = el("div", "dtp");
  pop.hidden = true;

  const head = el("div", "dtp__head");
  const prev = el("button", "dtp__nav", "‹");
  prev.type = "button";
  prev.title = "Предыдущий месяц";
  const next = el("button", "dtp__nav", "›");
  next.type = "button";
  next.title = "Следующий месяц";
  const title = el("button", "dtp__title");
  title.type = "button";
  title.title = "Выбрать месяц и год";
  const titleText = el("span", "dtp__label");
  title.append(titleText, caretIcon("dtp__caret"));
  head.append(prev, title, next);

  const week = el("div", "dtp__week");
  for (const day of WEEK_DAYS) week.appendChild(el("span", null, day));

  const grid = el("div", "dtp__grid");
  const days = el("div", "dtp__days");
  days.append(week, grid);

  const month = wheelColumn(MONTH_NAMES, "wide");
  const year = wheelColumn([], "wide");
  const period = el("div", "dtp__period");
  period.appendChild(wheelDeck("period", month, year));

  const hour = wheelColumn(padLabels(24));
  const minute = wheelColumn(padLabels(60));
  const wheel = el("div", "wheel");
  wheel.appendChild(wheelDeck(null, hour, el("b", "wheel__sep", ":"), minute));

  const foot = el("div", "dtp__foot");
  const now = el("button", "dtp__link", "Сейчас");
  now.type = "button";
  const wipe = el("button", "dtp__link", "Очистить");
  wipe.type = "button";
  const done = el("button", "dtp__done", "Готово");
  done.type = "button";
  foot.append(now, wipe, done);

  pop.append(head, days, period, wheel, foot);
  document.body.appendChild(pop);

  return { pop, prev, next, title, titleText, days, grid, period, month, year, hour, minute, now, wipe, done };
}

function datePickerValue(picker) {
  const cut = readCutoff(picker.input.value);
  return cut.ok && cut.at ? new Date(cut.at) : null;
}

function syncWheels(picker) {
  spinWheel(picker.parts.hour, picker.hour);
  spinWheel(picker.parts.minute, picker.minute);
}

function syncPeriod(picker) {
  const parts = picker.parts;
  const thisYear = new Date().getFullYear();
  const from = Math.min(thisYear - YEARS_BACK, picker.year);
  const to = Math.max(thisYear + YEARS_ON, picker.year);
  if (picker.yearFrom !== from || parts.year.childElementCount !== to - from + 1) {
    picker.yearFrom = from;
    fillWheel(parts.year, Array.from({ length: to - from + 1 }, (_, i) => String(from + i)));
  }
  spinWheel(parts.month, picker.month);
  spinWheel(parts.year, picker.year - picker.yearFrom);
}

function stepMonth(picker, by) {
  const step = new Date(picker.year, picker.month + by, 1);
  picker.year = step.getFullYear();
  picker.month = step.getMonth();
  renderDatePicker(picker);
}

function renderDatePicker(picker) {
  const parts = picker.parts;
  const chosen = picker.chosen;
  parts.titleText.textContent = `${MONTH_NAMES[picker.month]} ${picker.year}`;
  if (parts.pop.classList.contains("is-period")) syncPeriod(picker);

  const first = new Date(picker.year, picker.month, 1);
  const shift = (first.getDay() + 6) % 7;
  const start = new Date(picker.year, picker.month, 1 - shift);
  const today = new Date();

  parts.grid.innerHTML = "";
  for (let i = 0; i < 42; i += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const cell = el("button", "dtp__day", String(day.getDate()));
    cell.type = "button";
    cell.dataset.day = `${day.getFullYear()}-${day.getMonth()}-${day.getDate()}`;
    cell.classList.toggle("is-out", day.getMonth() !== picker.month);
    cell.classList.toggle("is-today", sameDay(day, today));
    cell.classList.toggle("is-on", Boolean(chosen) && sameDay(day, chosen));
    parts.grid.appendChild(cell);
  }
}

function emitDatePicker(picker, date) {
  picker.chosen = date;
  picker.echo = true;
  picker.input.value = stampText(date);
  picker.input.dispatchEvent(new Event("input", { bubbles: true }));
  picker.echo = false;
  renderDatePicker(picker);
}

function pickDay(picker, key) {
  const [year, month, day] = String(key).split("-").map(Number);
  emitDatePicker(picker, new Date(year, month, day, picker.hour, picker.minute));
}

function slideDatePicker(picker) {
  const base = picker.chosen || new Date();
  emitDatePicker(picker, new Date(base.getFullYear(), base.getMonth(), base.getDate(), picker.hour, picker.minute));
}

function placeDatePicker(picker) {
  const pop = picker.parts.pop;
  const box = picker.input.getBoundingClientRect();
  const size = pop.getBoundingClientRect();
  const room = 10;

  let left = box.left;
  if (left + size.width > window.innerWidth - room) left = window.innerWidth - size.width - room;
  if (left < room) left = room;

  const under = box.bottom + 8;
  const above = box.top - size.height - 8;
  const wanted = under + size.height > window.innerHeight - room && above > room ? above : under;
  const roof = Math.max(room, window.innerHeight - size.height - room);

  pop.style.left = `${Math.round(left)}px`;
  pop.style.top = `${Math.round(Math.min(Math.max(wanted, room), roof))}px`;
}

function openDatePicker(picker) {
  if (openedDatePicker && openedDatePicker !== picker) closeDatePicker(openedDatePicker);

  const value = datePickerValue(picker) || new Date();
  picker.chosen = datePickerValue(picker);
  picker.year = value.getFullYear();
  picker.month = value.getMonth();
  picker.hour = value.getHours();
  picker.minute = value.getMinutes();

  picker.parts.pop.classList.remove("is-period");
  renderDatePicker(picker);
  picker.parts.pop.hidden = false;
  syncWheels(picker);
  placeDatePicker(picker);
  requestAnimationFrame(() => picker.parts.pop.classList.add("is-open"));
  openedDatePicker = picker;
}

function closeDatePicker(picker) {
  if (!picker) return;
  picker.parts.pop.classList.remove("is-open");
  if (openedDatePicker === picker) openedDatePicker = null;
  window.clearTimeout(picker.timer);
  picker.timer = window.setTimeout(() => {
    if (openedDatePicker !== picker) picker.parts.pop.hidden = true;
  }, 200);
  picker.input.dispatchEvent(new Event("change", { bubbles: true }));
}

function mountDatePicker(id) {
  const input = $(id);
  const button = document.querySelector(`[data-picker="${id}"]`);
  if (!input || !button || datePickers.has(id)) return;

  const picker = {
    input,
    parts: buildDatePicker(),
    chosen: null,
    timer: null,
    year: new Date().getFullYear(),
    month: new Date().getMonth(),
    hour: 12,
    minute: 0
  };
  datePickers.set(id, picker);
  const parts = picker.parts;

  button.addEventListener("mousedown", (event) => event.preventDefault());
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (openedDatePicker === picker) closeDatePicker(picker);
    else openDatePicker(picker);
  });
  input.addEventListener("focus", () => {
    if (openedDatePicker !== picker) openDatePicker(picker);
  });
  input.addEventListener("click", () => {
    if (openedDatePicker !== picker) openDatePicker(picker);
  });

  parts.pop.addEventListener("mousedown", (event) => event.preventDefault());
  parts.pop.addEventListener("click", (event) => event.stopPropagation());

  parts.prev.addEventListener("click", () => stepMonth(picker, -1));
  parts.next.addEventListener("click", () => stepMonth(picker, 1));
  parts.title.addEventListener("click", () => {
    const on = parts.pop.classList.toggle("is-period");
    if (on) syncPeriod(picker);
    placeDatePicker(picker);
  });
  parts.grid.addEventListener("click", (event) => {
    const cell = event.target.closest("[data-day]");
    if (cell) pickDay(picker, cell.dataset.day);
  });

  for (const unit of ["hour", "minute"]) {
    bindWheel(parts[unit], (value) => {
      if (picker[unit] === value) return;
      picker[unit] = value;
      slideDatePicker(picker);
    });
  }
  bindWheel(parts.month, (value) => {
    if (picker.month === value) return;
    picker.month = value;
    renderDatePicker(picker);
  });
  bindWheel(parts.year, (value) => {
    const year = picker.yearFrom + value;
    if (picker.year === year) return;
    picker.year = year;
    renderDatePicker(picker);
  });
  parts.now.addEventListener("click", () => {
    const at = new Date();
    picker.year = at.getFullYear();
    picker.month = at.getMonth();
    picker.hour = at.getHours();
    picker.minute = at.getMinutes();
    emitDatePicker(picker, at);
    syncWheels(picker);
  });
  parts.wipe.addEventListener("click", () => {
    picker.chosen = null;
    picker.input.value = "";
    picker.input.dispatchEvent(new Event("input", { bubbles: true }));
    closeDatePicker(picker);
  });
  parts.done.addEventListener("click", () => closeDatePicker(picker));

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && openedDatePicker === picker) closeDatePicker(picker);
  });
  input.addEventListener("input", () => {
    if (openedDatePicker !== picker || picker.echo) return;
    const value = datePickerValue(picker);
    if (!value) return;
    picker.chosen = value;
    picker.year = value.getFullYear();
    picker.month = value.getMonth();
    picker.hour = value.getHours();
    picker.minute = value.getMinutes();
    renderDatePicker(picker);
    syncWheels(picker);
  });
}

document.addEventListener(
  "input",
  (event) => {
    const input = event.target;
    if (!input?.matches?.(".dtp-field input")) return;
    const masked = maskStamp(input.value);
    if (masked === input.value) return;
    const tail = input.selectionStart === input.value.length;
    input.value = masked;
    if (tail) input.setSelectionRange(masked.length, masked.length);
  },
  true
);

document.addEventListener("pointerdown", (event) => {
  if (!openedDatePicker) return;
  if (event.target.closest(".dtp") || event.target.closest(".dtp-field")) return;
  closeDatePicker(openedDatePicker);
});

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && openedDatePicker) closeDatePicker(openedDatePicker);
});

function trackDatePicker() {
  if (!openedDatePicker) return;
  const box = openedDatePicker.input.getBoundingClientRect();
  if (box.bottom < 0 || box.top > window.innerHeight) closeDatePicker(openedDatePicker);
  else placeDatePicker(openedDatePicker);
}

window.addEventListener("resize", trackDatePicker);
document.addEventListener("scroll", trackDatePicker, true);

function renderViewCutoff() {
  viewCutoffEl.classList.toggle("is-bad", !readCutoff(viewCutoffEl.value).ok);
  reveal($("view-cutoff-clear"), Boolean(ui.viewCutoff));
}

function renderResults(payload, fresh) {
  const results = (payload?.results || []).filter(Boolean);
  changeLabels = payload?.changeLabels || {};
  ui.finished = payload || null;
  ui.reportSaved = false;
  viewCutoffEl.value = "";
  setViewCutoff("", true);

  indexResults(false);
  renderResultHead();
  renderViewCutoff();
  setResultView(resultView);

  const duration = Number(payload?.durationMs) || 0;
  setText($("gauge-elapsed"), duration ? fmtDuration(duration) : "—");
  setText($("gauge-rate"), fmtRate(duration && results.length ? (results.length / duration) * 60000 : 0));
  setText($("gauge-eta"), payload?.stopped ? "стоп" : "0:00");

  ui.hasResults = true;
  renderRuns();
  updateFormState();
  setStep("result");

  if (fresh && duration > 4000 && results.length >= 5 && !payload?.stopped) {
    const measured = (results.length / duration) * 60000;
    ui.rates = { ...ui.rates, auto: measured };
    patchSettings({ rates: ui.rates });
  }
}

const REPORT_SHEET = "Все ID";
const DETAIL_SHEET = "Последние действия";

const CUTOFF_RE = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})[\s,]+(\d{1,2}):(\d{2})(?::(\d{2}))?$/;

function readCutoff(raw) {
  const text = String(raw || "").trim();
  if (!text) return { ok: true, text: "", at: 0 };

  const parts = text.match(CUTOFF_RE);
  if (!parts) return { ok: false, text, at: 0 };

  const day = Number(parts[1]);
  const month = Number(parts[2]);
  const year = Number(parts[3]);
  const hour = Number(parts[4]);
  const minute = Number(parts[5]);
  const second = Number(parts[6] || 0);
  if (hour > 23 || minute > 59 || second > 59) return { ok: false, text, at: 0 };

  const back = new Date(year, month - 1, day, hour, minute, second);
  if (back.getFullYear() !== year || back.getMonth() !== month - 1 || back.getDate() !== day) {
    return { ok: false, text, at: 0 };
  }
  const at = back.getTime();

  const tail = second ? `:${pad(second)}` : "";
  return { ok: true, text: `${pad(day)}.${pad(month)}.${year} ${pad(hour)}:${pad(minute)}${tail}`, at };
}

function cutoffNow() {
  return ui.viewCutoff || readCutoff(ui.finished?.cutoffText).at || Date.now();
}

function dateColumnAt(report) {
  return columnAt(report, /^дата/i, 1);
}

function hitsOf(report) {
  const list = Array.isArray(report?.hits) ? report.hits : [];
  const found = [];
  for (const hit of list) {
    const at = parseHubDate(hit?.at);
    if (at) found.push({ ms: at.getTime(), at: String(hit.at), cell: String(hit?.cell || "") });
  }
  if (found.length) return found.sort((a, b) => b.ms - a.ms);

  const single = parseHubDate(report?.warehouseAt);
  if (!single) return [];
  return [
    {
      ms: single.getTime(),
      at: String(report.warehouseAt),
      cell: String(report?.warehouseCell || "")
    }
  ];
}

function cutItem(item, at) {
  const report = item?.report;
  const kind = classify(item);
  if (!report || kind === "issue") return item;

  const dateAt = dateColumnAt(report);
  const source = Array.isArray(report.lastRows) ? report.lastRows : [];
  const codes = Array.isArray(report.codes) ? report.codes : [];
  const rows = [];
  const kept = [];
  source.forEach((row, index) => {
    const stamp = parseHubDate(Array.isArray(row) ? row[dateAt] : "");
    if (stamp && stamp.getTime() > at) return;
    rows.push(row);
    kept.push(codes[index] ?? "");
  });

  const list = hitsOf(report);
  const top = list.find((hit) => hit.ms <= at) || null;
  const dated = list.length > 0;

  const next = {
    ...item,
    found: top ? true : !dated && Boolean(item.found),
    report: {
      ...report,
      lastRows: rows,
      codes: kept,
      warehouseAt: top ? top.at : dated ? "" : report.warehouseAt,
      warehouseCell: top ? top.cell : dated ? "" : report.warehouseCell,
      lastPlace: ""
    }
  };

  if (!top && dated && kind === "hit") {
    next.ok = false;
    next.status = "later";
  }
  return next;
}

function shownResults() {
  const results = (ui.finished?.results || []).filter(Boolean);
  if (!ui.viewCutoff) return results;
  return results.map((item) => cutItem(item, ui.viewCutoff));
}

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

const BUCKET_ORDER = [...BUCKETS.map((bucket) => bucket.label), "48 ч+"];

function bucketDateOf(report) {
  return String(report?.warehouseAt || "").trim() || topDateOf(report);
}

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
  return `https://hub.o3t.ru/management/stock/item/Lozon:${encodeURIComponent(clean)}?&tab=transitionHistory`;
}

const CHECK_STATUS = {
  complete: "проверено",
  later: "след позже потолка",
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

function buildXlsx() {
  const entries = statsRowsForExport();
  const cols = statsCols.filter((key) => STATS_COLUMNS[key]);

  const detailRows = [];
  const anchors = new Map();

  entries.forEach((entry, index) => {
    const report = entry.item.report;
    if (!report?.lastRows?.length) return;

    const reportRow = index + 2;
    anchors.set(index, `'${DETAIL_SHEET}'!A${detailRows.length + 1}`);

    detailRows.push([
      { text: report.number || "", style: xlsxStyles.STYLE_TITLE },
      { text: entry.item.posting, link: hubUrl(entry.item.posting) },
      { text: verdictOf(entry.item).text, style: xlsxStyles.STYLE_MUTED },
      { text: "← к отчёту", anchor: `'${REPORT_SHEET}'!A${reportRow}`, style: xlsxStyles.STYLE_BACK }
    ]);

    const columns = report.columns?.length
      ? report.columns
      : Array.from({ length: report.lastRows[0].length }, (_, i) => `Колонка ${i + 1}`);
    detailRows.push(columns.map((title) => ({ text: title, style: xlsxStyles.STYLE_HEAD })));

    for (const row of withLabels(report)) detailRows.push(row.map((value) => ({ text: value })));
    detailRows.push([]);
  });

  const head = cols.map((key) => ({ text: STATS_COLUMNS[key].title, style: xlsxStyles.STYLE_HEAD }));
  head.push({ text: "Детализация", style: xlsxStyles.STYLE_HEAD });
  const reportRows = [head];

  entries.forEach((entry, index) => {
    const row = cols.map((key) => {
      const column = STATS_COLUMNS[key];
      const cell = { text: column.text(entry) };
      if (column.link) cell.link = column.link(entry);
      return cell;
    });
    const anchor = anchors.get(index);
    row.push(anchor ? { text: "детализация →", anchor, style: xlsxStyles.STYLE_JUMP } : { text: "" });
    reportRows.push(row);
  });

  const reportColumns = cols.map((key) => ({
    title: STATS_COLUMNS[key].title,
    width: STATS_COLUMNS[key].width
  }));
  reportColumns.push({ title: "Детализация", width: 16 });

  const detailWidths = [
    { width: 24 }, { width: 22 }, { width: 30 }, { width: 72 },
    { width: 40 }, { width: 40 }, { width: 40 }, { width: 40 }
  ];

  return buildXlsxBlob({
    sheets: [
      {
        name: REPORT_SHEET,
        columns: reportColumns,
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
  const at = new Date();
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}-${pad(at.getHours())}-${pad(at.getMinutes())}`;
  const marks = [];
  if (ui.finished?.cutoffText) marks.push("timed");
  if (ui.viewCutoff) marks.push("cut");
  const tag = marks.length ? `${marks.join("-")}-` : "";
  return `hub-trace-${tag}${stamp}.${extension}`;
}

function rememberWarehouse(value) {
  const clean = String(value || "").trim();
  if (!clean) return;
  ui.recentWarehouses = [clean, ...ui.recentWarehouses.filter((item) => item !== clean)].slice(0, 8);
  renderRecentWarehouses();
  patchSettings({ recentWarehouses: ui.recentWarehouses, warehouse: clean });
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
  const cutoff = readCutoff(cutoffEl.value);
  showError("");
  if (!cutoff.ok) {
    updateFormState();
    showError("Отпечаток времени пишем как 26.08.2026 12:00");
    return;
  }
  if (!postings.length || !warehouse) {
    updateFormState();
    return;
  }
  cutoffEl.value = cutoff.text;

  ui.jobId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  ui.running = true;
  ui.paused = false;
  ui.stopping = false;
  ui.hasResults = false;
  ui.finished = null;
  ui.reportSaved = false;

  rememberWarehouse(warehouse);
  patchSettings({ ...settings, warehouse, cutoffText: cutoff.text, lastPostings: postingsEl.value });
  await flushSettings();

  ensureKeepAlive();
  resetScanHud(postings.length);
  setStep("scan");

  const reply = await send({
    action: "startScan",
    jobId: ui.jobId,
    postings: [...postings],
    warehouse,
    cutoff: cutoff.at,
    cutoffText: cutoff.text,
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

postingsEl.addEventListener("input", () => {
  updateCount();
  patchSettings({ lastPostings: postingsEl.value });
});
warehouseEl.addEventListener("input", () => {
  updateFormState();
  patchSettings({ warehouse: warehouseEl.value.trim() });
});
warehouseEl.addEventListener("change", () => rememberWarehouse(warehouseEl.value));

cutoffEl.addEventListener("input", () => {
  updateFormState();
  patchSettings({ cutoffText: cutoffEl.value.trim() });
});
viewCutoffEl.addEventListener("input", () => setViewCutoff(viewCutoffEl.value));
viewCutoffEl.addEventListener("change", () => {
  const cut = readCutoff(viewCutoffEl.value);
  if (cut.ok && cut.text) viewCutoffEl.value = cut.text;
  setViewCutoff(viewCutoffEl.value);
});
$("view-cutoff-clear").addEventListener("click", () => {
  viewCutoffEl.value = "";
  setViewCutoff("");
});

cutoffEl.addEventListener("change", () => {
  const cutoff = readCutoff(cutoffEl.value);
  if (cutoff.ok && cutoff.text) cutoffEl.value = cutoff.text;
  updateFormState();
  patchSettings({ cutoffText: cutoffEl.value.trim() });
});

$("btn-clear").addEventListener("click", () => {
  postingsEl.value = "";
  updateCount();
  patchSettings({ lastPostings: "" });
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
  patchSettings({ lastPostings: postingsEl.value });
}

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

  if (result.kind === "xlsx") {
    showError(`В ${file.name} не нашлось ни одного ID (от 10 цифр подряд).`);
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

function absorbState(next) {
  if (!next) return;
  ui.running = Boolean(next.running);
  ui.paused = Boolean(next.paused);
  ui.stopping = Boolean(next.stopping);
  ui.workers = Array.isArray(next.workers) ? next.workers : [];
  ui.retryRound = Number(next.retryRound) || 0;
  ui.retryTotal = Number(next.retryTotal) || 0;
  ui.retryLeft = Number(next.retryLeft) || 0;
  ui.elapsedMs = Number(next.elapsedMs) || 0;
  ui.elapsedAt = Date.now();
  if (next.total) ui.total = next.total;

  renderLanes();
  renderRunState();
  updateScanHud();
  tickLive();
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === "scanProgress") {
    if (message.total) ui.total = message.total;
    if (typeof message.retryTotal === "number") {
      ui.retryRound = Number(message.retryRound) || 0;
      ui.retryTotal = message.retryTotal;
      ui.retryLeft = Number(message.retryLeft) || 0;
    }
    if (message.item && typeof message.index === "number" && message.index >= 0) {
      applyItem(message.index, message.item);
      renderFeed(message.item);
      if (ui.running && !ui.stopping) addRadarBlip(classify(message.item));
      $("scan-current").textContent = ui.retryLeft
        ? `Добор: ${message.item.posting} · ${statusLabel(message.item)}`
        : `${message.item.posting} · ${statusLabel(message.item)}`;
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
    if (message.level === "api") return;
    toast(message.level === "error" ? "error" : "ok", message.text);
    return;
  }

  if (message?.action === "scanRevalidate") {
    for (const index of message.indexes || []) dropItem(index);
    updateScanHud();
    return;
  }

  if (message?.action === "scanFinished") {
    ui.running = false;
    ui.paused = false;
    ui.stopping = false;
    renderRunState();
    if (message.finished?.results?.length) {
      renderResults(message.finished, true);
      return;
    }
    void storageGet([STORAGE_FINISHED]).then((saved) => {
      const finished = saved[STORAGE_FINISHED];
      if (finished?.results?.length) renderResults(finished, true);
      else {
        $("scan-current").textContent = "Сейчас ничего не проверяется";
        syncSteps();
      }
    });
  }
});

function applySavedSettings(saved) {
  if (!saved) return;
  if (Array.isArray(saved.statsCols)) {
    const cols = saved.statsCols.filter((key) => STATS_COLUMNS[key]);
    if (cols.length) statsCols = [...new Set(cols)];
  }
  if (saved.statsSort === null) statsSort = null;
  else if (saved.statsSort && STATS_COLUMNS[saved.statsSort.key]) {
    statsSort = { key: saved.statsSort.key, dir: saved.statsSort.dir < 0 ? -1 : 1 };
  }
  if (RESULT_VIEWS.includes(saved.resultView)) resultView = saved.resultView;
  if (Array.isArray(saved.statsPanels)) {
    const panels = saved.statsPanels
      .filter((panel) => STATS_DIMS[panel?.dim] && STATS_VIZ[panel?.viz])
      .map((panel) => ({ dim: panel.dim, viz: panel.viz }))
      .slice(0, MAX_PANELS);
    if (panels.length) statsPanels = panels;
  }
  if (saved.warehouse) warehouseEl.value = saved.warehouse;
  if (saved.cutoffText) cutoffEl.value = saved.cutoffText;
  if (Array.isArray(saved.recentWarehouses)) ui.recentWarehouses = saved.recentWarehouses;
  if (saved.rates && typeof saved.rates === "object") ui.rates = saved.rates;
  if (saved.lastPostings) postingsEl.value = saved.lastPostings;
}

async function boot() {
  ensureKeepAlive();
  mountDatePicker("cutoff");
  mountDatePicker("view-cutoff");

  const saved = await storageGet([STORAGE_SETTINGS, STORAGE_FINISHED]);
  applySavedSettings(saved[STORAGE_SETTINGS]);
  renderBrief();
  renderRecentWarehouses();
  void loadRuns();
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

const VERDICT_ITEMS = [
  { value: "hit", label: "склад есть" },
  { value: "miss", label: "склада нет" },
  { value: "issue", label: "не вышло" }
];

let detailQuery = [];
let detailIndex = [];
const detailFilters = { verdict: [], bucket: [], status: [] };

function detailFits(key, value) {
  const list = detailFilters[key];
  return !list.length || list.includes(value);
}

function haystackOf(item) {
  const report = item.report || {};
  const kind = classify(item);
  return [
    item.posting,
    report.number,
    report.status,
    report.warehouseAt,
    report.warehouseCell,
    report.lastPlace,
    bucketOf(bucketDateOf(report), cutoffNow()),
    kind === "hit" ? "есть склад" : kind === "miss" ? "нет склада" : "не вышло",
    CHECK_STATUS[item.status] || item.status,
    ...(report.columns || []),
    ...withLabels(report).flat()
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function buildDetailIndex(results) {
  detailIndex = results.map((item) => ({ item, hay: haystackOf(item) }));
}

function fillFilterOptions() {
  const buckets = [];
  const statuses = [];
  for (const { item } of detailIndex) {
    const bucket = bucketOf(bucketDateOf(item.report), cutoffNow());
    if (bucket && !buckets.includes(bucket)) buckets.push(bucket);
    const status = item.report?.status;
    if (status && !statuses.includes(status)) statuses.push(status);
  }
  buckets.sort((a, b) => BUCKET_ORDER.indexOf(a) - BUCKET_ORDER.indexOf(b));
  statuses.sort((a, b) => a.localeCompare(b, "ru"));

  setPickerItems("filter-bucket", buckets);
  setPickerItems("filter-status", statuses);
}

function passesFilters(item) {
  if (!detailFits("verdict", classify(item))) return false;
  if (!detailFits("status", item.report?.status || "")) return false;
  if (!detailFits("bucket", bucketOf(bucketDateOf(item.report), cutoffNow()))) return false;
  return true;
}

function filtersActive() {
  return Object.values(detailFilters).some((list) => list.length) || detailQuery.length > 0;
}

const RESULT_VIEWS = ["list", "detail", "stats"];
let resultView = "list";
let viewSwapTimer = null;

function resultPanes() {
  return {
    list: document.querySelector(".result-grid"),
    detail: $("result-detail"),
    stats: $("result-stats")
  };
}

function setResultView(view, animate) {
  const tabs = $("result-tabs");
  const panes = resultPanes();
  const to = panes[view];
  if (!tabs || !to) return;

  const buttons = $$(".seg__btn", tabs);
  const at = buttons.findIndex((btn) => btn.dataset.view === view);
  tabs.style.setProperty("--seg-index", String(Math.max(0, at)));
  tabs.style.setProperty("--seg-count", String(buttons.length || 1));
  for (const btn of buttons) btn.classList.toggle("is-on", btn.dataset.view === view);

  const from = panes[resultView];
  const same = resultView === view;
  resultView = view;
  patchSettings({ resultView: view });

  window.clearTimeout(viewSwapTimer);
  const show = () => {
    for (const [key, pane] of Object.entries(panes)) {
      if (!pane || key === view) continue;
      pane.hidden = true;
      pane.classList.remove("is-leaving");
    }
    to.hidden = false;
    if (view === "detail") renderDetail();
    if (view === "stats") renderStats();
  };

  if (!animate || same || !from || from.hidden) {
    show();
    return;
  }
  from.classList.add("is-leaving");
  viewSwapTimer = window.setTimeout(show, 160);
}

function parseDetailQuery(raw) {
  return String(raw || "")
    .split(/[\s;]+|,(?!\d{2}(?!\d))/)
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean);
}

function matchesDetail(entry) {
  if (!passesFilters(entry.item)) return false;
  if (!detailQuery.length) return true;
  return detailQuery.some((needle) => entry.hay.includes(needle));
}

function verdictOf(item) {
  const kind = classify(item);
  if (kind === "hit") return { className: "is-hit", text: "склад есть" };
  if (kind === "miss") return { className: "is-miss", text: "склада нет" };
  return { className: "is-issue", text: statusLabel(item) };
}

const pickers = new Map();

const PICKER_SEARCH_FROM = 8;

function mountPicker(id, onPick) {
  const host = $(id);
  if (!host || pickers.has(id)) return pickers.get(id) || null;

  const anyLabel = host.dataset.any || "любое";
  const btn = el("button", "mselect__btn");
  btn.type = "button";
  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");
  const value = el("span", "mselect__value");
  const caret = el("i", "mselect__caret");
  btn.append(value, caret);

  const pop = el("div", "mselect__pop");
  pop.hidden = true;
  const search = document.createElement("input");
  search.className = "mselect__search";
  search.type = "text";
  search.placeholder = "Найти";
  search.autocomplete = "off";
  const list = el("div", "mselect__list");
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-multiselectable", "true");
  const foot = el("div", "mselect__foot");
  const tally = el("span", "mselect__tally");
  const clear = el("button", "mselect__clear", "Снять всё");
  clear.type = "button";
  foot.append(tally, clear);
  pop.append(search, list, foot);
  host.append(btn, pop);

  const picker = {
    id, host, btn, value, pop, search, list, foot, tally, clear, anyLabel,
    items: [], values: [], open: false, timer: null, onPick
  };
  pickers.set(id, picker);

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (picker.open) closePicker(id);
    else openPicker(id);
  });
  clear.addEventListener("click", () => applyPicker(picker, []));
  search.addEventListener("input", () => renderPickerList(picker));
  pop.addEventListener("click", (event) => event.stopPropagation());
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (!option) return;
    const one = option.dataset.value;
    const has = picker.values.includes(one);
    applyPicker(picker, has ? picker.values.filter((v) => v !== one) : [...picker.values, one]);
  });
  list.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const all = [...list.querySelectorAll(".mselect__opt")];
    const at = all.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    all[(next + all.length) % all.length]?.focus({ preventScroll: true });
  });

  renderPickerValue(picker);
  return picker;
}

function applyPicker(picker, values) {
  picker.values = [...new Set(values)];
  renderPickerValue(picker);
  paintPickerMarks(picker);
  picker.onPick(picker.values);
}

function paintPickerMarks(picker) {
  for (const option of picker.list.querySelectorAll(".mselect__opt")) {
    const on = picker.values.includes(option.dataset.value);
    option.classList.toggle("is-on", on);
    option.setAttribute("aria-selected", on ? "true" : "false");
  }
  picker.foot.hidden = !picker.values.length;
  picker.tally.textContent = `выбрано ${picker.values.length} из ${picker.items.length}`;
}

function renderPickerValue(picker) {
  const { values, items } = picker;
  const labelOf = (one) => items.find((item) => item.value === one)?.label || one;
  picker.host.classList.toggle("is-set", values.length > 0);
  if (!values.length) picker.value.textContent = picker.anyLabel;
  else if (values.length === 1) picker.value.textContent = labelOf(values[0]);
  else picker.value.textContent = `${labelOf(values[0])} +${values.length - 1}`;
  picker.value.title = values.length > 1 ? values.map(labelOf).join(", ") : "";
}

function renderPickerList(picker) {
  const { items, values, list, search } = picker;
  const needle = search.value.trim().toLowerCase();
  const shown = needle ? items.filter((item) => item.label.toLowerCase().includes(needle)) : items;
  search.hidden = items.length < PICKER_SEARCH_FROM;
  picker.foot.hidden = !values.length;
  picker.tally.textContent = `выбрано ${values.length} из ${items.length}`;

  list.replaceChildren();
  if (!shown.length) {
    list.appendChild(el("p", "mselect__none", items.length ? "Ничего не нашлось" : "Значений нет"));
    return;
  }
  for (const item of shown) {
    list.appendChild(pickerOption(item.value, item.label, values.includes(item.value)));
  }
}

function fitPop(host, pop) {
  pop.classList.remove("is-up", "is-left");
  const box = host.getBoundingClientRect();
  if (box.bottom + pop.offsetHeight + 12 > window.innerHeight && box.top > pop.offsetHeight + 12) {
    pop.classList.add("is-up");
  }
  if (box.left + pop.offsetWidth + 12 > window.innerWidth) pop.classList.add("is-left");
}

function fitPicker(picker) {
  fitPop(picker.host, picker.pop);
}

function pickerOption(value, label, on) {
  const option = el("button", `mselect__opt${on ? " is-on" : ""}`);
  option.type = "button";
  option.dataset.value = value;
  option.setAttribute("role", "option");
  option.setAttribute("aria-selected", on ? "true" : "false");
  option.append(el("i", "mselect__mark"), el("span", "mselect__label", label));
  return option;
}

const singles = new Set();

function shutSingle(one) {
  if (!one.open) return;
  one.open = false;
  one.pop.classList.remove("is-open");
  one.btn.setAttribute("aria-expanded", "false");
  one.host.classList.remove("is-open");
  window.clearTimeout(one.timer);
  one.timer = window.setTimeout(() => {
    if (!one.open) one.pop.hidden = true;
  }, 200);
}

function closeSingles(keep) {
  for (const one of [...singles]) {
    if (!one.host.isConnected) {
      singles.delete(one);
      one.pop.remove();
    } else if (one !== keep) {
      shutSingle(one);
    }
  }
}

function placeSingle(one) {
  const pop = one.pop;
  const box = one.btn.getBoundingClientRect();
  pop.style.minWidth = `${box.width}px`;
  const size = pop.getBoundingClientRect();
  const room = 10;

  let top = box.bottom + 6;
  if (top + size.height + room > window.innerHeight && box.top - size.height - 6 > room) {
    top = box.top - size.height - 6;
  }
  pop.style.top = `${Math.max(room, Math.min(top, window.innerHeight - size.height - room))}px`;
  pop.style.left = `${Math.max(room, Math.min(box.left, window.innerWidth - size.width - room))}px`;
}

function openSingle(one) {
  closeAllPickers();
  closeSingles(one);
  if (one.open) return;
  one.open = true;
  window.clearTimeout(one.timer);
  one.paint();
  one.pop.hidden = false;
  one.btn.setAttribute("aria-expanded", "true");
  one.host.classList.add("is-open");
  placeSingle(one);
  requestAnimationFrame(() => one.pop.classList.add("is-open"));
}

function trackSingles() {
  for (const one of singles) {
    if (!one.open) continue;
    const box = one.btn.getBoundingClientRect();
    if (box.bottom < 0 || box.top > window.innerHeight) shutSingle(one);
    else placeSingle(one);
  }
}

window.addEventListener("resize", trackSingles);
document.addEventListener("scroll", trackSingles, true);

// список живёт на body: панели режут своим overflow всё, что вылезает за край
function bindSingle(host, btn, entries, value, onChange) {
  const pop = el("div", "mselect__pop mselect__pop--one");
  pop.hidden = true;
  const list = el("div", "mselect__list");
  list.setAttribute("role", "listbox");
  pop.appendChild(list);
  document.body.appendChild(pop);

  btn.setAttribute("aria-haspopup", "listbox");
  btn.setAttribute("aria-expanded", "false");

  const one = {
    host, btn, pop, open: false, timer: null,
    paint() {
      list.replaceChildren();
      for (const [key, title] of entries) list.appendChild(pickerOption(key, title, key === value));
    }
  };
  singles.add(one);

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (one.open) shutSingle(one);
    else openSingle(one);
  });
  pop.addEventListener("click", (event) => event.stopPropagation());
  list.addEventListener("click", (event) => {
    const option = event.target.closest("[data-value]");
    if (!option) return;
    shutSingle(one);
    if (option.dataset.value !== value) onChange(option.dataset.value);
  });
  return one;
}

function openPicker(id) {
  closeSingles(null);
  for (const other of pickers.keys()) if (other !== id) closePicker(other);
  const picker = pickers.get(id);
  if (!picker || picker.open) return;
  picker.open = true;
  window.clearTimeout(picker.timer);
  picker.search.value = "";
  renderPickerList(picker);
  picker.pop.hidden = false;
  picker.btn.setAttribute("aria-expanded", "true");
  picker.host.classList.add("is-open");
  fitPicker(picker);
  requestAnimationFrame(() => picker.pop.classList.add("is-open"));
  if (!picker.search.hidden) picker.search.focus({ preventScroll: true });
}

function closePicker(id) {
  const picker = pickers.get(id);
  if (!picker || !picker.open) return;
  picker.open = false;
  picker.pop.classList.remove("is-open");
  picker.btn.setAttribute("aria-expanded", "false");
  picker.host.classList.remove("is-open");
  window.clearTimeout(picker.timer);
  picker.timer = window.setTimeout(() => {
    if (!picker.open) picker.pop.hidden = true;
  }, 200);
}

function closeAllPickers() {
  for (const id of pickers.keys()) closePicker(id);
}

function setPickerItems(id, items) {
  const picker = pickers.get(id);
  if (!picker) return;
  picker.items = items.map((item) => (typeof item === "string" ? { value: item, label: item } : item));
  picker.values = picker.values.filter((one) => picker.items.some((item) => item.value === one));
  renderPickerValue(picker);
  renderPickerList(picker);
}

function setPickerValues(id, values) {
  const picker = pickers.get(id);
  if (!picker) return;
  const next = [...new Set(values)];
  const same = next.length === picker.values.length && next.every((one, at) => one === picker.values[at]);
  if (same) return;
  picker.values = next;
  renderPickerValue(picker);
  if (picker.open) paintPickerMarks(picker);
}

document.addEventListener("click", () => {
  closeAllPickers();
  closeSingles(null);
});

function escapeClosedPicker() {
  const single = [...singles].find((one) => one.open);
  if (single) {
    shutSingle(single);
    single.btn.focus({ preventScroll: true });
    return true;
  }
  const open = [...pickers.values()].find((picker) => picker.open);
  if (!open) return false;
  closePicker(open.id);
  open.btn.focus({ preventScroll: true });
  return true;
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

const SVG_NS = "http://www.w3.org/2000/svg";

function svgEl(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs || {})) node.setAttribute(key, String(value));
  return node;
}

function crossIcon(className) {
  const cross = svgEl("svg", { viewBox: "0 0 12 12", class: className, "aria-hidden": "true" });
  cross.appendChild(
    svgEl("path", {
      d: "M3.5 3.5 8.5 8.5M8.5 3.5 3.5 8.5",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.25",
      "stroke-linecap": "round"
    })
  );
  return cross;
}

function caretIcon(className) {
  const caret = svgEl("svg", { viewBox: "0 0 12 12", class: className, "aria-hidden": "true" });
  caret.appendChild(
    svgEl("path", {
      d: "M2.5 4.5 6 8l3.5-3.5",
      fill: "none",
      stroke: "currentColor",
      "stroke-width": "1.6",
      "stroke-linecap": "round",
      "stroke-linejoin": "round"
    })
  );
  return caret;
}

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
  addFact("Корзинка", bucketOf(bucketDateOf(report), cutoffNow()));
  addFact("Когда", report.warehouseAt || topDateOf(report));
  addFact("Последняя ячейка", report.warehouseCell);
  if (classify(item) !== "hit") addFact("Предыдущий склад", report.lastPlace || topPlaceOf(withLabels(report)));
  if (facts.childElementCount) card.appendChild(facts);

  const rows = withLabels(report);
  if (!rows.length) {
    const why = ui.viewCutoff ? "До этого момента записей нет." : "Строки истории не прочитались.";
    card.appendChild(el("p", "card__none", why));
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

function renderTally(id, shown, all) {
  const box = $(id);
  if (!box) return;
  const filtered = shown !== all;
  box.innerHTML = "";
  box.classList.toggle("is-filtered", filtered);
  box.appendChild(el("b", null, String(shown)));
  box.appendChild(el("em", null, plural(shown, ["отправление", "отправления", "отправлений"])));
  if (filtered) box.appendChild(el("em", null, `из ${all}`));
}

const filterBoxes = new Map();

function countActive(values) {
  return values.filter(Boolean).length;
}

function closeFilterBox(name) {
  const box = filterBoxes.get(name);
  if (!box || !box.open) return;
  box.open = false;
  box.pop.classList.remove("is-open");
  box.btn.classList.remove("is-on");
  box.btn.setAttribute("aria-expanded", "false");
  window.clearTimeout(box.timer);
  box.timer = window.setTimeout(() => {
    if (!box.open) box.pop.hidden = true;
  }, 200);
}

function fitFilterBox(pop) {
  pop.style.setProperty("--shift", "0px");
  const parent = pop.offsetParent;
  const base = parent ? parent.getBoundingClientRect().left : 0;
  const left = base + pop.offsetLeft;
  const right = left + pop.offsetWidth;
  const pad = 12;

  let shift = 0;
  if (left < pad) shift = pad - left;
  else if (right > window.innerWidth - pad) shift = window.innerWidth - pad - right;
  if (shift) pop.style.setProperty("--shift", `${Math.round(shift)}px`);
}

function openFilterBox(name) {
  for (const other of filterBoxes.keys()) if (other !== name) closeFilterBox(other);
  const box = filterBoxes.get(name);
  if (!box || box.open) return;
  box.open = true;
  window.clearTimeout(box.timer);
  box.pop.hidden = false;
  box.btn.classList.add("is-on");
  box.btn.setAttribute("aria-expanded", "true");
  fitFilterBox(box.pop);
  requestAnimationFrame(() => box.pop.classList.add("is-open"));
}

function mountFilterBox(name, btnId, popId, countId) {
  const btn = $(btnId);
  const pop = $(popId);
  if (!btn || !pop) return;
  const box = { btn, pop, count: $(countId), open: false, timer: null };
  filterBoxes.set(name, box);

  btn.addEventListener("click", (event) => {
    event.stopPropagation();
    if (box.open) closeFilterBox(name);
    else openFilterBox(name);
  });
  pop.addEventListener("click", (event) => event.stopPropagation());
}

function renderFilterCount(name, active) {
  const box = filterBoxes.get(name);
  if (!box) return;
  for (const one of box.pop.querySelectorAll(".mselect")) {
    one.closest(".pick")?.classList.toggle("is-set", one.classList.contains("is-set"));
  }
  if (!box.count) return;
  reveal(box.count, active > 0);
  if (active) box.count.textContent = String(active);
  box.btn.classList.toggle("has-filters", active > 0);
}

document.addEventListener("click", () => {
  for (const name of filterBoxes.keys()) closeFilterBox(name);
});
window.addEventListener("resize", () => {
  for (const box of filterBoxes.values()) if (box.open) fitFilterBox(box.pop);
});
document.addEventListener("keydown", (event) => {
  if (event.key !== "Escape") return;
  if (escapeClosedPicker()) return;
  for (const [name, box] of filterBoxes) if (box.open) closeFilterBox(name);
});

function renderDetailChips() {
  const box = $("detail-chips");
  if (!box) return;
  const show = detailQuery.length >= 2;
  box.closest(".detail__bar")?.classList.toggle("has-chips", show);
  if (!show) {
    emptyLater(box);
    return;
  }
  emptyNow(box);
  for (const value of detailQuery) {
    const chip = el("span", "detail__chip", value);
    const drop = el("button");
    drop.type = "button";
    drop.title = "Убрать из поиска";
    drop.appendChild(crossIcon());
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

  renderTally("detail-count", shown.length, all);
  renderFilterCount("detail", countActive(Object.values(detailFilters).map((list) => list.length)));
  reveal($("filter-reset"), filtersActive());
  renderDetailChips();

  list.innerHTML = "";
  if (!shown.length) {
    const empty = el("div", "detail__empty");
    empty.appendChild(el("b", null, all ? "Ничего не нашлось" : "Пока пусто"));
    empty.appendChild(
      el("span", null, all ? "Смягчите фильтры или очистите поиск." : "Запустите проверку — детали появятся здесь.")
    );
    list.appendChild(empty);
    playSwap(list);
    return;
  }

  const LIMIT = 300;
  for (const entry of shown.slice(0, LIMIT)) list.appendChild(detailCard(entry.item));
  if (shown.length > LIMIT) {
    const more = el("div", "detail__empty");
    more.appendChild(el("b", null, `Показаны первые ${LIMIT}`));
    more.appendChild(el("span", null, "Сузьте поиск или фильтры, чтобы увидеть остальные."));
    list.appendChild(more);
  }
  playSwap(list);
}

function mountDetail() {
  mountFilterBox("detail", "detail-filters-btn", "detail-filters-pop", "detail-filters-count");
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

  for (const [id, key] of [["filter-verdict", "verdict"], ["filter-bucket", "bucket"], ["filter-status", "status"]]) {
    mountPicker(id, (values) => {
      detailFilters[key] = values;
      renderDetail();
    });
  }
  setPickerItems("filter-verdict", VERDICT_ITEMS);

  $("filter-reset")?.addEventListener("click", () => {
    resetDetailFilters();
    renderDetail();
  });
}

const DETAIL_SELECTS = { verdict: "filter-verdict", bucket: "filter-bucket", status: "filter-status" };

function resetDetailFilters() {
  detailQuery = [];
  for (const key of Object.keys(detailFilters)) detailFilters[key] = [];
  const search = $("detail-search");
  if (search) search.value = "";
  for (const id of Object.values(DETAIL_SELECTS)) setPickerValues(id, []);
}

function syncDetailControls() {
  for (const [key, id] of Object.entries(DETAIL_SELECTS)) setPickerValues(id, detailFilters[key]);
}

mountDetail();

let statsIndex = [];
let statsQuery = [];

const statsFilters = {
  verdict: [],
  cell: [],
  place: [],
  bucket: [],
  status: [],
  op: [],
  day: [],
  user: [],
  hour: []
};

function filterList(key) {
  return statsFilters[key] || [];
}

function filterOn(key) {
  return filterList(key).length > 0;
}

function filterFits(key, value) {
  const list = filterList(key);
  return !list.length || list.includes(value);
}

function setStatsFilter(key, values) {
  statsFilters[key] = [...new Set(values.filter(Boolean))];
  renderStats();
}

function toggleStatsFilter(key, value, add) {
  const list = filterList(key);
  const has = list.includes(value);
  if (add) setStatsFilter(key, has ? list.filter((one) => one !== value) : [...list, value]);
  else setStatsFilter(key, has && list.length === 1 ? [] : [value]);
}

let statsSort = { key: "at", dir: -1 };

function firstSortDir(key) {
  return key === "at" ? -1 : 1;
}

function nextSort(key) {
  const first = firstSortDir(key);
  if (!statsSort || statsSort.key !== key) return { key, dir: first };
  if (statsSort.dir === first) return { key, dir: -first };
  return null;
}

const STATS_VIZ = { bars: "Гистограмма", cols: "Столбики", line: "График", donut: "Диаграмма" };
const DEFAULT_PANELS = [
  { dim: "cell", viz: "bars" },
  { dim: "place", viz: "bars" },
  { dim: "day", viz: "cols" },
  { dim: "status", viz: "bars" }
];
const MAX_PANELS = 8;
let statsPanels = DEFAULT_PANELS.map((panel) => ({ ...panel }));

function persistStatsPanels() {
  patchSettings({ statsPanels });
}

const STATS_SELECTS = {
  verdict: "stats-verdict",
  cell: "stats-cell",
  place: "stats-place",
  bucket: "stats-bucket",
  status: "stats-status",
  op: "stats-op"
};

function lastCellOf(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const sides = text.split("→").map((side) => side.trim()).filter(Boolean);
  for (let i = sides.length - 1; i >= 0; i -= 1) {
    if (sides[i] && sides[i] !== "—") return sides[i];
  }
  return "";
}

function topPlaceOf(rows) {
  let fallback = "";
  for (const row of rows || []) {
    for (const cell of row || []) {
      const text = String(cell || "");
      if (!text.includes("Местоположение:")) continue;
      for (const part of text.split(/;\s*/)) {
        const at = part.indexOf("Местоположение:");
        if (at < 0) continue;
        const value = part.slice(at + "Местоположение:".length).trim();
        const sides = value.split("→").map((side) => side.trim()).filter(Boolean);
        for (let i = sides.length - 1; i >= 0; i -= 1) {
          const side = sides[i];
          if (!side || side === "—") continue;
          const warehouse = side.match(/^(.*?)\s*·\s*Склад$/);
          if (warehouse) return warehouse[1].trim();
          if (!fallback) fallback = side.replace(/\s*·\s*[^·]+$/, "").trim();
        }
      }
    }
  }
  return fallback;
}

function topDateOf(report) {
  const rows = report?.lastRows;
  if (!Array.isArray(rows) || !rows.length) return "";
  return String(rows[0]?.[dateColumnAt(report)] || "").trim();
}

function blameOf(item) {
  const report = item.report || {};
  const kind = classify(item);
  if (kind === "hit") {
    return { kind: "cell", value: lastCellOf(report.warehouseCell), at: report.warehouseAt || topDateOf(report) };
  }
  if (kind === "miss") {
    const place = report.lastPlace || topPlaceOf(withLabels(report));
    return { kind: "place", value: place, at: topDateOf(report) };
  }
  return { kind: "none", value: "", at: "" };
}

const BLAME_TAGS = { cell: "ячейка", place: "склад" };

function topUserOf(report) {
  const rows = withLabels(report);
  if (!rows.length) return "";
  const value = String(rows[0]?.[userColumnAt(report)] || "").trim();
  return value === "—" ? "" : value;
}

function buildStatsIndex(results) {
  const now = cutoffNow();
  statsIndex = results.map((item) => {
    const blame = blameOf(item);
    const stamp = parseHubDate(blame.at);
    const op = String(withLabels(item.report)[0]?.[0] || "").trim();
    const user = topUserOf(item.report);
    const hour = stamp ? `${pad(stamp.getHours())}:00` : "";
    return {
      item,
      blame,
      op,
      user,
      hour,
      bucket: bucketOf(bucketDateOf(item.report), now),
      day: stamp ? `${pad(stamp.getDate())}.${pad(stamp.getMonth() + 1)}` : "",
      dayTs: stamp ? new Date(stamp.getFullYear(), stamp.getMonth(), stamp.getDate()).getTime() : 0,
      hay: [haystackOf(item), blame.value, BLAME_TAGS[blame.kind] || "", user, hour]
        .join(" ")
        .toLowerCase()
    };
  });
  assignStatsColors();
}

const STATS_NO_SKIP = new Set();

function passesStats(entry, skip) {
  const s = skip || STATS_NO_SKIP;
  const item = entry.item;
  if (!s.has("verdict") && !filterFits("verdict", classify(item))) return false;
  if (!s.has("op") && !filterFits("op", entry.op)) return false;
  if (!s.has("status") && !filterFits("status", item.report?.status || "")) return false;
  if (!s.has("bucket") && !filterFits("bucket", entry.bucket)) return false;
  if (!s.has("cell") && filterOn("cell")) {
    if (entry.blame.kind !== "cell" || !filterFits("cell", entry.blame.value)) return false;
  }
  if (!s.has("place") && filterOn("place")) {
    if (entry.blame.kind !== "place" || !filterFits("place", entry.blame.value)) return false;
  }
  if (!s.has("day") && !filterFits("day", entry.day)) return false;
  if (!s.has("user") && !filterFits("user", entry.user)) return false;
  if (!s.has("hour") && !filterFits("hour", entry.hour)) return false;
  if (statsQuery.length && !statsQuery.some((needle) => entry.hay.includes(needle))) return false;
  return true;
}

function statsFiltersActive() {
  return Object.values(statsFilters).some((list) => list.length) || statsQuery.length > 0;
}

function tallyBy(entries, keyOf) {
  const map = new Map();
  for (const entry of entries) {
    const key = keyOf(entry);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ru"));
}

function fillStatsOptions() {
  const blameValues = (kind) =>
    tallyBy(
      statsIndex.filter((entry) => entry.blame.kind === kind),
      (entry) => entry.blame.value
    ).map(([value]) => value);

  const buckets = [];
  const statuses = [];
  const ops = [];
  for (const entry of statsIndex) {
    if (entry.bucket && !buckets.includes(entry.bucket)) buckets.push(entry.bucket);
    const status = entry.item.report?.status;
    if (status && !statuses.includes(status)) statuses.push(status);
    if (entry.op && !ops.includes(entry.op)) ops.push(entry.op);
  }
  buckets.sort((a, b) => BUCKET_ORDER.indexOf(a) - BUCKET_ORDER.indexOf(b));
  statuses.sort((a, b) => a.localeCompare(b, "ru"));
  ops.sort((a, b) => a.localeCompare(b, "ru"));

  setPickerItems("stats-cell", blameValues("cell"));
  setPickerItems("stats-place", blameValues("place"));
  setPickerItems("stats-bucket", buckets);
  setPickerItems("stats-status", statuses);
  setPickerItems("stats-op", ops);
}

function syncStatsControls() {
  for (const [key, id] of Object.entries(STATS_SELECTS)) setPickerValues(id, filterList(key));
}

function renderStatsKpis(shown) {
  const host = $("stats-kpis");
  if (!host) return;

  let hits = 0;
  let misses = 0;
  let issues = 0;
  const cells = new Set();
  const places = new Set();
  for (const entry of shown) {
    const kind = classify(entry.item);
    if (kind === "hit") hits += 1;
    else if (kind === "miss") misses += 1;
    else issues += 1;
    if (entry.blame.kind === "cell" && entry.blame.value) cells.add(entry.blame.value);
    if (entry.blame.kind === "place" && entry.blame.value) places.add(entry.blame.value);
  }

  const tiles = [
    { label: "Склад есть", value: hits, mod: "hit" },
    { label: "Склада нет", value: misses, mod: "miss" },
    { label: "Не вышло", value: issues, mod: "issue" },
    { label: "Последних ячеек", value: cells.size, mod: "cell" },
    { label: "Предыдущих складов", value: places.size, mod: "place" }
  ];

  host.innerHTML = "";
  for (const tile of tiles) {
    const box = el("div", `kpi kpi--${tile.mod}`);
    box.appendChild(el("span", null, tile.label));
    box.appendChild(el("b", null, String(tile.value)));
    markValue(box, tile.value, tile.label);
    host.appendChild(box);
  }
  host.appendChild(deltaTile(hits, misses));
}

const DELTA_ARC = "M7 31A27 27 0 0 1 61 31";
const DELTA_LEN = Math.PI * 27;
// ниша дуги узкая, поэтому длинные значения садятся на меньший кегль
const DELTA_SIZES = [15, 15, 13.5, 11.5, 9.5, 8.5];

function deltaRow(mod, label, count) {
  const row = el("div", `delta__row delta__row--${mod}`);
  row.append(el("i", "delta__dot"), el("u", "delta__name", label), el("strong", "delta__val", String(count)));
  return row;
}

// дуга наливается от вершины в сторону перевеса, число живёт в её нише
function deltaTile(hits, misses) {
  const total = hits + misses;
  const gap = hits - misses;
  const half = DELTA_LEN / 2;
  const reach = total ? (Math.abs(gap) / total) * half : 0;
  const side = gap > 0 ? "hit" : gap < 0 ? "miss" : "even";

  const box = el("div", `kpi kpi--delta is-${side}`);
  box.title = total ? `Склад есть ${hits}, склада нет ${misses}` : "Сравнивать нечего";
  box.appendChild(el("span", null, "Разница"));

  const art = svgEl("svg", { viewBox: "0 0 68 34", class: "delta__art", "aria-hidden": "true" });
  art.appendChild(
    svgEl("path", { class: "delta__rail", d: DELTA_ARC, fill: "none", "stroke-width": "6", "stroke-linecap": "round" })
  );

  const live = svgEl("path", {
    class: "delta__live",
    d: DELTA_ARC,
    fill: "none",
    "stroke-width": "6",
    "stroke-linecap": "round"
  });
  live.style.strokeDasharray = `${reach} ${DELTA_LEN}`;
  live.style.strokeDashoffset = String(-(gap > 0 ? half : half - reach));
  art.appendChild(live);

  art.appendChild(svgEl("path", { class: "delta__pin", d: "M34 0.6V7.4", "stroke-width": "1.4", "stroke-linecap": "round" }));

  const shown = `${gap > 0 ? "+" : gap < 0 ? "−" : ""}${Math.abs(gap)}`;
  const num = svgEl("text", { class: "delta__num", x: "34", y: "27.5", "text-anchor": "middle" });
  num.style.fontSize = `${DELTA_SIZES[Math.min(shown.length, DELTA_SIZES.length) - 1]}px`;
  num.textContent = shown;
  art.appendChild(num);

  const wrap = el("div", "delta");
  const legend = el("div", "delta__legend");
  legend.append(deltaRow("hit", "есть", hits), deltaRow("miss", "нет", misses));
  wrap.append(art, legend);
  box.appendChild(wrap);

  markValue(box, gap, "Разница", total ? `${hits} к ${misses}` : "");
  return box;
}

function markPickGroup(node, key) {
  if (node && key) node.dataset.pickGroup = key;
  return node;
}

function markPick(node, value) {
  const text = String(value == null ? "" : value);
  if (node && text) node.dataset.pick = text;
  return node;
}

function addKey(event) {
  return Boolean(event && (event.ctrlKey || event.metaKey));
}

const SWEEP_SLOP = 5;
let sweep = null;
let sweepSwallow = false;

function sweepingNow() {
  return Boolean(sweep && sweep.moved);
}

function sweepItems(group) {
  return [...group.querySelectorAll("[data-pick]")];
}

function paintSweep(items, from, to) {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  items.forEach((node, at) => node.classList.toggle("is-sweep", at >= lo && at <= hi));
}

function endSweep(apply) {
  if (!sweep) return;
  const done = sweep;
  sweep = null;
  for (const node of done.items) node.classList.remove("is-sweep");
  done.host.classList.remove("is-sweeping");
  if (done.host.hasPointerCapture?.(done.id)) done.host.releasePointerCapture(done.id);
  if (!done.moved) return;
  sweepSwallow = true;
  if (!apply) return;
  const lo = Math.min(done.from, done.to);
  const hi = Math.max(done.from, done.to);
  const values = done.items.slice(lo, hi + 1).map((node) => node.dataset.pick);
  setStatsFilter(done.key, done.add ? [...filterList(done.key), ...values] : values);
}

function mountStatsSweep() {
  const host = $("stats-panels");
  if (!host) return;

  host.addEventListener("pointerdown", (event) => {
    sweepSwallow = false;
    if (event.button !== 0 || event.pointerType === "touch") return;
    const node = event.target.closest?.("[data-pick]");
    const group = node?.closest?.("[data-pick-group]");
    if (!node || !group?.dataset.pickGroup) return;
    const items = sweepItems(group);
    const at = items.indexOf(node);
    if (at < 0) return;
    sweep = {
      host,
      group,
      items,
      key: group.dataset.pickGroup,
      from: at,
      to: at,
      x: event.clientX,
      y: event.clientY,
      moved: false,
      add: addKey(event),
      id: event.pointerId
    };
  });

  host.addEventListener("pointermove", (event) => {
    if (!sweep || event.pointerId !== sweep.id) return;
    if (!sweep.moved) {
      if (Math.hypot(event.clientX - sweep.x, event.clientY - sweep.y) < SWEEP_SLOP) return;
      sweep.moved = true;
      host.classList.add("is-sweeping");
      host.setPointerCapture?.(event.pointerId);
      hideVizTip();
    }
    const under = document.elementFromPoint(event.clientX, event.clientY);
    const node = under?.closest?.("[data-pick]");
    if (node && sweep.group.contains(node)) {
      const at = sweep.items.indexOf(node);
      if (at >= 0) sweep.to = at;
    }
    paintSweep(sweep.items, sweep.from, sweep.to);
  });

  host.addEventListener("pointerup", (event) => {
    if (sweep && event.pointerId === sweep.id) endSweep(true);
  });
  host.addEventListener("pointercancel", (event) => {
    if (sweep && event.pointerId === sweep.id) endSweep(false);
  });

  host.addEventListener(
    "click",
    (event) => {
      if (!sweepSwallow) return;
      sweepSwallow = false;
      event.stopPropagation();
      event.preventDefault();
    },
    true
  );
}

mountStatsSweep();

function chartEmpty(host, text) {
  host.appendChild(el("p", "bars__none", text));
}

let vizTipEl = null;
let vizTipRaf = 0;

function vizTip() {
  if (vizTipEl?.isConnected) return vizTipEl;
  vizTipEl = el("div", "viztip");
  vizTipEl.hidden = true;
  document.body.appendChild(vizTipEl);
  return vizTipEl;
}

function placeVizTip(x, y) {
  const tip = vizTip();
  const box = tip.getBoundingClientRect();
  const pad = 14;
  let left = x + 16;
  let top = y + 18;
  if (left + box.width > window.innerWidth - pad) left = x - box.width - 16;
  if (top + box.height > window.innerHeight - pad) top = y - box.height - 14;
  tip.style.left = `${Math.max(pad, left)}px`;
  tip.style.top = `${Math.max(pad, top)}px`;
}

function hideVizTip() {
  if (!vizTipEl) return;
  vizTipEl.classList.remove("is-on");
  vizTipEl.hidden = true;
}

function showVizTip(event, content) {
  if (sweepingNow()) return;
  const data = typeof content === "function" ? content() : content;
  if (!data) return;
  const tip = vizTip();
  tip.innerHTML = "";

  const head = el("div", "viztip__head");
  if (data.color) {
    const mark = el("i");
    mark.style.background = data.color;
    head.appendChild(mark);
  }
  head.appendChild(el("span", null, data.title));
  tip.appendChild(head);

  for (const [label, value] of data.rows || []) {
    const row = el("div", "viztip__row");
    row.appendChild(el("span", null, label));
    row.appendChild(el("b", null, String(value)));
    tip.appendChild(row);
  }
  if (data.foot) tip.appendChild(el("p", "viztip__foot", data.foot));

  tip.hidden = false;
  tip.classList.add("is-on");
  placeVizTip(event.clientX, event.clientY);
}

function bindVizTip(node, content) {
  node.addEventListener("pointerenter", (event) => showVizTip(event, content));
  node.addEventListener("pointermove", (event) => {
    if (vizTipRaf) return;
    const { clientX, clientY } = event;
    vizTipRaf = requestAnimationFrame(() => {
      vizTipRaf = 0;
      if (vizTipEl && !vizTipEl.hidden) placeVizTip(clientX, clientY);
    });
  });
  node.addEventListener("pointerleave", hideVizTip);
  node.addEventListener("click", hideVizTip);
}

function shareText(count, total) {
  if (!total) return "—";
  const share = (count / total) * 100;
  return share >= 10 ? `${Math.round(share)}%` : `${share.toFixed(1)}%`;
}

function pickFoot(active, value) {
  const list = asList(active);
  if (list.includes(value)) return "Клик — снять, Ctrl — убрать из выбора";
  if (list.length) return "Клик — оставить только эти, Ctrl — добавить к выбору";
  return "Клик — оставить только эти ID, протянуть — выбрать несколько";
}

const STATS_CAT = ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181"];
const STATS_REST = "#5b6478";
const DAY_RAMP = ["#9ec4ff", "#63a3ef", "#3987e5", "#2262b8", "#184f95"];
const VERDICT_COLORS = { hit: "var(--viz-hit)", miss: "var(--viz-miss)", issue: "#e66767" };
const VERDICT_WORDS = { hit: "склад есть", miss: "склада нет", issue: "не вышло" };

const STATS_DIMS = {
  cell: {
    title: "Последняя ячейка",
    sub: "Искомый склад в истории есть. Ячейка, в которой предмет лежал на нём последний раз.",
    filter: "cell",
    hue: "var(--viz-hit)",
    of: (entry) => (entry.blame.kind === "cell" ? entry.blame.value : "")
  },
  place: {
    title: "Предыдущий склад",
    sub: "Искомого склада в истории нет. Склад, где предмет находится по последнему движению.",
    filter: "place",
    hue: "var(--viz-miss)",
    of: (entry) => (entry.blame.kind === "place" ? entry.blame.value : "")
  },
  verdict: {
    title: "Результат проверки",
    sub: "Чем закончилась проверка каждого ID.",
    filter: "verdict",
    of: (entry) => classify(entry.item),
    label: (value) => VERDICT_WORDS[value] || value,
    color: (value) => VERDICT_COLORS[value] || STATS_REST
  },
  status: {
    title: "Статусы отправлений",
    sub: "Статус предмета, как он написан в карточке Hub.",
    filter: "status",
    of: (entry) => entry.item.report?.status || ""
  },
  op: {
    title: "Последние операции",
    sub: "Что делали с предметом последним — тип верхней строки истории.",
    filter: "op",
    of: (entry) => entry.op
  },
  user: {
    title: "Кто делал операцию",
    sub: "Кто делал последнюю операцию.",
    filter: "user",
    of: (entry) => entry.user
  },
  day: {
    title: "По дням",
    sub: "Дата последней операции по предмету.",
    filter: "day",
    ordered: "day",
    of: (entry) => entry.day
  },
  hour: {
    title: "По часам",
    sub: "Час, в который прошла последняя операция.",
    filter: "hour",
    ordered: "hour",
    of: (entry) => entry.hour
  },
  bucket: {
    title: "Корзинки",
    sub: "Сколько прошло с последней операции по предмету.",
    filter: "bucket",
    ordered: "bucket",
    of: (entry) => entry.bucket
  }
};

let statsColors = {};

function assignStatsColors() {
  statsColors = {};
  for (const dim of ["cell", "place", "status", "op", "user"]) {
    const map = new Map();
    tallyBy(statsIndex, STATS_DIMS[dim].of).forEach(([value], index) => {
      map.set(value, STATS_CAT[index] || STATS_REST);
    });
    statsColors[dim] = map;
  }
}

function dimOrderKey(dimKey, entry) {
  if (dimKey === "day") return entry.dayTs;
  if (dimKey === "hour") return Number(entry.hour.slice(0, 2));
  if (dimKey === "bucket") {
    const at = BUCKET_ORDER.indexOf(entry.bucket);
    return at < 0 ? BUCKET_ORDER.length : at;
  }
  return 0;
}

function dimRows(dimKey, slice) {
  const dim = STATS_DIMS[dimKey];
  const rows = tallyBy(slice, dim.of);
  if (!dim.ordered) return rows;
  const order = new Map();
  for (const entry of slice) {
    const value = dim.of(entry);
    if (value && !order.has(value)) order.set(value, dimOrderKey(dimKey, entry));
  }
  return rows.sort((a, b) => (order.get(a[0]) || 0) - (order.get(b[0]) || 0));
}

function dimColorOf(dimKey, slice) {
  const dim = STATS_DIMS[dimKey];
  if (dim.color) return dim.color;
  if (dim.ordered) {
    const values = dimRows(dimKey, slice).map(([value]) => value);
    const shade = new Map(
      values.map((value, index) => [
        value,
        DAY_RAMP[values.length === 1 ? 2 : Math.round((index * (DAY_RAMP.length - 1)) / (values.length - 1))]
      ])
    );
    return (value) => shade.get(value) || STATS_REST;
  }
  const map = statsColors[dimKey] || new Map();
  return (value) => map.get(value) || STATS_REST;
}

function dimLabelOf(dimKey) {
  return STATS_DIMS[dimKey].label || ((value) => value);
}

function statsDays(entries) {
  const byDay = new Map();
  for (const entry of entries) {
    if (!entry.day) continue;
    const known = byDay.get(entry.day);
    if (!known || entry.dayTs < known.ts) byDay.set(entry.day, { day: entry.day, ts: entry.dayTs });
  }
  let days = [...byDay.values()].sort((a, b) => a.ts - b.ts);
  if (days.length > 16) days = days.slice(-16);
  return days;
}

function seriesByDay(entries, keyOf, colorOf, labelOf, topN) {
  const days = statsDays(entries);
  const at = new Map(days.map((day, index) => [day.day, index]));
  const names = tallyBy(entries, keyOf).slice(0, topN);
  const series = names.map(([name, total]) => {
    const points = days.map(() => 0);
    for (const entry of entries) {
      if (keyOf(entry) !== name) continue;
      const index = at.get(entry.day);
      if (index != null) points[index] += 1;
    }
    return { name, label: labelOf(name), total, points, color: colorOf(name) };
  });
  return { days, series };
}

function legendChip(label, total, color, state, pick, value) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = `lchip${state}`;
  chip.title = state === " is-on" ? "Снять фильтр" : "Показать все ID с этим значением";
  bindVizTip(chip, { title: label, color, rows: [["ID", total]] });
  const mark = el("i");
  mark.style.background = color;
  chip.append(mark, el("span", null, label), el("b", null, String(total)));
  markPick(chip, value == null ? label : value);
  chip.addEventListener("click", (event) => pick(addKey(event)));
  markValue(chip, label, null, total);
  return chip;
}

function asList(active) {
  if (Array.isArray(active)) return active;
  return active ? [active] : [];
}

function chipState(active, name) {
  const list = asList(active);
  if (list.includes(name)) return " is-on";
  return list.length ? " is-dim" : "";
}

function renderBarChart(host, rows, options) {
  host.innerHTML = "";
  if (!rows.length) {
    chartEmpty(host, options.empty);
    return;
  }

  const top = rows.slice(0, 10);
  const max = Math.max(...top.map(([, count]) => count)) || 1;
  const total = rows.reduce((sum, [, count]) => sum + count, 0);
  const digits = Math.max(2, ...top.map(([, count]) => String(count).length));
  const rowsBox = el("div", "bars__rows");
  rowsBox.style.setProperty("--bar-rows", String(top.length));
  rowsBox.style.setProperty("--bar-value", `${digits}ch`);
  markPickGroup(rowsBox, options.filterKey);
  top.forEach(([value, count], at) => {
    const active = options.active;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `hbar${chipState(active, value)}`;
    markPick(row, value);
    row.addEventListener("click", (event) => options.pick(value, addKey(event)));

    const hue = options.colorPerValue ? options.colorPerValue(value) : options.color;
    bindVizTip(row, {
      title: options.labelOf(value),
      color: hue,
      rows: [
        ["ID", count],
        ["доля среза", shareText(count, total)],
        ["место", `${at + 1} из ${rows.length}`]
      ],
      foot: pickFoot(active, value)
    });

    const label = el("span", "hbar__label", options.labelOf(value));
    const track = el("span", "hbar__track");
    const fill = el("i", "hbar__fill");
    fill.style.width = `${Math.max(3, (count / max) * 100)}%`;
    fill.style.background = hue;
    track.appendChild(fill);
    const num = el("span", "hbar__value", String(count));

    markValue(row, options.labelOf(value), null, count);
    row.append(label, track, num);
    rowsBox.appendChild(row);
  });
  host.appendChild(rowsBox);

  const feet = [];
  if (rows.length > top.length) {
    const rest = rows.slice(top.length).reduce((sum, [, count]) => sum + count, 0);
    const left = rows.length - top.length;
    feet.push(
      `показаны ${top.length} самых частых · ещё ` +
        `${left} ${plural(left, ["значение", "значения", "значений"])}, суммарно ${rest} ID`
    );
  }
  if (options.foot) feet.push(options.foot);
  if (feet.length) host.appendChild(el("p", "bars__foot", feet.join(" · ")));
}

function renderColsChart(host, slice, dimKey, options) {
  host.innerHTML = "";
  const dim = STATS_DIMS[dimKey];
  const labelOf = dimLabelOf(dimKey);
  const rows = dimRows(dimKey, slice);
  const top = rows.length > 12 && !dim.ordered ? rows.slice(0, 12) : rows.slice(0, 16);
  if (!top.length) {
    chartEmpty(host, options.empty);
    return;
  }

  const split = new Map(top.map(([value]) => [value, { hit: 0, miss: 0, issue: 0 }]));
  for (const entry of slice) {
    const bucket = split.get(dim.of(entry));
    if (bucket) bucket[classify(entry.item)] += 1;
  }

  const totals = { hit: 0, miss: 0, issue: 0 };
  for (const counts of split.values()) {
    totals.hit += counts.hit;
    totals.miss += counts.miss;
    totals.issue += counts.issue;
  }

  const legend = el("div", "legend");
  const key = (color, text) => {
    const item = el("span", "legend__item", text);
    const mark = el("i");
    mark.style.background = color;
    item.prepend(mark);
    legend.appendChild(item);
  };
  key(VERDICT_COLORS.hit, `склад есть · ${totals.hit}`);
  key(VERDICT_COLORS.miss, `склада нет · ${totals.miss}`);
  if (totals.issue) key(VERDICT_COLORS.issue, `не вышло · ${totals.issue}`);
  host.appendChild(legend);

  const cols = el("div", "cols");
  markPickGroup(cols, options.filterKey);
  const max = Math.max(...top.map(([value]) => {
    const counts = split.get(value);
    return counts.hit + counts.miss + counts.issue;
  })) || 1;

  const grand = totals.hit + totals.miss + totals.issue;
  const active = options.active;

  for (const [value] of top) {
    const counts = split.get(value);
    const total = counts.hit + counts.miss + counts.issue;
    const col = document.createElement("button");
    col.type = "button";
    col.className = `col${chipState(active, value)}`;
    markPick(col, value);
    col.addEventListener("click", (event) => options.pick(value, addKey(event)));

    const tipRows = [["всего ID", total]];
    if (counts.hit) tipRows.push(["склад есть", counts.hit]);
    if (counts.miss) tipRows.push(["склада нет", counts.miss]);
    if (counts.issue) tipRows.push(["не вышло", counts.issue]);
    tipRows.push(["доля среза", shareText(total, grand)]);
    bindVizTip(col, {
      title: labelOf(value),
      color: counts.hit >= counts.miss ? VERDICT_COLORS.hit : VERDICT_COLORS.miss,
      rows: tipRows,
      foot: pickFoot(active, value)
    });

    col.appendChild(el("span", "col__cap", String(total)));
    const plot = el("span", "col__plot");
    const stack = el("span", "col__stack");
    stack.style.height = `${Math.max(2, (total / max) * 100)}%`;
    const parts = [
      [VERDICT_COLORS.issue, counts.issue],
      [VERDICT_COLORS.miss, counts.miss],
      [VERDICT_COLORS.hit, counts.hit]
    ];
    for (const [color, count] of parts) {
      if (!count) continue;
      const seg = el("i", "col__seg");
      seg.style.background = color;
      seg.style.flexGrow = String(count);
      stack.appendChild(seg);
    }
    plot.appendChild(stack);
    col.appendChild(plot);
    col.appendChild(el("span", "col__day", labelOf(value)));
    markValue(col, labelOf(value), null, total);
    cols.appendChild(col);
  }
  host.appendChild(cols);
  if (rows.length > top.length) {
    host.appendChild(el("p", "bars__foot", `показаны первые ${top.length} из ${rows.length}`));
  }
}

function renderLineChart(host, data, options) {
  host.innerHTML = "";
  const { days, series } = data;
  if (!days.length || !series.length) {
    chartEmpty(host, options.empty);
    return;
  }

  const max = Math.max(1, ...series.flatMap((line) => line.points));
  const box = el("div", "line");
  const plot = el("div", "line__plot");
  plot.appendChild(el("span", "line__max", String(max)));

  const svg = svgEl("svg", { viewBox: "0 0 100 100", preserveAspectRatio: "none" });
  const xOf = (index) => (days.length === 1 ? 50 : (index / (days.length - 1)) * 100);
  const yOf = (value) => 95 - (value / max) * 86;

  for (const line of series) {
    const poly = svgEl("polyline", {
      points: line.points.map((value, index) => `${xOf(index)},${yOf(value)}`).join(" "),
      class: `line__path${chipState(options.active, line.name)}`
    });
    poly.style.stroke = line.color;
    svg.appendChild(poly);
  }
  plot.appendChild(svg);

  for (const line of series) {
    line.points.forEach((value, index) => {
      const dot = el("i", `line__dot${chipState(options.active, line.name)}`);
      dot.style.left = `${xOf(index)}%`;
      dot.style.top = `${yOf(value)}%`;
      dot.style.background = line.color;
      bindVizTip(dot, {
        title: `${line.label} · ${days[index].day}`,
        color: line.color,
        rows: [
          ["ID за день", value],
          ["всего по линии", line.total],
          ["доля дня", shareText(value, line.total)]
        ]
      });
      plot.appendChild(dot);
    });
  }
  box.appendChild(plot);

  const labels = el("div", "line__days");
  labels.style.gridTemplateColumns = `repeat(${days.length}, 1fr)`;
  for (const day of days) labels.appendChild(el("span", null, day.day));
  box.appendChild(labels);

  const legend = el("div", "lchips");
  markPickGroup(legend, options.filterKey);
  for (const line of series) {
    legend.appendChild(
      legendChip(line.label, line.total, line.color, chipState(options.active, line.name),
        (add) => options.pick(line.name, add), line.name)
    );
  }
  box.appendChild(legend);
  if (options.foot) box.appendChild(el("p", "bars__foot", options.foot));
  host.appendChild(box);
}

function renderDonutChart(host, rows, options) {
  host.innerHTML = "";
  if (!rows.length) {
    chartEmpty(host, options.empty);
    return;
  }

  const top = rows.slice(0, 5);
  const rest = rows.slice(5);
  const restCount = rest.reduce((sum, [, count]) => sum + count, 0);
  const segments = top.map(([name, count]) => ({
    name,
    label: options.labelOf(name),
    count,
    color: options.colorOf(name),
    pickable: true
  }));
  if (restCount) {
    segments.push({ name: "", label: `остальные · ${rest.length}`, count: restCount, color: STATS_REST, pickable: false });
  }

  const total = segments.reduce((sum, seg) => sum + seg.count, 0) || 1;
  const box = el("div", "donut");
  const svg = svgEl("svg", { viewBox: "0 0 120 120", class: "donut__ring" });
  markPickGroup(svg, options.filterKey);

  const R = 44;
  const LEN = 2 * Math.PI * R;
  const GAP = segments.length > 1 ? 2.6 : 0;
  let offset = 0;
  for (const seg of segments) {
    const share = (seg.count / total) * LEN;
    const dash = Math.max(0.5, share - GAP);
    const circle = svgEl("circle", {
      cx: "60",
      cy: "60",
      r: R,
      class: `donut__seg${seg.pickable ? chipState(options.active, seg.name) : ""}`,
      "stroke-dasharray": `${dash} ${LEN - dash}`,
      "stroke-dashoffset": -offset,
      transform: "rotate(-90 60 60)"
    });
    circle.style.stroke = seg.color;
    bindVizTip(circle, {
      title: seg.label,
      color: seg.color,
      rows: [
        ["ID", seg.count],
        ["доля", shareText(seg.count, total)]
      ],
      foot: seg.pickable ? pickFoot(options.active, seg.name) : ""
    });
    if (seg.pickable) {
      markPick(circle, seg.name);
      circle.addEventListener("click", (event) => options.pick(seg.name, addKey(event)));
    }
    svg.appendChild(circle);
    offset += share;
  }

  const centerValue = svgEl("text", { x: "60", y: "58", class: "donut__total" });
  centerValue.textContent = String(total);
  svg.appendChild(centerValue);
  const centerLabel = svgEl("text", { x: "60", y: "74", class: "donut__label" });
  centerLabel.textContent = "ID";
  svg.appendChild(centerLabel);
  box.appendChild(svg);

  const legend = el("div", "lchips lchips--column");
  markPickGroup(legend, options.filterKey);
  for (const seg of segments) {
    if (seg.pickable) {
      legend.appendChild(
        legendChip(seg.label, seg.count, seg.color, chipState(options.active, seg.name),
          (add) => options.pick(seg.name, add), seg.name)
      );
    } else {
      const still = el("span", "lchip is-rest");
      const mark = el("i");
      mark.style.background = seg.color;
      still.append(mark, el("span", null, seg.label), el("b", null, String(seg.count)));
      markValue(still, seg.label, null, seg.count);
      legend.appendChild(still);
    }
  }
  box.appendChild(legend);
  host.appendChild(box);
}

function titleOf(entries, value) {
  return entries.find(([key]) => key === value)?.[1] || value;
}

function panelTitle(value, entries, onChange) {
  const box = el("div", "ptitle");
  const button = el("button", "ptitle__btn");
  button.type = "button";
  button.title = "Выбрать, что показывать";
  button.appendChild(el("h3", null, titleOf(entries, value)));
  button.appendChild(caretIcon("ptitle__caret"));
  box.appendChild(button);
  bindSingle(box, button, entries, value, onChange);
  return box;
}

function panelSelect(value, entries, onChange) {
  const box = el("div", "mselect mselect--one");
  const button = el("button", "mselect__btn");
  button.type = "button";
  button.title = "Как показывать";
  button.append(el("span", "mselect__value", titleOf(entries, value)), el("i", "mselect__caret"));
  box.appendChild(button);
  bindSingle(box, button, entries, value, onChange);
  return box;
}

function updatePanel(index, patch) {
  statsPanels[index] = { ...statsPanels[index], ...patch };
  persistStatsPanels();

  const grid = $("stats-panels");
  const node = grid?.querySelector(`.spanel[data-at="${index}"]`);
  if (!node) {
    renderStatsPanels();
    return;
  }
  node.replaceWith(renderStatsPanel(statsPanels[index], index));
}

function syncPanelTools() {
  const addBtn = $("stats-add");
  if (addBtn) addBtn.disabled = statsPanels.length >= MAX_PANELS;
}

function renderStatsPanel(panel, index) {
  const dim = STATS_DIMS[panel.dim];
  const section = el("section", "panel glass spanel");
  section.dataset.at = String(index);

  const head = el("div", "spanel__head");
  head.appendChild(
    panelTitle(panel.dim, Object.entries(STATS_DIMS).map(([key, entry]) => [key, entry.title]), (next) =>
      updatePanel(index, { dim: next })
    )
  );
  const tools = el("div", "spanel__tools");
  tools.appendChild(
    panelSelect(panel.viz, Object.entries(STATS_VIZ), (next) => updatePanel(index, { viz: next }))
  );
  const drop = el("button", "spanel__drop");
  drop.type = "button";
  drop.title = "Убрать панель";
  drop.appendChild(crossIcon());
  drop.addEventListener("click", () => {
    const done = () => {
      statsPanels.splice(index, 1);
      persistStatsPanels();
      renderStatsPanels();
    };
    if (REDUCED_MOTION.matches) {
      done();
      return;
    }
    section.classList.add("is-going");
    window.setTimeout(done, 260);
  });
  tools.appendChild(drop);
  head.appendChild(tools);
  section.appendChild(head);
  if (dim.sub) section.appendChild(el("p", "spanel__note", dim.sub));

  const chart = el("div", panel.viz === "bars" ? "bars" : "pchart");
  section.appendChild(chart);

  const skip = new Set([dim.filter]);
  const slice = statsIndex.filter((entry) => passesStats(entry, skip) && dim.of(entry));
  const active = filterList(dim.filter);
  const pick = (value, add) => toggleStatsFilter(dim.filter, value, add);
  const labelOf = dimLabelOf(panel.dim);
  const colorOf = dimColorOf(panel.dim, slice);
  const empty = "Под фильтры ничего не попало.";

  if (panel.viz === "line") {
    if (panel.dim === "day") {
      const data = seriesByDay(
        slice.filter((entry) => classify(entry.item) !== "issue"),
        (entry) => classify(entry.item),
        (value) => VERDICT_COLORS[value],
        (value) => VERDICT_WORDS[value],
        2
      );
      renderLineChart(chart, data, {
        active: filterList("verdict"),
        pick: (value, add) => toggleStatsFilter("verdict", value, add),
        filterKey: "verdict",
        empty
      });
    } else {
      const rows = tallyBy(slice, dim.of);
      renderLineChart(chart, seriesByDay(slice, dim.of, colorOf, labelOf, 3), {
        active,
        pick,
        filterKey: dim.filter,
        empty,
        foot: rows.length > 3 ? "линии — три самых частых значения; остальное в гистограмме" : ""
      });
    }
    return section;
  }

  if (panel.viz === "donut") {
    renderDonutChart(chart, dimRows(panel.dim, slice), {
      active,
      pick,
      filterKey: dim.filter,
      colorOf,
      labelOf,
      empty
    });
    return section;
  }

  if (panel.viz === "cols") {
    renderColsChart(chart, slice, panel.dim, { active, pick, filterKey: dim.filter, empty });
    return section;
  }

  const missing =
    panel.dim === "cell" || panel.dim === "place"
      ? statsIndex.filter(
          (entry) => passesStats(entry, skip) && entry.blame.kind === panel.dim && !entry.blame.value
        ).length
      : 0;
  renderBarChart(chart, dimRows(panel.dim, slice), {
    color: dim.hue || "var(--viz-blue)",
    colorPerValue: dim.color || null,
    labelOf,
    active,
    pick,
    filterKey: dim.filter,
    empty,
    foot: missing ? `без значения: ${missing} ${plural(missing, ["ID", "ID", "ID"])}` : ""
  });
  return section;
}

function renderStatsPanels() {
  const grid = $("stats-panels");
  if (!grid) return;
  grid.innerHTML = "";
  statsPanels.forEach((panel, index) => {
    if (!STATS_DIMS[panel.dim] || !STATS_VIZ[panel.viz]) return;
    grid.appendChild(renderStatsPanel(panel, index));
  });
  syncPanelTools();
}

function appendStatsPanel(index) {
  const grid = $("stats-panels");
  if (!grid) return;
  const node = renderStatsPanel(statsPanels[index], index);
  if (!REDUCED_MOTION.matches) node.classList.add("is-fresh");
  grid.appendChild(node);
  syncPanelTools();
}

const STATS_COLUMNS = {
  id: {
    title: "ID",
    width: 26,
    sort: (entry) => entry.item.posting,
    text: (entry) => entry.item.posting,
    link: (entry) => hubUrl(entry.item.posting),
    cell: (entry, td) => {
      td.className = "t-id";
      const link = el("a", "t-id__code", entry.item.posting);
      link.href = hubUrl(entry.item.posting);
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      link.title = "Открыть отправление в Hub";
      td.appendChild(link);
      const open = el("button", "t-open", "детализация");
      open.type = "button";
      open.title = "Открыть этот ID в детализации";
      open.dataset.posting = entry.item.posting;
      td.appendChild(open);
    }
  },
  number: {
    title: "Номер",
    width: 22,
    sort: (entry) => entry.item.report?.number || "",
    text: (entry) => entry.item.report?.number || "",
    cell: (entry, td) => {
      td.className = "t-number";
      td.textContent = entry.item.report?.number || "—";
    }
  },
  verdict: {
    title: "Результат",
    width: 14,
    sort: (entry) => {
      const kind = classify(entry.item);
      return kind === "hit" ? 0 : kind === "miss" ? 1 : 2;
    },
    text: (entry) => verdictOf(entry.item).text,
    cell: (entry, td) => {
      const verdict = verdictOf(entry.item);
      td.appendChild(el("span", `card__verdict ${verdict.className}`, verdict.text));
    }
  },
  blame: {
    title: "Ячейка / склад",
    width: 34,
    sort: (entry) => entry.blame.value || "",
    text: (entry) => entry.blame.value || "",
    cell: (entry, td) => {
      if (entry.blame.kind === "none") {
        td.appendChild(el("span", "t-none", "—"));
        return;
      }
      if (!entry.blame.value) {
        td.appendChild(el("span", "t-none", "—"));
        return;
      }
      const chip = el("button", `t-blame t-blame--${entry.blame.kind}`);
      chip.type = "button";
      chip.title = "Показать все ID с этим значением";
      chip.dataset.kind = entry.blame.kind;
      chip.dataset.value = entry.blame.value;
      chip.appendChild(el("i", null, BLAME_TAGS[entry.blame.kind]));
      chip.appendChild(el("span", null, entry.blame.value));
      td.appendChild(chip);
    }
  },
  kind: {
    title: "Что это",
    width: 14,
    sort: (entry) => BLAME_TAGS[entry.blame.kind] || "",
    text: (entry) => BLAME_TAGS[entry.blame.kind] || "",
    cell: (entry, td) => {
      td.textContent = BLAME_TAGS[entry.blame.kind] || "—";
    }
  },
  at: {
    title: "Когда",
    width: 22,
    sort: (entry) => {
      const date = parseHubDate(entry.blame.at);
      return date ? date.getTime() : 0;
    },
    text: (entry) => entry.blame.at || "",
    cell: (entry, td) => {
      td.className = "t-when";
      td.textContent = entry.blame.at || "—";
    }
  },
  bucket: {
    title: "Корзинка",
    width: 13,
    sort: (entry) => {
      const at = BUCKET_ORDER.indexOf(entry.bucket);
      return at < 0 ? BUCKET_ORDER.length : at;
    },
    text: (entry) => entry.bucket || "",
    cell: (entry, td) => {
      td.textContent = entry.bucket || "—";
    }
  },
  status: {
    title: "Статус",
    width: 26,
    sort: (entry) => entry.item.report?.status || "",
    text: (entry) => entry.item.report?.status || "",
    cell: (entry, td) => {
      td.textContent = entry.item.report?.status || "—";
    }
  },
  op: {
    title: "Операция",
    width: 20,
    sort: (entry) => entry.op || "",
    text: (entry) => entry.op || "",
    cell: (entry, td) => {
      td.textContent = entry.op || "—";
    }
  },
  user: {
    title: "Пользователь",
    width: 32,
    sort: (entry) => entry.user || "",
    text: (entry) => entry.user || "",
    cell: (entry, td) => {
      td.textContent = entry.user || "—";
    }
  },
  hour: {
    title: "Час",
    width: 10,
    sort: (entry) => Number(String(entry.hour).slice(0, 2)) || 0,
    text: (entry) => entry.hour || "",
    cell: (entry, td) => {
      td.className = "t-when";
      td.textContent = entry.hour || "—";
    }
  }
};

const DEFAULT_STATS_COLS = ["id", "number", "verdict", "blame", "at", "bucket", "status", "op"];
let statsCols = DEFAULT_STATS_COLS.slice();

function persistStatsCols() {
  patchSettings({ statsCols, statsSort });
}

function sortStats(entries) {
  if (!statsSort) return [...entries];
  const column = STATS_COLUMNS[statsSort.key] || STATS_COLUMNS.at;
  const dir = statsSort.dir;
  return [...entries].sort((a, b) => {
    const left = column.sort(a);
    const right = column.sort(b);
    const cmp =
      typeof left === "number" && typeof right === "number"
        ? left - right
        : String(left).localeCompare(String(right), "ru");
    return cmp ? cmp * dir : String(a.item.posting).localeCompare(String(b.item.posting), "ru");
  });
}

const STATS_ROW_LIMIT = 500;

let dragCol = "";

function renderStatsHead() {
  const head = $("stats-head");
  if (!head) return;
  head.innerHTML = "";

  statsCols.forEach((key) => {
    const column = STATS_COLUMNS[key];
    if (!column) return;
    const th = document.createElement("th");
    th.dataset.sort = key;
    th.draggable = true;
    th.textContent = column.title;
    th.title = "Клик — сортировка, третий — снять; перетаскиванием — порядок столбцов";
    th.classList.toggle("is-sorted", key === statsSort?.key);
    th.classList.toggle("is-desc", key === statsSort?.key && statsSort.dir < 0);

    th.addEventListener("dragstart", (event) => {
      dragCol = key;
      th.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", key);
    });
    th.addEventListener("dragend", () => {
      dragCol = "";
      for (const cell of $$("#stats-head th")) cell.classList.remove("is-dragging", "is-over");
    });
    th.addEventListener("dragover", (event) => {
      if (!dragCol || dragCol === key) return;
      event.preventDefault();
      th.classList.add("is-over");
    });
    th.addEventListener("dragleave", () => th.classList.remove("is-over"));
    th.addEventListener("drop", (event) => {
      event.preventDefault();
      th.classList.remove("is-over");
      if (!dragCol || dragCol === key) return;
      const from = statsCols.indexOf(dragCol);
      const to = statsCols.indexOf(key);
      if (from < 0 || to < 0) return;
      statsCols.splice(to, 0, ...statsCols.splice(from, 1));
      persistStatsCols();
      refreshStatsTable();
    });

    head.appendChild(th);
  });
}

function renderColMenu() {
  const box = $("stats-colmenu");
  if (!box) return;
  box.innerHTML = "";

  const hint = el("p", "colmenu__hint", "Отметьте столбцы; порядок меняется перетаскиванием заголовков.");
  box.appendChild(hint);

  const list = el("div", "colmenu__list");
  for (const [key, column] of Object.entries(STATS_COLUMNS)) {
    const on = statsCols.includes(key);
    const row = el("label", `colmenu__row${on ? " is-on" : ""}`);
    const box2 = document.createElement("input");
    box2.type = "checkbox";
    box2.checked = on;
    box2.addEventListener("change", () => {
      if (box2.checked) {
        if (!statsCols.includes(key)) statsCols.push(key);
      } else {
        if (statsCols.length <= 1) {
          box2.checked = true;
          return;
        }
        statsCols = statsCols.filter((name) => name !== key);
        if (statsSort?.key === key) statsSort = { key: statsCols[0], dir: firstSortDir(statsCols[0]) };
      }
      persistStatsCols();
      refreshStatsTable();
    });
    row.append(box2, el("span", null, column.title));
    list.appendChild(row);
  }
  box.appendChild(list);

  const reset = el("button", "btn btn--ghost btn--sm", "Стандартные столбцы");
  reset.type = "button";
  reset.addEventListener("click", () => {
    statsCols = DEFAULT_STATS_COLS.slice();
    statsSort = { key: "at", dir: -1 };
    persistStatsCols();
    renderColMenu();
    refreshStatsTable();
  });
  box.appendChild(reset);
}

function refreshStatsTable() {
  renderStatsTable(statsIndex.filter((entry) => passesStats(entry)));
}

function renderStatsTable(shown) {
  const body = $("stats-rows");
  if (!body) return;
  body.innerHTML = "";
  playSwap(body);

  renderStatsHead();

  const rows = sortStats(shown);
  const count = $("stats-table-count");
  if (count) {
    count.textContent =
      rows.length > STATS_ROW_LIMIT ? `первые ${STATS_ROW_LIMIT} из ${rows.length}` : `${rows.length} строк`;
  }

  if (!rows.length) {
    const tr = document.createElement("tr");
    const td = el("td", "t-none", "Под фильтры ничего не попало — смягчите их или очистите поиск.");
    td.colSpan = Math.max(1, statsCols.length);
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }

  for (const entry of rows.slice(0, STATS_ROW_LIMIT)) {
    const tr = document.createElement("tr");
    for (const key of statsCols) {
      const column = STATS_COLUMNS[key];
      if (!column) continue;
      const td = document.createElement("td");
      column.cell(entry, td);
      tr.appendChild(td);
    }
    statsRowEntry.set(tr, entry);
    body.appendChild(tr);
  }
}

function statsRowsForExport() {
  return sortStats(statsIndex.filter((entry) => passesStats(entry)));
}

function renderStatsChips() {
  const box = $("stats-chips");
  if (!box) return;
  const chips = [
    ["cell", "ячейка"],
    ["place", "склад"],
    ["day", "день"],
    ["hour", "час"],
    ["user", "пользователь"]
  ];
  const active = [];
  for (const [key, label] of chips) {
    for (const value of filterList(key)) active.push({ key, label, value });
  }
  box.closest(".detail__bar")?.classList.toggle("has-chips", active.length > 0);
  if (!active.length) {
    emptyLater(box);
    return;
  }

  emptyNow(box);
  for (const { key, label, value } of active) {
    const chip = el("span", "detail__chip", `${label}: ${value}`);
    const drop = el("button");
    drop.type = "button";
    drop.title = "Снять фильтр";
    drop.appendChild(crossIcon());
    drop.addEventListener("click", () => {
      setStatsFilter(key, filterList(key).filter((one) => one !== value));
    });
    chip.appendChild(drop);
    box.appendChild(chip);
  }
}

function renderStats() {
  const host = $("result-stats");
  if (!host) return;

  hideVizTip();
  closeCopyMenu();
  syncStatsControls();
  const shown = statsIndex.filter((entry) => passesStats(entry));

  renderTally("stats-count", shown.length, statsIndex.length);
  renderFilterCount("stats", countActive(Object.values(statsFilters).map((list) => list.length)));
  const reset = $("stats-reset");
  reveal(reset, statsFiltersActive());

  renderStatsKpis(shown);
  renderStatsPanels();
  renderStatsTable(shown);
  renderStatsChips();
  renderFab();
}

const statsRowEntry = new WeakMap();

function markValue(node, value, label, extra) {
  if (!node) return node;
  const text = oneLine(value);
  if (!text) return node;
  node.dataset.copyValue = text;
  const title = oneLine(label);
  if (title) node.dataset.copyLabel = title;
  const more = oneLine(extra);
  if (more) node.dataset.copyExtra = more;
  return node;
}

function oneLine(value) {
  return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
}

const FIELD_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const LOOSE_LIMIT = 200;

function visibleStatsCols() {
  return statsCols.filter((key) => STATS_COLUMNS[key]);
}

function columnText(key, entry) {
  const column = STATS_COLUMNS[key];
  if (!column) return "";
  return oneLine(column.text ? column.text(entry) : "");
}

function looseValue(node, root) {
  for (let at = node; at && at !== root; at = at.parentElement) {
    if (FIELD_TAGS.has(at.tagName)) return "";
    const text = oneLine(at.textContent);
    if (!text) continue;
    return text.length <= LOOSE_LIMIT ? text : "";
  }
  return "";
}

function statsCopyItems(target) {
  const items = [];
  const head = target.closest("#stats-head th");
  const cell = target.closest("#stats-rows td");
  const cols = visibleStatsCols();

  const columnItem = (key) => {
    const rows = statsRowsForExport();
    return {
      label: "Копировать столбец",
      hint: `${rows.length} ${plural(rows.length, ["значение", "значения", "значений"])}`,
      text: rows.map((entry) => columnText(key, entry)).join("\n"),
      said: `Столбец «${STATS_COLUMNS[key].title}» скопирован`
    };
  };

  if (head?.dataset.sort) {
    items.push(columnItem(head.dataset.sort));
    return items;
  }

  if (cell) {
    const row = cell.parentElement;
    const entry = statsRowEntry.get(row);
    const at = [...row.children].indexOf(cell);
    const key = cols[at];
    const value = entry && key ? columnText(key, entry) : oneLine(cell.textContent);
    const title = key ? STATS_COLUMNS[key].title : "";
    if (value) {
      items.push({ label: "Копировать", hint: value, text: value });
      if (title) items.push({ label: "Копировать с подписью", text: `${title}: ${value}` });
    }
    if (entry) {
      items.push({
        label: "Копировать строку",
        hint: `${cols.length} ${plural(cols.length, ["столбец", "столбца", "столбцов"])}`,
        text: cols.map((name) => columnText(name, entry)).join("\t"),
        said: "Строка скопирована"
      });
    }
    if (key) items.push(columnItem(key));
    return items;
  }

  const marked = target.closest("[data-copy-value]");
  const value = marked ? marked.dataset.copyValue : looseValue(target, $("result-stats"));
  if (!value) return items;

  items.push({ label: "Копировать", hint: value, text: value });
  const label = marked?.dataset.copyLabel;
  const extra = marked?.dataset.copyExtra;
  if (label) items.push({ label: "Копировать с подписью", text: `${label}: ${value}` });
  else if (extra) items.push({ label: "Копировать со значением", text: `${value} — ${extra}` });
  return items;
}

let copyMenuEl = null;

function copyMenu() {
  if (copyMenuEl?.isConnected) return copyMenuEl;
  copyMenuEl = el("div", "cmenu glass");
  copyMenuEl.hidden = true;
  copyMenuEl.setAttribute("role", "menu");
  copyMenuEl.addEventListener("contextmenu", (event) => event.preventDefault());
  document.body.appendChild(copyMenuEl);
  return copyMenuEl;
}

function closeCopyMenu() {
  if (!copyMenuEl || copyMenuEl.hidden) return;
  reveal(copyMenuEl, false);
}

function placeCopyMenu(x, y) {
  const menu = copyMenuEl;
  const pad = 10;
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  const left = Math.min(Math.max(pad, x), Math.max(pad, window.innerWidth - width - pad));
  const up = y + height + pad > window.innerHeight;
  const top = Math.min(
    Math.max(pad, up ? y - height : y),
    Math.max(pad, window.innerHeight - height - pad)
  );
  menu.style.left = `${Math.round(left)}px`;
  menu.style.top = `${Math.round(top)}px`;
}

async function copyValue(text, said) {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    toast("ok", said || "Скопировано");
  } catch (_err) {
    toast("error", "Буфер обмена недоступен");
  }
}

function openCopyMenu(x, y, items) {
  const menu = copyMenu();
  menu.replaceChildren();
  for (const item of items) {
    const button = el("button", "cmenu__item");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.appendChild(el("span", "cmenu__label", item.label));
    if (item.hint) button.appendChild(el("em", "cmenu__hint", item.hint));
    button.addEventListener("click", () => {
      closeCopyMenu();
      void copyValue(item.text, item.said);
    });
    menu.appendChild(button);
  }
  reveal(menu, true);
  placeCopyMenu(x, y);
  menu.firstElementChild?.focus({ preventScroll: true });
  openedAt = Date.now();
}

const SETTLE_MS = 120;
let openedAt = 0;

function closeOnMove() {
  if (Date.now() - openedAt < SETTLE_MS) return;
  closeCopyMenu();
}

function mountCopyMenu() {
  const host = $("result-stats");
  if (!host) return;

  host.addEventListener("contextmenu", (event) => {
    if (FIELD_TAGS.has(event.target.tagName)) return;
    const items = statsCopyItems(event.target);
    if (!items.length) return;
    event.preventDefault();
    hideVizTip();
    openCopyMenu(event.clientX, event.clientY, items);
  });

  document.addEventListener("click", closeCopyMenu);
  document.addEventListener("wheel", closeOnMove, { capture: true, passive: true });
  window.addEventListener("resize", closeOnMove);
  window.addEventListener("blur", closeOnMove);
  document.addEventListener("keydown", (event) => {
    if (!copyMenuEl || copyMenuEl.hidden) return;
    if (event.key === "Escape") {
      event.stopPropagation();
      closeCopyMenu();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const all = [...copyMenuEl.querySelectorAll(".cmenu__item")];
    const at = all.indexOf(document.activeElement);
    const next = event.key === "ArrowDown" ? at + 1 : at - 1;
    all[(next + all.length) % all.length]?.focus();
  });
}

mountCopyMenu();

function resetStatsFilters() {
  statsQuery = [];
  for (const key of Object.keys(statsFilters)) statsFilters[key] = [];
  const search = $("stats-search");
  if (search) search.value = "";
  for (const id of Object.values(STATS_SELECTS)) setPickerValues(id, []);
}

function jumpToDetail(posting) {
  resetDetailFilters();
  detailQuery = [String(posting).toLowerCase()];
  const search = $("detail-search");
  if (search) search.value = String(posting);
  setResultView("detail", true);
}

function mountStats() {
  mountFilterBox("stats", "stats-filters-btn", "stats-filters-pop", "stats-filters-count");
  const search = $("stats-search");
  if (search) {
    let timer = null;
    search.addEventListener("input", () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        statsQuery = parseDetailQuery(search.value);
        renderStats();
      }, 160);
    });
  }

  for (const [key, id] of Object.entries(STATS_SELECTS)) {
    mountPicker(id, (values) => setStatsFilter(key, values));
  }
  setPickerItems("stats-verdict", VERDICT_ITEMS);

  $("stats-reset")?.addEventListener("click", () => {
    resetStatsFilters();
    renderStats();
  });

  $("stats-cols")?.addEventListener("click", () => {
    const box = $("stats-colmenu");
    const btn = $("stats-cols");
    if (!box) return;
    const open = box.hidden;
    if (open) renderColMenu();
    box.hidden = false;
    requestAnimationFrame(() => box.classList.toggle("is-open", open));
    btn?.classList.toggle("is-on", open);
    if (!open) window.setTimeout(() => { box.hidden = true; }, 240);
  });

  $("stats-add")?.addEventListener("click", () => {
    if (statsPanels.length >= MAX_PANELS) return;
    const used = new Set(statsPanels.map((panel) => panel.dim));
    const dim = Object.keys(STATS_DIMS).find((key) => !used.has(key)) || "verdict";
    statsPanels.push({ dim, viz: "bars" });
    persistStatsPanels();
    appendStatsPanel(statsPanels.length - 1);
  });

  $("stats-default")?.addEventListener("click", () => {
    statsPanels = DEFAULT_PANELS.map((panel) => ({ ...panel }));
    persistStatsPanels();
    renderStats();
  });

  const table = $("stats-table");
  if (table) {
    table.addEventListener("click", (event) => {
      const open = event.target.closest(".t-open");
      if (open) {
        jumpToDetail(open.dataset.posting);
        return;
      }
      const blame = event.target.closest(".t-blame");
      if (blame) {
        toggleStatsFilter(blame.dataset.kind === "cell" ? "cell" : "place", blame.dataset.value);
        return;
      }
      const th = event.target.closest("th[data-sort]");
      if (th) {
        const key = th.dataset.sort;
        statsSort = nextSort(key);
        persistStatsCols();
        refreshStatsTable();
      }
    });
  }
}

mountStats();

const CREDIT = {
  everyMs: 10 * 60 * 1000,
  showMs: 7000,
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
  el.querySelector(".credit__link")?.addEventListener("click", hideCredit);

  window.setInterval(showCredit, CREDIT.everyMs);
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && creditPending) window.setTimeout(showCredit, 1200);
  });
}

mountCredit();

document.addEventListener("dragstart", (event) => {
  if (event.target?.closest?.('[draggable="true"]')) return;
  event.preventDefault();
});

const SPLASH_MS = 3500;

function playSplash() {
  const splash = $("splash");
  if (!splash) return;
  if (REDUCED_MOTION.matches) {
    splash.remove();
    return;
  }
  splash.classList.add("is-on");
  window.setTimeout(() => {
    splash.classList.add("is-out");
    window.setTimeout(() => splash.remove(), 700);
  }, SPLASH_MS);
}

playSplash();

void boot();
