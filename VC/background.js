const APP_PATH = "app.html";
const STORAGE_RUNTIME = "hubTraceRuntime";
const STORAGE_FINISHED = "hubTraceFinished";
const STORAGE_RUNS = "hubTraceRuns";
const RUN_PREFIX = "hubTraceRun:";
const MAX_RUNS = 5;

const RUNS_BUDGET_BYTES = 6 * 1024 * 1024;
const STORAGE_SETTINGS = "hubTraceSettings";

const MODES = {
  turbo: {
    label: "Турбо",
    threads: 8,
    api: true,
    retryPartial: 0,
    retryFail: 1,
    navTimeoutMs: 20000,
    scanTimeoutMs: 25000,
    apiTimeoutMs: 15000,
    spotCheckEvery: 50
  },
  balance: {
    label: "Баланс",
    threads: 5,
    api: true,
    retryPartial: 1,
    retryFail: 1,
    navTimeoutMs: 28000,
    scanTimeoutMs: 45000,
    apiTimeoutMs: 20000,
    spotCheckEvery: 25
  },
  deep: {
    label: "Глубокий",
    threads: 3,
    api: true,
    retryPartial: 3,
    retryFail: 2,
    navTimeoutMs: 40000,
    scanTimeoutMs: 90000,
    apiTimeoutMs: 25000,
    spotCheckEvery: 0
  }
};

const DEFAULT_SETTINGS = {
  mode: "balance",
  threads: 5,
  focusMode: true,
  useApi: true,
  uncheckCurrentOnly: false
};

const MAX_THREADS = 12;

const state = {
  running: false,
  paused: false,
  stopping: false,
  finalized: true,

  jobId: null,
  warehouse: "",
  postings: [],
  results: [],
  cursor: 0,
  requeue: [],
  processed: 0,

  mode: DEFAULT_SETTINGS.mode,
  threads: DEFAULT_SETTINGS.threads,
  focusMode: DEFAULT_SETTINGS.focusMode,
  useApi: DEFAULT_SETTINGS.useApi,
  uncheckCurrentOnly: false,

  apiState: "unknown",
  apiNote: "",
  apiFailStreak: 0,
  apiSinceCheck: 0,
  apiIndexes: new Set(),
  apiDigests: [],
  apiBlockKind: "",
  apiLastReason: "",
  apiRetryAt: 0,
  apiRetries: 0,
  apiAuthStreak: 0,
  apiInconclusive: 0,
  apiMismatch: 0,
  apiChecks: 0,
  apiRecheck: false,
  nativeApiOffAt: 0,
  recipeStale: false,
  recipeStaleAt: 0,

  appVersion: "",
  placeId: "",
  nativeApi: true,
  apiTune: null,
  cardPlaceless: null,
  changeLabels: {},
  lessonDone: false,
  lessonTries: 0,
  lessonBusy: false,
  autoThreads: false,
  auditTypes: null,
  apiProbe: [],
  retryRound: 0,
  retryIndexes: new Set(),
  retryPending: new Set(),
  apiNotReady: false,

  workers: new Map(),
  liveWorkers: 0,
  domInFlight: 0,

  workerWindowId: null,
  ownsWorkerWindow: false,
  anchorTabId: null,
  workerTabIds: new Set(),

  recipe: null,
  cardRecipe: null,
  startedAt: 0,
  pausedAt: 0,
  pausedMs: 0,

  boostTimerId: null,
  boostIndex: 0
};

const pauseWaiters = new Set();
const pendingByTab = new Map();
let taskSeq = 0;
let stateEmitAt = 0;
let stateEmitTimer = null;

