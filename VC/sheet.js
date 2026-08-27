(function () {
  "use strict";

  const ID_RE = /(?<![0-9])[0-9]{10,}(?![0-9])/g;

  function looksLikeId(value) {
    return /^[0-9]{10,}$/.test(value) && value.endsWith("000");
  }

  function looksLikeNumber(value) {
    return /^[0-9]{10,}$/.test(value);
  }

  function idsIn(text, loose) {
    const fits = loose ? looksLikeNumber : looksLikeId;
    const out = [];
    for (const match of String(text == null ? "" : text).matchAll(ID_RE)) {
      if (fits(match[0])) out.push(match[0]);
    }
    return out;
  }

  function uniq(list) {
    const out = [];
    const seen = new Set();
    for (const value of list) {
      if (seen.has(value)) continue;
      seen.add(value);
      out.push(value);
    }
    return out;
  }

  const STRICT_SHARE = 0.8;

  function pickRule(strict, loose) {
    return strict.length >= loose.length * STRICT_SHARE ? strict : loose;
  }

  function extractIds(text) {
    const loose = uniq(idsIn(text, true));
    if (!loose.length) return [];
    return pickRule(uniq(idsIn(text)), loose);
  }

  const CHUNK = 4000;

  function breathe() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  async function columnsOf(cells, loose, onScan) {
    const byColumn = new Map();
    for (let at = 0; at < cells.length; at += 1) {
      const cell = cells[at];
      const ids = idsIn(cell.value, loose);
      if (ids.length) {
        let bucket = byColumn.get(cell.key);
        if (!bucket) {
          bucket = [];
          byColumn.set(cell.key, bucket);
        }
        for (const id of ids) bucket.push(id);
      }
      if ((at + 1) % CHUNK) continue;
      if (onScan) onScan((at + 1) / cells.length);
      await breathe();
    }
    return byColumn;
  }

  const HEAD_RE = /отправлен|posting|^\s*id\s*$|\bid\b|номер\s+заказа/i;
  const POSTING_LENGTH = 14;

  function longShare(ids) {
    if (!ids.length) return 0;
    let long = 0;
    for (const id of ids) if (id.length >= POSTING_LENGTH) long += 1;
    return long / ids.length;
  }

  function bestColumn(byColumn, heads) {
    const named = [...byColumn.keys()].filter((key) => HEAD_RE.test(heads?.get(key) || ""));
    const pool = named.length ? named : [...byColumn.keys()];
    const rank = (key) => [Math.round(longShare(byColumn.get(key)) * 10), byColumn.get(key).length];
    pool.sort((a, b) => {
      const left = rank(a);
      const right = rank(b);
      return right[0] - left[0] || right[1] - left[1];
    });
    const key = pool[0];
    return key == null ? null : { key, ids: byColumn.get(key) };
  }

  function headsOf(cells) {
    const heads = new Map();
    let top = Infinity;
    for (const cell of cells) {
      if (cell.row == null) continue;
      if (cell.row < top) {
        top = cell.row;
        heads.clear();
      }
      if (cell.row === top && !heads.has(cell.key)) heads.set(cell.key, cell.value);
    }
    return heads;
  }

  async function idsFromCells(cells, onScan) {
    const say = onScan || (() => {});
    const loose = await columnsOf(cells, true, (share) => say(share / 2));
    if (!loose.size) return { ids: [], columns: 0 };

    const pick = bestColumn(loose, headsOf(cells));
    say(0.5, pick.ids.length);
    const tight = await columnsOf(cells, false, (share) => say(0.5 + share / 2, pick.ids.length));
    const strict = tight.get(pick.key) || [];
    return { ids: uniq(pickRule(strict, pick.ids)), columns: loose.size, column: pick.key };
  }

  const SIG_ZIP = 0x04034b50;
  const SIG_OLE = [0xd0, 0xcf, 0x11, 0xe0];

  function isOle(bytes) {
    return SIG_OLE.every((byte, i) => bytes[i] === byte);
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function unzip(buffer, wanted, onScan) {
    const view = new DataView(buffer);
    const bytes = new Uint8Array(buffer);
    const names = new TextDecoder("utf-8");
    const out = new Map();

    let at = 0;
    while (at + 30 <= bytes.length && view.getUint32(at, true) === SIG_ZIP) {
      const flags = view.getUint16(at + 6, true);
      const method = view.getUint16(at + 8, true);
      const compressed = view.getUint32(at + 18, true);
      const uncompressed = view.getUint32(at + 22, true);
      const nameLength = view.getUint16(at + 26, true);
      const extraLength = view.getUint16(at + 28, true);
      const name = names.decode(bytes.subarray(at + 30, at + 30 + nameLength));
      const dataAt = at + 30 + nameLength + extraLength;

      if ((flags & 0x08) !== 0 && compressed === 0) break;

      if (wanted(name)) {
        const chunk = bytes.subarray(dataAt, dataAt + compressed);
        try {
          const raw = method === 0 ? chunk : await inflateRaw(chunk);
          out.set(name, new TextDecoder("utf-8").decode(raw));
        } catch (_err) {
        }
      }

      at = dataAt + compressed;
      if (onScan) onScan(Math.min(1, at / bytes.length));
      if (compressed === 0 && uncompressed === 0 && !name.endsWith("/")) break;
    }
    return out;
  }

  function wantedEntry(name) {
    return name === "xl/sharedStrings.xml" || /^xl\/worksheets\/sheet[0-9]+\.xml$/.test(name);
  }

  function parseXml(text) {
    const doc = new DOMParser().parseFromString(text, "application/xml");
    return doc.querySelector("parsererror") ? null : doc;
  }

  function sharedStrings(text) {
    const doc = text ? parseXml(text) : null;
    if (!doc) return [];
    return [...doc.getElementsByTagName("si")].map((si) =>
      [...si.getElementsByTagName("t")].map((t) => t.textContent).join("")
    );
  }

  const CELL_RE = /^([A-Z]+)(\d+)$/;

  async function sheetCells(text, shared, onScan) {
    const doc = parseXml(text);
    if (!doc) return [];
    const out = [];
    const all = doc.getElementsByTagName("c");
    const total = all.length;
    for (let at = 0; at < total; at += 1) {
      const cell = all[at];
      const ref = cell.getAttribute("r") || "";
      const spot = ref.match(CELL_RE);
      const key = spot ? spot[1] : "?";
      const row = spot ? Number(spot[2]) : null;
      const type = cell.getAttribute("t");
      let value = "";
      if (type === "s") {
        const at = Number(cell.getElementsByTagName("v")[0]?.textContent);
        value = Number.isFinite(at) ? shared[at] || "" : "";
      } else if (type === "inlineStr") {
        value = [...cell.getElementsByTagName("t")].map((t) => t.textContent).join("");
      } else {
        value = cell.getElementsByTagName("v")[0]?.textContent || "";
      }
      if (value) out.push({ key, value, row });
      if ((at + 1) % CHUNK) continue;
      if (onScan) onScan((at + 1) / total);
      await breathe();
    }
    return out;
  }

  async function readXlsx(buffer, step) {
    const parts = await unzip(buffer, wantedEntry, (share) => step(0.08 + share * 0.22, "распаковываю"));
    if (!parts.size) return { ids: [], columns: 0 };

    const shared = sharedStrings(parts.get("xl/sharedStrings.xml"));
    const sheets = [...parts].filter(([name]) => name !== "xl/sharedStrings.xml");
    const cells = [];
    for (let at = 0; at < sheets.length; at += 1) {
      const from = 0.3 + (at / sheets.length) * 0.45;
      const span = 0.45 / sheets.length;
      step(from, "разбираю лист");
      await breathe();
      const part = await sheetCells(sheets[at][1], shared, (share) => step(from + share * span, "разбираю лист"));
      for (const cell of part) cells.push(cell);
    }
    if (cells.length) return idsFromCells(cells, (share, found) => step(0.75 + share * 0.25, "ищу номера", found));

    return { ids: extractIds([...parts.values()].join(" ").replace(/></g, "> <")), columns: 0 };
  }

  const HAR_HEAD_RE = /^\s*\{[\s\S]{0,400}?"log"\s*:/;
  const MAX_BODY = 4000000;

  function harvestIds(node, path, cells, depth) {
    if (node == null || depth > 8) return;
    if (Array.isArray(node)) {
      for (const item of node) harvestIds(item, path, cells, depth + 1);
      return;
    }
    if (typeof node === "object") {
      for (const key of Object.keys(node)) {
        harvestIds(node[key], path ? `${path}.${key}` : key, cells, depth + 1);
      }
      return;
    }
    if (typeof node === "boolean") return;
    const text = String(node);
    if (text.length < 10 || text.length > 40) return;
    for (const id of idsIn(text, true)) cells.push({ key: path || "?", value: id });
  }

  const ARTICLE_URL_RE = /\/articles\/(\d{10,})(?:[/?]|$)/g;
  const OWNER_WORDS = ["posting", "box", "отправление"];

  function pathWords(path) {
    return String(path)
      .replace(/([a-zа-яё])([A-ZА-ЯЁ])/g, "$1 $2")
      .split(/[^A-Za-zА-Яа-яЁё]+/)
      .filter(Boolean)
      .map((word) => word.toLowerCase());
  }

  function ownedWords(words) {
    return words.some((word) => OWNER_WORDS.some((owner) => word.startsWith(owner)));
  }

  function looksLikePostingPath(path) {
    const parts = String(path).split(".").filter(Boolean);
    if (!parts.length) return false;
    const last = pathWords(parts[parts.length - 1]);
    if (last[last.length - 1] !== "id") return false;
    if (last.length > 1) return ownedWords(last.slice(0, -1));
    return parts.length > 1 && ownedWords(pathWords(parts[parts.length - 2]));
  }

  function harvestBody(text, cells) {
    if (typeof text !== "string" || text.length < 2 || text.length > MAX_BODY) return;
    const head = text.trimStart()[0];
    if (head !== "{" && head !== "[") return;
    try {
      harvestIds(JSON.parse(text), "", cells, 0);
    } catch (_err) {
    }
  }

  async function readHar(text, step) {
    let har;
    try {
      har = JSON.parse(text);
    } catch (_err) {
      return null;
    }
    const entries = har?.log?.entries;
    if (!Array.isArray(entries)) return null;

    const cells = [];
    for (let at = 0; at < entries.length; at += 1) {
      const entry = entries[at];
      const url = String(entry?.request?.url || "");
      for (const match of url.matchAll(ARTICLE_URL_RE)) cells.push({ key: "postingId", value: match[1] });
      harvestBody(entry?.request?.postData?.text, cells);
      harvestBody(entry?.response?.content?.text, cells);
      if ((at + 1) % 25) continue;
      step(0.1 + ((at + 1) / entries.length) * 0.6, "разбираю запросы");
      await breathe();
    }
    if (!cells.length) return { ids: [], columns: 0 };

    const mine = cells.filter((cell) => looksLikePostingPath(cell.key));
    if (mine.length) {
      const paths = [...new Set(mine.map((cell) => cell.key))];
      step(0.95, "ищу номера", new Set(mine.map((cell) => cell.value)).size);
      return { ids: uniq(mine.map((cell) => cell.value)), columns: paths.length, column: paths.join(", ") };
    }
    return idsFromCells(cells, (share, found) => step(0.7 + share * 0.3, "ищу номера", found));
  }

  const BOM_RE = /^﻿/;
  const SPLIT_RE = /[\t;,]/;

  async function readDelimited(text, step) {
    const say = step || (() => {});
    const lines = String(text || "").split(/\r?\n/);
    const cells = [];
    let split = false;
    for (let at = 0; at < lines.length; at += 1) {
      const line = lines[at];
      if (line.trim()) {
        if (SPLIT_RE.test(line)) {
          split = true;
          line.split(SPLIT_RE).forEach((part, index) => cells.push({ key: `c${index}`, value: part, row: at }));
        } else {
          cells.push({ key: "c0", value: line, row: at });
        }
      }
      if ((at + 1) % CHUNK) continue;
      say(0.1 + ((at + 1) / lines.length) * 0.5, "разбираю строки");
      await breathe();
    }
    if (!split) return { ids: extractIds(text), columns: 0 };
    return idsFromCells(cells, (share, found) => say(0.6 + share * 0.4, "ищу номера", found));
  }

  async function readIdsFromFile(file, onStep) {
    const step = (share, label, found) => {
      if (typeof onStep === "function") onStep(Math.max(0, Math.min(1, share)), label, found);
    };

    step(0, "читаю файл");
    const buffer = await file.arrayBuffer();
    step(0.08, "читаю файл");
    const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));

    if (isOle(head)) {
      return { ids: [], text: "", error: "Старый формат .xls. Сохраните как .xlsx или .csv." };
    }

    const view = new DataView(buffer);
    if (buffer.byteLength >= 4 && view.getUint32(0, true) === SIG_ZIP) {
      const found = await readXlsx(buffer, step);
      step(1, "готово");
      return { ids: found.ids, columns: found.columns, column: found.column, text: "", kind: "xlsx" };
    }

    const text = new TextDecoder("utf-8").decode(buffer).replace(BOM_RE, "");

    if (HAR_HEAD_RE.test(text)) {
      step(0.1, "читаю запись обмена");
      const har = await readHar(text, step);
      if (har) {
        step(1, "готово");
        return { ids: har.ids, columns: har.columns, column: har.column, text: "", kind: "har" };
      }
    }

    step(0.1, "разбираю строки");
    const found = await readDelimited(text, step);
    step(1, "готово");
    return { ids: found.ids, columns: found.columns, column: found.column, text, kind: "text" };
  }

  globalThis.sheetReader = {
    readIdsFromFile,
    extractIds,
    idsIn,
    looksLikeId,
    looksLikeNumber,
    readDelimited
  };
})();
