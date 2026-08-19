const APP_PATH = "app.html";
const STORAGE_RUNTIME = "hubTraceRuntime";
const STORAGE_FINISHED = "hubTraceFinished";
const STORAGE_SETTINGS = "hubTraceSettings";

const DEFAULT_SETTINGS = {
  threads: 4,
  zoom: 0.25,
  timeoutSec: 180,
  focusMode: true,
  uncheckCurrentOnly: false,
  workerWindow: true
};

const state = {
  inProgress: false,
  stopRequested: false,
  jobId: null,
  processed: 0,
  total: 0,
  threads: 0,
  activeTabIds: new Set(),
  workerWindowId: null,
  blankTabId: null,
  ownsWorkerWindow: false,
  aggressive: false,
  poolTabIds: [],
  boostTimerId: null,
  boostIndex: 0
};

const stopWaiters = new Set();

function ignoreLastError() {
  void chrome.runtime.lastError;
}

function storageSet(payload) {
  return new Promise((resolve) => chrome.storage.local.set(payload, resolve));
}

function storageRemove(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

function emit(payload) {
  chrome.runtime.sendMessage(payload, ignoreLastError);
}

function stoppedItem(posting) {
  return { posting, status: "stopped", found: false, expected: 0, loaded: 0, ok: false };
}

function notifyStop() {
  for (const resolve of stopWaiters) resolve();
  stopWaiters.clear();
}

function waitForStop() {
  if (state.stopRequested) return Promise.resolve();
  return new Promise((resolve) => stopWaiters.add(resolve));
}

async function persistRuntime() {
  await storageSet({
    [STORAGE_RUNTIME]: {
      inProgress: state.inProgress,
      processed: state.processed,
      total: state.total,
      threads: state.threads,
      jobId: state.jobId,
      activeTabs: state.activeTabIds.size,
      updatedAt: Date.now()
    }
  });
}

function buildHistoryUrl(posting) {
  const clean = String(posting || "").trim().replace(/^Lozon:/i, "");
  return `https://hub.o3t.ru/management/stock/item/Lozon:${encodeURIComponent(clean)}?&tab=history`;
}

function waitTabComplete(tabId, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    function finish(reason) {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(reason);
    }

    function onUpdated(updatedId, info) {
      if (updatedId === tabId && info.status === "complete") finish("complete");
    }

    function onRemoved(removedId) {
      if (removedId === tabId) finish("removed");
    }

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish("missing");
        return;
      }
      if (tab?.status === "complete") finish("complete");
    });
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

function setTabZoom(tabId, zoom) {
  const value = Math.max(0.25, Math.min(1, Number(zoom) || 0.25));
  return new Promise((resolve) => {
    chrome.tabs.getZoom(tabId, (current) => {
      ignoreLastError();
      if (Math.abs((Number(current) || 1) - value) < 0.02) {
        resolve(false);
        return;
      }
      chrome.tabs.setZoomSettings(tabId, { mode: "automatic", scope: "per-tab" }, () => {
        ignoreLastError();
        chrome.tabs.setZoom(tabId, value, () => {
          ignoreLastError();
          resolve(true);
        });
      });
    });
  });
}

function createTab(options) {
  return new Promise((resolve) => {
    chrome.tabs.create(options, (tab) => {
      if (chrome.runtime.lastError || !tab?.id) resolve(null);
      else resolve(tab);
    });
  });
}

async function ensureWorkerWindow(enabled, aggressive) {
  if (!enabled) return null;
  if (state.workerWindowId) {
    const existing = await new Promise((resolve) => {
      chrome.windows.get(state.workerWindowId, {}, (win) => {
        if (chrome.runtime.lastError || !win) resolve(null);
        else resolve(win.id);
      });
    });
    if (existing) return existing;
    state.workerWindowId = null;
  }

  const win = await new Promise((resolve) => {
    chrome.windows.create(
      {
        url: "about:blank",
        focused: Boolean(aggressive),
        state: "maximized",
        type: "normal"
      },
      resolve
    );
  });
  if (!win?.id) return null;
  state.workerWindowId = win.id;
  state.ownsWorkerWindow = true;
  state.blankTabId = win.tabs?.[0]?.id || null;
  return win.id;
}

