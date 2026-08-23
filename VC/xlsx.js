// Пишем .xlsx сами, без библиотек. CSV не годится: ссылка там только через =HYPERLINK,
// а Excel разбирает имя функции по локали и выдаёт #ИМЯ?.
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

  // без сжатия: файл мелкий, а deflate тянуть неоткуда
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

  // Excel не пускает в имя листа : \ / ? * [ ] и режет до 31 символа
  function sheetTitle(name, index) {
    const clean = String(name || `Лист${index + 1}`).replace(/[\\/?*[\]:]/g, " ").trim();
    return (clean || `Лист${index + 1}`).slice(0, 31);
  }

  const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
  const NS = "http://schemas.openxmlformats.org/spreadsheetml/2006/main";
  const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
  const NS_PKG = "http://schemas.openxmlformats.org/package/2006/relationships";

  // 0 обычный, 1 шапка, 2 ссылка, 3 подзаголовок, 4 приглушённый,
  // 5 переход «смотреть», 6 переход «к отчёту»
  const STYLE_PLAIN = 0;
  const STYLE_HEAD = 1;
  const STYLE_LINK = 2;
  const STYLE_TITLE = 3;
  const STYLE_MUTED = 4;
  const STYLE_JUMP = 5;
  const STYLE_BACK = 6;

  function buildSheetXml(sheet) {
    const links = [];
    const body = [];
    const rows = sheet.rows || [];

    rows.forEach((row, rowIndex) => {
      const cells = [];
      (row || []).forEach((raw, colIndex) => {
        const cell = raw && typeof raw === "object" ? raw : { text: raw };
        if (cell.text == null && cell.number == null && !cell.link && !cell.anchor) return;

        const ref = `${columnName(colIndex)}${rowIndex + 1}`;
        let style = cell.style != null ? cell.style : STYLE_PLAIN;
        if (cell.style == null) {
          if (sheet.headRow === rowIndex) style = STYLE_HEAD;
          else if (cell.link || cell.anchor) style = STYLE_LINK;
        }

        if (cell.link) links.push({ ref, target: cell.link });
        else if (cell.anchor) links.push({ ref, anchor: cell.anchor });

        if (cell.number != null && Number.isFinite(cell.number)) {
          cells.push(`<c r="${ref}" s="${style}"><v>${cell.number}</v></c>`);
        } else {
          cells.push(
            `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(cell.text)}</t></is></c>`
          );
        }
      });
      if (cells.length) body.push(`<row r="${rowIndex + 1}">${cells.join("")}</row>`);
    });

    const width = Math.max(
      (sheet.columns || []).length,
      ...rows.map((row) => (row || []).length),
      1
    );
    const lastCol = columnName(width - 1);
    const lastRow = Math.max(1, rows.length);

    const colDefs = (sheet.columns || []).length
      ? `<cols>${sheet.columns
          .map((col, i) => `<col min="${i + 1}" max="${i + 1}" width="${col.width || 16}" customWidth="1"/>`)
          .join("")}</cols>`
      : "";

    const external = links.filter((link) => link.target);
    const hyperlinks = links.length
      ? `<hyperlinks>${links
          .map((link) =>
            link.target
              ? `<hyperlink ref="${link.ref}" r:id="rIdL${external.indexOf(link) + 1}"/>`
              : `<hyperlink ref="${link.ref}" location="${esc(link.anchor)}"/>`
          )
          .join("")}</hyperlinks>`
      : "";

    const freeze = sheet.freeze
      ? `<pane ySplit="${sheet.freeze}" topLeftCell="A${sheet.freeze + 1}" activePane="bottomLeft" state="frozen"/>`
      : "";

    const filter = sheet.autoFilter && rows.length > 1 ? `<autoFilter ref="A1:${lastCol}${lastRow}"/>` : "";

    const xml =
      `${XML_HEAD}<worksheet xmlns="${NS}" xmlns:r="${NS_R}">` +
      `<dimension ref="A1:${lastCol}${lastRow}"/>` +
      `<sheetViews><sheetView workbookViewId="0">${freeze}</sheetView></sheetViews>` +
      `<sheetFormatPr defaultRowHeight="15"/>` +
      colDefs +
      `<sheetData>${body.join("")}</sheetData>` +
      filter +
      hyperlinks +
      `<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>` +
      `</worksheet>`;

    const rels = external.length
      ? `${XML_HEAD}<Relationships xmlns="${NS_PKG}">` +
        external
          .map(
            (link, i) =>
              `<Relationship Id="rIdL${i + 1}" Type="${NS_R}/hyperlink" Target="${esc(link.target)}" TargetMode="External"/>`
          )
          .join("") +
        `</Relationships>`
      : "";

    return { xml, rels };
  }

  // { sheets: [{ name, columns, rows, headRow, freeze, autoFilter }] }
  // ячейка — строка/число либо { text, number, link, anchor, style }
  function buildXlsxBlob(input) {
    const encoder = new TextEncoder();
    const sheets = (input && input.sheets ? input.sheets : [input || {}]).map((sheet, index) => ({
      headRow: 0,
      freeze: 1,
      autoFilter: false,
      ...sheet,
      name: sheetTitle(sheet.name || sheet.sheetName, index)
    }));

    const files = [];
    const parts = sheets.map((sheet) => buildSheetXml(sheet));

    parts.forEach((part, index) => {
      files.push({ name: `xl/worksheets/sheet${index + 1}.xml`, data: encoder.encode(part.xml) });
      if (part.rels) {
        files.push({
          name: `xl/worksheets/_rels/sheet${index + 1}.xml.rels`,
          data: encoder.encode(part.rels)
        });
      }
    });

    const styles =
      `${XML_HEAD}<styleSheet xmlns="${NS}">` +
      `<fonts count="6">` +
      `<font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>` +
      `<font><b/><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>` +
      `<font><u/><sz val="11"/><color rgb="FF0563C1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>` +
      `<font><b/><sz val="12"/><color rgb="FF1F3864"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>` +
      `<font><sz val="10"/><color rgb="FF808080"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>` +
      `<font><b/><u/><sz val="14"/><color rgb="FF0563C1"/><name val="Calibri"/><family val="2"/><scheme val="minor"/></font>` +
      `</fonts>` +
      `<fills count="3">` +
      `<fill><patternFill patternType="none"/></fill>` +
      `<fill><patternFill patternType="gray125"/></fill>` +
      `<fill><patternFill patternType="solid"><fgColor rgb="FFDCE6F1"/><bgColor indexed="64"/></patternFill></fill>` +
      `</fills>` +
      `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
      `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
      `<cellXfs count="7">` +
      `<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>` +
      `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>` +
      `<xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
      `<xf numFmtId="0" fontId="3" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
      `<xf numFmtId="0" fontId="4" fillId="0" borderId="0" xfId="0" applyFont="1"/>` +
      `<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">` +
      `<alignment horizontal="center" vertical="center"/></xf>` +
      `<xf numFmtId="0" fontId="5" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1">` +
      `<alignment horizontal="left" vertical="center"/></xf>` +
      `</cellXfs>` +
      `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
      `</styleSheet>`;

    const workbook =
      `${XML_HEAD}<workbook xmlns="${NS}" xmlns:r="${NS_R}"><sheets>` +
      sheets
        .map((sheet, i) => `<sheet name="${esc(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("") +
      `</sheets></workbook>`;

    const workbookRels =
      `${XML_HEAD}<Relationships xmlns="${NS_PKG}">` +
      sheets
        .map((sheet, i) => `<Relationship Id="rId${i + 1}" Type="${NS_R}/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("") +
      `<Relationship Id="rIdStyles" Type="${NS_R}/styles" Target="styles.xml"/>` +
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
      sheets
        .map(
          (sheet, i) =>
            `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
        )
        .join("") +
      `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
      `</Types>`;

    files.unshift(
      { name: "[Content_Types].xml", data: encoder.encode(contentTypes) },
      { name: "_rels/.rels", data: encoder.encode(rootRels) },
      { name: "xl/workbook.xml", data: encoder.encode(workbook) },
      { name: "xl/_rels/workbook.xml.rels", data: encoder.encode(workbookRels) },
      { name: "xl/styles.xml", data: encoder.encode(styles) }
    );

    return zipStore(files, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  }

  globalThis.buildXlsxBlob = buildXlsxBlob;
  globalThis.xlsxStyles = {
    STYLE_PLAIN,
    STYLE_HEAD,
    STYLE_LINK,
    STYLE_TITLE,
    STYLE_MUTED,
    STYLE_JUMP,
    STYLE_BACK
  };
  globalThis.xlsxSheetTitle = sheetTitle;
})();
