const STORAGE_SETTINGS = "hubTraceSettings";
const STORAGE_FINISHED = "hubTraceFinished";
const STORAGE_RUNTIME = "hubTraceRuntime";

const postingsEl = document.getElementById("postings");
const warehouseEl = document.getElementById("warehouse");
const countBadge = document.getElementById("count-badge");
const inputError = document.getElementById("input-error");

const screens = {
  input: document.getElementById("screen-input"),
  scan: document.getElementById("screen-scan"),
  result: document.getElementById("screen-result")
};

const scanState = {
  jobId: null,
  hits: 0,
  misses: 0,
  issues: 0,
  items: [],
  blips: [],
  scanning: false,
  stopping: false,
  hasResults: false,
  currentStep: "input",
  mode: "idle",
  boostTimer: null
};

let keepAlivePort = null;

function ensureKeepAlive() {
  if (keepAlivePort) return;
  keepAlivePort = chrome.runtime.connect({ name: "hub-trace-keepalive" });
  keepAlivePort.onDisconnect.addListener(() => {
    keepAlivePort = null;
  });
}

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}

function storageSet(payload) {
  return new Promise((resolve) => chrome.storage.local.set(payload, resolve));
}

function parsePostings(raw) {
  const lines = String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const tokens = [];
  for (const line of lines) {
    if (line.includes("\t")) {
      tokens.push(line.split("\t")[0].trim());
      continue;
    }
    if (/[,;]/.test(line)) {
      tokens.push(...line.split(/[,;]+/).map((part) => part.trim()).filter(Boolean));
      continue;
    }
    const parts = line.split(/\s+/);
    if (parts.length > 1 && parts.every((part) => /^[A-Za-z0-9:_-]+$/.test(part))) {
      tokens.push(...parts);
    } else {
      tokens.push(parts[0]);
    }
  }

  const out = [];
  const seen = new Set();
  for (let token of tokens) {
    const fromUrl = token.match(/stock\/item\/Lozon:([^?&#/]+)/i);
    if (fromUrl) token = decodeURIComponent(fromUrl[1]);
    token = token.replace(/^Lozon:/i, "").trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out;
}

function readSettings() {
  return {
    threads: Math.max(1, Math.min(12, Number(document.getElementById("threads").value) || 4)),
    focusMode: document.getElementById("focus-mode").checked,
    workerWindow: document.getElementById("worker-window").checked
  };
}

function applySettings(settings) {
  if (!settings) return;
  if (settings.threads) document.getElementById("threads").value = settings.threads;
  if (settings.warehouse) warehouseEl.value = settings.warehouse;
  document.getElementById("focus-mode").checked = settings.focusMode !== false;
  document.getElementById("worker-window").checked = settings.workerWindow !== false;
}

function availableSteps() {
  return {
    input: true,
    scan: true,
    result: scanState.hasResults
  };
}

function syncSteps() {
  const avail = availableSteps();
  document.querySelectorAll(".step").forEach((btn) => {
    const step = btn.dataset.step;
    btn.classList.toggle("is-active", step === scanState.currentStep);
    btn.disabled = !avail[step];
  });
}

function setScanMode(mode) {
  scanState.mode = mode;
  screens.scan.classList.toggle("is-live", mode === "live");
  screens.scan.classList.toggle("is-stopping", mode === "stopping");
  screens.scan.classList.toggle("is-idle", mode === "idle");
  const radar = document.getElementById("radar");
  if (radar) radar.classList.toggle("is-live", mode === "live");
  const badge = document.getElementById("scan-status");
  badge.classList.toggle("badge--live", mode === "live");
  if (mode === "live") badge.textContent = "идёт";
  else if (mode === "stopping") badge.textContent = "стоп";
  else badge.textContent = "ожидание";
  const stopBtn = document.getElementById("btn-stop");
  stopBtn.disabled = mode !== "live";
  const empty = document.getElementById("feed-empty");
  const hasItems = document.getElementById("feed").children.length > 0;
  const current = document.getElementById("scan-current");
  if (hasItems) {
    empty.hidden = true;
  } else if (mode === "live") {
    empty.hidden = false;
    empty.textContent = "Жду первые результаты…";
  } else if (mode === "stopping") {
    empty.hidden = false;
    empty.textContent = "Останавливаю проверку…";
  } else {
    empty.hidden = false;
    empty.textContent = "Сейчас ничего не проверяется";
  }
  if (mode === "idle") {
    current.textContent = hasItems ? "Проверка не идёт" : "Сейчас ничего не проверяется";
  } else if (mode === "stopping") {
    current.textContent = "Останавливаю…";
  }
}

function startBoostClient() {
  stopBoostClient();
  if (!document.getElementById("focus-mode")?.checked) return;
  scanState.boostTimer = window.setInterval(() => {
    chrome.runtime.sendMessage({ action: "workerBoostTick" }, () => {
      void chrome.runtime.lastError;
    });
  }, 450);
}

function stopBoostClient() {
  if (!scanState.boostTimer) return;
  window.clearInterval(scanState.boostTimer);
  scanState.boostTimer = null;
}

function finishScanUi(payload) {
  window.clearTimeout(scanState.stopTimer);
  stopBoostClient();
  scanState.scanning = false;
  scanState.stopping = false;
  setScanMode("idle");
  updateFormState();
  const savedResults = payload?.results;
  void storageGet([STORAGE_FINISHED]).then((saved) => {
    const finished = saved[STORAGE_FINISHED] || {
      results: savedResults || scanState.items,
      inputCount: Number(document.getElementById("scan-progress").dataset.total || scanState.items.length),
      warehouse: warehouseEl.value.trim(),
      stopped: payload?.stopped,
      error: payload?.error
    };
    if (finished.results?.length || scanState.items.length) {
      if (!finished.results?.length) finished.results = scanState.items;
      scanState.hasResults = true;
      scanState.items = finished.results;
      renderResults(finished);
    } else {
      document.getElementById("scan-current").textContent = "Сейчас ничего не проверяется";
      syncSteps();
    }
  });
}

function rebuildFeed() {
  const feed = document.getElementById("feed");
  feed.innerHTML = "";
  for (const item of scanState.items.slice(-80)) renderFeed(item);
}

function setStep(name) {
  const avail = availableSteps();
  if (!avail[name]) return;
  scanState.currentStep = name;
  for (const [key, el] of Object.entries(screens)) {
    el.hidden = key !== name;
  }
  if (name === "scan" && !scanState.scanning) {
    rebuildFeed();
    setScanMode("idle");
  }
  syncSteps();
}

function updateCount() {
  countBadge.textContent = String(parsePostings(postingsEl.value).length);
  updateFormState();
}

function updateFormState() {
  const hasPostings = parsePostings(postingsEl.value).length > 0;
  const hasWarehouse = warehouseEl.value.trim().length > 0;
  const hasHits = document.getElementById("hits").value.trim().length > 0;
  const hasMisses = document.getElementById("misses").value.trim().length > 0;
  const hasIssues = document.getElementById("issues").value.trim().length > 0;
  document.getElementById("btn-start").disabled = scanState.scanning || scanState.stopping || !(hasPostings && hasWarehouse);
  document.getElementById("btn-clear").disabled = !postingsEl.value.trim();
  document.getElementById("btn-copy").disabled = !hasHits;
  document.getElementById("btn-copy-hits").disabled = !hasHits;
  document.getElementById("btn-copy-misses").disabled = !hasMisses;
  document.getElementById("btn-copy-issues").disabled = !hasIssues;
}

function classify(item) {
  if (item?.found) return "hit";
  if (item?.status === "partial" && !item?.found) return "issue";
  if (["complete", "missing"].includes(item?.status) && !item?.found) return "miss";
  if (item?.ok && !item?.found) return "miss";
  return "issue";
}

function statusLabel(item) {
  if (item?.found) return "есть";
  const map = {
    complete: "нет",
    missing: "нет страницы",
    partial: "мало строк",
    auth: "нет входа",
    no_history: "нет истории",
    no_counter: "нет счётчика",
    timeout: "таймаут",
    stopped: "стоп",
    tab_error: "вкладка",
    script_error: "скрипт",
    exception: "ошибка"
  };
  return map[item?.status] || item?.status || "ошибка";
}

function blipDistance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function randomBlipPoint(minR, maxR) {
  const angle = Math.random() * Math.PI * 2;
  const radius = minR + Math.random() * (maxR - minR);
  return {
    x: 0.5 + Math.cos(angle) * radius,
    y: 0.5 + Math.sin(angle) * radius
  };
}

function placeRadarBlip() {
  const dishR = 30 / 64;
  const minR = dishR * 0.4;
  const maxR = dishR * 0.86;
  const minDist = Math.max(0.048, 0.078 - scanState.blips.length * 0.0007);

  for (let i = 0; i < 90; i += 1) {
    const point = randomBlipPoint(minR, maxR);
    if (scanState.blips.every((other) => blipDistance(point, other) >= minDist)) {
      return point;
    }
  }

  let best = randomBlipPoint(minR, maxR);
  let bestGap = -1;
  for (let i = 0; i < 70; i += 1) {
    const point = randomBlipPoint(minR, maxR);
    const gap = scanState.blips.reduce((min, other) => Math.min(min, blipDistance(point, other)), Infinity);
    if (gap > bestGap) {
      bestGap = gap;
      best = point;
    }
  }
  return best;
}

function addRadarBlip(kind) {
  const root = document.getElementById("radar-blips");
  if (!root) return;
  const point = placeRadarBlip();
  scanState.blips.push(point);
  const blip = document.createElement("span");
  blip.className = `radar__blip radar__blip--${kind}`;
  blip.style.left = `${point.x * 100}%`;
  blip.style.top = `${point.y * 100}%`;
  const core = document.createElement("span");
  core.className = "radar__blip-core";
  blip.appendChild(core);
  root.appendChild(blip);
  window.setTimeout(() => {
    void blip.offsetWidth;
    blip.classList.add("is-gone");
    window.setTimeout(() => {
      blip.remove();
      scanState.blips = scanState.blips.filter((item) => item !== point);
    }, 1800);
  }, 5000);
}

function resetRadarBlips() {
  scanState.blips = [];
  const root = document.getElementById("radar-blips");
  if (root) root.innerHTML = "";
}

function renderFeed(item) {
  if (!item) return;
  const kind = classify(item);
  const label = statusLabel(item);
  const wide = label.length > 4 ? " tag--wide" : "";
  const li = document.createElement("li");
  li.innerHTML = `
    <span class="tag tag--${kind}${wide}">${label}</span>
    <code>${item.posting}</code>
    <span class="feed__count">${item.loaded || 0}/${item.expected || 0}</span>
  `;
  const feed = document.getElementById("feed");
  feed.prepend(li);
  while (feed.children.length > 80) feed.lastElementChild.remove();
  const empty = document.getElementById("feed-empty");
  if (empty) empty.hidden = true;
}

function updateScanHud() {
  const total = Number(document.getElementById("scan-progress").dataset.total || 0);
  const processed = scanState.hits + scanState.misses + scanState.issues;
  const pct = total ? Math.round((processed / total) * 100) : 0;
  document.getElementById("scan-progress").textContent = `${processed} / ${total}`;
  document.getElementById("scan-hits").textContent = String(scanState.hits);
  document.getElementById("scan-misses").textContent = String(scanState.misses);
  document.getElementById("progress-label").textContent = `${processed} из ${total}`;
  document.getElementById("progress-pct").textContent = `${pct}%`;
  document.getElementById("progress-hit").style.width = total ? `${(scanState.hits / total) * 100}%` : "0%";
  document.getElementById("progress-miss").style.width = total ? `${(scanState.misses / total) * 100}%` : "0%";
  document.getElementById("progress-issue").style.width = total ? `${(scanState.issues / total) * 100}%` : "0%";
  const sub = document.getElementById("progress-sub");
  if (!processed) {
    sub.textContent = total ? "Ожидание первых результатов" : "Ожидание запуска";
  } else {
    sub.textContent = `Есть ${scanState.hits} · нет ${scanState.misses} · ошибки ${scanState.issues}`;
  }
}

function resetScanHud(total) {
  scanState.hits = 0;
  scanState.misses = 0;
  scanState.issues = 0;
  scanState.items = [];
  resetRadarBlips();
  document.getElementById("feed").innerHTML = "";
  document.getElementById("scan-progress").dataset.total = String(total);
  document.getElementById("scan-current").textContent = "Открываю историю…";
  setScanMode("live");
  updateScanHud();
}

function showError(message) {
  inputError.hidden = !message;
  inputError.textContent = message || "";
}

function splitResults(results) {
  const hits = [];
  const misses = [];
  const issues = [];
  for (const item of results) {
    const kind = classify(item);
    if (kind === "hit") hits.push(item.posting);
    else if (kind === "miss") misses.push(item.posting);
    else issues.push(`${item.posting}\t${statusLabel(item)}\t${item.loaded || 0}/${item.expected || 0}`);
  }
  return { hits, misses, issues };
}

function renderResults(payload) {
  const results = payload?.results || scanState.items;
  const { hits, misses, issues } = splitResults(results);
  const inputCount = payload?.inputCount || results.length;
  document.getElementById("result-title").textContent = `Было ${inputCount}, нашлось ${hits.length}`;
  document.getElementById("result-sub").textContent = payload?.error
    ? payload.error
    : payload?.warehouse
      ? `Склад ${payload.warehouse} есть в истории этих номеров.`
      : "Номера, у которых этот склад есть в истории.";
  document.getElementById("hits").value = hits.join("\n");
  document.getElementById("misses").value = misses.join("\n");
  document.getElementById("issues").value = issues.join("\n");
  document.getElementById("hit-count").textContent = String(hits.length);
  document.getElementById("miss-count").textContent = String(misses.length);
  document.getElementById("issue-count").textContent = String(issues.length);
  scanState.hasResults = true;
  updateFormState();
  setStep("result");
}

async function startScan() {
  const postings = parsePostings(postingsEl.value);
  const warehouse = warehouseEl.value.trim();
  const settings = readSettings();
  showError("");

  if (!postings.length || !warehouse) {
    updateFormState();
    return;
  }

  scanState.jobId = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  await storageSet({
    [STORAGE_SETTINGS]: { ...settings, warehouse, lastPostings: postingsEl.value }
  });
  scanState.scanning = true;
  scanState.stopping = false;
  scanState.hasResults = false;
  ensureKeepAlive();
  resetScanHud(postings.length);
  setStep("scan");
  startBoostClient();
  updateFormState();

  chrome.runtime.sendMessage(
    {
      action: "startScan",
      jobId: scanState.jobId,
      postings,
      warehouse,
      settings
    },
    (response) => {
      if (chrome.runtime.lastError) {
        showError("Фон не отвечает. Перезагрузите расширение.");
        scanState.scanning = false;
        stopBoostClient();
        setScanMode("idle");
        setStep("input");
        updateFormState();
        return;
      }
      if (response && response.ok === false) {
        showError(response.error || "Не получилось запустить.");
        scanState.scanning = false;
        stopBoostClient();
        setScanMode("idle");
        setStep("input");
        updateFormState();
      }
    }
  );
}

postingsEl.addEventListener("input", updateCount);
warehouseEl.addEventListener("input", updateFormState);
document.getElementById("threads").addEventListener("change", () => {
  const input = document.getElementById("threads");
  input.value = String(Math.max(1, Math.min(12, Number(input.value) || 4)));
});
document.getElementById("btn-clear").addEventListener("click", () => {
  postingsEl.value = "";
  updateCount();
});
document.getElementById("btn-paste").addEventListener("click", async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text) return;
    postingsEl.value = postingsEl.value.trim() ? `${postingsEl.value.trim()}\n${text}` : text;
    updateCount();
  } catch (_err) {
    showError("Нет доступа к буферу.");
  }
});
document.getElementById("btn-start").addEventListener("click", () => void startScan());
document.querySelectorAll(".step").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (btn.disabled) return;
    const step = btn.dataset.step;
    if (step === "result" && scanState.items.length) {
      renderResults({
        results: scanState.items,
        inputCount: Number(document.getElementById("scan-progress").dataset.total || scanState.items.length),
        warehouse: warehouseEl.value.trim()
      });
      return;
    }
    setStep(step);
    updateFormState();
  });
});
document.getElementById("btn-stop").addEventListener("click", () => {
  if (!scanState.scanning || scanState.stopping) return;
  scanState.stopping = true;
  stopBoostClient();
  setScanMode("stopping");
  document.getElementById("scan-current").textContent = "Останавливаю…";
  chrome.runtime.sendMessage({ action: "stopScan" }, () => {
    void chrome.runtime.lastError;
  });
  window.clearTimeout(scanState.stopTimer);
  scanState.stopTimer = window.setTimeout(() => {
    if (!scanState.stopping && !scanState.scanning) return;
    finishScanUi({ stopped: true, results: scanState.items });
  }, 3500);
});
document.getElementById("btn-again").addEventListener("click", () => {
  setStep("input");
  updateFormState();
});