function closeWorkerWindow() {
  const id = state.workerWindowId;
  const owns = state.ownsWorkerWindow;
  state.workerWindowId = null;
  state.blankTabId = null;
  state.poolTabIds = [];
  state.ownsWorkerWindow = false;
  if (!id || !owns) return;
  chrome.windows.remove(id, ignoreLastError);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
    chrome.tabs.get(tabId, (tab) => {
      ignoreLastError();
      resolve(tab || null);
    });
  });
}

function reloadTab(tabId) {
  return new Promise((resolve) => {
    chrome.tabs.reload(tabId, { bypassCache: true }, () => {
      ignoreLastError();
      resolve();
    });
  });
}

function activatePoolTab(tabId) {
  if (tabId == null) return;
  chrome.tabs.get(tabId, (tab) => {
    ignoreLastError();
    if (!tab?.id) return;
    chrome.tabs.highlight({ windowId: tab.windowId, tabs: [tab.index] }, ignoreLastError);
    chrome.tabs.update(
      tabId,
      { active: true, highlighted: true, autoDiscardable: false },
      ignoreLastError
    );
    if (state.aggressive) {
      chrome.windows.update(tab.windowId, { focused: true, drawAttention: true }, ignoreLastError);
    }
  });
}

const WORKER_BOOST_INTERVAL_MS = 450;

function stopWorkerBoost() {
  if (state.boostTimerId != null) {
    clearInterval(state.boostTimerId);
    state.boostTimerId = null;
  }
}

function workerBoostTick() {
  if (!state.inProgress || state.stopRequested || !state.aggressive) return;
  const tabIds = state.poolTabIds.slice();
  if (!tabIds.length) return;
  if (state.boostIndex >= tabIds.length) state.boostIndex = 0;
  const tabId = tabIds[state.boostIndex];
  state.boostIndex += 1;
  activatePoolTab(tabId);
}

function startWorkerBoost() {
  stopWorkerBoost();
  if (!state.aggressive) return;
  state.boostIndex = 0;
  workerBoostTick();
  state.boostTimerId = setInterval(workerBoostTick, WORKER_BOOST_INTERVAL_MS);
}

async function createTabPool(count, windowId) {
  const tabIds = [];
  if (state.blankTabId) {
    tabIds.push(state.blankTabId);
    state.blankTabId = null;
  }
  while (tabIds.length < count) {
    const options = { url: "about:blank", active: false };
    if (windowId) options.windowId = windowId;
    const tab = await createTab(options);
    if (!tab?.id) break;
    tabIds.push(tab.id);
  }
  if (windowId) {
    const tabs = await new Promise((resolve) => chrome.tabs.query({ windowId }, resolve));
    const ordered = (tabs || [])
      .slice()
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((tab) => tab.id)
      .filter(Boolean);
    if (ordered.length) {
      tabIds.length = 0;
      tabIds.push(...ordered.slice(0, count));
    }
  }
  for (const id of tabIds) {
    state.activeTabIds.add(id);
    await updateTab(id, { autoDiscardable: false });
  }
  state.poolTabIds = tabIds.slice();
  return state.poolTabIds;
}

function waitTabNavigate(tabId, timeoutMs) {
  let finish = () => {};
  const promise = new Promise((resolve) => {
    let done = false;
    let loading = false;
    const timer = setTimeout(() => finish("timeout"), timeoutMs);

    finish = (reason) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      resolve(reason);
    };

    function onUpdated(updatedId, info) {
      if (updatedId !== tabId) return;
      if (info.status === "loading") loading = true;
      if (info.status === "complete" && loading) finish("complete");
    }

    function onRemoved(removedId) {
      if (removedId === tabId) finish("removed");
    }

    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError) {
        finish("missing");
        return;
      }
      if (tab?.status === "loading") loading = true;
    });
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
  promise.cancel = (reason = "cancelled") => finish(reason);
  return promise;
}

