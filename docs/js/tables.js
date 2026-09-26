/* tables.js — read a digital PDF's text layer and lay it out as a grid, then
   write that grid as CSV or a spreadsheet (.xlsx). No pixels: this reads the
   text a PDF already carries, so a scanned photo (no text layer) comes back
   empty — that page needs OCR, which is not here yet. */
(function (root) {
  'use strict';

  var LIB = 'js/vendor/pdfjs/pdf.min.js';
  var WORKER = 'js/vendor/pdfjs/pdf.worker.min.js';
  var libPromise = null;

  /* Load Mozilla's pdf.js the first time it is asked for, not at start-up. */
  function ensureLib() {
    if (root.pdfjsLib) return Promise.resolve(setWorker(root.pdfjsLib));
    if (libPromise) return libPromise;
    libPromise = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = LIB;
      s.onload = function () {
        if (root.pdfjsLib) res(setWorker(root.pdfjsLib));
        else rej(new Error('pdf.js did not load'));
      };
      s.onerror = function () { libPromise = null; rej(new Error('pdf.js did not load')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  function setWorker(lib) {
    try { lib.GlobalWorkerOptions.workerSrc = WORKER; } catch (e) { }
    return lib;
  }

  // ---------------------------------------------------------------- extract

  /* pdf.js text items -> {str, left, right, y, h}, dropping whitespace-only
     runs. y is the baseline (PDF space, up is positive). */
  function mapItems(list) {
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      if (!it.str || !it.str.replace(/\s/g, '')) continue;
      var tr = it.transform || [1, 0, 0, 1, 0, 0];
      var h = it.height || Math.abs(tr[3]) || 10;
      var w = it.width || it.str.length * h * 0.5;
      out.push({ str: it.str.replace(/\s+/g, ' ').trim(), left: tr[4], right: tr[4] + w, y: tr[5], h: h });
    }
    return out;
  }

  function median(nums) {
    if (!nums.length) return 0;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    return s[s.length >> 1];
  }

  /* items -> array of rows, each row an array of cell strings. Rows come from
     clustering the baseline y; columns from clustering where cells start across
     the whole page, so a column lines up even when a row leaves it blank. */
  function buildGrid(items) {
    if (!items.length) return [];
    var mh = median(items.map(function (i) { return i.h; })) || 10;

    // rows, top to bottom
    items.sort(function (a, b) { return (b.y - a.y) || (a.left - b.left); });
    var rowTol = Math.max(2, mh * 0.5);
    var rows = [], cur = null;
    items.forEach(function (it) {
      if (cur && Math.abs(cur.y - it.y) <= rowTol) cur.items.push(it);
      else { cur = { y: it.y, items: [it] }; rows.push(cur); }
    });

    // each row -> cells (a wide horizontal gap ends a cell)
    var gapCell = mh * 0.9, spaceGap = mh * 0.18;
    var rowsCells = rows.map(function (row) {
      var its = row.items.sort(function (a, b) { return a.left - b.left; });
      var cells = [], c = null;
      its.forEach(function (it) {
        if (c && it.left - c.right <= gapCell) {
          c.text += (it.left - c.right > spaceGap ? ' ' : '') + it.str;
          c.right = Math.max(c.right, it.right);
        } else {
          c = { left: it.left, right: it.right, text: it.str };
          cells.push(c);
        }
      });
      return cells;
    });

    // columns from vertical whitespace: an x is "occupied" when at least a
    // couple of rows have text there, so a gutter between columns survives a
    // one-line title spanning it, and right-aligned numbers (whose left edges
    // wander) still land in one column. Cells are placed by centre, not edge.
    var allCells = [];
    rowsCells.forEach(function (cells) { cells.forEach(function (c) { allCells.push(c); }); });
    var centres = columnCentres(allCells, mh, rowsCells.length);

    // fall back to one column when no vertical structure shows (prose, a form)
    if (centres.length < 2) {
      var flat = rowsCells.map(function (cells) {
        return [cells.map(function (c) { return c.text; }).join(' ')];
      });
      return trim(flat);
    }

    function nearest(x) {
      var best = 0, bd = Infinity;
      for (var i = 0; i < centres.length; i++) {
        var d = Math.abs(x - centres[i]);
        if (d < bd) { bd = d; best = i; }
      }
      return best;
    }
    var grid = rowsCells.map(function (cells) {
      var arr = [];
      for (var i = 0; i < centres.length; i++) arr.push('');
      cells.forEach(function (c) {
        var j = nearest((c.left + c.right) / 2);
        arr[j] = arr[j] ? arr[j] + ' ' + c.text : c.text;
      });
      return arr;
    });

    return trim(grid);
  }

  /* Sweep the cell edges; between two edges, count how many cells cover the
     midpoint. Runs where that count clears a small floor are columns; the rest
     is gutter. Returns the centre x of each column band. */
  function columnCentres(cells, mh, nRows) {
    if (!cells.length) return [];
    var occ = Math.max(2, Math.ceil(nRows * 0.12));   // rows needed to be a column, not a stray title
    var edges = [];
    cells.forEach(function (c) { edges.push(c.left, c.right); });
    edges.sort(function (a, b) { return a - b; });
    var uniq = edges.filter(function (x, i) { return i === 0 || x !== edges[i - 1]; });

    var bands = [], cur = null;
    for (var i = 0; i < uniq.length - 1; i++) {
      var a = uniq[i], b = uniq[i + 1], mid = (a + b) / 2, cov = 0;
      for (var k = 0; k < cells.length; k++) if (cells[k].left <= mid && cells[k].right >= mid) cov++;
      if (cov >= occ) { if (cur) cur.r = b; else { cur = { l: a, r: b }; bands.push(cur); } }
      else cur = null;
    }
    return bands.map(function (band) { return (band.l + band.r) / 2; });
  }

  /* drop columns empty in every row, then rows empty in every column */
  function trim(grid) {
    if (!grid.length) return grid;
    var cols = grid.reduce(function (m, r) { return Math.max(m, r.length); }, 0);
    var keep = [];
    for (var c = 0; c < cols; c++) {
      var any = grid.some(function (r) { return (r[c] || '').trim() !== ''; });
      if (any) keep.push(c);
    }
    var out = grid.map(function (r) { return keep.map(function (c) { return (r[c] || '').trim(); }); });
    return out.filter(function (r) { return r.some(function (v) { return v !== ''; }); });
  }

  function fromPdf(buf, onProgress) {
    return ensureLib().then(function (lib) {
      return lib.getDocument({ data: buf, isEvalSupported: false }).promise;
    }).then(function (pdf) {
      var n = pdf.numPages, pages = [], chain = Promise.resolve();
      var _loop = function (i) {
        chain = chain.then(function () {
          if (onProgress) onProgress(i, n);
          return pdf.getPage(i).then(function (page) {
            return page.getTextContent().then(function (tc) {
              pages.push({ page: i, grid: buildGrid(mapItems(tc.items)) });
            });
          });
        });
      };
      for (var i = 1; i <= n; i++) _loop(i);
      return chain.then(function () { return { numPages: n, pages: pages }; });
    });
  }

  // ---------------------------------------------------------------- CSV

  function csvCell(v) {
    v = v == null ? '' : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }

  function gridToCSV(grid) {
    return grid.map(function (r) { return r.map(csvCell).join(','); }).join('\r\n');
  }

  // ---------------------------------------------------------------- XLSX

  function xmlText(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function xmlAttr(s) { return xmlText(s).replace(/"/g, '&quot;'); }

  function colName(n) {                     // 0 -> A, 26 -> AA
    var s = '';
    n += 1;
    while (n > 0) { var r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = (n - r - 1) / 26; }
    return s;
  }

  var NUMBER = /^-?\d+(\.\d+)?$/;

  function sheetXml(grid) {
    var rows = grid.map(function (row, r) {
      var cells = row.map(function (v, c) {
        var ref = colName(c) + (r + 1);
        v = v == null ? '' : String(v);
        if (v === '') return '';
        if (NUMBER.test(v)) return '<c r="' + ref + '"><v>' + v + '</v></c>';
        return '<c r="' + ref + '" t="inlineStr"><is><t xml:space="preserve">' + xmlText(v) + '</t></is></c>';
      }).join('');
      return '<row r="' + (r + 1) + '">' + cells + '</row>';
    }).join('');
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<sheetData>' + rows + '</sheetData></worksheet>';
  }

  function safeSheetName(name, used) {
    var n = String(name || 'Sheet').replace(/[\\\/?*\[\]:]/g, ' ').trim().slice(0, 31) || 'Sheet';
    var base = n, k = 2;
    while (used[n.toLowerCase()]) { n = base.slice(0, 28) + ' ' + (k++); }
    used[n.toLowerCase()] = true;
    return n;
  }

  /* sheets: [{ name, grid }] -> Blob (a stored, uncompressed .xlsx) */
  function toXLSX(sheets) {
    if (!sheets.length) sheets = [{ name: 'Sheet1', grid: [] }];
    var used = {};
    sheets = sheets.map(function (s) { return { name: safeSheetName(s.name, used), grid: s.grid || [] }; });

    var types = [
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
      '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">',
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
      '<Default Extension="xml" ContentType="application/xml"/>',
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
    ];
    sheets.forEach(function (s, i) {
      types.push('<Override PartName="/xl/worksheets/sheet' + (i + 1) +
        '.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>');
    });
    types.push('</Types>');

    var rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '</Relationships>';

    var sheetTags = '', wbRels = '';
    sheets.forEach(function (s, i) {
      var rid = 'rId' + (i + 1);
      sheetTags += '<sheet name="' + xmlAttr(s.name) + '" sheetId="' + (i + 1) + '" r:id="' + rid + '"/>';
      wbRels += '<Relationship Id="' + rid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet' + (i + 1) + '.xml"/>';
    });
    var stylesRid = 'rId' + (sheets.length + 1);
    wbRels += '<Relationship Id="' + stylesRid + '" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>';

    var workbook = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<sheets>' + sheetTags + '</sheets></workbook>';

    var workbookRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + wbRels + '</Relationships>';

    var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>' +
      '<fills count="1"><fill><patternFill patternType="none"/></fill></fills>' +
      '<borders count="1"><border/></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>' +
      '</styleSheet>';

    var files = [
      { name: '[Content_Types].xml', data: types.join('') },
      { name: '_rels/.rels', data: rootRels },
      { name: 'xl/workbook.xml', data: workbook },
      { name: 'xl/_rels/workbook.xml.rels', data: workbookRels },
      { name: 'xl/styles.xml', data: styles }
    ];
    sheets.forEach(function (s, i) {
      files.push({ name: 'xl/worksheets/sheet' + (i + 1) + '.xml', data: sheetXml(s.grid) });
    });

    return zip(files);
  }

  // ---------------------------------------------------------------- zip (store)

  var CRC = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    var c = 0xFFFFFFFF;
    for (var i = 0; i < bytes.length; i++) c = CRC[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function zip(files) {
    var enc = new TextEncoder();
    var parts = [], central = [], offset = 0;

    function u16(n) { return [n & 0xFF, (n >>> 8) & 0xFF]; }
    function u32(n) { return [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]; }

    files.forEach(function (f) {
      var name = enc.encode(f.name);
      var data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
      var crc = crc32(data);
      var local = [].concat(
        u32(0x04034b50), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(crc), u32(data.length), u32(data.length), u16(name.length), u16(0)
      );
      parts.push(new Uint8Array(local), name, data);
      central.push({ name: name, crc: crc, size: data.length, offset: offset });
      offset += local.length + name.length + data.length;
    });

    var cdStart = offset, cd = [];
    central.forEach(function (c) {
      var rec = [].concat(
        u32(0x02014b50), u16(20), u16(20), u16(0), u16(0), u16(0), u16(0),
        u32(c.crc), u32(c.size), u32(c.size), u16(c.name.length),
        u16(0), u16(0), u16(0), u16(0), u32(0), u32(c.offset)
      );
      cd.push(new Uint8Array(rec), c.name);
      offset += rec.length + c.name.length;
    });
    var cdSize = offset - cdStart;
    var eocd = [].concat(
      u32(0x06054b50), u16(0), u16(0), u16(central.length), u16(central.length),
      u32(cdSize), u32(cdStart), u16(0)
    );

    return new Blob(parts.concat(cd, [new Uint8Array(eocd)]),
      { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  root.TABLES = {
    ensureLib: ensureLib, fromPdf: fromPdf,
    gridToCSV: gridToCSV, toXLSX: toXLSX,
    _mapItems: mapItems, _buildGrid: buildGrid   // for tests
  };
})(typeof self !== 'undefined' ? self : this);
