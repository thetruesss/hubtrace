/*
 * Hub Trace · движок сканирования.
 *
 * Что изменилось по сравнению с 1.x:
 *   · быстрый путь через повтор запроса истории (см. netprobe.js) — вкладку
 *     больше не нужно перезагружать на каждый номер;
 *   · сканер приезжает как content script на document_start, поэтому ушли
 *     ожидание tabs.status === "complete" и два раунда executeScript;
 *   · очередь умеет возвращать номера обратно, отсюда честная пауза;
 *   · режим, число потоков и переключатели меняются прямо во время работы;
 *   · «агрессивный режим» дёргает вкладки только когда реально идёт обход
 *     DOM — на быстром пути фокус не воруется вообще.
 */

const APP_PATH = "app.html";
const STORAGE_RUNTIME = "hubTraceRuntime";
const STORAGE_FINISHED = "hubTraceFinished";
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
    /*
     * Раньше «глубокий» означал «только обход страницы». Но обход дочитывает
     * не всю историю, и на нём же нельзя строить отчёт. Теперь и здесь
     * сначала API, а страница остаётся запасным путём — с самыми щедрыми
     * повторами. Совсем без API — это выключатель «Быстрый путь».
     */
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
  recipeStale: false,
  recipeStaleAt: 0,

  /* Версия приложения Hub и склад оператора — общие для всех вкладок. */
  appVersion: "",
  placeId: "",
  /* Известные ручки Hub отвечают. Сбрасывается, если Hub их переименует —
     тогда быстрый путь снова держится только на подсмотренном запросе. */
  nativeApi: true,
  /* Вариант запроса, который принял сервер: подбирается один раз за прогон
     и раздаётся всем вкладкам. */
  apiTune: null,
  /*
   * Подписи типов изменения, подсмотренные на самой странице.
   *
   * В ответе тип приходит кодом (Flow, DestinationPlace), а на странице
   * он написан словами. Угадывать все коды бессмысленно — их список нам
   * неизвестен. Поэтому там, где номер прошёл обоими путями, строки
   * совпадают по порядку: код из ответа встаёт в пару с подписью со
   * страницы, и дальше она подставляется всем.
   */
  changeLabels: {},
  /* Один номер за прогон считается обоими путями — «урок». */
  lessonDone: false,
  lessonTries: 0,
  lessonBusy: false,
  autoThreads: false,
  /* Типы изменений, которые показывает открываемая вкладка. Список берётся
     с запроса самой страницы, если он подсмотрен. */
  auditTypes: null,
  /* Что ответил сервер на каждый вариант — показываем в интерфейсе. */
  apiProbe: [],
  /* Круги добора: номера, которые не вышли или дочитались не полностью. */
  retryRound: 0,
  retryIndexes: new Set(),
  /* Последняя попытка сорвалась не из-за поломки, а потому что повторять
     было нечем: ручек нет, запрос ещё не подсмотрен. */
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

/* ------------------------------------------------------------------ */
/* обёртки над chrome.*                                                */
/* ------------------------------------------------------------------ */

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

function emit(payload) {
  try {
    chrome.runtime.sendMessage(payload, ignoreLastError);
  } catch (_err) {
    /* приложение закрыто — не страшно */
  }
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
  } catch (_err) {
    /* ignore */
  }
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

/* ------------------------------------------------------------------ */
/* общее состояние                                                     */
/* ------------------------------------------------------------------ */

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
    /* Что ответил сервер на каждый вариант запроса — без этого «быстрый
       путь недоступен» ничего не объясняет. */
    apiProbe: state.apiProbe,
    apiTune: state.apiTune,
    apiLastReason: state.apiLastReason,
    apiBlockKind: state.apiBlockKind,
    apiRetryAt: state.apiRetryAt,
    recipeStale: state.recipeStale,
    elapsedMs: elapsedMs(),
    rate: ratePerMin(),
    etaMs: etaMs(),
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

/* Раньше писали в storage на каждый номер. Теперь номер закрывается за
   десятки миллисекунд, так что запись надо придержать. */
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

/* ------------------------------------------------------------------ */
/* пауза и остановка                                                   */
/* ------------------------------------------------------------------ */

function gate() {
  if (!state.paused || state.stopping) return Promise.resolve();
  return new Promise((resolve) => pauseWaiters.add(resolve));
}

function releaseGate() {
  for (const resolve of pauseWaiters) resolve();
  pauseWaiters.clear();
}