function flashCopied(button) {
  button.classList.add("is-copied");
  window.clearTimeout(button._copyTimer);
  button._copyTimer = window.setTimeout(() => {
    button.classList.remove("is-copied");
  }, 1400);
}

async function copyField(id, button) {
  const raw = document.getElementById(id).value.trim();
  if (!raw) return;
  const text =
    id === "issues"
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

document.getElementById("btn-copy").addEventListener("click", async () => {
  await copyField("hits", document.getElementById("btn-copy"));
});
document.getElementById("btn-copy-hits").addEventListener("click", async (event) => {
  await copyField("hits", event.currentTarget);
});
document.getElementById("btn-copy-misses").addEventListener("click", async (event) => {
  await copyField("misses", event.currentTarget);
});
document.getElementById("btn-copy-issues").addEventListener("click", async (event) => {
  await copyField("issues", event.currentTarget);
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.action === "scanProgress") {
    if (scanState.stopping && !message.item) return;
    if (message.item) {
      scanState.items.push(message.item);
      const kind = classify(message.item);
      if (kind === "hit") scanState.hits += 1;
      else if (kind === "miss") scanState.misses += 1;
      else scanState.issues += 1;
      renderFeed(message.item);
      if (scanState.scanning && !scanState.stopping) addRadarBlip(kind);
      document.getElementById("scan-current").textContent = `${message.item.posting} · ${statusLabel(message.item)}`;
      if (scanState.items.length) scanState.hasResults = true;
      syncSteps();
    }
    if (message.total) document.getElementById("scan-progress").dataset.total = String(message.total);
    updateScanHud();
  }
  if (message?.action === "scanFinished") {
    finishScanUi(message);
  }
});

