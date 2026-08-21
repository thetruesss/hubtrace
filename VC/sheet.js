/*
 * Чтение списка ID из файла.
 *
 * Раньше файл просто вываливался в поле как есть: из .xlsx туда попадал
 * бинарный мусор, а из выгрузки Excel — все колонки со знаками табуляции,
 * и в работу шёл первый столбец, который далеко не всегда ID.
 *
 * Теперь из файла достаются только ID. Признак ID у Hub жёсткий: подряд
 * идущие цифры, десять и больше, последние три — нули (501895529761000).
 * Сначала ищем столбец, в котором таких значений больше всего, и берём
 * только его — иначе к отправлениям примешались бы ID контейнеров и ячеек
 * из соседних колонок. Столбцов не видно (обычный текст без разделителей) —
 * собираем всё, что подходит под признак.
 */
(function () {
  "use strict";

  /* Десять и больше цифр подряд. Границы обязательны: иначе из
     «1501895529761000» вырезался бы кусок нужной длины. */
  const ID_RE = /(?<![0-9])[0-9]{10,}(?![0-9])/g;

  function looksLikeId(value) {
    return /^[0-9]{10,}$/.test(value) && value.endsWith("000");
  }

  /* ID внутри произвольного текста: «Lozon:501895529761000», ссылка на Hub,
     значение с пробелами-разрядами Excel уже развёрнуто в цифры. */
  function idsIn(text) {
    const out = [];
    for (const match of String(text == null ? "" : text).matchAll(ID_RE)) {
      if (looksLikeId(match[0])) out.push(match[0]);
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

  function extractIds(text) {
    return uniq(idsIn(text));
  }

  /*
   * Из ячеек вида {key: "B", value: "…"} выбираем столбец с наибольшим
   * числом ID и отдаём только его. При равенстве побеждает тот, что
   * встретился раньше — обычно это и есть колонка отправлений.
   */
  function idsFromCells(cells) {
    const byColumn = new Map();
    for (const cell of cells) {
      const ids = idsIn(cell.value);
      if (!ids.length) continue;
      if (!byColumn.has(cell.key)) byColumn.set(cell.key, []);
      byColumn.get(cell.key).push(...ids);
    }
    if (!byColumn.size) return { ids: [], columns: 0 };

    let best = null;
    for (const [key, ids] of byColumn) {
      if (!best || ids.length > best.ids.length) best = { key, ids };
    }
    return { ids: uniq(best.ids), columns: byColumn.size, column: best.key };
  }

  /* ------------------------------------------------------------------ */
  /* распаковка xlsx                                                     */
  /* ------------------------------------------------------------------ */

  const SIG_ZIP = 0x04034b50;
  /* Старый .xls — это OLE2, а не zip: его так не прочитать. */
  const SIG_OLE = [0xd0, 0xcf, 0x11, 0xe0];

  function isOle(bytes) {
    return SIG_OLE.every((byte, i) => bytes[i] === byte);
  }

  async function inflateRaw(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /*
   * Читаем локальные заголовки записей подряд от начала файла. Центральный
   * каталог для нашей задачи не нужен: имена и данные есть и здесь, а
   * пропустить запись всегда можно по её же compressedSize.
   */
  async function unzip(buffer, wanted) {
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

      /* Размеры уехали в дескриптор после данных — такую запись без
         центрального каталога не пройти, дальше идти нельзя. */
      if ((flags & 0x08) !== 0 && compressed === 0) break;

      if (wanted(name)) {
        const chunk = bytes.subarray(dataAt, dataAt + compressed);
        try {
          const raw = method === 0 ? chunk : await inflateRaw(chunk);
          out.set(name, new TextDecoder("utf-8").decode(raw));
        } catch (_err) {
          /* повреждённую запись пропускаем: остальные ещё могут прочитаться */
        }
      }

      at = dataAt + compressed;
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
    /* Внутри <si> может быть несколько кусков <t> (форматированный текст). */
    return [...doc.getElementsByTagName("si")].map((si) =>
      [...si.getElementsByTagName("t")].map((t) => t.textContent).join("")
    );
  }

  const COLUMN_RE = /^([A-Z]+)/;

  function sheetCells(text, shared) {
    const doc = parseXml(text);
    if (!doc) return [];
    const out = [];
    for (const cell of doc.getElementsByTagName("c")) {
      const ref = cell.getAttribute("r") || "";
      const key = (ref.match(COLUMN_RE) || ["?"])[0];
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
      if (value) out.push({ key, value });
    }
    return out;
  }

  async function readXlsx(buffer) {
    const parts = await unzip(buffer, wantedEntry);
    if (!parts.size) return { ids: [], columns: 0 };

    const shared = sharedStrings(parts.get("xl/sharedStrings.xml"));
    const cells = [];
    for (const [name, text] of parts) {
      if (name === "xl/sharedStrings.xml") continue;
      cells.push(...sheetCells(text, shared));
    }
    if (cells.length) return idsFromCells(cells);

    /* Разобрать разметку не вышло — ищем ID прямо в тексте частей. Пробелы
       между тегами не дают соседним числам склеиться в одно длинное. */
    return { ids: extractIds([...parts.values()].join(" ").replace(/></g, "> <")), columns: 0 };
  }

  /* ------------------------------------------------------------------ */
  /* текстовые файлы                                                     */
  /* ------------------------------------------------------------------ */

  const SPLIT_RE = /[\t;,]/;

  function readDelimited(text) {
    const lines = String(text || "").split(/\r?\n/);
    const cells = [];
    let split = false;
    for (const line of lines) {
      if (!line.trim()) continue;
      if (SPLIT_RE.test(line)) {
        split = true;
        line.split(SPLIT_RE).forEach((part, index) => cells.push({ key: `c${index}`, value: part }));
      } else {
        cells.push({ key: "c0", value: line });
      }
    }
    /* Разделителей не было — это просто список, столбец выбирать не из чего. */
    if (!split) return { ids: extractIds(text), columns: 0 };
    return idsFromCells(cells);
  }

  /* ------------------------------------------------------------------ */

  async function readIdsFromFile(file) {
    const buffer = await file.arrayBuffer();
    const head = new Uint8Array(buffer, 0, Math.min(8, buffer.byteLength));

    if (isOle(head)) {
      return { ids: [], text: "", error: "Старый формат .xls. Сохраните как .xlsx или .csv." };
    }

    const view = new DataView(buffer);
    if (buffer.byteLength >= 4 && view.getUint32(0, true) === SIG_ZIP) {
      const found = await readXlsx(buffer);
      return { ids: found.ids, columns: found.columns, column: found.column, text: "", kind: "xlsx" };
    }

    /* Текстовый файл: кодировка неважна — ID состоят из цифр, а они
       одинаковы и в utf-8, и в windows-1251. */
    const text = new TextDecoder("utf-8").decode(buffer).replace(/^﻿/, "");
    const found = readDelimited(text);
    return { ids: found.ids, columns: found.columns, column: found.column, text, kind: "text" };
  }

  globalThis.sheetReader = { readIdsFromFile, extractIds, idsIn, looksLikeId, readDelimited };
})();