/* Один общий промис на всю задачу: иначе на каждый номер копился
   собственный резолвер и они жили до самой остановки. */
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

/* ------------------------------------------------------------------ */
/* окно и вкладки-воркеры                                              */
/* ------------------------------------------------------------------ */

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

/* Рабочие вкладки живут только в своём окне: рядом с окном приложения им
   делать нечего — они перехватывают фокус и мешают работать.
   Воркеры стартуют одновременно, поэтому создание окна — синглтон, иначе
   каждый откроет своё. */
let workerWindowPromise = null;

async function ensureWorkerWindow() {
  if (state.workerWindowId != null && (await getWindow(state.workerWindowId))) return state.workerWindowId;
  if (workerWindowPromise) return workerWindowPromise;

  workerWindowPromise = (async () => {
    /* Chrome отвергает state:"maximized" вместе с focused:false
       («Invalid value for state»), поэтому разворачиваем окно отдельным
       вызовом. Раньше создание молча падало, и рабочие вкладки открывались
       рядом с окном приложения. */
    let win = await createWindow({ url: "about:blank", focused: false, type: "normal" });
    if (!win?.id) win = await createWindow({ url: "about:blank", type: "normal" });
    if (!win?.id) return null;

    state.workerWindowId = win.id;
    state.ownsWorkerWindow = true;
    /* Стартовая вкладка остаётся якорем: если окно останется без вкладок,
       Chrome его закроет, а мы примем это за «пользователь закрыл окно»
       и остановим проверку. */
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

  /* Сначала вкладки: даже если окно уже закрыли руками, за нами не должно
     остаться ни одной вкладки Hub. */
  for (const tabId of [...state.workerTabIds]) removeTab(tabId);
  state.workerTabIds.clear();

  if (id != null && owns) {
    try {
      chrome.windows.remove(id, ignoreLastError);
    } catch (_err) {
      /* ignore */
    }
  }
}

const BOOST_INTERVAL_MS = 450;

function stopBoost() {
  if (state.boostTimerId == null) return;
  clearInterval(state.boostTimerId);
  state.boostTimerId = null;
}

/* Фон дёргает вкладку, только когда она реально листает DOM: скрытые
   вкладки Chrome тормозит, и бесконечный скролл в них залипает. */
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
    /* Иначе воркер молча повиснет: liveWorkers уже увеличен, а цикл не стартовал. */
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

  /* Проверяем по факту, а не по ответу create: рабочая вкладка не должна
     оказаться в окне пользователя ни при каких обстоятельствах. Если
     перенести не вышло — закрываем её и падаем с понятной ошибкой, это
     лучше, чем тихо засорять основное окно. */
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

/* ------------------------------------------------------------------ */
/* очередь                                                             */
/* ------------------------------------------------------------------ */

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

/*
 * Вкладка истории.
 *
 * Внутри «Истории» Hub держит три фишки фильтра: «Все» (tab=history),
 * «Перемещения» (tab=transitionHistory) и «Свойства» (tab=propertiesHistory).
 * Открываем «Перемещения»: там строки про движение предмета — приезды на
 * склад, ячейки, контейнеры, рейсы, — а не смены статуса и тайм-слота.
 */
const HISTORY_TAB = "transitionHistory";

function buildHistoryUrl(posting) {
  const id = encodeURIComponent(cleanPosting(posting));
  /* Склад оператора Hub всё равно допишет сам — но уже после загрузки.
     Подставляем сразу: карточке предмета он нужен в самом первом запросе. */
  const place = state.placeId ? `warehouse=${encodeURIComponent(state.placeId)}&` : "";
  return `https://hub.o3t.ru/management/stock/item/Lozon:${id}?${place}tab=${HISTORY_TAB}`;
}

function failItem(posting, status, extra) {
  return { posting, status, found: false, expected: 0, loaded: 0, ok: false, via: "dom", ...(extra || {}) };
}

/* ------------------------------------------------------------------ */
/* сканирование одного номера                                          */
/* ------------------------------------------------------------------ */

async function domScan(worker, posting) {
  const conf = cfg();
  const tabId = worker.tabId;
  /* tabs.update(null, ...) уедет в активную вкладку пользователя. */
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
    /* content script достаёт номер из адреса, там префикса Lozon: уже нет */
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

    /* Страховка: если content script не поднялся (например, расширение
       только что обновили) — доставляем его руками. */
    const rescue = setTimeout(() => {
      const pending = pendingByTab.get(tabId);
      if (!pending || pending.taskId !== taskId || pending.claimed) return;
      injectScanner(tabId);
    }, Math.min(7000, conf.navTimeoutMs));

    /* Если за время навигации никто не забрал задание — смотрим, куда нас
       вообще увело. Ждать полный таймаут на странице логина незачем. */
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
  } catch (_err) {
    /* ignore */
  }
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
      /*
       * Hub переехал на другие пути: дальше только подсмотренный запрос.
       * Вкладкам это тоже надо знать — после каждой загрузки страницы
       * content script поднимается заново и иначе снова ходил бы за
       * несуществующей ручкой.
       */
      state.nativeApi = false;
      broadcastHints();
    }
    if (reply?.notReady) {
      /* Ни ручки, ни подсмотренного запроса: это не поломка. */
      state.apiNotReady = true;
      return null;
    }
    if (reply?.auth) {
      state.apiAuthStreak += 1;
      /*
       * Протухший токен бывает только у подсмотренного запроса. У известных
       * ручек токена нет — там 401 означает, что в этой вкладке сессия Hub
       * не поднялась. Ждать «свежего рецепта» минуту в этом случае незачем:
       * номер уйдёт на страницу, её загрузка сессию и починит.
       */
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
    (report.lastRows?.length ? 1 : 0)
  );
}