function closeTab(tabId) {
  if (!tabId) return;
  state.activeTabIds.delete(tabId);
  state.poolTabIds = state.poolTabIds.filter((id) => id !== tabId);
  chrome.tabs.remove(tabId, ignoreLastError);
}

function stopScan() {
  if (state.stopRequested && !state.inProgress) {
    closeWorkerWindow();
    return;
  }
  state.stopRequested = true;
  notifyStop();
  stopWorkerBoost();
  for (const tabId of [...state.activeTabIds]) {
    chrome.tabs.remove(tabId, ignoreLastError);
  }
  state.activeTabIds.clear();
  closeWorkerWindow();
  void persistRuntime();
}

async function openAppWindow() {
  const url = chrome.runtime.getURL(APP_PATH);
  const existing = await chrome.tabs.query({ url });
  if (existing[0]) {
    await chrome.windows.update(existing[0].windowId, { focused: true, state: "maximized" });
    await chrome.tabs.update(existing[0].id, { active: true });
    return;
  }
  await chrome.windows.create({
    url,
    type: "normal",
    state: "maximized",
    focused: true
  });
}

function shouldRetry(item) {
  if (state.stopRequested) return false;
  if (!item) return true;
  if (item.status === "stopped") return false;
  if (item.found) return false;
  if (item.ok && item.status === "complete") return false;
  return true;
}

async function runScanner(tabId, settings) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["scanner.js"]
  });
  const injected = await chrome.scripting.executeScript({
    target: { tabId },
    func: (options) => globalThis.__hubTraceScan(options),
    args: [
      {
        warehouse: settings.warehouse,
        timeoutMs: 180000,
        uncheckCurrentOnly: false
      }
    ]
  });
  return injected?.[0]?.result || null;
}

async function scanOne(posting, settings, tabId, forceReload = false) {
  if (state.stopRequested) return stoppedItem(posting);
  if (!tabId) {
    return { posting, status: "tab_error", found: false, expected: 0, loaded: 0, ok: false };
  }

  const url = buildHistoryUrl(posting);
  const existing = await getTab(tabId);
  if (!existing) {
    return { posting, status: "tab_error", found: false, expected: 0, loaded: 0, ok: false };
  }

  const samePage = String(existing.url || "").split("#")[0] === url.split("#")[0];
  const navWait = waitTabNavigate(tabId, 25000);
  if (forceReload || samePage) {
    if (!samePage) {
      const moved = await updateTab(tabId, { url, autoDiscardable: false });
      if (!moved) {
        navWait.cancel("missing");
        return { posting, status: "tab_error", found: false, expected: 0, loaded: 0, ok: false };
      }
    }
    await reloadTab(tabId);
  } else {
    const updated = await updateTab(tabId, { url, autoDiscardable: false });
    if (!updated) {
      navWait.cancel("missing");
      return { posting, status: "tab_error", found: false, expected: 0, loaded: 0, ok: false };
    }
  }
  if (state.aggressive) activatePoolTab(tabId);
  if (state.stopRequested) {
    navWait.cancel("stopped");
    return stoppedItem(posting);
  }

  try {
    const ready = await Promise.race([navWait, waitForStop().then(() => "stopped")]);
    if (state.stopRequested || ready === "stopped" || ready === "removed" || ready === "missing") {
      navWait.cancel("stopped");
      return stoppedItem(posting);
    }

    const zoomChanged = await setTabZoom(tabId, 0.25);
    if (zoomChanged) await Promise.race([sleep(80), waitForStop()]);
    if (state.stopRequested) return stoppedItem(posting);

    const result = await Promise.race([
      runScanner(tabId, settings).catch((error) => ({
        posting,
        status: "exception",
        found: false,
        expected: 0,
        loaded: 0,
        ok: false,
        error: String(error?.message || error)
      })),
      waitForStop().then(() => null)
    ]);
    if (state.stopRequested || result == null) return stoppedItem(posting);
    if (!result.status && result.found == null) {
      return { posting, status: "script_error", found: false, expected: 0, loaded: 0, ok: false };
    }
    return { posting, ...result };
  } catch (error) {
    if (state.stopRequested) return stoppedItem(posting);
    return {
      posting,
      status: "exception",
      found: false,
      expected: 0,
      loaded: 0,
      ok: false,
      error: String(error?.message || error)
    };
  }
}