function ignoreLastError() {
  void chrome.runtime.lastError;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function storageSet(payload) {
  return new Promise((resolve) => chrome.storage.local.set(payload, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function storageSetChecked(payload) {
  return new Promise((resolve) => {
    try {
      chrome.storage.local.set(payload, () => {
        const failed = Boolean(chrome.runtime.lastError);
        ignoreLastError();
        resolve(!failed);
      });
    } catch (_err) {
      resolve(false);
    }
  });
}

function emit(payload) {
  try {
    chrome.runtime.sendMessage(payload, ignoreLastError);
  } catch {}
}

function createTab(options) {
  return new Promise((resolve) => {
    chrome.tabs.create(options, (tab) => {
      ignoreLastError();
      resolve(tab && tab.id ? tab : null);
    });
  });
}

function updateTab(tabId, props) {
  return new Promise((resolve) => {
    chrome.tabs.update(tabId, props, (tab) => {
      ignoreLastError();
      resolve(tab || null);
    });
  });
}

function getTab(tabId) {
  return new Promise((resolve) => {
    if (tabId == null) {
      resolve(null);
      return;
    }
    chrome.tabs.get(tabId, (tab) => {
      ignoreLastError();
      resolve(tab || null);
    });
  });
}

function removeTab(tabId) {
  if (tabId == null) return;
  try {
    chrome.tabs.remove(tabId, ignoreLastError);
  } catch {}
}

function sendTab(tabId, message) {
  return new Promise((resolve) => {
    try {
      chrome.tabs.sendMessage(tabId, message, (reply) => {
        ignoreLastError();
        resolve(reply || null);
      });
    } catch (_err) {
      resolve(null);
    }
  });
}

function cfg() {
  return MODES[state.mode] || MODES.balance;
}

function elapsedMs() {
  if (!state.startedAt) return 0;
  const paused = state.pausedMs + (state.paused && state.pausedAt ? Date.now() - state.pausedAt : 0);
  return Math.max(0, Date.now() - state.startedAt - paused);
}

function ratePerMin() {
  const ms = elapsedMs();
  if (ms < 1500 || !state.processed) return 0;
  return (state.processed / ms) * 60000;
}

function etaMs() {
  const rate = ratePerMin();
  if (!rate) return null;
  const left = state.postings.length - state.processed;
  if (left <= 0) return 0;
  return Math.round((left / rate) * 60000);
}

function workerSnapshot() {
  return [...state.workers.values()]
    .sort((a, b) => a.id - b.id)
    .map((worker) => ({
      id: worker.id,
      posting: worker.posting,
      phase: worker.phase,
      via: worker.via
    }));
}

function snapshot() {
  return {
    running: state.running,
    paused: state.paused,
    stopping: state.stopping,
    jobId: state.jobId,
    warehouse: state.warehouse,
    processed: state.processed,
    total: state.postings.length,
    mode: state.mode,
    threads: state.threads,
    focusMode: state.focusMode,
    useApi: state.useApi,
    apiState: state.apiState,
    apiNote: state.apiNote,
    apiProbe: state.apiProbe,
    apiTune: state.apiTune,
    apiLastReason: state.apiLastReason,
    apiBlockKind: state.apiBlockKind,
    apiRetryAt: state.apiRetryAt,
    recipeStale: state.recipeStale,
    elapsedMs: elapsedMs(),
    rate: ratePerMin(),
    etaMs: etaMs(),
    retryRound: state.retryRound,
    retryTotal: state.retryIndexes.size,
    retryLeft: state.retryPending.size,
    workers: workerSnapshot()
  };
}

function emitState(force) {
  const now = Date.now();
  if (!force && now - stateEmitAt < 220) {
    if (stateEmitTimer) return;
    stateEmitTimer = setTimeout(() => {
      stateEmitTimer = null;
      emitState(true);
    }, 220);
    return;
  }
  stateEmitAt = now;
  emit({ action: "scanState", state: snapshot() });
}

function notice(level, text) {
  state.apiNote = level === "api" ? text : state.apiNote;
  emit({ action: "scanNotice", level, text, at: Date.now() });
}

let runtimeWriteAt = 0;
let runtimeWriteTimer = null;

function persistRuntimeSoon() {
  if (runtimeWriteTimer) return;
  const wait = Math.max(0, 1000 - (Date.now() - runtimeWriteAt));
  runtimeWriteTimer = setTimeout(() => {
    runtimeWriteTimer = null;
    void persistRuntime();
  }, wait);
}

async function persistRuntime() {
  runtimeWriteAt = Date.now();
  await storageSet({
    [STORAGE_RUNTIME]: {
      inProgress: state.running,
      paused: state.paused,
      processed: state.processed,
      total: state.postings.length,
      threads: state.threads,
      mode: state.mode,
      jobId: state.jobId,
      updatedAt: Date.now()
    }
  });
}

function gate() {
  if (!state.paused || state.stopping) return Promise.resolve();
  return new Promise((resolve) => pauseWaiters.add(resolve));
}

function releaseGate() {
  for (const resolve of pauseWaiters) resolve();
  pauseWaiters.clear();
}

let stopSignal = null;
let releaseStopSignal = null;

function resetStopSignal() {
  stopSignal = new Promise((resolve) => {
    releaseStopSignal = resolve;
  });
}

function waitForStop() {
  if (state.stopping) return Promise.resolve("stopped");
  if (!stopSignal) resetStopSignal();
  return stopSignal;
}

function releaseStop() {
  releaseStopSignal?.("stopped");
}

function abortActiveTabs() {
  for (const worker of state.workers.values()) {
    if (worker.tabId != null) void sendTab(worker.tabId, { action: "ht:abort" });
  }
}

function setPaused(value) {
  const next = Boolean(value);
  if (!state.running || state.paused === next) return;
  state.paused = next;
  if (next) {
    state.pausedAt = Date.now();
    abortActiveTabs();
    stopBoost();
  } else {
    state.pausedMs += Date.now() - (state.pausedAt || Date.now());
    state.pausedAt = 0;
    releaseGate();
    ensureWorkers();
    syncBoost();
  }
  emitState(true);
  void persistRuntime();
}

function stopScan() {
  if (!state.running) {
    closeWorkerWindow();
    return;
  }
  state.stopping = true;
  state.paused = false;
  releaseGate();
  releaseStop();
  abortActiveTabs();
  stopBoost();
  emitState(true);
}

function createWindow(options) {
  return new Promise((resolve) => {
    try {
      chrome.windows.create(options, (created) => {
        ignoreLastError();
        resolve(created || null);
      });
    } catch (_err) {
      resolve(null);
    }
  });
}

function getWindow(windowId) {
  return new Promise((resolve) => {
    if (windowId == null) {
      resolve(null);
      return;
    }
    chrome.windows.get(windowId, {}, (win) => {
      ignoreLastError();
      resolve(win || null);
    });
  });
}

let workerWindowPromise = null;

async function ensureWorkerWindow() {
  if (state.workerWindowId != null && (await getWindow(state.workerWindowId))) return state.workerWindowId;
  if (workerWindowPromise) return workerWindowPromise;

  workerWindowPromise = (async () => {
    let win = await createWindow({ url: "about:blank", focused: false, type: "normal" });
    if (!win?.id) win = await createWindow({ url: "about:blank", type: "normal" });
    if (!win?.id) return null;

    state.workerWindowId = win.id;
    state.ownsWorkerWindow = true;
    state.anchorTabId = win.tabs?.[0]?.id ?? null;
    if (state.anchorTabId != null) state.workerTabIds.add(state.anchorTabId);
    chrome.windows.update(win.id, { state: "maximized" }, ignoreLastError);
    return win.id;
  })();

  try {
    return await workerWindowPromise;
  } finally {
    workerWindowPromise = null;
  }
}

function closeWorkerWindow() {
  const id = state.workerWindowId;
  const owns = state.ownsWorkerWindow;
  state.workerWindowId = null;
  state.ownsWorkerWindow = false;
  state.anchorTabId = null;

  for (const tabId of [...state.workerTabIds]) removeTab(tabId);
  state.workerTabIds.clear();

  if (id != null && owns) {
    try {
      chrome.windows.remove(id, ignoreLastError);
    } catch {}
  }
}

const BOOST_INTERVAL_MS = 450;

function stopBoost() {
  if (state.boostTimerId == null) return;
  clearInterval(state.boostTimerId);
  state.boostTimerId = null;
}

function boostTick() {
  if (!state.running || state.stopping || state.paused) return;
  if (!state.focusMode || state.domInFlight <= 0) return;
  const candidates = [...state.workers.values()].filter((worker) => worker.phase !== "idle" && worker.via !== "api");
  if (!candidates.length) return;
  if (state.boostIndex >= candidates.length) state.boostIndex = 0;
  const worker = candidates[state.boostIndex];
  state.boostIndex += 1;
  activateTab(worker.tabId);
}

function syncBoost() {
  if (!state.running || state.stopping || state.paused || !state.focusMode) {
    stopBoost();
    return;
  }
  if (state.boostTimerId != null) return;
  state.boostIndex = 0;
  boostTick();
  state.boostTimerId = setInterval(boostTick, BOOST_INTERVAL_MS);
}

function activateTab(tabId) {
  if (tabId == null) return;
  chrome.tabs.get(tabId, (tab) => {
    ignoreLastError();
    if (!tab?.id) return;
    chrome.tabs.update(tabId, { active: true, autoDiscardable: false }, ignoreLastError);
  });
}

async function spawnWorker(id) {
  if (state.workers.has(id)) return;
  state.liveWorkers += 1;
  try {
    await spawnWorkerInner(id);
  } catch (error) {
    state.liveWorkers -= 1;
    notice("error", `Не удалось поднять вкладку: ${String(error?.message || error)}`);
    maybeFinalize();
  }
}

async function spawnWorkerInner(id) {
  const windowId = await ensureWorkerWindow();
  if (windowId == null || state.stopping || !state.running) {
    if (windowId == null && state.running) throw new Error("не удалось открыть окно для рабочих вкладок");
    state.liveWorkers -= 1;
    maybeFinalize();
    return;
  }

  const tab = await createTab({ url: "about:blank", active: false, windowId });

  if (!tab?.id || state.stopping || !state.running) {
    if (tab?.id) removeTab(tab.id);
    state.liveWorkers -= 1;
    maybeFinalize();
    return;
  }

  state.workerTabIds.add(tab.id);

  let placed = tab.windowId != null ? tab : await getTab(tab.id);
  if (placed && placed.windowId !== windowId) {
    await moveWorkerTabsTo(windowId, [tab.id]);
    placed = await getTab(tab.id);
  }
  if (placed && placed.windowId !== windowId) {
    state.workerTabIds.delete(tab.id);
    removeTab(tab.id);
    throw new Error("вкладка не попала в рабочее окно");
  }

  const worker = {
    id,
    tabId: tab.id,
    posting: "",
    phase: "idle",
    via: "",
    hubReady: false,
    retire: false
  };
  state.workers.set(id, worker);
  await updateTab(tab.id, { autoDiscardable: false });
  emitState();
  void workerLoop(worker);
}

function retireWorker(worker) {
  if (!state.workers.has(worker.id)) return;
  state.workers.delete(worker.id);
  if (worker.tabId != null) {
    pendingByTab.delete(worker.tabId);
    state.workerTabIds.delete(worker.tabId);
    removeTab(worker.tabId);
  }
  state.liveWorkers -= 1;
  emitState();
  maybeFinalize();
}

function ensureWorkers() {
  if (!state.running || state.stopping) return;
  if (!hasWork()) return;
  for (let id = 1; id <= state.threads; id += 1) {
    if (!state.workers.has(id)) void spawnWorker(id);
  }
}

async function moveWorkerTabsTo(windowId, only) {
  const tabIds = only || [...state.workers.values()].map((worker) => worker.tabId).filter((id) => id != null);
  if (!tabIds.length || windowId == null) return;
  await new Promise((resolve) => {
    chrome.tabs.move(tabIds, { windowId, index: -1 }, () => {
      ignoreLastError();
      resolve();
    });
  });
}

function hasWork() {
  return state.requeue.length > 0 || state.cursor < state.postings.length;
}

function takeNext() {
  if (state.requeue.length) return state.requeue.shift();
  if (state.cursor < state.postings.length) return state.cursor++;
  return null;
}

function putBack(index) {
  if (index == null) return;
  if (!state.requeue.includes(index)) state.requeue.unshift(index);
}

function setPhase(worker, phase, posting, via) {
  worker.phase = phase;
  if (posting !== undefined) worker.posting = posting;
  if (via !== undefined) worker.via = via;
  emitState();
}

function cleanPosting(posting) {
  return String(posting || "").trim().replace(/^Lozon:/i, "");
}

const HISTORY_TAB = "transitionHistory";

function buildHistoryUrl(posting) {
  const id = encodeURIComponent(cleanPosting(posting));
  const place = state.placeId ? `warehouse=${encodeURIComponent(state.placeId)}&` : "";
  return `https://hub.o3t.ru/management/stock/item/Lozon:${id}?${place}tab=${HISTORY_TAB}`;
}

function failItem(posting, status, extra) {
  return { posting, status, found: false, expected: 0, loaded: 0, ok: false, via: "dom", ...(extra || {}) };
}

async function domScan(worker, posting) {
  const conf = cfg();
  const tabId = worker.tabId;
  if (tabId == null) {
    worker.retire = true;
    return failItem(posting, "tab_error");
  }
  const taskId = `k${++taskSeq}`;
  const url = buildHistoryUrl(posting);

  let settle = null;
  const answer = new Promise((resolve) => {
    settle = resolve;
  });

  pendingByTab.set(tabId, {
    taskId,
    posting: cleanPosting(posting),
    claimed: false,
    resolve: settle,
    job: {
      taskId,
      warehouse: state.warehouse,
      timeoutMs: conf.scanTimeoutMs,
      uncheckCurrentOnly: state.uncheckCurrentOnly
    }
  });

  state.domInFlight += 1;
  syncBoost();
  setPhase(worker, "open", posting, "dom");

  try {
    const moved = await updateTab(tabId, { url, autoDiscardable: false });
    if (!moved) return failItem(posting, "tab_error");
    if (state.focusMode) activateTab(tabId);

    const rescue = setTimeout(() => {
      const pending = pendingByTab.get(tabId);
      if (!pending || pending.taskId !== taskId || pending.claimed) return;
      injectScanner(tabId);
    }, Math.min(7000, conf.navTimeoutMs));

    const strayCheck = await Promise.race([
      answer.then((value) => ({ answered: value })),
      sleep(conf.navTimeoutMs).then(() => ({ answered: null })),
      waitForStop().then(() => ({ answered: { status: "stopped", found: false, expected: 0, loaded: 0, ok: false } }))
    ]);
    if (strayCheck.answered === null) {
      const pending = pendingByTab.get(tabId);
      if (pending && pending.taskId === taskId && !pending.claimed) {
        const current = await getTab(tabId);
        const href = String(current?.url || "");
        if (!href) {
          clearTimeout(rescue);
          return failItem(posting, "tab_error");
        }
        if (!/\/stock\/item\//i.test(href)) {
          clearTimeout(rescue);
          return failItem(posting, /login|sso|auth/i.test(href) ? "auth" : "no_history");
        }
      }
    }

    const verdict =
      strayCheck.answered ||
      (await Promise.race([
        answer,
        sleep(conf.scanTimeoutMs).then(() => ({ timeout: true })),
        waitForStop().then(() => ({ stopped: true }))
      ]));
    clearTimeout(rescue);

    if (verdict?.stopped) return failItem(posting, "stopped");
    if (verdict?.timeout) return failItem(posting, "timeout");
    return { posting, ...verdict };
  } catch (error) {
    return failItem(posting, "exception", { error: String(error?.message || error) });
  } finally {
    pendingByTab.delete(tabId);
    state.domInFlight = Math.max(0, state.domInFlight - 1);
    syncBoost();
    setPhase(worker, "idle", "", "");
  }
}

function injectScanner(tabId) {
  try {
    chrome.scripting.executeScript(
      { target: { tabId }, files: ["netprobe.js"], world: "MAIN" },
      ignoreLastError
    );
    chrome.scripting.executeScript({ target: { tabId }, files: ["scanner.js"] }, ignoreLastError);
  } catch {}
}

async function apiScan(worker, posting) {
  const conf = cfg();
  if (worker.tabId == null) {
    worker.retire = true;
    return null;
  }
  setPhase(worker, "api", posting, "api");
  state.apiNotReady = false;
  const reply = await Promise.race([
    sendTab(worker.tabId, {
      action: "ht:apiScan",
      posting,
      warehouse: state.warehouse,
      timeoutMs: conf.apiTimeoutMs
    }),
    sleep(conf.apiTimeoutMs + 4000).then(() => null)
  ]);
  setPhase(worker, "idle", "", "");
  if (!reply?.ok || !reply.result) {
    state.apiLastReason = reply?.reason || "нет ответа от вкладки";
    if (Array.isArray(reply?.probe) && reply.probe.length) {
      state.apiProbe = reply.probe;
      emitState(true);
    }
    if (reply?.nativeMissing && state.nativeApi) {
      state.nativeApi = false;
      state.nativeApiOffAt = Date.now();
      broadcastHints();
    }
    if (reply?.notReady) {
      state.apiNotReady = true;
      return null;
    }
    if (reply?.auth) {
      state.apiAuthStreak += 1;
      if (state.recipe) markRecipeStale(reply.reason);
    }
    return null;
  }
  state.apiAuthStreak = 0;
  return { posting, ...reply.result };
}

function isHardStop(item) {
  return ["auth", "missing", "stopped", "paused"].includes(item?.status);
}

function reportWeight(item) {
  const report = item?.report;
  if (!report) return 0;
  return (
    (report.number ? 4 : 0) +
    (report.status ? 3 : 0) +
    (report.warehouseAt ? 2 : 0) +
    (report.warehouseCell ? 2 : 0) +
    (report.price ? 2 : 0) +
    (report.lastRows?.length ? 1 : 0)
  );
}

function mergeReports(a, b) {
  if (!a?.report) return b?.report || null;
  if (!b?.report) return a.report;
  const strong = reportWeight(a) >= reportWeight(b) ? a.report : b.report;
  const weak = strong === a.report ? b.report : a.report;
  return {
    number: strong.number || weak.number || "",
    status: strong.status || weak.status || "",
    warehouseAt: strong.warehouseAt || weak.warehouseAt || "",
    warehouseCell: strong.warehouseCell || weak.warehouseCell || "",
    lastPlace: strong.lastPlace || weak.lastPlace || "",
    price: strong.price || weak.price || "",
    fairPrice: strong.fairPrice || weak.fairPrice || "",
    columns: strong.columns?.length ? strong.columns : weak.columns || [],
    lastRows: strong.lastRows?.length ? strong.lastRows : weak.lastRows || [],
    codes: strong.lastRows?.length ? strong.codes || [] : weak.codes || []
  };
}

function betterOf(a, b) {
  if (!b) return a;
  if (!a) return b;
  if (b.found !== a.found) return b.found ? b : a;
  const aLoaded = Number(a.loaded) || 0;
  const bLoaded = Number(b.loaded) || 0;
  if (aLoaded !== bLoaded) return bLoaded > aLoaded ? b : a;
  if (b.ok !== a.ok) return b.ok ? b : a;
  return a;
}

function needsRetry(item, attempt) {
  if (state.stopping || state.paused) return false;
  if (!item) return true;
  if (item.found) return false;
  if (isHardStop(item)) return false;
  if (item.ok && item.status === "complete") return false;
  const conf = cfg();
  if (item.status === "partial") return attempt <= conf.retryPartial;
  return attempt <= conf.retryFail;
}

async function domScanWithRetry(worker, posting) {
  let best = await domScan(worker, posting);
  let attempt = 1;
  while (needsRetry(best, attempt)) {
    attempt += 1;
    await sleep(150);
    if (state.stopping) break;
    const next = await domScan(worker, posting);
    const merged = mergeReports(best, next);
    best = betterOf(best, next);
    if (merged) best = { ...best, report: merged };
  }
  return best;
}

function hintsMessage() {
  return {
    action: "ht:setHints",
    appVersion: state.appVersion,
    placeId: state.placeId,
    nativeApi: state.nativeApi,
    apiTune: state.apiTune,
    cardPlaceless: state.cardPlaceless,
    labels: state.changeLabels,
    auditTypes: state.auditTypes
  };
}

const CYRILLIC = /[А-Яа-яЁё]/;

function labelsByDate(rows) {
  const byDate = new Map();
  if (!Array.isArray(rows)) return byDate;
  for (const row of rows) {
    const at = String(row?.[1] || "").trim();
    const label = String(row?.[0] || "").trim();
    if (!at || !label) continue;
    const known = byDate.get(at);
    if (known === undefined) byDate.set(at, label);
    else if (known !== label) byDate.set(at, "");
  }
  return byDate;
}

function learnChangeLabels(api, dom) {
  const codes = api?.report?.codes;
  const apiRows = api?.report?.lastRows;
  const domRows = dom?.report?.lastRows;
  if (!Array.isArray(codes) || !codes.length || !Array.isArray(domRows)) return false;

  const sameShape = codes.length === domRows.length;
  const byDate = sameShape ? null : labelsByDate(domRows);
  if (!sameShape && (!byDate.size || !Array.isArray(apiRows))) return false;

  let learned = 0;
  let full = sameShape;
  codes.forEach((code, index) => {
    let label;
    if (sameShape) label = String(domRows[index]?.[0] || "").trim();
    else {
      const at = String(apiRows[index]?.[1] || "").trim();
      label = at ? byDate.get(at) || "" : "";
    }
    if (!label) full = false;
    if (!code || !label || state.changeLabels[code]) return;
    if (!CYRILLIC.test(label) || label.length > 40) return;
    state.changeLabels[code] = label;
    learned += 1;
  });
  if (learned) broadcastHints();
  return full;
}

function broadcastHints() {
  const message = hintsMessage();
  for (const worker of state.workers.values()) {
    if (worker.tabId != null) void sendTab(worker.tabId, message);
  }
}

function reviveNativeApi() {
  if (state.nativeApi || !state.nativeApiOffAt) return;
  if (Date.now() - state.nativeApiOffAt < NATIVE_RECOVER_MS) return;
  state.nativeApi = true;
  state.nativeApiOffAt = 0;
  notice("api", "Пробую прямую ручку истории заново.");
  broadcastHints();
  emitState(true);
}

function apiAllowed(worker) {
  if (!state.useApi || !cfg().api || !worker.hubReady) return false;
  reviveNativeApi();
  if (!state.nativeApi && !state.recipe) return false;

  if (state.recipeStale) {
    if (Date.now() - state.recipeStaleAt < RECIPE_REFRESH_TIMEOUT_MS) return false;
    state.recipeStale = false;
    state.recipeStaleAt = 0;
  }

  if (state.apiState === "blocked") return apiRetryDue();
  return true;
}

const SAME_DIGEST_LIMIT = 4;

function watchDigest(item) {
  const digest = item?.digest;
  if (!digest) return;
  state.apiDigests.push({ digest, posting: item.posting });
  if (state.apiDigests.length > SAME_DIGEST_LIMIT) state.apiDigests.shift();
  if (state.apiDigests.length < SAME_DIGEST_LIMIT) return;

  const first = state.apiDigests[0].digest;
  if (!state.apiDigests.every((entry) => entry.digest === first)) return;
  const postings = new Set(state.apiDigests.map((entry) => entry.posting));
  if (postings.size < SAME_DIGEST_LIMIT) return;

  const back = requeueApiResults();
  blockApi(
    back
      ? `Быстрый путь отдаёт одинаковый ответ на разные номера. Отключил его и переснимаю ${back} номер(ов).`
      : "Быстрый путь отдаёт одинаковый ответ на разные номера. Отключил его.",
    "mismatch"
  );
}

const LESSON_TRIES = 4;

function lessonDue() {
  return !state.lessonDone && !state.lessonBusy && state.lessonTries < LESSON_TRIES;
}

const SPOT_CHECK_BACKOFF = 4;

function spotCheckEvery() {
  const base = cfg().spotCheckEvery;
  if (!base) return 0;
  return base * Math.pow(2, Math.min(state.apiChecks, SPOT_CHECK_BACKOFF));
}

function spotCheckDue() {
  if (state.apiRecheck) return true;
  const every = spotCheckEvery();
  if (!every) return false;
  return state.apiSinceCheck >= every;
}

const API_RETRY_BASE_MS = 20000;

const API_RETRY_CAP_MS = 300000;

const API_MISMATCH_LIMIT = 2;

const API_MISMATCH_RETRY_MS = 180000;
const API_FAIL_LIMIT = 5;
const RECIPE_REFRESH_TIMEOUT_MS = 60000;
const API_AUTH_STREAK_LIMIT = 6;

const NATIVE_RECOVER_MS = 180000;

function acceptRecipe(next) {
  if (!state.recipe) return true;
  if (state.recipeStale) return true;
  const score = Number(next.score) || 0;
  const current = Number(state.recipe.score) || 0;
  if (score > current) return true;
  return score >= current && (Number(next.capturedAt) || 0) > (Number(state.recipe.capturedAt) || 0);
}

function markRecipeStale(status) {
  if (state.recipeStale) return;
  state.recipeStale = true;
  state.recipeStaleAt = Date.now();
  notice("api", `Токен устарел (ответ ${status || 401}). Обновляю его загрузкой страницы.`);
  emitState(true);
}

function blockApi(reason, kind) {
  if (state.apiState === "blocked") return;
  state.apiState = "blocked";
  state.apiBlockKind = kind || "mismatch";
  state.apiDigests = [];

  const wait =
    state.apiBlockKind === "mismatch"
      ? API_MISMATCH_RETRY_MS
      : Math.min(API_RETRY_CAP_MS, API_RETRY_BASE_MS * Math.pow(2, state.apiRetries));
  state.apiRetryAt = Date.now() + wait;

  notice("api", `${reason} Попробую снова через ${Math.round(wait / 1000)} с.`);
  retuneThreads();
  emitState(true);
}

function apiRetryDue() {
  if (state.apiState !== "blocked") return false;
  if (!state.apiRetryAt || Date.now() < state.apiRetryAt) return false;

  const wasMismatch = state.apiBlockKind === "mismatch";
  state.apiRetries += 1;
  state.apiRetryAt = 0;
  state.apiBlockKind = "";
  state.apiState = "unknown";
  state.apiFailStreak = 0;
  state.apiMismatch = 0;
  state.apiSinceCheck = 0;
  if (wasMismatch) state.apiChecks = 0;
  notice("api", `Пробую быстрый путь заново (попытка ${state.apiRetries}).`);
  emitState(true);
  return true;
}

function requeueApiResults() {
  if (!state.apiIndexes.size) return 0;
  const indexes = [...state.apiIndexes];
  state.apiIndexes.clear();
  for (const index of indexes) {
    if (state.results[index]) {
      state.results[index] = null;
      state.processed = Math.max(0, state.processed - 1);
    }
    putBack(index);
  }
  emit({ action: "scanRevalidate", indexes });
  return indexes.length;
}

const API_INCONCLUSIVE_LIMIT = 3;

function calibrate(api, dom, index) {
  state.apiRecheck = false;
  if (!api) {
    if (state.recipeStale) {
      if (state.apiAuthStreak >= API_AUTH_STREAK_LIMIT) {
        blockApi(`Токен не обновляется: ${state.apiLastReason || "ответ 401"}.`, "unavailable");
      }
      return;
    }
    state.apiFailStreak += 1;
    if (state.apiFailStreak >= API_FAIL_LIMIT) {
      blockApi(`Быстрый путь недоступен: ${state.apiLastReason || "нет ответа"}. Работаю через DOM.`, "unavailable");
    }
    return;
  }

  const domTrusted = Boolean(dom?.ok) && dom?.status === "complete";
  if (!domTrusted) {
    state.apiSinceCheck = 0;
    state.apiInconclusive += 1;
    state.apiChecks += 1;
    if (
      state.apiInconclusive >= API_INCONCLUSIVE_LIMIT &&
      state.apiState !== "trusted" &&
      api.status === "complete"
    ) {
      state.apiState = "trusted";
      state.apiRetries = 0;
      state.apiBlockKind = "";
      retuneThreads();
      notice(
        "api",
        "Обход DOM не дочитывает список, сверять не с чем. Доверяю быстрому пути: он берёт итог из ответа сервера."
      );
      emitState(true);
    }
    return;
  }

  state.apiInconclusive = 0;
  state.apiSinceCheck = 0;
  if (Boolean(api.found) === Boolean(dom?.found)) {
    state.apiFailStreak = 0;
    state.apiMismatch = 0;
    state.apiChecks += 1;
    if (state.apiState === "blocked") return;
    if (state.apiState !== "trusted") {
      state.apiState = "trusted";
      state.apiRetries = 0;
      state.apiBlockKind = "";
      retuneThreads();
      notice("api", "Быстрый путь включён: история читается напрямую.");
      emitState(true);
    }
    return;
  }

  state.apiMismatch += 1;
  state.apiChecks = 0;
  const where = dom?.posting || index;
  if (state.apiMismatch < API_MISMATCH_LIMIT) {
    state.apiRecheck = true;
    notice("api", `Быстрый путь разошёлся с обходом DOM на ${where}. Проверяю ещё раз на следующем номере.`);
    emitState(true);
    return;
  }

  const back = requeueApiResults();
  blockApi(
    back
      ? `Быстрый путь разошёлся с обходом DOM на ${where}. Отключил его и переснимаю ${back} номер(ов).`
      : `Быстрый путь разошёлся с обходом DOM на ${where}. Отключил его.`,
    "mismatch"
  );
}

async function primeTab(worker, posting) {
  if (worker.hubReady || worker.tabId == null) return worker.hubReady;

  setPhase(worker, "open", posting, "api");
  const moved = await updateTab(worker.tabId, {
    url: buildHistoryUrl(posting),
    autoDiscardable: false
  });
  if (!moved) {
    worker.retire = true;
    return false;
  }

  const deadline = Date.now() + cfg().navTimeoutMs;
  while (!worker.hubReady && Date.now() < deadline) {
    if (state.stopping || worker.retire) break;
    await sleep(120);
  }
  setPhase(worker, "idle", "", "");
  return worker.hubReady;
}

async function retryBoth(worker, posting, index) {
  if (!worker.hubReady && state.useApi && cfg().api) await primeTab(worker, posting);

  const api = apiAllowed(worker) ? await apiScan(worker, posting) : null;
  if (api) {
    state.apiIndexes.add(index);
    watchDigest(api);
  }
  if (state.stopping) return failItem(posting, "stopped");

  const dom = await domScanWithRetry(worker, posting);
  learnChangeLabels(api, dom);
  const best = betterOf(api, dom);
  const merged = mergeReports(api, dom);
  return merged ? { ...best, report: merged } : best;
}

async function processOne(worker, posting, index) {
  if (!worker.hubReady && state.useApi && cfg().api) await primeTab(worker, posting);

  if (state.retryIndexes.has(index)) return retryBoth(worker, posting, index);

  if (apiAllowed(worker)) {
    if (state.apiState === "trusted" && !spotCheckDue() && !lessonDue()) {
      const api = await apiScan(worker, posting);
      if (!api && state.apiNotReady) return domScanWithRetry(worker, posting);
      if (api) {
        state.apiFailStreak = 0;
        state.apiSinceCheck += 1;
        state.apiIndexes.add(index);
        watchDigest(api);
        return api;
      }
      if (state.recipeStale) {
        if (state.apiAuthStreak >= API_AUTH_STREAK_LIMIT) {
          blockApi(`Токен не обновляется: ${state.apiLastReason || "ответ 401"}.`, "unavailable");
        }
      } else {
        state.apiFailStreak += 1;
        if (state.apiFailStreak >= API_FAIL_LIMIT) {
          blockApi(`Быстрый путь перестал отвечать: ${state.apiLastReason || "нет ответа"}.`, "unavailable");
        }
      }
    } else {
      const lesson = lessonDue();
      if (lesson) {
        state.lessonBusy = true;
        state.lessonTries += 1;
      }
      try {
        const api = await apiScan(worker, posting);
        if (state.stopping) return failItem(posting, "stopped");
        const dom = await domScanWithRetry(worker, posting);
        if (learnChangeLabels(api, dom) && lesson) state.lessonDone = true;
        calibrate(api, dom, index);
        const merged = mergeReports(dom, api);
        return merged ? { ...dom, report: merged } : dom;
      } finally {
        if (lesson) state.lessonBusy = false;
      }
    }
  }

  return domScanWithRetry(worker, posting);
}

function commit(index, item) {
  const prev = state.results[index];
  if (prev == null) state.processed += 1;
  state.retryPending.delete(index);
  const best = betterOf(prev, item) || item;
  const merged = mergeReports(prev, item);
  item = merged ? { ...best, report: merged } : best;
  state.results[index] = item;
  emit({
    action: "scanProgress",
    jobId: state.jobId,
    index,
    item,
    processed: state.processed,
    total: state.postings.length,
    elapsedMs: elapsedMs(),
    rate: ratePerMin(),
    etaMs: etaMs(),
    retryRound: state.retryRound,
    retryTotal: state.retryIndexes.size,
    retryLeft: state.retryPending.size
  });
  persistRuntimeSoon();
}

async function workerLoop(worker) {
  try {
    while (state.running && !state.stopping && !worker.retire && worker.id <= state.threads) {
      await gate();
      if (!state.running || state.stopping || worker.retire || worker.id > state.threads) break;

      const index = takeNext();
      if (index == null) break;

      const posting = state.postings[index];
      let item;
      try {
        item = await processOne(worker, posting, index);
      } catch (error) {
        item = failItem(posting, "exception", { error: String(error?.message || error) });
      }

      if (state.stopping) {
        putBack(index);
        break;
      }
      if (item?.status === "paused" || item?.status === "stopped") {
        putBack(index);
        continue;
      }
      if (item?.via === "api" && state.apiState === "blocked") {
        state.apiIndexes.delete(index);
        putBack(index);
        continue;
      }
      commit(index, item || failItem(posting, "script_error"));
    }
  } finally {
    retireWorker(worker);
  }
}

function isIssue(item) {
  if (!item) return true;
  if (item.found) return false;
  if (item.status === "partial") return true;
  if (item.status === "complete" || item.status === "missing") return false;
  return !item.ok;
}

const COVERAGE_TARGET = 0.8;
const MAX_RETRY_ROUNDS = 3;

function coverageOf(item) {
  if (!item) return 0;
  if (item.found) return 1;
  const expected = Number(item.expected) || 0;
  const loaded = Number(item.loaded) || 0;
  if (!expected) return loaded > 0 || (item.ok && item.status === "complete") ? 1 : 0;
  return Math.min(1, loaded / expected);
}

const NOTHING_MORE = ["missing", "stopped", "paused"];

function needsMore(item) {
  if (NOTHING_MORE.includes(item?.status)) return false;
  return isIssue(item) || coverageOf(item) < COVERAGE_TARGET;
}

function queueRetries() {
  if (state.stopping || state.retryRound >= MAX_RETRY_ROUNDS) return false;

  const again = [];
  state.results.forEach((item, index) => {
    if (needsMore(item)) again.push(index);
  });
  if (!again.length) return false;

  state.retryRound += 1;
  state.retryIndexes = new Set(again);
  state.retryPending = new Set(again);
  state.requeue.push(...again);
  notice(
    "api",
    `Дочитываю ${again.length} номер(ов) — круг ${state.retryRound} из ${MAX_RETRY_ROUNDS}, ` +
      "запросом и страницей."
  );
  emitState(true);
  return true;
}

function maybeFinalize() {
  if (!state.running || state.finalized) return;
  if (state.liveWorkers > 0) return;
  if (!state.stopping && state.paused) return;
  if (!state.stopping && hasWork()) {
    ensureWorkers();
    if (state.liveWorkers > 0) return;
  }
  if (!state.stopping && queueRetries()) {
    ensureWorkers();
    if (state.liveWorkers > 0) return;
  }
  void finalize();
}

function verdictKind(item) {
  if (item?.found) return "hit";
  return isIssue(item) ? "issue" : "miss";
}

function runSummary(finished, bytes) {
  const results = Array.isArray(finished?.results) ? finished.results : [];
  let hits = 0;
  let misses = 0;
  let issues = 0;
  for (const item of results) {
    const kind = verdictKind(item);
    if (kind === "hit") hits += 1;
    else if (kind === "miss") misses += 1;
    else issues += 1;
  }
  return {
    jobId: finished.jobId,
    warehouse: finished.warehouse || "",
    at: finished.finishedAt || Date.now(),
    inputCount: Number(finished.inputCount) || results.length,
    durationMs: Number(finished.durationMs) || 0,
    stopped: Boolean(finished.stopped),
    hits,
    misses,
    issues,
    bytes
  };
}

function byteSize(value) {
  try {
    return new TextEncoder().encode(value).length;
  } catch (_err) {
    return value.length * 2;
  }
}

async function archiveRun(finished) {
  if (!finished?.jobId) return;

  let json;
  try {
    json = JSON.stringify(finished);
  } catch (_err) {
    return;
  }

  const saved = await new Promise((resolve) => chrome.storage.local.get([STORAGE_RUNS], resolve));
  const previous = Array.isArray(saved[STORAGE_RUNS]) ? saved[STORAGE_RUNS] : [];
  const fresh = runSummary(finished, byteSize(json));

  let runs = [fresh, ...previous.filter((run) => run && run.jobId !== fresh.jobId)];

  const kept = [];
  let bytes = 0;
  for (const run of runs.slice(0, MAX_RUNS)) {
    const size = Number(run.bytes) || 0;
    if (kept.length && bytes + size > RUNS_BUDGET_BYTES) break;
    kept.push(run);
    bytes += size;
  }

  const gone = runs.filter((run) => !kept.includes(run)).map((run) => `${RUN_PREFIX}${run.jobId}`);
  if (gone.length) await storageRemove(gone);

  const stored = await storageSetChecked({ [`${RUN_PREFIX}${fresh.jobId}`]: finished });
  if (!stored) {
    notice("api", "Не хватило места сохранить итог прогона — список прошлых проверок не обновлён.");
    return;
  }
  await storageSetChecked({ [STORAGE_RUNS]: kept });
}

async function finalize() {
  if (state.finalized) return;
  state.finalized = true;

  const stopped = state.stopping || state.processed < state.postings.length;
  const results = [];
  for (let i = 0; i < state.postings.length; i += 1) {
    results.push(
      state.results[i] || {
        posting: state.postings[i],
        status: "stopped",
        found: false,
        expected: 0,
        loaded: 0,
        ok: false
      }
    );
  }

  const finished = {
    jobId: state.jobId,
    stopped,
    warehouse: state.warehouse,
    mode: state.mode,
    inputCount: state.postings.length,
    durationMs: elapsedMs(),
    results,
    changeLabels: { ...state.changeLabels },
    finishedAt: Date.now()
  };

  state.running = false;
  state.paused = false;
  state.stopping = false;
  state.domInFlight = 0;
  stopBoost();
  releaseGate();
  releaseStop();
  pendingByTab.clear();
  state.workers.clear();
  state.liveWorkers = 0;
  closeWorkerWindow();

  await storageSet({ [STORAGE_FINISHED]: finished });
  await archiveRun(finished);
  await persistRuntime();
  notifyFinished(finished);
  emit({ action: "scanFinished", jobId: finished.jobId, stopped, finished });
  emitState(true);
}

function notifyFinished(finished) {
  const results = Array.isArray(finished?.results) ? finished.results : [];
  const hits = results.filter((item) => item?.found).length;
  const checked = results.filter((item) => item?.status !== "stopped").length;
  const total = Number(finished?.inputCount) || results.length;
  const seconds = Math.round((Number(finished?.durationMs) || 0) / 1000);
  const title = finished?.stopped ? "Hub Trace · остановлено" : "Hub Trace · готово";
  const message = finished?.stopped
    ? `Проверено ${checked} из ${total}. Нашлось ${hits}.`
    : `Было ${total}, нашлось ${hits}. За ${seconds} с.`;

  try {
    chrome.notifications.create(
      `hub-trace-done-${Date.now()}`,
      { type: "basic", iconUrl: "icons/icon-128.png", title, message, priority: 2 },
      ignoreLastError
    );
  } catch {}
}

function normalizeSettings(raw) {
  const mode = MODES[raw?.mode] ? raw.mode : DEFAULT_SETTINGS.mode;
  return {
    mode,
    threads: Math.max(1, Math.min(MAX_THREADS, Number(raw?.threads) || MODES[mode].threads)),
    auto: raw?.auto === true,
    focusMode: raw?.focusMode !== false,
    useApi: raw?.useApi !== false,
    uncheckCurrentOnly: raw?.uncheckCurrentOnly === true
  };
}

function autoThreadCount() {
  const left = Math.max(1, state.postings.length - state.processed);
  const apiOk = state.useApi && state.apiState !== "blocked";
  const base = apiOk ? 4 : 8;
  return Math.max(1, Math.min(base, left, MAX_THREADS));
}

function retuneThreads() {
  if (!state.autoThreads || !state.running) return;
  const next = autoThreadCount();
  if (next === state.threads) return;
  const before = state.threads;
  state.threads = next;
  for (const worker of state.workers.values()) worker.retire = worker.id > state.threads;
  if (next > before && !state.paused) ensureWorkers();
  emitState();
}

function validateScan(payload) {
  const postings = Array.isArray(payload?.postings) ? payload.postings.filter(Boolean) : [];
  const warehouse = String(payload?.warehouse || "").trim();
  if (state.running) return { ok: false, error: "Уже идёт проверка" };
  if (!postings.length) return { ok: false, error: "Нет номеров отправлений" };
  if (!warehouse) return { ok: false, error: "Не указан склад" };
  return { ok: true, postings, warehouse };
}

async function runScan(payload, postings, warehouse) {
  const settings = normalizeSettings(payload?.settings);

  await storageRemove([STORAGE_FINISHED]);

  state.running = true;
  state.finalized = false;
  state.paused = false;
  state.stopping = false;
  state.jobId = payload?.jobId || `job-${Date.now()}`;
  state.warehouse = warehouse;
  state.postings = postings;
  state.results = new Array(postings.length).fill(null);
  state.cursor = 0;
  state.requeue = [];
  state.processed = 0;
  state.mode = settings.mode;
  state.threads = settings.threads;
  state.autoThreads = settings.auto;
  state.focusMode = settings.focusMode;
  state.useApi = settings.useApi;
  state.uncheckCurrentOnly = settings.uncheckCurrentOnly;
  state.apiState = "trusted";
  if (state.autoThreads) state.threads = autoThreadCount();
  state.apiNote = "";
  state.nativeApi = true;
  state.nativeApiOffAt = 0;
  state.apiTune = null;
  state.apiProbe = [];
  state.changeLabels = {};
  state.lessonDone = false;
  state.lessonTries = 0;
  state.lessonBusy = false;
  state.auditTypes = null;
  state.apiNotReady = false;
  state.retryRound = 0;
  state.retryIndexes = new Set();
  state.retryPending = new Set();
  state.apiFailStreak = 0;
  state.apiSinceCheck = 0;
  state.apiIndexes = new Set();
  state.apiDigests = [];
  state.apiBlockKind = "";
  state.apiLastReason = "";
  state.apiRetryAt = 0;
  state.apiRetries = 0;
  state.apiAuthStreak = 0;
  state.apiInconclusive = 0;
  state.apiMismatch = 0;
  state.apiChecks = 0;
  state.apiRecheck = false;
  state.recipeStale = false;
  state.recipeStaleAt = 0;
  state.domInFlight = 0;
  state.anchorTabId = null;
  state.workerTabIds = new Set();
  state.startedAt = Date.now();
  state.pausedAt = 0;
  state.pausedMs = 0;
  pauseWaiters.clear();
  resetStopSignal();
  pendingByTab.clear();

  const savedSettings = await new Promise((resolve) => chrome.storage.local.get([STORAGE_SETTINGS], resolve));
  await storageSet({
    [STORAGE_SETTINGS]: {
      ...(savedSettings[STORAGE_SETTINGS] || {}),
      ...settings,
      warehouse,
      lastPostings: payload?.lastPostings || savedSettings[STORAGE_SETTINGS]?.lastPostings || ""
    }
  });
  await persistRuntime();

  emit({
    action: "scanProgress",
    jobId: state.jobId,
    index: -1,
    item: null,
    processed: 0,
    total: postings.length
  });
  emitState(true);

  try {
    ensureWorkers();
    if (!state.liveWorkers) {
      notice("error", "Не удалось открыть вкладки для проверки.");
      await finalize();
    }
    syncBoost();
  } catch (error) {
    notice("error", String(error?.message || error));
    await finalize();
  }
}

async function applyLiveSettings(raw) {
  const before = { threads: state.threads };

  if (raw?.mode && MODES[raw.mode] && raw.mode !== state.mode) {
    state.mode = raw.mode;
    if (raw.threads == null) state.threads = MODES[raw.mode].threads;
    if (!MODES[raw.mode].api) {
      state.apiSinceCheck = 0;
    }
  }
  if (raw?.threads != null) {
    state.threads = Math.max(1, Math.min(MAX_THREADS, Number(raw.threads) || state.threads));
  }
  if (raw?.focusMode != null) state.focusMode = Boolean(raw.focusMode);
  if (raw?.uncheckCurrentOnly != null) state.uncheckCurrentOnly = Boolean(raw.uncheckCurrentOnly);
  if (raw?.useApi != null) {
    const next = Boolean(raw.useApi);
    if (next && !state.useApi && state.apiState === "blocked") {
      state.apiState = "unknown";
      state.apiBlockKind = "";
      state.apiRetryAt = 0;
      state.apiFailStreak = 0;
    }
    state.useApi = next;
  }

  if (state.running) {
    for (const worker of state.workers.values()) worker.retire = worker.id > state.threads;

    if (state.threads > before.threads && !state.paused) ensureWorkers();
    syncBoost();
  }

  const settings = {
    mode: state.mode,
    threads: state.threads,
    focusMode: state.focusMode,
    useApi: state.useApi,
    uncheckCurrentOnly: state.uncheckCurrentOnly
  };
  const saved = await new Promise((resolve) => chrome.storage.local.get([STORAGE_SETTINGS], resolve));
  await storageSet({ [STORAGE_SETTINGS]: { ...(saved[STORAGE_SETTINGS] || {}), ...settings } });

  emitState(true);
  return settings;
}

async function openAppWindow() {
  const url = chrome.runtime.getURL(APP_PATH);
  const existing = await chrome.tabs.query({ url });
  if (existing[0]) {
    await chrome.windows.update(existing[0].windowId, { focused: true, state: "maximized" });
    await chrome.tabs.update(existing[0].id, { active: true });
    return;
  }
  await chrome.windows.create({ url, type: "normal", state: "maximized", focused: true });
}

chrome.action.onClicked.addListener(() => void openAppWindow());
chrome.notifications.onClicked.addListener(() => void openAppWindow());

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== state.workerWindowId) return;
  state.workerWindowId = null;
  state.ownsWorkerWindow = false;
  if (state.running) stopScan();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const pending = pendingByTab.get(tabId);
  if (pending) {
    pendingByTab.delete(tabId);
    pending.resolve({ status: "tab_error", found: false, expected: 0, loaded: 0, ok: false });
  }
  state.workerTabIds.delete(tabId);
  for (const worker of state.workers.values()) {
    if (worker.tabId !== tabId) continue;
    worker.retire = true;
    worker.tabId = null;
  }
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "hub-trace-keepalive") return;
  port.onMessage.addListener(() => {
    try {
      port.postMessage({ pong: Date.now() });
    } catch {}
  });
  port.onDisconnect.addListener(ignoreLastError);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message?.action;

  if (action === "ht:hello") {
    const tabId = sender?.tab?.id;
    const pending = tabId != null ? pendingByTab.get(tabId) : null;
    for (const worker of state.workers.values()) {
      if (worker.tabId === tabId) {
        worker.hubReady = true;
        if (state.recipe) void sendTab(tabId, { action: "ht:setRecipe", recipe: state.recipe });
        if (state.cardRecipe) void sendTab(tabId, { action: "ht:setCardRecipe", recipe: state.cardRecipe });
        void sendTab(tabId, hintsMessage());
      }
    }
    if (!pending || pending.posting !== message.posting) {
      sendResponse({ run: false });
      return false;
    }
    pending.claimed = true;
    sendResponse({ run: true, job: pending.job });
    return false;
  }

  if (action === "ht:result") {
    const tabId = sender?.tab?.id;
    const pending = tabId != null ? pendingByTab.get(tabId) : null;
    if (pending && pending.taskId === message.taskId) {
      pendingByTab.delete(tabId);
      pending.resolve(message.result || { status: "script_error", found: false, expected: 0, loaded: 0, ok: false });
    }
    sendResponse({ ok: true });
    return false;
  }

  if (action === "ht:phase") {
    const tabId = sender?.tab?.id;
    for (const worker of state.workers.values()) {
      if (worker.tabId !== tabId) continue;
      worker.phase = message.phase || "idle";
      if (message.posting) worker.posting = message.posting;
      emitState();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (action === "ht:cardRecipe") {
    const next = message.recipe;
    const current = state.cardRecipe;
    const score = Number(next?.score) || 0;
    const fresher =
      !current ||
      score > (Number(current.score) || 0) ||
      (score >= (Number(current.score) || 0) && (Number(next.capturedAt) || 0) > (Number(current.capturedAt) || 0));
    if (next?.itemId && fresher) {
      state.cardRecipe = next;
      for (const worker of state.workers.values()) {
        if (worker.tabId != null) void sendTab(worker.tabId, { action: "ht:setCardRecipe", recipe: next });
      }
    }
    sendResponse({ ok: true });
    return false;
  }

  if (action === "ht:hints") {
    let changed = false;
    if (message.appVersion && !state.appVersion) {
      state.appVersion = String(message.appVersion);
      changed = true;
    }
    if (message.placeId && !state.placeId) {
      state.placeId = String(message.placeId);
      changed = true;
    }
    if (message.apiTune && !state.apiTune) {
      state.apiTune = message.apiTune;
      changed = true;
    }
    if (typeof message.cardPlaceless === "boolean" && state.cardPlaceless == null) {
      state.cardPlaceless = message.cardPlaceless;
      changed = true;
    }
    if (Array.isArray(message.auditTypes) && message.auditTypes.length) {
      const next = message.auditTypes.join("|");
      if (next !== (state.auditTypes || []).join("|")) {
        state.auditTypes = message.auditTypes;
        changed = true;
      }
    }
    if (Array.isArray(message.probe) && message.probe.length) {
      state.apiProbe = message.probe;
      emitState(true);
    }
    if (changed) broadcastHints();
    sendResponse({ ok: true });
    return false;
  }

  if (action === "ht:recipe") {
    const next = message.recipe;
    if (next?.itemId && acceptRecipe(next)) {
      state.recipe = next;
      if (state.recipeStale) {
        state.recipeStale = false;
        state.recipeStaleAt = 0;
        notice("api", "Токен обновлён, возвращаюсь на быстрый путь.");
      }
      for (const worker of state.workers.values()) {
        if (worker.tabId != null) void sendTab(worker.tabId, { action: "ht:setRecipe", recipe: next });
      }
      emitState();
    }
    sendResponse({ ok: true });
    return false;
  }

  if (action === "openApp") {
    void openAppWindow().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (action === "startScan") {
    const check = validateScan(message);
    if (!check.ok) {
      sendResponse(check);
      return false;
    }
    state.running = true;
    state.finalized = false;
    sendResponse({ ok: true });
    void runScan(message, check.postings, check.warehouse);
    return false;
  }

  if (action === "pauseScan") {
    setPaused(message.paused !== false);
    sendResponse({ ok: true, paused: state.paused });
    return false;
  }

  if (action === "stopScan") {
    stopScan();
    sendResponse({ ok: true });
    return false;
  }

  if (action === "updateSettings") {
    void applyLiveSettings(message.settings).then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (action === "getScanState") {
    sendResponse({
      ...snapshot(),
      results: state.running ? state.results.map((item, index) => (item ? { index, item } : null)).filter(Boolean) : []
    });
    return false;
  }

  if (action === "keepAlive") {
    sendResponse({ ok: true, at: Date.now() });
    return false;
  }

  return false;
});