/* Отчёт склеиваем из обеих попыток: DOM даёт номер и статус со страницы,
   быстрый путь — строки истории. Терять то, что уже добыто, незачем. */
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
    columns: strong.columns?.length ? strong.columns : weak.columns || [],
    lastRows: strong.lastRows?.length ? strong.lastRows : weak.lastRows || [],
    /* Коды идут в паре со строками: берём те, что от того же пути. */
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
    labels: state.changeLabels,
    auditTypes: state.auditTypes
  };
}

const CYRILLIC = /[А-Яа-яЁё]/;

/*
 * Строки обоих путей идут в одном порядке и описывают одни и те же
 * события, поэтому код из ответа и подпись со страницы стоят в паре.
 * Берём только кириллические подписи: английское слово со страницы
 * означало бы, что и она не знает перевода.
 */
/*
 * Сводим строки по дате, а не по месту в списке.
 *
 * По месту работало, только пока оба пути отдавали ровно один и тот же
 * срез: чуть разошлись — и i-я строка у них уже про разные события, а
 * подпись уезжала не тому коду. Разойтись они могут запросто: список видов
 * перемещения приезжает со страницы, и один путь может узнать про новый вид
 * раньше другого. Дата же у события одна на оба пути.
 */
function labelsByDate(rows) {
  const byDate = new Map();
  if (!Array.isArray(rows)) return byDate;
  for (const row of rows) {
    const at = String(row?.[1] || "").trim();
    const label = String(row?.[0] || "").trim();
    if (!at || !label) continue;
    const known = byDate.get(at);
    /* Две строки одной секундой с разными подписями — не учимся ни на одной. */
    if (known === undefined) byDate.set(at, label);
    else if (known !== label) byDate.set(at, "");
  }
  return byDate;
}

/*
 * Возвращает, полным ли вышло сведение: срезы совпали по длине, и каждая
 * подпись легла к своему коду. Пока полного сведения не было, урок
 * повторяется на следующих номерах — иначе один ранний урок (до того, как
 * со страницы приехал список типов) навсегда оставил бы незнакомый код
 * без подписи.
 */