function pickBetterScan(a, b) {
  if (!b) return a;
  if (!a) return b;
  if (b.found && !a.found) return b;
  if (a.found && !b.found) return a;
  const aLoad = Number(a.loaded) || 0;
  const bLoad = Number(b.loaded) || 0;
  if (bLoad !== aLoad) return bLoad > aLoad ? b : a;
  if (b.ok && !a.ok) return b;
  if (b.status === "complete" && a.status !== "complete") return b;
  return a;
}

function extraAttempts(item) {
  if (!item) return 1;
  if (item.status === "partial" && !item.found) return 3;
  if (shouldRetry(item)) return 1;
  return 0;
}

async function scanOneWithRetry(posting, settings, tabId) {
  let best = await scanOne(posting, settings, tabId, false);
  let used = 0;
  while (!state.stopRequested) {
    const extra = extraAttempts(best);
    if (used >= extra) break;
    if (best?.found || (best?.ok && best?.status === "complete")) break;
    used += 1;
    await Promise.race([sleep(200), waitForStop()]);
    if (state.stopRequested) return best;
    const next = await scanOne(posting, settings, tabId, true);
    best = pickBetterScan(best, next);
  }
  return best;
}

function validateScan(payload) {
  const postings = Array.isArray(payload?.postings) ? payload.postings.filter(Boolean) : [];
  const warehouse = String(payload?.warehouse || "").trim();
  if (state.inProgress) return { ok: false, error: "Уже идёт сканирование" };
  if (!postings.length) return { ok: false, error: "Нет номеров отправлений" };
  if (!warehouse) return { ok: false, error: "Не указан склад" };
  return { ok: true, postings, warehouse };
}

function notifyFinished(finished) {
  const results = Array.isArray(finished?.results) ? finished.results : [];
  const hits = results.filter((item) => item?.found).length;
  const checked = results.filter((item) => item?.status !== "stopped").length;
  const total = Number(finished?.inputCount) || results.length;
  const title = finished?.stopped ? "Hub Trace · остановлено" : "Hub Trace · готово";
  const message = finished?.error
    ? String(finished.error)
    : finished?.stopped
      ? `Проверено ${checked} из ${total}. Нашлось ${hits}.`
      : `Было ${total}, нашлось ${hits}.`;
  chrome.notifications.create(
    `hub-trace-done-${Date.now()}`,
    {
      type: "basic",
      iconUrl: "icons/icon-128.png",
      title,
      message,
      priority: 2
    },
    ignoreLastError
  );
}

