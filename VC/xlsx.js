/*
 * Hub Trace · сборка .xlsx без внешних библиотек.
 *
 * Почему не CSV: в CSV ссылку можно задать только формулой
 * =HYPERLINK("...";"..."), а Excel при импорте текста разбирает имена
 * функций на языке интерфейса — в русском Excel такая ячейка станет #ИМЯ?.
 * В xlsx ссылка живёт в отношениях листа и открывается в любой локали.
 */
(() => {
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  /* Пакуем без сжатия: файл небольшой, а deflate тянуть неоткуда. */
  function zipStore(entries, mimeType) {
    const encoder = new TextEncoder();
    const parts = [];
    const central = [];
    let offset = 0;

    const now = new Date();
    const dosTime = ((now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1)) & 0xffff;
    const dosDate = (((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate()) & 0xffff;

    for (const entry of entries) {
      const name = encoder.encode(entry.name);
      const data = entry.data;
      const crc = crc32(data);

      const header = new Uint8Array(30 + name.length);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x04034b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 0, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, dosTime, true);
      view.setUint16(12, dosDate, true);
      view.setUint32(14, crc, true);
      view.setUint32(18, data.length, true);
      view.setUint32(22, data.length, true);
      view.setUint16(26, name.length, true);
      view.setUint16(28, 0, true);
      header.set(name, 30);

      parts.push(header, data);
      central.push({ name, crc, size: data.length, offset });
      offset += header.length + data.length;
    }

    const directory = [];
    let directorySize = 0;
    for (const entry of central) {
      const header = new Uint8Array(46 + entry.name.length);
      const view = new DataView(header.buffer);
      view.setUint32(0, 0x02014b50, true);
      view.setUint16(4, 20, true);
      view.setUint16(6, 20, true);
      view.setUint16(8, 0, true);
      view.setUint16(10, 0, true);
      view.setUint16(12, dosTime, true);
      view.setUint16(14, dosDate, true);
      view.setUint32(16, entry.crc, true);
      view.setUint32(20, entry.size, true);
      view.setUint32(24, entry.size, true);
      view.setUint16(28, entry.name.length, true);
      view.setUint32(42, entry.offset, true);
      header.set(entry.name, 46);
      directory.push(header);
      directorySize += header.length;
    }

    const end = new Uint8Array(22);
    const endView = new DataView(end.buffer);
    endView.setUint32(0, 0x06054b50, true);
    endView.setUint16(8, central.length, true);
    endView.setUint16(10, central.length, true);
    endView.setUint32(12, directorySize, true);
    endView.setUint32(16, offset, true);

    return new Blob([...parts, ...directory, end], { type: mimeType });
  }

  const CONTROL_CHARS = new RegExp("[\\u0000-\\u0008\\u000B\\u000C\\u000E-\\u001F]", "g");

  function esc(value) {
    return String(value == null ? "" : value)
      .replace(CONTROL_CHARS, "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function columnName(index) {
    let name = "";
    let n = index + 1;
    while (n > 0) {
      const rest = (n - 1) % 26;
      name = String.fromCharCode(65 + rest) + name;
      n = Math.floor((n - 1) / 26);
    }
    return name;
  }

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships";

  /*
   * rows  — массив строк, строка — массив ячеек.
   * Ячейка: строка/число либо { text, link, number }.
   * Первая строка считается шапкой.
   */
  function buildXlsxBlob({ sheetName = "Лист1", columns = [], rows = [] }) {
    const encoder = new TextEncoder();
    const links = [];
    const body = [];

    rows.forEach((row, rowIndex) => {
      const cells = [];
      row.forEach((raw, colIndex) => {
        const cell = raw && typeof raw === "object" ? raw : { text: raw };
        const ref = `${columnName(colIndex)}${rowIndex + 1}`;
        let style = 0;
        if (rowIndex === 0) style = 1;
        else if (cell.link) style = 2;

        if (cell.link && rowIndex > 0) links.push({ ref, target: cell.link });

        if (cell.number != null && Number.isFinite(cell.number)) {
          cells.push(`<c r="${ref}" s="${style}"><v>${cell.number}</v></c>`);
        } else {
          cells.push(
            `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.text)}</t></is></c>`
          );
        }
      });
      body.push(`<row r="${rowIndex + 1}">${cells.join("")}</row>`);
    });

    const width = columns.length || (rows[0] || []).length;
    const lastCol = columnName(Math.max(0, width - 1));
    const dimension = `A1:${lastCol}${Math.max(1, rows.length)}`;

    const colDefs = columns.length
      ? `<cols>${columns
          .map((col, i) => `<col min="${i + 1}" max="${i + 1}" width="${col.width || 16}" customWidth="1"/>`)
          .join("")}</cols>`
      : "";

    const hyperlinks = links.length
      ? `<hyperlinks>${links.map((link, i) => `<hyperlink ref="${link.ref}" r:id="rIdL${i + 1}"/>`).join("")}</hyperlinks>`
      : "";

    /* Порядок элементов внутри worksheet задан схемой: sheetData,
       затем autoFilter, и только потом hyperlinks. */
    const sheet =
      `${XML_HEAD}<worksheet xmlns="${NS}" xmlns:r="${NS_R}">` +
      `<dimension ref="${dimension}"/>` +
      `<sheetViews><sheetView workbookViewId="0">` +
      `<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>` +
      `</sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>` +
      colDefs +
      `<sheetData>${body.join("")}</sheetData>` +
      (rows.length > 1 ? `<autoFilter ref="A1:${lastCol}${rows.length}"/>` : "") +
      hyperlinks +
      `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
      `</worksheet>`;

    const sheetRels =
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}">` +
      links
        .map(
          (link, i) =>
            `<Relationship Id="rIdL${i + 1}" Type="${NS_R}/hyperlink" Target="${esc(link.target)}" TargetMode="External"/>`
        )
        .join("") +
      `</Relationships>`;

    const styles =
      `${XML_HEAD}<styleSheet xmlns="${NS}">` +
      `<fonts count="3">` +
      `<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>` +
      `<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>` +
      `<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>` +
      `</fonts>` +
      `<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="3">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
      `<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
      `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
      `</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`;

    const workbook =
      `${XML_HEAD}<workbook xmlns="${NS}" xmlns:r="${NS_R}">` +
      `<sheets><sheet name="${esc(sheetName).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets>` +
      `</workbook>`;

    const workbookRels =
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}">` +
      `<Relationship Id="rId1" Type="${NS_R}/worksheet" Target="worksheets/sheet1.xml"/>` +
      `<Relationship Id="rId2" Type="${NS_R}/styles" Target="styles.xml"/>` +
      `</Relationships>`;

    const rootRels =
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}">` +
      `<Relationship Id="rId1" Type="${NS_R}/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`;

    const contentTypes =
      `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`;

    const files = [
      { name: "[Content_Types].xml", data: encoder.encode(contentTypes) },
      { name: "_rels/.rels", data: encoder.encode(rootRels) },
      { name: "xl/workbook.xml", data: encoder.encode(workbook) },
      { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRels) },
      { name: "xl/styles.xml", data: encoder.encode(styles) },
      { name: "xl/worksheets/sheet1.xml", data: encoder.encode(sheet) }
    ];
    if (links.length) {
      files.push({ name: "xl/worksheets/_rels/sheet1.xml.rels", data: encoder.encode(sheetRels) });
    }

    return zipStore(files, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  globalThis.buildXlsxBlob = buildXlsxBlob;
})();
