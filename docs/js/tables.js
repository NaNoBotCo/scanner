/* tables.js — read a digital PDF's text layer and lay it out as a grid, then
   write that grid as CSV or a spreadsheet (.xlsx). No pixels: this reads the
   text a PDF already carries, so a scanned photo (no text layer) comes back
   empty — that page needs OCR, which is not here yet. A ruled table (borders
   drawn as vectors) is read off its own lines, which resolves merged cells and
   stacked headers; a borderless one falls back to reading the whitespace. */
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
    var OPS;
    return ensureLib().then(function (lib) {
      OPS = lib.OPS;
      return lib.getDocument({ data: buf, isEvalSupported: false }).promise;
    }).then(function (pdf) {
      var n = pdf.numPages, pages = [], chain = Promise.resolve();
      var _loop = function (i) {
        chain = chain.then(function () {
          if (onProgress) onProgress(i, n);
          return pdf.getPage(i).then(function (page) {
            return Promise.all([page.getTextContent(), page.getOperatorList()])
              .then(function (r) {
                var items = mapItems(r[0].items);
                // a ruled table gives the truest structure (merged cells, stacked
                // headers); fall back to whitespace when there are no lines.
                var lat = latticeGrid(rulingLines(r[1], OPS), items);
                pages.push({ page: i, grid: lat || buildGrid(items) });
              });
          });
        });
      };
      for (var i = 1; i <= n; i++) _loop(i);
      return chain.then(function () { return { numPages: n, pages: pages }; });
    });
  }

  // ---------------------------------------------------------------- lattice

  /* Walk the page's draw ops, tracking the transform, and collect every
     rectangle in page space. Thin ones are ruling lines. Returns the vertical
     line x-positions (column edges) and the horizontal line segments (each with
     its x-span, so a merged cell — a row edge a column does not cross — shows).  */
  function rulingLines(opList, OPS) {
    var consume = {};
    consume[OPS.moveTo] = 2; consume[OPS.lineTo] = 2; consume[OPS.curveTo] = 6;
    consume[OPS.curveTo2] = 4; consume[OPS.curveTo3] = 4; consume[OPS.closePath] = 0;
    consume[OPS.rectangle] = 4;

    function mul(a, b) {
      return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
      a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
    }
    function ap(m, x, y) { return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]; }

    var ctm = [1, 0, 0, 1, 0, 0], stack = [], vlines = [], hsegs = [];
    var fns = opList.fnArray, args = opList.argsArray;
    for (var i = 0; i < fns.length; i++) {
      var fn = fns[i];
      if (fn === OPS.save) stack.push(ctm.slice());
      else if (fn === OPS.restore) ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
      else if (fn === OPS.transform) ctm = mul(ctm, args[i]);
      else if (fn === OPS.constructPath) {
        var ops = args[i][0], co = args[i][1], ci = 0;
        for (var k = 0; k < ops.length; k++) {
          if (ops[k] === OPS.rectangle) {
            var p0 = ap(ctm, co[ci], co[ci + 1]), p1 = ap(ctm, co[ci] + co[ci + 2], co[ci + 1] + co[ci + 3]);
            var X = Math.min(p0[0], p1[0]), Y = Math.min(p0[1], p1[1]);
            var W = Math.abs(p1[0] - p0[0]), H = Math.abs(p1[1] - p0[1]);
            var thin = Math.min(W, H), lng = Math.max(W, H);
            if (thin <= 2.5 && lng >= 8) {
              if (H >= W) vlines.push(X + W / 2);
              else hsegs.push({ x0: X, x1: X + W, y: Y + H / 2 });
            }
          }
          ci += consume[ops[k]] || 0;
        }
      }
    }
    return { vlines: vlines, hsegs: hsegs };
  }

  function cluster(vals, tol) {
    vals = vals.slice().sort(function (a, b) { return a - b; });
    var out = [], g = null;
    vals.forEach(function (v) {
      if (g && v - g.last <= tol) { g.sum += v; g.n++; g.last = v; }
      else { g = { sum: v, n: 1, last: v }; out.push(g); }
    });
    return out.map(function (g) { return g.sum / g.n; });
  }

  /* Build a grid from ruling lines: vertical lines are column edges, horizontal
     lines row edges. Text lands in the cell its centre/baseline fall in. Where a
     column has no line on a row edge, that cell is merged across the rows and its
     value fills down. Returns null when there is no real grid. */
  function latticeGrid(ruling, items) {
    var colE = cluster(ruling.vlines, 3);
    var rowE = cluster(ruling.hsegs.map(function (s) { return s.y; }), 3);
    if (colE.length < 3 || rowE.length < 3) return null;   // need ≥2 cols and ≥2 rows
    colE.sort(function (a, b) { return a - b; });
    rowE.sort(function (a, b) { return b - a; });           // top (high y) first
    var nC = colE.length - 1, nR = rowE.length - 1, tol = 3;

    var grid = [];
    for (var r = 0; r < nR; r++) { grid.push([]); for (var c = 0; c < nC; c++) grid[r].push(''); }

    function colOf(x) { for (var c = 0; c < nC; c++) if (x >= colE[c] - tol && x < colE[c + 1] + tol) return c; return -1; }
    function rowOf(y) { for (var r = 0; r < nR; r++) if (y <= rowE[r] + tol && y > rowE[r + 1] - tol) return r; return -1; }

    items.forEach(function (it) {
      var c = colOf((it.left + it.right) / 2), r = rowOf(it.y);
      if (c < 0 || r < 0) return;
      grid[r][c] = grid[r][c] ? grid[r][c] + ' ' + it.str : it.str;
    });

    // A merged cell is a run of rows a column's lines never divide. Give every
    // row in that run the run's one value, wherever in it the text sits.
    function divides(col, y) {
      return ruling.hsegs.some(function (s) {
        return Math.abs(s.y - y) <= tol && s.x0 <= colE[col] + tol && s.x1 >= colE[col + 1] - tol;
      });
    }
    for (var c2 = 0; c2 < nC; c2++) {
      var a = 0;
      for (var r2 = 1; r2 <= nR; r2++) {
        if (r2 === nR || divides(c2, rowE[r2])) {          // close the run [a..r2-1]
          if (r2 - 1 > a) {
            var v = '';
            for (var s = a; s < r2; s++) if (grid[s][c2]) { v = grid[s][c2]; break; }
            if (v) for (var s2 = a; s2 < r2; s2++) grid[s2][c2] = v;
          }
          a = r2;
        }
      }
    }

    return trim(grid);
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
    _mapItems: mapItems, _buildGrid: buildGrid,   // for tests
    _rulingLines: rulingLines, _latticeGrid: latticeGrid
  };
})(typeof self !== 'undefined' ? self : this);