async function runScan(payload, postings, warehouse) {
  const settings = {
    ...DEFAULT_SETTINGS,
    ...(payload.settings || {}),
    warehouse,
    zoom: 0.25,
    timeoutSec: 180,
    uncheckCurrentOnly: false
  };

  await storageRemove([STORAGE_FINISHED]);
  state.inProgress = true;
  state.stopRequested = false;
  stopWaiters.clear();
  state.jobId = payload.jobId || `job-${Date.now()}`;
  state.processed = 0;
  state.total = postings.length;
  state.threads = Math.max(1, Math.min(12, Number(settings.threads) || 4));
  state.activeTabIds.clear();

  try {
    state.workerWindowId = await ensureWorkerWindow(settings.workerWindow !== false, settings.focusMode);
    state.aggressive = settings.focusMode !== false;
    const pool = await createTabPool(state.threads, state.workerWindowId);
    if (pool.length) state.threads = Math.min(state.threads, pool.length);
    if (!state.workerWindowId && pool[0]) {
      const tab = await new Promise((resolve) => {
        chrome.tabs.get(pool[0], (item) => {
          ignoreLastError();
          resolve(item || null);
        });
      });
      if (tab?.windowId) state.workerWindowId = tab.windowId;
    }
    if (state.aggressive) startWorkerBoost();
    await persistRuntime();
    await storageSet({ [STORAGE_SETTINGS]: settings });

    emit({
      action: "scanProgress",
      jobId: state.jobId,
      processed: 0,
      total: state.total,
      item: null
    });

    const results = [];
    let cursor = 0;

    async function worker(workerId) {
      const tabId = pool[workerId - 1];
      while (!state.stopRequested) {
        const index = cursor++;
        if (index >= postings.length) break;
        const posting = postings[index];
        const item = await scanOneWithRetry(posting, settings, tabId);
        if (item?.status === "stopped") {
          results[index] = item;
          continue;
        }
        results[index] = item;
        state.processed += 1;
        await persistRuntime();
        emit({
          action: "scanProgress",
          jobId: state.jobId,
          processed: state.processed,
          total: state.total,
          workerId,
          item
        });
      }
    }

    if (!state.stopRequested) {
      await Promise.all(Array.from({ length: state.threads }, (_, i) => worker(i + 1)));
    }

    if (state.stopRequested) {
      for (let i = 0; i < postings.length; i += 1) {
        if (!results[i]) results[i] = stoppedItem(postings[i]);
      }
    }

    const finished = {
      jobId: state.jobId,
      stopped: state.stopRequested,
      warehouse: settings.warehouse,
      inputCount: postings.length,
      results: results.filter(Boolean),
      finishedAt: Date.now()
    };
    await storageSet({ [STORAGE_FINISHED]: finished });
    notifyFinished(finished);
    emit({ action: "scanFinished", jobId: state.jobId, stopped: state.stopRequested });
  } catch (error) {
    await storageSet({
      [STORAGE_FINISHED]: {
        jobId: state.jobId,
        stopped: true,
        warehouse: settings.warehouse,
        inputCount: postings.length,
        results: [],
        error: String(error?.message || error),
        finishedAt: Date.now()
      }
    });
    notifyFinished({
      stopped: true,
      warehouse: settings.warehouse,
      inputCount: postings.length,
      results: [],
      error: String(error?.message || error)
    });
    emit({
      action: "scanFinished",
      jobId: state.jobId,
      stopped: true,
      error: String(error?.message || error)
    });
  } finally {
    state.inProgress = false;
    state.stopRequested = false;
    state.aggressive = false;
    stopWaiters.clear();
    stopWorkerBoost();
    state.activeTabIds.clear();
    closeWorkerWindow();
    await persistRuntime();
  }
}

chrome.notifications.onClicked.addListener(() => {
  void openAppWindow();
});

chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId !== state.workerWindowId) return;
  state.workerWindowId = null;
  state.blankTabId = null;
  if (state.inProgress) stopScan();
});

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== "hub-trace-keepalive") return;
  port.onDisconnect.addListener(() => {});
});

chrome.action.onClicked.addListener(() => {
  void openAppWindow();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.action === "openApp") {
    void openAppWindow().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.action === "startScan") {
    const check = validateScan(message);
    if (check.ok) state.inProgress = true;
    sendResponse(check);
    if (check.ok) void runScan(message, check.postings, check.warehouse);
    return false;
  }
  if (message?.action === "stopScan") {
    stopScan();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.action === "workerBoostTick") {
    workerBoostTick();
    sendResponse({ ok: true });
    return false;
  }
  if (message?.action === "getScanState") {
    sendResponse({
      inProgress: state.inProgress,
      processed: state.processed,
      total: state.total,
      threads: state.threads,
      jobId: state.jobId
    });
    return false;
  }
  return false;
});
