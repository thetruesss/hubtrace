
const STORAGE_SETTINGS = "hubTraceSettings";
const STORAGE_FINISHED = "hubTraceFinished";
const STORAGE_RUNS = "hubTraceRuns";
const RUN_PREFIX = "hubTraceRun:";

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

// Всё, что пишется в настройки, идёт через одну очередь: два сохранения
// подряд затирали друг друга, каждое читало старый снимок.
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

// Колонки Excel и CSV разделены табом или «;», список в одну строку — пробелами.
const CELL_SPLIT_RE = /[\t;,]/;
// Похоже на номер, даже если это не он: буквы, цифры и знаки из ссылок Hub.
const TOKEN_RE = /^[A-Za-z0-9:_-]+$/;

function splitCells(line) {
  const by = CELL_SPLIT_RE.test(line) ? CELL_SPLIT_RE : /\s+/;
  return line.split(by).map((part) => part.trim()).filter(Boolean);
}

// Что бы ни стояло в строке, до проверки она должна дойти: угадывать за
// человека, какая часть «настоящая», мы можем только когда видим ID.
function tokenize(line) {
  const cells = splitCells(line);
  // в строке из Excel колонок несколько и ID далеко не первый
  const id = cells.find(sheetReader.looksLikeId) || cells.find(sheetReader.looksLikeNumber);
  if (id) return [id];
  // ID не видно, выбирать не из чего: список коротких номеров разбираем по частям,
  // а всё остальное отдаём строкой целиком — иначе от ввода останется первое слово
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

// hidden убирает элемент из раскладки в том же кадре, и соседи прыгают. Показываем
// в два шага: сначала возвращаем в поток и только следующим кадром снимаем гашение,
// а прячем наоборот — гасим переходом, из потока убираем после него.
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
      // разметка приходит просто скрытой, без гашения: без него первый показ
      // будет мгновенным, потому что снимать нечего
      node.classList.add("is-out");
      node.hidden = false;
      // пересчёт раскладки обязателен, иначе оба класса схлопнутся в один кадр
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

// Список перерисовывается целиком, и без этого он подменяется рывком. Оживляем
// контейнер, а не строки: построчная волна на каждую букву в поиске — та же дёрганность.
function playSwap(node) {
  if (!node || REDUCED_MOTION.matches) return;
  node.classList.remove("is-swap");
  // перезапуск анимации требует пересчёта раскладки между снятием и возвратом класса
  void node.offsetWidth;
  node.classList.add("is-swap");
}

// Полоса схлопывается переходом, поэтому вычищать её сразу нельзя: содержимое
// исчезнет рывком, а закрываться будет уже пустое место.
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

// круги добора входят в знаменатель, иначе висит «55 из 55 · 100 %»,
// пока вкладки ещё крутятся
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

// дёргать текст на каждый тик незачем, ломается плавность
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
      // остаток времени падает к нулю, поэтому инвертируем
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

// Разбор идёт на каждое нажатие клавиши, на тысяче строк он не бесплатный —
// у кого список уже на руках, тот его и передаёт.
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
    // не молчим про мусор, но и не выкидываем его: проверим и покажем в отчёте
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
  $("btn-start").disabled = ui.running || !(hasPostings && hasWarehouse);
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
  if (!note) return;
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
  // текст меняем только при показе: на уходе он нужен, пока строка схлопывается
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

// тип приходит кодом, а подпись со страницы может приехать позже
let changeLabels = {};

function withLabels(report) {
  const rows = report?.lastRows;
  const codes = report?.codes;
  if (!Array.isArray(rows) || !Array.isArray(codes) || !codes.length) return rows || [];
  return rows.map((row, index) => {
    const label = changeLabels[codes[index]];
    if (!label || !row?.length || row[0] === label) return row;
    return [label, ...row.slice(1)];
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

  const caret = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  caret.setAttribute("viewBox", "0 0 12 12");
  caret.setAttribute("class", "run__caret");
  caret.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2.5 4.5 6 8l3.5-3.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  caret.appendChild(path);
  head.appendChild(caret);

  head.addEventListener("click", () => {
    ui.openRun = ui.openRun === run.jobId ? "" : run.jobId;
    renderRuns();
  });
  item.appendChild(head);

  const body = el("div", "run__body");
  // сетке нужно что сжимать до нуля
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

function renderResults(payload, fresh) {
  const results = (payload?.results || []).filter(Boolean);
  changeLabels = payload?.changeLabels || {};
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
  buildStatsIndex(results);
  resetStatsFilters();
  fillStatsOptions();
  setResultView(resultView);
  renderDetail();

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

// «15.08.2026, 09:18:58» или ISO с быстрого пути
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

// если склада нет, возраст считаем от верхней строки истории
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

// tab=transitionHistory — это фишка «Перемещения» внутри «Истории»
function hubUrl(posting) {
  const clean = String(posting || "").trim().replace(/^Lozon:/i, "");
  return `https://hub.o3t.ru/management/stock/item/Lozon:${encodeURIComponent(clean)}?&tab=transitionHistory`;
}

// технический статус проверки, не тот, что на странице Hub
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

// Кнопок внутри xlsx не бывает: макросы требуют .xlsm. «детализация →» —
// обычная внутренняя ссылка на второй лист.
function buildXlsx() {
  const entries = statsRowsForExport();
  const cols = statsCols.filter((key) => STATS_COLUMNS[key]);

  const detailRows = [];
  const anchors = new Map();

  entries.forEach((entry, index) => {
    const report = entry.item.report;
    if (!report?.lastRows?.length) return;

    // +1 на шапку, +1 на нумерацию с единицы
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
  const stamp = new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-");
  return `hub-trace-${stamp}.${extension}`;
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

  rememberWarehouse(warehouse);
  patchSettings({ ...settings, warehouse, lastPostings: postingsEl.value });
  // ждём записи: фон следом дописывает в тот же ключ
  await flushSettings();

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

postingsEl.addEventListener("input", () => {
  updateCount();
  patchSettings({ lastPostings: postingsEl.value });
});
warehouseEl.addEventListener("input", () => {
  updateFormState();
  patchSettings({ warehouse: warehouseEl.value.trim() });
});
warehouseEl.addEventListener("change", () => rememberWarehouse(warehouseEl.value));

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
  if (saved.statsSort && STATS_COLUMNS[saved.statsSort.key]) {
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
  if (Array.isArray(saved.recentWarehouses)) ui.recentWarehouses = saved.recentWarehouses;
  if (saved.rates && typeof saved.rates === "object") ui.rates = saved.rates;
  if (saved.lastPostings) postingsEl.value = saved.lastPostings;
}

async function boot() {
  ensureKeepAlive();

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

let detailQuery = [];
let detailIndex = [];
const detailFilters = { verdict: "", bucket: "", status: "" };

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
    ...priceNeedles(report.price),
    ...priceNeedles(report.fairPrice),
    bucketOf(bucketDateOf(report), Date.now()),
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
    const bucket = bucketOf(bucketDateOf(item.report), Date.now());
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
  if (detailFilters.status && item.report?.status !== detailFilters.status) return false;
  if (detailFilters.bucket && bucketOf(bucketDateOf(item.report), Date.now()) !== detailFilters.bucket) return false;
  return true;
}

function filtersActive() {
  return Object.values(detailFilters).some(Boolean) || detailQuery.length > 0;
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

// Запятая бывает и десятичной («12 000,50»): по хвосту из двух цифр не режем.
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

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
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
  addFact("Корзинка", bucketOf(bucketDateOf(report), Date.now()));
  addFact("Когда", report.warehouseAt || topDateOf(report));
  addFact("Цена реализации", report.price);
  addFact("Цена", report.fairPrice);
  addFact("Последняя ячейка", report.warehouseCell);
  if (classify(item) !== "hit") addFact("Предыдущий склад", report.lastPlace || topPlaceOf(withLabels(report)));
  if (facts.childElementCount) card.appendChild(facts);

  const rows = withLabels(report);
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
      // первая колонка Hub — плашка типа, вторая — дата моноширинным
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
  // меряем по раскладке: закрытый поповер ещё уменьшен анимацией появления
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
  // кадр на раскладку, потом класс — иначе перехода не будет
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

// у select нет атрибута value, поэтому состояние ставим отсюда, а не в CSS
function renderFilterCount(name, active) {
  const box = filterBoxes.get(name);
  if (!box) return;
  for (const select of box.pop.querySelectorAll("select")) {
    select.closest(".pick")?.classList.toggle("is-set", Boolean(select.value));
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

  renderTally("detail-count", shown.length, all);
  renderFilterCount("detail", countActive(Object.values(detailFilters)));
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

  // тысячи карточек рисовать незачем, до них никто не долистает
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
  for (const id of ["filter-verdict", "filter-bucket", "filter-status"]) {
    const select = $(id);
    if (select) select.value = "";
  }
}

mountDetail();

// Склад в истории есть — смотрим последнюю ячейку на нём; склада нет —
// предыдущий склад по движениям.
let statsIndex = [];
let statsQuery = [];
const statsFilters = {
  verdict: "",
  cell: "",
  place: "",
  bucket: "",
  status: "",
  op: "",
  day: "",
  user: "",
  hour: "",
  priceBand: ""
};
let statsSort = { key: "at", dir: -1 };

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
  op: "stats-op",
  priceBand: "stats-price"
};

// «A → B» — доехал до B, «A → —» — последним известен A
function lastCellOf(raw) {
  const text = String(raw || "").trim();
  if (!text) return "";
  const sides = text.split("→").map((side) => side.trim()).filter(Boolean);
  for (let i = sides.length - 1; i >= 0; i -= 1) {
    if (sides[i] && sides[i] !== "—") return sides[i];
  }
  return "";
}

// рейсы пропускаем, нужен именно склад
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
  const columns = report.columns || [];
  let at = columns.findIndex((title) => /^дата/i.test(String(title || "")));
  if (at < 0) at = 1;
  return String(rows[0]?.[at] || "").trim();
}

function blameOf(item) {
  const report = item.report || {};
  const kind = classify(item);
  if (kind === "hit") {
    return { kind: "cell", value: lastCellOf(report.warehouseCell), at: report.warehouseAt || topDateOf(report) };
  }
  if (kind === "miss") {
    // сканер видит всю историю, разбор текста — откат для обхода DOM
    const place = report.lastPlace || topPlaceOf(withLabels(report));
    return { kind: "place", value: place, at: topDateOf(report) };
  }
  return { kind: "none", value: "", at: "" };
}

const BLAME_TAGS = { cell: "ячейка", place: "склад" };

// Hub пишет «12 000,50 ₽» с неразрывным пробелом, а ищут как придётся
function priceNeedles(text) {
  const value = priceValue(text);
  if (value == null) return [];
  const exact = value.toFixed(2);
  const plain = String(value);
  return [
    String(text),
    exact,
    exact.replace(".", ","),
    plain,
    plain.replace(".", ",")
  ];
}

function priceValue(text) {
  const clean = String(text || "").replace(/[^0-9,.\s]/g, "").replace(/\s+/g, "").replace(",", ".");
  const number = Number.parseFloat(clean);
  return Number.isFinite(number) ? number : null;
}

function priceText(value) {
  try {
    return `${new Intl.NumberFormat("ru-RU", {
      maximumFractionDigits: 2,
      minimumFractionDigits: 2
    }).format(value)} \u20bd`;
  } catch (_err) {
    return `${value.toFixed(2)} \u20bd`;
  }
}

const PRICE_STEPS = [
  { upTo: 500, label: "до 500 ₽" },
  { upTo: 1000, label: "500–1 000 ₽" },
  { upTo: 3000, label: "1 000–3 000 ₽" },
  { upTo: 10000, label: "3 000–10 000 ₽" }
];
const PRICE_ORDER = [...PRICE_STEPS.map((step) => step.label), "10 000 ₽+"];

function priceBandOf(text) {
  const value = priceValue(text);
  if (value == null) return "";
  for (const step of PRICE_STEPS) if (value < step.upTo) return step.label;
  return "10 000 ₽+";
}

function topUserOf(report) {
  const rows = report?.lastRows;
  if (!Array.isArray(rows) || !rows.length) return "";
  const columns = report.columns || [];
  let at = columns.findIndex((title) => /^польз/i.test(String(title || "")));
  if (at < 0) at = 2;
  return String(rows[0]?.[at] || "").trim();
}

function buildStatsIndex(results) {
  const now = Date.now();
  statsIndex = results.map((item) => {
    const blame = blameOf(item);
    const stamp = parseHubDate(blame.at);
    const op = String(withLabels(item.report)[0]?.[0] || "").trim();
    const user = topUserOf(item.report);
    const hour = stamp ? `${pad(stamp.getHours())}:00` : "";
    const price = item.report?.price || "";
    return {
      item,
      blame,
      op,
      user,
      hour,
      price,
      priceBand: priceBandOf(price),
      bucket: bucketOf(bucketDateOf(item.report), now),
      day: stamp ? `${pad(stamp.getDate())}.${pad(stamp.getMonth() + 1)}` : "",
      dayTs: stamp ? new Date(stamp.getFullYear(), stamp.getMonth(), stamp.getDate()).getTime() : 0,
      hay: [haystackOf(item), blame.value, BLAME_TAGS[blame.kind] || "", user, hour, ...priceNeedles(price)]
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
  if (!s.has("verdict") && statsFilters.verdict && classify(item) !== statsFilters.verdict) return false;
  if (!s.has("op") && statsFilters.op && entry.op !== statsFilters.op) return false;
  if (!s.has("status") && statsFilters.status && (item.report?.status || "") !== statsFilters.status) return false;
  if (!s.has("bucket") && statsFilters.bucket && entry.bucket !== statsFilters.bucket) return false;
  if (!s.has("cell") && statsFilters.cell) {
    if (entry.blame.kind !== "cell" || entry.blame.value !== statsFilters.cell) return false;
  }
  if (!s.has("place") && statsFilters.place) {
    if (entry.blame.kind !== "place" || entry.blame.value !== statsFilters.place) return false;
  }
  if (!s.has("day") && statsFilters.day && entry.day !== statsFilters.day) return false;
  if (!s.has("user") && statsFilters.user && entry.user !== statsFilters.user) return false;
  if (!s.has("hour") && statsFilters.hour && entry.hour !== statsFilters.hour) return false;
  if (!s.has("priceBand") && statsFilters.priceBand && entry.priceBand !== statsFilters.priceBand) return false;
  if (statsQuery.length && !statsQuery.some((needle) => entry.hay.includes(needle))) return false;
  return true;
}

function statsFiltersActive() {
  return Object.values(statsFilters).some(Boolean) || statsQuery.length > 0;
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

  const cells = tallyBy(
    statsIndex.filter((entry) => entry.blame.kind === "cell"),
    (entry) => entry.blame.value
  ).map(([value]) => value);
  const places = tallyBy(
    statsIndex.filter((entry) => entry.blame.kind === "place"),
    (entry) => entry.blame.value
  ).map(([value]) => value);

  const buckets = [];
  const statuses = [];
  const ops = [];
  const bands = [];
  for (const entry of statsIndex) {
    if (entry.bucket && !buckets.includes(entry.bucket)) buckets.push(entry.bucket);
    const status = entry.item.report?.status;
    if (status && !statuses.includes(status)) statuses.push(status);
    if (entry.op && !ops.includes(entry.op)) ops.push(entry.op);
    if (entry.priceBand && !bands.includes(entry.priceBand)) bands.push(entry.priceBand);
  }
  buckets.sort((a, b) => BUCKET_ORDER.indexOf(a) - BUCKET_ORDER.indexOf(b));
  statuses.sort((a, b) => a.localeCompare(b, "ru"));
  ops.sort((a, b) => a.localeCompare(b, "ru"));
  bands.sort((a, b) => PRICE_ORDER.indexOf(a) - PRICE_ORDER.indexOf(b));

  fill("stats-cell", cells, "любая");
  fill("stats-place", places, "любой");
  fill("stats-bucket", buckets, "любая");
  fill("stats-status", statuses, "любой");
  fill("stats-op", ops, "любая");
  fill("stats-price", bands, "любая");
}

function syncStatsControls() {
  for (const [key, id] of Object.entries(STATS_SELECTS)) {
    const select = $(id);
    if (select && select.value !== statsFilters[key]) select.value = statsFilters[key];
  }
}

function toggleStatsFilter(key, value) {
  statsFilters[key] = statsFilters[key] === value ? "" : value;
  renderStats();
}

function renderStatsKpis(shown) {
  const host = $("stats-kpis");
  if (!host) return;

  let hits = 0;
  let misses = 0;
  let issues = 0;
  let sum = 0;
  let priced = 0;
  const cells = new Set();
  const places = new Set();
  for (const entry of shown) {
    const kind = classify(entry.item);
    if (kind === "hit") hits += 1;
    else if (kind === "miss") misses += 1;
    else issues += 1;
    if (entry.blame.kind === "cell" && entry.blame.value) cells.add(entry.blame.value);
    if (entry.blame.kind === "place" && entry.blame.value) places.add(entry.blame.value);
    const value = priceValue(entry.price);
    if (value != null) {
      sum += value;
      priced += 1;
    }
  }

  const tiles = [
    { label: "Склад есть", value: hits, mod: "hit" },
    { label: "Склада нет", value: misses, mod: "miss" },
    { label: "Не вышло", value: issues, mod: "issue" },
    { label: "Последних ячеек", value: cells.size, mod: "cell" },
    { label: "Предыдущих складов", value: places.size, mod: "place" }
  ];
  if (priced) {
    tiles.push({
      label: "Сумма",
      text: priceText(sum),
      sub: priced < shown.length ? `по ${priced} из ${shown.length}` : "",
      mod: "money"
    });
  }

  host.innerHTML = "";
  for (const tile of tiles) {
    const box = el("div", `kpi${tile.mod ? ` kpi--${tile.mod}` : ""}`);
    box.appendChild(el("span", null, tile.label));
    box.appendChild(el("b", null, tile.text != null ? tile.text : String(tile.value)));
    if (tile.sub) box.appendChild(el("em", null, tile.sub));
    host.appendChild(box);
  }
}

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
  return active === value ? "Клик — снять фильтр" : "Клик — оставить только эти ID";
}

// цвет закреплён за значением на весь прогон: фильтр не перекрашивает выживших
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
  priceBand: {
    title: "Цена реализации",
    sub: "Цена реализации с карточки Hub, разложенная по разрядам.",
    filter: "priceBand",
    ordered: "priceBand",
    of: (entry) => entry.priceBand
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
  if (dimKey === "priceBand") {
    const at = PRICE_ORDER.indexOf(entry.priceBand);
    return at < 0 ? PRICE_ORDER.length : at;
  }
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

function legendChip(label, total, color, state, pick) {
  const chip = document.createElement("button");
  chip.type = "button";
  chip.className = `lchip${state}`;
  chip.title = state === " is-on" ? "Снять фильтр" : "Показать все ID с этим значением";
  bindVizTip(chip, { title: label, color, rows: [["ID", total]] });
  const mark = el("i");
  mark.style.background = color;
  chip.append(mark, el("span", null, label), el("b", null, String(total)));
  chip.addEventListener("click", pick);
  return chip;
}

function chipState(active, name) {
  return active === name ? " is-on" : active ? " is-dim" : "";
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
  // число строк отдаём в CSS: по нему высота делится поровну
  const rowsBox = el("div", "bars__rows");
  rowsBox.style.setProperty("--bar-rows", String(top.length));
  for (const [value, count] of top) {
    const active = options.active;
    const row = document.createElement("button");
    row.type = "button";
    row.className = `hbar${chipState(active, value)}`;
    row.addEventListener("click", () => options.pick(value));

    const hue = options.colorPerValue ? options.colorPerValue(value) : options.color;
    bindVizTip(row, {
      title: options.labelOf(value),
      color: hue,
      rows: [
        ["ID", count],
        ["доля среза", shareText(count, total)],
        ["место", `${rows.findIndex(([name]) => name === value) + 1} из ${rows.length}`]
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

    row.append(label, track, num);
    rowsBox.appendChild(row);
  }
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

  let totals = { hit: 0, miss: 0, issue: 0 };
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
  const max = Math.max(...top.map(([value]) => {
    const counts = split.get(value);
    return counts.hit + counts.miss + counts.issue;
  })) || 1;

  for (const [value] of top) {
    const counts = split.get(value);
    const total = counts.hit + counts.miss + counts.issue;
    const active = options.active;
    const col = document.createElement("button");
    col.type = "button";
    col.className = `col${chipState(active, value)}`;
    col.addEventListener("click", () => options.pick(value));

    const grand = totals.hit + totals.miss + totals.issue;
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
    // высота столбика — доля от самого высокого, чтобы график занял блок целиком
    const plot = el("span", "col__plot");
    const stack = el("span", "col__stack");
    stack.style.height = `${Math.max(2, (total / max) * 100)}%`;
    // снизу вверх: склад есть, склада нет, не вышло
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

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 100 100");
  svg.setAttribute("preserveAspectRatio", "none");
  const xOf = (index) => (days.length === 1 ? 50 : (index / (days.length - 1)) * 100);
  const yOf = (value) => 95 - (value / max) * 86;

  for (const line of series) {
    const poly = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
    poly.setAttribute("points", line.points.map((value, index) => `${xOf(index)},${yOf(value)}`).join(" "));
    poly.setAttribute("class", `line__path${chipState(options.active, line.name)}`);
    poly.style.stroke = line.color;
    svg.appendChild(poly);
  }
  plot.appendChild(svg);

  // точки HTML поверх: preserveAspectRatio=none растянул бы круги
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
  for (const line of series) {
    legend.appendChild(
      legendChip(line.label, line.total, line.color, chipState(options.active, line.name), () => options.pick(line.name))
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
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 120 120");
  svg.setAttribute("class", "donut__ring");

  const R = 44;
  const LEN = 2 * Math.PI * R;
  const GAP = segments.length > 1 ? 2.6 : 0;
  let offset = 0;
  for (const seg of segments) {
    const share = (seg.count / total) * LEN;
    const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    circle.setAttribute("cx", "60");
    circle.setAttribute("cy", "60");
    circle.setAttribute("r", String(R));
    circle.setAttribute("class", `donut__seg${seg.pickable ? chipState(options.active, seg.name) : ""}`);
    circle.style.stroke = seg.color;
    circle.setAttribute("stroke-dasharray", `${Math.max(0.5, share - GAP)} ${LEN - Math.max(0.5, share - GAP)}`);
    circle.setAttribute("stroke-dashoffset", String(-offset));
    circle.setAttribute("transform", "rotate(-90 60 60)");
    bindVizTip(circle, {
      title: seg.label,
      color: seg.color,
      rows: [
        ["ID", seg.count],
        ["доля", shareText(seg.count, total)]
      ],
      foot: seg.pickable ? pickFoot(options.active, seg.name) : ""
    });
    if (seg.pickable) circle.addEventListener("click", () => options.pick(seg.name));
    svg.appendChild(circle);
    offset += share;
  }

  const centerValue = document.createElementNS("http://www.w3.org/2000/svg", "text");
  centerValue.setAttribute("x", "60");
  centerValue.setAttribute("y", "58");
  centerValue.setAttribute("class", "donut__total");
  centerValue.textContent = String(total);
  svg.appendChild(centerValue);
  const centerLabel = document.createElementNS("http://www.w3.org/2000/svg", "text");
  centerLabel.setAttribute("x", "60");
  centerLabel.setAttribute("y", "74");
  centerLabel.setAttribute("class", "donut__label");
  centerLabel.textContent = "ID";
  svg.appendChild(centerLabel);
  box.appendChild(svg);

  const legend = el("div", "lchips lchips--column");
  for (const seg of segments) {
    if (seg.pickable) {
      legend.appendChild(
        legendChip(seg.label, seg.count, seg.color, chipState(options.active, seg.name), () => options.pick(seg.name))
      );
    } else {
      const still = el("span", "lchip is-rest");
      const mark = el("i");
      mark.style.background = seg.color;
      still.append(mark, el("span", null, seg.label), el("b", null, String(seg.count)));
      legend.appendChild(still);
    }
  }
  box.appendChild(legend);
  host.appendChild(box);
}

function panelTitle(value, entries, onChange) {
  const box = el("div", "ptitle");
  const button = el("button", "ptitle__btn");
  button.type = "button";
  button.title = "Выбрать, что показывать";
  const label = entries.find(([key]) => key === value)?.[1] || value;
  button.appendChild(el("h3", null, label));
  const caret = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  caret.setAttribute("viewBox", "0 0 12 12");
  caret.setAttribute("class", "ptitle__caret");
  caret.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M2.5 4.5 6 8l3.5-3.5");
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "currentColor");
  path.setAttribute("stroke-width", "1.6");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("stroke-linejoin", "round");
  caret.appendChild(path);
  button.appendChild(caret);

  // настоящий select лежит поверх прозрачным слоем: клавиатура и родное меню
  const select = document.createElement("select");
  select.className = "ptitle__select";
  select.setAttribute("aria-label", "Что показывать");
  for (const [key, title] of entries) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = title;
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));

  box.append(button, select);
  return box;
}

function panelSelect(value, entries, onChange) {
  const pick = el("label", "pick pick--panel");
  const select = document.createElement("select");
  for (const [key, title] of entries) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = title;
    select.appendChild(option);
  }
  select.value = value;
  select.addEventListener("change", () => onChange(select.value));
  pick.appendChild(select);
  return pick;
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
  section.dataset.dim = panel.dim;
  section.dataset.viz = panel.viz;

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
  // крестик есть всегда, у единственной панели его прячет CSS
  const drop = el("button", "spanel__drop", "×");
  drop.type = "button";
  drop.title = "Убрать панель";
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

  const slice = statsIndex.filter(
    (entry) => passesStats(entry, new Set([dim.filter])) && dim.of(entry)
  );
  const active = statsFilters[dim.filter];
  const pick = (value) => toggleStatsFilter(dim.filter, value);
  const labelOf = dimLabelOf(panel.dim);
  const colorOf = dimColorOf(panel.dim, slice);
  const empty = "Под фильтры ничего не попало.";

  if (panel.viz === "line") {
    if (panel.dim === "day") {
      // дни по дням выродились бы в диагональ, рисуем есть/нет
      const data = seriesByDay(
        slice.filter((entry) => classify(entry.item) !== "issue"),
        (entry) => classify(entry.item),
        (value) => VERDICT_COLORS[value],
        (value) => VERDICT_WORDS[value],
        2
      );
      renderLineChart(chart, data, {
        active: statsFilters.verdict,
        pick: (value) => toggleStatsFilter("verdict", value),
        empty
      });
    } else {
      const rows = tallyBy(slice, dim.of);
      renderLineChart(chart, seriesByDay(slice, dim.of, colorOf, labelOf, 3), {
        active,
        pick,
        empty,
        foot: rows.length > 3 ? "линии — три самых частых значения; остальное в гистограмме" : ""
      });
    }
    return section;
  }

  if (panel.viz === "donut") {
    renderDonutChart(chart, dimRows(panel.dim, slice), { active, pick, colorOf, labelOf, empty });
    return section;
  }

  if (panel.viz === "cols") {
    renderColsChart(chart, slice, panel.dim, { active, pick, empty });
    return section;
  }

  const missing =
    panel.dim === "cell" || panel.dim === "place"
      ? statsIndex.filter(
          (entry) =>
            passesStats(entry, new Set([dim.filter])) && entry.blame.kind === panel.dim && !entry.blame.value
        ).length
      : 0;
  renderBarChart(chart, dimRows(panel.dim, slice), {
    color: dim.hue || "var(--viz-blue)",
    colorPerValue: dim.color || null,
    labelOf,
    active,
    pick,
    empty,
    foot: missing ? `без значения: ${missing} ${plural(missing, ["ID", "ID", "ID"])}` : ""
  });
  return section;
}

// анимация появления — только новой панели, иначе мигает весь набор
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
  price: {
    title: "Цена реализации",
    width: 16,
    // сортируем числом, иначе «1 000,00» встанет раньше «9,00»
    sort: (entry) => priceValue(entry.price) ?? -1,
    text: (entry) => entry.price || "",
    cell: (entry, td) => {
      td.className = "t-price";
      td.textContent = entry.price || "—";
    }
  },
  priceBand: {
    title: "Разряд цены",
    width: 16,
    sort: (entry) => {
      const at = PRICE_ORDER.indexOf(entry.priceBand);
      return at < 0 ? PRICE_ORDER.length : at;
    },
    text: (entry) => entry.priceBand || "",
    cell: (entry, td) => {
      td.textContent = entry.priceBand || "—";
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

const DEFAULT_STATS_COLS = ["id", "number", "verdict", "blame", "at", "bucket", "price", "status", "op"];
let statsCols = DEFAULT_STATS_COLS.slice();

function persistStatsCols() {
  patchSettings({ statsCols, statsSort });
}

function sortStats(entries) {
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
    th.title = "Клик — сортировка, перетаскиванием — порядок столбцов";
    th.classList.toggle("is-sorted", key === statsSort.key);
    th.classList.toggle("is-desc", key === statsSort.key && statsSort.dir < 0);

    th.addEventListener("dragstart", (event) => {
      dragCol = key;
      th.classList.add("is-dragging");
      event.dataTransfer.effectAllowed = "move";
      // Firefox не начинает перетаскивание без данных
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
        if (statsSort.key === key) statsSort = { key: statsCols[0], dir: 1 };
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
    ["user", "пользователь"],
    ["priceBand", "цена"]
  ];
  const active = chips.filter(([key]) => statsFilters[key]);
  box.closest(".detail__bar")?.classList.toggle("has-chips", active.length > 0);
  if (!active.length) {
    emptyLater(box);
    return;
  }

  emptyNow(box);
  for (const [key, label] of active) {
    const chip = el("span", "detail__chip", `${label}: ${statsFilters[key]}`);
    const drop = el("button", null, "×");
    drop.type = "button";
    drop.title = "Снять фильтр";
    drop.addEventListener("click", () => {
      statsFilters[key] = "";
      renderStats();
    });
    chip.appendChild(drop);
    box.appendChild(chip);
  }
}

function renderStats() {
  const host = $("result-stats");
  if (!host) return;

  // элемент под курсором сейчас исчезнет, pointerleave по нему не придёт
  hideVizTip();
  syncStatsControls();
  const shown = statsIndex.filter((entry) => passesStats(entry));

  renderTally("stats-count", shown.length, statsIndex.length);
  renderFilterCount("stats", countActive(Object.values(statsFilters)));
  const reset = $("stats-reset");
  reveal(reset, statsFiltersActive());

  renderStatsKpis(shown);
  renderStatsPanels();
  renderStatsTable(shown);
  renderStatsChips();
  renderFab();
}

function resetStatsFilters() {
  statsQuery = [];
  for (const key of Object.keys(statsFilters)) statsFilters[key] = "";
  const search = $("stats-search");
  if (search) search.value = "";
  for (const id of Object.values(STATS_SELECTS)) {
    const select = $(id);
    if (select) select.value = "";
  }
  statsFilters.day = "";
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
    const select = $(id);
    if (!select) continue;
    select.addEventListener("change", () => {
      statsFilters[key] = select.value;
      renderStats();
    });
  }

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
        if (statsSort.key === key) statsSort.dir = -statsSort.dir;
        else statsSort = { key, dir: key === "at" ? -1 : 1 };
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

// браузер разрешает тащить картинки и текст как файл, а это выглядит как
// поломка; своё перетаскивание помечено draggable="true"

document.addEventListener("dragstart", (event) => {
  if (event.target?.closest?.('[draggable="true"]')) return;
  event.preventDefault();
});

const SPLASH_MS = 3050;

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