async function boot() {
  ensureKeepAlive();
  const saved = await storageGet([STORAGE_SETTINGS, STORAGE_FINISHED, STORAGE_RUNTIME]);
  applySettings(saved[STORAGE_SETTINGS]);
  if (saved[STORAGE_SETTINGS]?.lastPostings) {
    postingsEl.value = saved[STORAGE_SETTINGS].lastPostings;
  }
  updateCount();

  chrome.runtime.sendMessage({ action: "getScanState" }, (state) => {
    if (state?.inProgress) {
      scanState.scanning = true;
      scanState.stopping = false;
      resetScanHud(state.total || 0);
      setStep("scan");
      setScanMode("live");
      startBoostClient();
      document.getElementById("scan-current").textContent = `Идёт: ${state.processed}/${state.total}`;
    } else if (saved[STORAGE_FINISHED]?.results?.length) {
      scanState.hasResults = true;
      scanState.items = saved[STORAGE_FINISHED].results;
      setScanMode("idle");
      renderResults(saved[STORAGE_FINISHED]);
    } else {
      setScanMode("idle");
    }
  });
}

const SIGNATURE_EVERY_MS = 5 * 60 * 1000;
const SIGNATURE_DURATION_MS = 16000;

function playSignature() {
  const el = document.getElementById("signature");
  if (!el || document.hidden) return;
  document.body.classList.add("has-sig");
  el.classList.remove("is-on");
  void el.offsetWidth;
  el.classList.add("is-on");
  window.setTimeout(() => {
    el.classList.remove("is-on");
    document.body.classList.remove("has-sig");
  }, SIGNATURE_DURATION_MS);
}

window.setTimeout(() => {
  playSignature();
  window.setInterval(playSignature, SIGNATURE_EVERY_MS);
}, SIGNATURE_EVERY_MS);

void boot();