function learnChangeLabels(api, dom) {
  const codes = api?.report?.codes;
  const apiRows = api?.report?.lastRows;
  const domRows = dom?.report?.lastRows;
  if (!Array.isArray(codes) || !codes.length || !Array.isArray(domRows)) return false;

  /* Срезы совпали по длине — строки те же и в том же порядке, сводить по
     месту точнее всего. Разошлись — выручает дата. */
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

function apiAllowed(worker) {
  /*
   * Рецепт больше не обязателен: ручки истории и карточки известны, ID
   * подставляется прямо в путь. Раньше без подсмотренного запроса быстрый
   * путь вообще не включался, и первые номера всегда шли обходом DOM.
   */
  if (!state.useApi || !cfg().api || !worker.hubReady) return false;
  /* Ни известных ручек, ни подсмотренного запроса — повторять нечего. */
  if (!state.nativeApi && !state.recipe) return false;

  if (state.recipeStale) {
    /* Ждём свежий захват. Если он так и не приехал — пробуем как есть,
       лучше получить 401 и ещё одну попытку, чем встать на DOM насовсем. */
    if (Date.now() - state.recipeStaleAt < RECIPE_REFRESH_TIMEOUT_MS) return false;
    state.recipeStale = false;
    state.recipeStaleAt = 0;
  }

  if (state.apiState === "blocked") return apiRetryDue();
  return true;
}

const SAME_DIGEST_LIMIT = 4;

/* Если на четыре разных номера подряд приходит байт-в-байт один ответ —
   подстановка номера не работает и быстрому пути верить нельзя. */
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

/*
 * Урок: один номер за прогон проходим обоими путями.
 *
 * Тип изменения приходит кодом, а как Hub называет его по-русски, знает
 * только страница. Список кодов нам неизвестен, угадать все нельзя —
 * поэтому один раз смотрим на строки обоих путей рядом и запоминаем
 * подписи. Заодно это сверка: сходятся ли пути в ответе про склад.
 */
const LESSON_TRIES = 4;

/* Пока один урок в работе, остальные воркеры идут быстрым путём: иначе до
   конца первого урока каждый успевал бы взять свой. */
function lessonDue() {
  return !state.lessonDone && !state.lessonBusy && state.lessonTries < LESSON_TRIES;
}

function spotCheckDue() {
  const every = cfg().spotCheckEvery;
  if (!every) return false;
  return state.apiSinceCheck >= every;
}

/* Быстрый путь — основной, поэтому возвращаемся к нему настойчивее:
   раньше пауза была 45 с и три попытки. */
const API_RETRY_BASE_MS = 20000;
const API_MAX_RETRIES = 6;
/* Сколько неудач подряд терпим, прежде чем уйти на страницу. */
const API_FAIL_LIMIT = 5;
/* Если свежий рецепт не приехал за это время — снимаем стоп-кран сами,
   иначе прогон навсегда останется на медленном обходе DOM. */
const RECIPE_REFRESH_TIMEOUT_MS = 60000;
const API_AUTH_STREAK_LIMIT = 6;

/*
 * Свежесть рецепта важнее его «качества»: повторный захват того же
 * эндпоинта даёт такой же score, а вместе с ним приезжает новый токен.
 * Со строгим «больше» свежий рецепт отвергался, токен протухал, и сервер
 * начинал отвечать 401 до самого перезапуска расширения.
 */
function acceptRecipe(next) {
  if (!state.recipe) return true;
  if (state.recipeStale) return true;
  const score = Number(next.score) || 0;
  const current = Number(state.recipe.score) || 0;
  if (score > current) return true;
  return score >= current && (Number(next.capturedAt) || 0) > (Number(state.recipe.capturedAt) || 0);
}

/* 401/403 — не повод хоронить быстрый путь: нужен свежий захват. Пока он
   не приехал, воркеры идут через DOM, а загрузка страницы как раз и даёт
   пробнику поймать новый токен. */
function markRecipeStale(status) {
  if (state.recipeStale) return;
  state.recipeStale = true;
  state.recipeStaleAt = Date.now();
  notice("api", `Токен устарел (ответ ${status || 401}). Обновляю его загрузкой страницы.`);
  emitState(true);
}

/*
 * Отказ отказу рознь. Расхождение с обходом DOM или одинаковые ответы на
 * разные номера — это про неверные данные, тут возврата быть не может.
 * А недоступность (таймаут, 401 на обновлении токена, разовый сбой сети) —
 * временная, и раньше она навсегда роняла быстрый путь на весь прогон.
 */
function blockApi(reason, kind) {
  if (state.apiState === "blocked") return;
  state.apiState = "blocked";
  state.apiBlockKind = kind || "mismatch";
  state.apiDigests = [];

  let text = reason;
  if (state.apiBlockKind === "unavailable" && state.apiRetries < API_MAX_RETRIES) {
    const wait = API_RETRY_BASE_MS * Math.pow(2, state.apiRetries);
    state.apiRetryAt = Date.now() + wait;
    text = `${reason} Попробую снова через ${Math.round(wait / 1000)} с.`;
  } else {
    state.apiRetryAt = 0;
  }

  notice("api", text);
  retuneThreads();
  emitState(true);
}

/* Кулдаун вышел — даём быстрому пути ещё один шанс через калибровку. */
function apiRetryDue() {
  if (state.apiState !== "blocked") return false;
  if (state.apiBlockKind !== "unavailable") return false;
  if (!state.apiRetryAt || Date.now() < state.apiRetryAt) return false;

  state.apiRetries += 1;
  state.apiRetryAt = 0;
  state.apiBlockKind = "";
  state.apiState = "unknown";
  state.apiFailStreak = 0;
  state.apiSinceCheck = 0;
  notice("api", `Пробую быстрый путь заново (попытка ${state.apiRetries} из ${API_MAX_RETRIES}).`);
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

  /*
   * Сверять можно только с полным обходом DOM. Если он сам не дочитал
   * список, его «не нашёл» ничего не доказывает — и раньше такое
   * расхождение навсегда выключало быстрый путь, хотя неправ был как раз
   * обход страницы.
   */
  const domTrusted = Boolean(dom?.ok) && dom?.status === "complete";
  if (!domTrusted) {
    state.apiSinceCheck = 0;
    state.apiInconclusive += 1;
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
    /* Сверка могла быть запущена соседним воркером ещё до блокировки.
       Снимать её результатом такой сверки нельзя — иначе путь, признанный
       ненадёжным, тихо включался бы обратно. */
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

  /*
   * Оба пути смотрят на один и тот же срез истории: запрос шлёт тот же
   * список типов, что и открытая вкладка. Поэтому расхождение в любую
   * сторону — настоящее, и быстрый путь за него выключается.
   */
  const back = requeueApiResults();
  blockApi(
    back
      ? `Быстрый путь разошёлся с обходом DOM на ${dom?.posting || index}. Отключил его и переснимаю ${back} номер(ов).`
      : `Быстрый путь разошёлся с обходом DOM на ${dom?.posting || index}. Отключил его.`,
    "mismatch"
  );
}

/*
 * Открыть вкладке страницу Hub и дождаться, пока в ней поднимется
 * content script.
 *
 * Повторить запрос можно только из страницы Hub: нужны её cookie и origin.
 * Раньше вкладку открывал первый же номер — и он всегда шёл обходом DOM,
 * просто чтобы вкладка появилась. Теперь страница открывается отдельно и
 * молча, а номер сразу идёт через API.
 */
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

/*
 * Добор: считаем номер обоими путями и берём тот, который вышел лучше.
 * Отчёт при этом собираем из обоих — у запроса точнее поля, у страницы
 * есть номер и статус даже без карточки.
 */
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
  /* Вкладка нужна и быстрому пути — но только как площадка для запроса. */
  if (!worker.hubReady && state.useApi && cfg().api) await primeTab(worker, posting);

  if (state.retryIndexes.has(index)) return retryBoth(worker, posting, index);

  if (apiAllowed(worker)) {
    if (state.apiState === "trusted" && !spotCheckDue() && !lessonDue()) {
      const api = await apiScan(worker, posting);
      /* Попытка не считается: известной ручки не оказалось, а рецепта ещё
         не было. Ждём захвата, а не выключаем быстрый путь. */
      if (!api && state.apiNotReady) return domScanWithRetry(worker, posting);
      if (api) {
        state.apiFailStreak = 0;
        state.apiSinceCheck += 1;
        state.apiIndexes.add(index);
        watchDigest(api);
        return api;
      }
      if (state.recipeStale) {
        /* Это протухший токен, а не поломка. Номер берём через DOM — заодно
           загрузка страницы обновит рецепт. */
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
      /* Урок и периодические сверки: считаем оба пути и сравниваем. */
      const lesson = lessonDue();
      if (lesson) {
        state.lessonBusy = true;
        state.lessonTries += 1;
      }
      try {
        const api = await apiScan(worker, posting);
        if (state.stopping) return failItem(posting, "stopped");
        const dom = await domScanWithRetry(worker, posting);
        /* Урок засчитан, только когда сведение вышло полным: ранний урок —
           до списка типов со страницы — видит у путей разные срезы. */
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

/* ------------------------------------------------------------------ */
/* цикл воркера                                                        */
/* ------------------------------------------------------------------ */

function commit(index, item) {
  /* На круге добора номер приходит второй раз — счётчик не должен расти. */
  const prev = state.results[index];
  if (prev == null) state.processed += 1;
  /* И не должен ухудшаться: если прошлый заход прочитал больше, оставляем
     его, а отчёт собираем из обоих. */
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
    etaMs: etaMs()
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
      /* Пока мы решали, что быстрому пути верить нельзя, соседний воркер мог
         уже получить по нему ответ. Такой результат не засчитываем. */
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

/*
 * Что считать ошибкой — ровно то же, что показывает лента: «не вышло».
 * Найденный склад и честное «нет» ошибками не считаются.
 */
function isIssue(item) {
  if (!item) return true;
  if (item.found) return false;
  if (item.status === "partial") return true;
  if (item.status === "complete" || item.status === "missing") return false;
  return !item.ok;
}

/*
 * Доля прочитанной истории.
 *
 * Склад нашёлся — дальше читать незачем, история просмотрена ровно до
 * нужного места. А вот «нет» стоит чего-то только если список прочитан
 * почти весь: 20 строк из 83 не доказывают ничего.
 */
const COVERAGE_TARGET = 0.8;
const MAX_RETRY_ROUNDS = 3;

function coverageOf(item) {
  if (!item) return 0;
  if (item.found) return 1;
  const expected = Number(item.expected) || 0;
  const loaded = Number(item.loaded) || 0;
  if (!expected) return loaded > 0 ? 1 : 0;
  return Math.min(1, loaded / expected);
}

function needsMore(item) {
  return isIssue(item) || coverageOf(item) < COVERAGE_TARGET;
}

/*
 * Круги добора. Заход мог не выйти по случайной причине: вкладка не
 * успела, сервер ответил не тем, страница не дочиталась до конца. Такие
 * номера прогоняем ещё раз — сразу обоими путями, и берём тот результат,
 * который прочитал больше. Кругов до трёх: если и после них список не
 * дочитан, честнее показать это в «не вышло», чем крутиться бесконечно.
 */
function queueRetries() {
  if (state.stopping || state.retryRound >= MAX_RETRY_ROUNDS) return false;

  const again = [];
  state.results.forEach((item, index) => {
    if (needsMore(item)) again.push(index);
  });
  if (!again.length) return false;

  state.retryRound += 1;
  state.retryIndexes = new Set(again);
  state.requeue.push(...again);
  notice(
    "api",
    `Дочитываю ${again.length} номер(ов) — круг ${state.retryRound} из ${MAX_RETRY_ROUNDS}, ` +
      "запросом и страницей."
  );
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
    /* Подписи, подсмотренные на странице: приложение подставит их и в те
       строки, что собрались до того, как подпись стала известна. */
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
  } catch (_err) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* запуск                                                              */
/* ------------------------------------------------------------------ */

function normalizeSettings(raw) {
  const mode = MODES[raw?.mode] ? raw.mode : DEFAULT_SETTINGS.mode;
  return {
    mode,
    threads: Math.max(1, Math.min(MAX_THREADS, Number(raw?.threads) || MODES[mode].threads)),
    /* auto — пул вкладок подбирается сам: приложение всегда шлёт true,
       явные настройки (например, из тестов) оставляют ручное число. */
    auto: raw?.auto === true,
    focusMode: raw?.focusMode !== false,
    useApi: raw?.useApi !== false,
    uncheckCurrentOnly: raw?.uncheckCurrentOnly === true
  };
}

/*
 * Сколько вкладок нужно сейчас. Пока работает быстрый путь, вкладки —
 * лишь площадки для запросов, и четырёх хватает с запасом; ушли на обход
 * страницы — пул расширяется. Меньше очереди не открываем.
 */
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
  /*
   * Прогон начинается с доверия к быстрому пути.
   *
   * Раньше здесь стояло "unknown", и до первой удачной сверки каждый номер
   * шёл обоими путями, а в ленту попадал результат обхода страницы. То
   * есть начало прогона всегда было медленным DOM-ом, даже когда API
   * отвечал. Теперь наоборот: идём через API, а страница подключается
   * только там, где API не смог. Надёжность держат сверки по расписанию
   * (spotCheckEvery) и защита от одинаковых ответов.
   */
  state.apiState = "trusted";
  if (state.autoThreads) state.threads = autoThreadCount();
  state.apiNote = "";
  /* Новый прогон — снова пробуем известные ручки: Hub мог и вернуться. */
  state.nativeApi = true;
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

/* ------------------------------------------------------------------ */
/* смена настроек на лету                                              */
/* ------------------------------------------------------------------ */

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
    /* Сжатие пула: лишние воркеры уходят после текущего номера. */
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

/* ------------------------------------------------------------------ */
/* приложение                                                          */
/* ------------------------------------------------------------------ */

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
    } catch (_err) {
      /* ignore */
    }
  });
  port.onDisconnect.addListener(ignoreLastError);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const action = message?.action;

  /* --- из content script --- */

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

  /*
   * Версия приложения Hub и склад оператора: их видит первая же вкладка,
   * а нужны они всем — без склада не собрать карточку предмета.
   */
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

  /* --- из приложения --- */

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
