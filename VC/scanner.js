globalThis.__hubTraceScan = async function scanHistoryPage(options) {
  const warehouse = String(options?.warehouse || "").trim();
  const timeoutMs = Math.max(20000, Number(options?.timeoutMs) || 180000);
  const uncheckCurrentOnly = options?.uncheckCurrentOnly === true;
  const needle = warehouse.toLowerCase();
  const started = Date.now();

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const remaining = () => Math.max(0, timeoutMs - (Date.now() - started));

  function textOf(el) {
    return (el?.innerText || el?.textContent || "").replace(/\s+/g, " ").trim();
  }

  function parseCounter() {
    const nodes = document.querySelectorAll('[class*="table-tools__counter"]');
    for (const node of nodes) {
      const match = textOf(node).match(/Всего:\s*(\d+)/i);
      if (match) return Number(match[1]);
    }
    const history = document.querySelector('[class*="_history_"]') || document.body;
    const match = textOf(history).match(/Всего:\s*(\d+)/i);
    return match ? Number(match[1]) : null;
  }

  function historyReady() {
    return Boolean(
      document.querySelector('[class*="_history_"]') ||
        document.querySelector('[class*="table-tools__counter"]') ||
        document.querySelector("table.ozi__table__table__HAe8A")
    );
  }

  function detectAuth() {
    const href = location.href.toLowerCase();
    if (href.includes("login") || href.includes("sso") || href.includes("auth")) return true;
    return Boolean(document.querySelector('input[type="password"]'));
  }

  function detectMissing() {
    const text = textOf(document.body).toLowerCase();
    return /не найден|не существует|нет данных по предмету|page not found/.test(text);
  }

  function dataRows() {
    const tables = [...document.querySelectorAll("table")];
    const table =
      document.querySelector("table.ozi__table__table__HAe8A") ||
      tables.find((item) => item.querySelector("tbody tr, tr[class*='data-grid__row']")) ||
      tables[0];
    const fromTable = table
      ? [...table.querySelectorAll("tbody tr, tr[class*='data-grid__row']")].filter(
          (row) => row.querySelectorAll("td").length > 0
        )
      : [];
    if (fromTable.length) return fromTable;
    return [...document.querySelectorAll('[class*="data-grid__row"]')].filter(
      (row) => textOf(row).length > 0
    );
  }

  function rowKey(row) {
    const cells = [...row.querySelectorAll("td")].map(textOf);
    const raw = cells.length ? cells.join("|") : textOf(row);
    return raw.slice(0, 420);
  }

  let foundInRows = false;

  function collectVisible(bag) {
    for (const row of dataRows()) {
      const key = rowKey(row);
      if (!key || bag.has(key)) continue;
      const text = textOf(row);
      bag.set(key, text);
      if (!foundInRows && text.toLowerCase().includes(needle)) foundInRows = true;
    }
    return foundInRows;
  }

  function ensureScrollCss() {
    let style = document.getElementById("hub-trace-expand");
    if (!style) {
      style = document.createElement("style");
      style.id = "hub-trace-expand";
      document.documentElement.appendChild(style);
    }
    style.textContent = `
      [class*="data-grid__scroller"],
      [data-overlayscrollbars="host"],
      [class*="ozi__scroller__scroller"] {
        max-height: 78vh !important;
        overflow: auto !important;
      }
      [data-overlayscrollbars-viewport] {
        overflow-y: scroll !important;
        overflow-x: hidden !important;
        max-height: 78vh !important;
      }
    `;
  }

  function candidateScrollers() {
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
    return list;
  }

  function room(el) {
    if (!el) return 0;
    return Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
  }

  function pickScroller() {
    const ranked = candidateScrollers().sort((a, b) => room(b) - room(a));
    return ranked.find((el) => room(el) > 8) || ranked[0] || document.scrollingElement;
  }

  function fireWheel(el, deltaY) {
    if (!el || !(deltaY > 0)) return;
    const rect = el.getBoundingClientRect?.() || { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    const event = new WheelEvent("wheel", {
      deltaY,
      deltaX: 0,
      deltaMode: 0,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
      clientX: Math.round(rect.left + Math.max(24, rect.width / 2)),
      clientY: Math.round(rect.top + Math.max(24, rect.height / 2))
    });
    el.dispatchEvent(event);
  }

  function setScrollTop(el, top) {
    if (!el) return;
    const max = room(el);
    const next = Math.max(0, Math.min(max, top));
    el.scrollTop = next;
    try {
      if (typeof el.scrollTo === "function") el.scrollTo({ top: next, left: 0, behavior: "auto" });
    } catch (_err) {
      /* ignore */
    }
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
  }

  function atBottom(el) {
    if (!el) return true;
    return room(el) < 4 || (el.scrollTop || 0) >= room(el) - 4;
  }

  async function scrollDown(el) {
    if (!el) return false;
    const from = el.scrollTop || 0;
    if (atBottom(el)) {
      fireWheel(el, Math.max(240, el.clientHeight || 360));
      await sleep(90);
      return !atBottom(el) || (el.scrollTop || 0) > from + 1;
    }
    const amount = Math.max(96, Math.round((el.clientHeight || 360) * 0.8));
    setScrollTop(el, from + amount);
    fireWheel(el, amount);
    await sleep(90);
    return (el.scrollTop || 0) > from + 1 || !atBottom(el);
  }

  function clickUncheckCurrentOnly() {
    if (!uncheckCurrentOnly) return false;
    const labels = [...document.querySelectorAll("label")];
    for (const label of labels) {
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
    const candidates = [...document.querySelectorAll('button, a, [role="tab"]')];
    for (const el of candidates) {
      const label = textOf(el).toLowerCase();
      if (label !== "история" && !label.startsWith("история")) continue;
      if (el.getAttribute("aria-selected") === "true" || el.className.includes("active")) return false;
      el.click();
      return true;
    }
    return false;
  }

  async function waitGrowth(bag, prev, ms) {
    collectVisible(bag);
    if (foundInRows || bag.size > prev) return true;

    const root =
      document.querySelector("table.ozi__table__table__HAe8A tbody") ||
      document.querySelector("table tbody") ||
      document.querySelector('[class*="_history_"]') ||
      document.body;
    const deadline = Date.now() + ms;

    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        obs.disconnect();
        clearInterval(poll);
        resolve(value);
      };
      const obs = new MutationObserver(() => {
        collectVisible(bag);
        if (foundInRows || bag.size > prev) finish(true);
      });
      obs.observe(root, { childList: true, subtree: true });
      const poll = setInterval(() => {
        collectVisible(bag);
        if (foundInRows || bag.size > prev) {
          finish(true);
          return;
        }
        if (Date.now() >= deadline || remaining() <= 0) finish(bag.size > prev || foundInRows);
      }, 30);
    });
  }

  async function loadAllRows(expected) {
    const bag = new Map();
    collectVisible(bag);
    if (foundInRows || expected <= 0 || bag.size >= expected) return bag;

    ensureScrollCss();
    await sleep(30);

    let stall = 0;
    let scroller = pickScroller();
    while (remaining() > 0 && bag.size < expected && !foundInRows) {
      const before = bag.size;
      if (stall > 0) scroller = pickScroller();
      const moved = await scrollDown(scroller);
      const grew = await waitGrowth(bag, before, moved ? 120 : 200);
      if (foundInRows) break;

      if (grew) {
        stall = 0;
        continue;
      }

      stall += 1;
      if (atBottom(scroller) && stall >= 4) break;
      if (stall >= 18) break;
    }

    collectVisible(bag);
    return bag;
  }

  if (!needle) {
    return { ok: false, status: "bad_input", found: false, expected: 0, loaded: 0, samples: [] };
  }

  let lastMissingCheck = 0;
  while (remaining() > 0) {
    if (historyReady()) break;
    clickHistoryTab();
    if (detectAuth() && Date.now() - started > 4000) {
      return { ok: false, status: "auth", found: false, expected: 0, loaded: 0, samples: [] };
    }
    if (Date.now() - started > 6000 && Date.now() - lastMissingCheck > 1000) {
      lastMissingCheck = Date.now();
      if (detectMissing()) {
        return { ok: false, status: "missing", found: false, expected: 0, loaded: 0, samples: [] };
      }
    }
    await sleep(80);
  }

  if (!historyReady()) {
    return { ok: false, status: "no_history", found: false, expected: 0, loaded: 0, samples: [] };
  }

  let expected = parseCounter();
  const waitCounterUntil = Date.now() + Math.min(12000, remaining());
  while (expected == null && Date.now() < waitCounterUntil) {
    await sleep(80);
    expected = parseCounter();
  }
  if (expected == null) {
    return { ok: false, status: "no_counter", found: false, expected: 0, loaded: 0, samples: [] };
  }

  if (clickUncheckCurrentOnly()) {
    await sleep(500);
    const reloadUntil = Date.now() + Math.min(8000, remaining());
    while (Date.now() < reloadUntil) {
      const next = parseCounter();
      if (next != null) {
        expected = next;
        break;
      }
      await sleep(160);
    }
  }

  ensureScrollCss();
  const bag = await loadAllRows(expected);
  collectVisible(bag);

  const found = foundInRows || textOf(document.body).toLowerCase().includes(needle);
  const samples = [];
  if (found) {
    for (const value of bag.values()) {
      if (value.toLowerCase().includes(needle)) samples.push(value.slice(0, 280));
      if (samples.length >= 3) break;
    }
  }

  return {
    ok: bag.size >= expected,
    status: bag.size >= expected ? "complete" : "partial",
    found,
    expected,
    loaded: bag.size,
    matchCount: samples.length,
    samples
  };
};
