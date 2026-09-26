/* ui.js — screens, camera, editing, export. */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };
  var BUILD = '6';
  var QUALITY = { small: 1400, normal: 2200, large: 3000 };
  var FILTERS = { colour: 'Colour', gray: 'Grey', bw: 'Text', photo: 'Photo' };
  var SIZES = { auto: 'Auto', a4: 'A4', letter: 'Letter', legal: 'Legal' };

  var S = {
    doc: null, pages: [], idx: 0,
    stream: null, track: null, live: null, liveTimer: null,
    cropQuad: null, cropBitmap: null, drag: -1, lastDeleted: null,
    tbl: null
  };

  // ---------------------------------------------------------------- worker

  var worker = null, jobs = {}, jobN = 0;
  try {
    worker = new Worker('js/worker.js');
    worker.onmessage = function (e) {
      var j = jobs[e.data.id];
      if (!j) return;
      delete jobs[e.data.id];
      if (e.data.error) j.rej(new Error(e.data.error)); else j.res(e.data);
    };
    worker.onerror = function () { worker = null; };
  } catch (err) { worker = null; }

  function send(msg, transfer) {
    return new Promise(function (res, rej) {
      msg.id = ++jobN;
      jobs[msg.id] = { res: res, rej: rej };
      worker.postMessage(msg, transfer);
    });
  }

  function detect(bitmap) {
    if (worker) {
      return send({ op: 'detect', bitmap: bitmap }, [bitmap])
        .then(function (r) { return r.quad; })
        .catch(function () { return null; });
    }
    var q = null;
    try { q = IMG.detectQuad(bitmap, bitmap.width, bitmap.height); } catch (e) { q = null; }
    bitmap.close();
    return Promise.resolve(q);
  }

  function process(bitmap, opts) {
    if (worker) {
      return send({
        op: 'process', bitmap: bitmap, quad: opts.quad,
        filter: opts.filter, rotate: opts.rotate, quality: opts.quality
      }, [bitmap]);
    }
    var r = IMG.processPage(bitmap, {
      quad: opts.quad, filter: opts.filter, rotate: opts.rotate,
      maxEdge: QUALITY[opts.quality] || QUALITY.normal
    });
    bitmap.close();
    return Promise.all([
      IMG.toBlob(r.canvas, 'image/jpeg', opts.filter === 'bw' ? 0.82 : 0.86),
      IMG.toBlob(IMG.thumbnail(r.canvas, 320), 'image/jpeg', 0.7)
    ]).then(function (o) { return { blob: o[0], thumb: o[1], w: r.w, h: r.h }; });
  }

  // ---------------------------------------------------------------- chrome

  function show(id) {
    ['home', 'capture', 'doc', 'page', 'crop', 'sign', 'place', 'tables'].forEach(function (k) {
      $('#' + k).classList.toggle('show', k === id);
    });
    if (id !== 'capture') stopCamera();
  }

  var busyDepth = 0;
  function busy(on, msg) {
    busyDepth = Math.max(0, busyDepth + (on ? 1 : -1));
    $('#busyMsg').textContent = msg || 'Working';
    $('#busy').hidden = busyDepth === 0;
  }

  var toastTimer = null;
  function toast(msg, label, fn) {
    var t = $('#toast');
    t.innerHTML = '';
    t.appendChild(document.createTextNode(msg));
    if (label) {
      var b = document.createElement('button');
      b.textContent = label;
      b.onclick = function () { t.hidden = true; clearTimeout(toastTimer); fn(); };
      t.appendChild(b);
    }
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, label ? 7000 : 3000);
  }

  function sheet(build) {
    var body = $('#sheetBody');
    body.innerHTML = '';
    build(body, closeSheet);
    $('#sheet').hidden = false;
  }
  function closeSheet() { $('#sheet').hidden = true; $('#sheetBody').innerHTML = ''; }
  $('#sheet').addEventListener('click', function (e) { if (e.target.id === 'sheet') closeSheet(); });

  function el(tag, attrs, text) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    if (text != null) n.textContent = text;
    return n;
  }

  function bytes(n) {
    if (!n) return '0 MB';
    if (n < 1048576) return Math.round(n / 1024) + ' KB';
    return (n / 1048576).toFixed(n < 10485760 ? 1 : 0) + ' MB';
  }

  function when(ts) {
    var d = new Date(ts), now = new Date();
    var same = d.toDateString() === now.toDateString();
    if (same) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function safeName(s) {
    return (s || 'Scan').replace(/[\\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Scan';
  }

  var urls = [];
  function url(blob) { var u = URL.createObjectURL(blob); urls.push(u); return u; }
  function freeUrls() { urls.splice(0).forEach(URL.revokeObjectURL); }

  // ---------------------------------------------------------------- home

  function renderHome() {
    freeUrls();
    return STORE.listDocs().then(function (docs) {
      var list = $('#docList');
      list.innerHTML = '';
      $('#empty').hidden = docs.length > 0;
      docs.forEach(function (d) {
        var li = el('li');
        var open = el('button', { class: 'open' });
        var img = el('img', { alt: '' });
        if (d.cover) img.src = url(d.cover);
        var meta = el('div', { class: 'meta' });
        meta.appendChild(el('b', null, d.name));
        meta.appendChild(el('span', null,
          d.order.length + (d.order.length === 1 ? ' page · ' : ' pages · ') + when(d.updated)));
        open.appendChild(img); open.appendChild(meta);
        open.onclick = function () { openDoc(d.id); };
        var more = el('button', { class: 'more', 'aria-label': 'More for ' + d.name }, '⋯');
        more.onclick = function () { docMenu(d); };
        li.appendChild(open); li.appendChild(more);
        list.appendChild(li);
      });
      return STORE.usage();
    }).then(function (u) {
      $('#usage').textContent = (u && u.usage ? bytes(u.usage) + ' held on this phone · ' : '') + 'v' + BUILD;
    });
  }

  function docMenu(d) {
    sheet(function (body, close) {
      body.appendChild(el('h2', null, d.name));
      var stack = el('div', { class: 'stack' });
      var b1 = el('button', { class: 'primary' }, 'Open');
      b1.onclick = function () { close(); openDoc(d.id); };
      var b2 = el('button', null, 'Rename');
      b2.onclick = function () { close(); rename(d, renderHome); };
      var b3 = el('button', null, 'Share PDF');
      b3.onclick = function () { close(); openDoc(d.id).then(function () { exportPdf(true); }); };
      var b4 = el('button', { class: 'danger' }, 'Delete');
      b4.onclick = function () {
        close();
        if (!confirm('Delete "' + d.name + '" and its ' + d.order.length + ' pages?')) return;
        STORE.deleteDoc(d.id).then(renderHome);
      };
      [b1, b2, b3, b4].forEach(function (b) { stack.appendChild(b); });
      body.appendChild(stack);
    });
  }

  function rename(d, after) {
    sheet(function (body, close) {
      body.appendChild(el('h2', null, 'Name'));
      var input = el('input', { type: 'text', value: d.name, 'aria-label': 'Document name' });
      body.appendChild(input);
      var stack = el('div', { class: 'stack' });
      var ok = el('button', { class: 'primary' }, 'Save');
      ok.onclick = function () {
        d.name = input.value.trim() || d.name;
        STORE.putDoc(d).then(function () { close(); after(); });
      };
      stack.appendChild(ok);
      body.appendChild(stack);
      setTimeout(function () { input.focus(); input.select(); }, 60);
    });
  }

  $('#newScan').onclick = function () {
    var now = new Date();
    var name = 'Scan ' + now.toLocaleDateString([], { day: 'numeric', month: 'short' }) + ' ' +
      now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    STORE.newDoc(name).then(function (d) {
      S.doc = d; S.pages = [];
      startCamera();
    });
  };

  $('#helpBtn').onclick = function () {
    sheet(function (body, close) {
      body.appendChild(el('h2', null, 'Scanner'));
      [
        'New scan opens the camera. Each shot becomes a page.',
        'The page gets straightened and the shadows flattened. Tap a page to change that, turn it, or crop it again.',
        'Sign opens a full-screen pad to sign with a finger, or takes the ink off a photo of a signature. Drag it where it goes.',
        'A saved signature sits behind a PIN, and behind the fingerprint where the phone allows it.',
        'PDF saves the file. Share sends it to mail, chat or Drive.',
        'PDF → sheet reads a table out of a PDF that carries real text and hands back a spreadsheet — CSV, or Excel with a sheet per page. A photographed page holds no text to read, so that path waits on OCR.',
        'Pages sit in this browser’s storage until you delete them.'
      ].forEach(function (t) { body.appendChild(el('p', null, t)); });
      var stack = el('div', { class: 'stack' });
      var b = el('button', { class: 'primary' }, 'Close');
      b.onclick = close;
      stack.appendChild(b);
      body.appendChild(stack);
    });
  };

  // ---------------------------------------------------------------- PDF → sheet

  $('#pdfTables').onclick = function () { $('#pdfInput').click(); };

  $('#pdfInput').onchange = function (e) {
    var file = (e.target.files || [])[0];
    e.target.value = '';
    if (!file) return;
    var name = safeName(file.name.replace(/\.pdf$/i, ''));
    busy(true, 'Reading the PDF');
    file.arrayBuffer().then(function (buf) {
      return TABLES.fromPdf(new Uint8Array(buf), function (i, n) {
        $('#busyMsg').textContent = 'Reading page ' + i + ' of ' + n;
      });
    }).then(function (res) {
      busy(false);
      S.tbl = { name: name, pages: res.pages, idx: 0 };
      show('tables');
      renderTable();
    }).catch(function (err) {
      busy(false);
      toast(/password|encrypt/i.test(String(err && err.message)) ?
        'That PDF is locked. Open it without a password first.' :
        'That PDF would not open.');
    });
  };

  /* one page's grid as an HTML table, or a note when the page carries no text */
  function renderTable() {
    var t = S.tbl;
    if (!t) return;
    var page = t.pages[t.idx] || { grid: [] };
    var grid = page.grid;
    $('#tblTitle').textContent = t.name;
    $('#tblPage').textContent = (t.idx + 1) + '/' + t.pages.length;
    $('#tblPrev').disabled = t.idx === 0;
    $('#tblNext').disabled = t.idx === t.pages.length - 1;

    var wrap = $('#tblWrap');
    wrap.innerHTML = '';
    if (!grid.length) {
      wrap.classList.remove('tblwrap');
      var m = el('div', { class: 'tblempty' });
      m.appendChild(el('p', null, 'No text on this page.'));
      m.appendChild(el('p', null, 'A photographed or scanned page is a picture, so there is nothing to read off it yet. Reading a table off an image needs OCR, which is not in Scanner yet.'));
      wrap.appendChild(m);
    } else {
      wrap.classList.add('tblwrap');
      var table = el('table', { class: 'grid' });
      grid.forEach(function (row) {
        var tr = el('tr');
        row.forEach(function (cell) { tr.appendChild(el('td', null, cell || '')); });
        table.appendChild(tr);
      });
      wrap.appendChild(table);
    }

    var withText = t.pages.filter(function (p) { return p.grid.length; }).length;
    var note = grid.length
      ? grid.length + (grid.length === 1 ? ' row' : ' rows') + ' × ' +
        grid[0].length + (grid[0].length === 1 ? ' column' : ' columns') +
        ' on this page. CSV saves this page; Excel saves all ' + t.pages.length + '.'
      : (withText ? 'Nothing here. Turn to a page that has a table.'
                  : 'None of the ' + t.pages.length + ' pages carry a text layer.');
    $('#tblNote').textContent = note;
  }

  function tblGo(d) {
    if (!S.tbl) return;
    var n = S.tbl.idx + d;
    if (n < 0 || n >= S.tbl.pages.length) return;
    S.tbl.idx = n;
    renderTable();
  }
  $('#tblPrev').onclick = function () { tblGo(-1); };
  $('#tblNext').onclick = function () { tblGo(1); };
  $('#tblBack').onclick = function () { S.tbl = null; show('home'); renderHome(); };

  function tblHasAny() {
    return S.tbl && S.tbl.pages.some(function (p) { return p.grid.length; });
  }

  $('#tblCsv').onclick = function () {
    if (!S.tbl) return;
    var grid = (S.tbl.pages[S.tbl.idx] || {}).grid || [];
    if (!grid.length) { toast('This page has no table to save.'); return; }
    var blob = new Blob(['﻿' + TABLES.gridToCSV(grid)], { type: 'text/csv' });
    var name = safeName(S.tbl.name) + (S.tbl.pages.length > 1 ? ' p' + (S.tbl.idx + 1) : '') + '.csv';
    saveOrShare(blob, name, false);
  };

  function buildXlsx() {
    var sheets = S.tbl.pages
      .filter(function (p) { return p.grid.length; })
      .map(function (p) { return { name: 'Page ' + p.page, grid: p.grid }; });
    return TABLES.toXLSX(sheets);
  }

  $('#tblXlsx').onclick = function () {
    if (!tblHasAny()) { toast('No tables were found to save.'); return; }
    saveOrShare(buildXlsx(), safeName(S.tbl.name) + '.xlsx', false);
  };

  $('#tblShare').onclick = function () {
    if (!tblHasAny()) { toast('No tables were found to share.'); return; }
    saveOrShare(buildXlsx(), safeName(S.tbl.name) + '.xlsx', true);
  };

  function saveOrShare(blob, name, share) {
    if (share && navigator.canShare) {
      var file = new File([blob], name, { type: blob.type });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: name })
          .catch(function (e) { if (e && e.name !== 'AbortError') download(blob, name); });
        return;
      }
    }
    download(blob, name);
    toast(share ? 'Sharing is off here. The file was saved instead.' : 'Saved ' + name);
  }

  // ---------------------------------------------------------------- camera

  function startCamera() {
    show('capture');
    $('#capCount').textContent = S.pages.length + (S.pages.length === 1 ? ' page' : ' pages');
    $('#camMsg').textContent = '';
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $('#camMsg').textContent = 'No camera here. Use Photos.';
      return;
    }
    navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 4096 } },
      audio: false
    }).then(function (stream) {
      S.stream = stream;
      S.track = stream.getVideoTracks()[0];
      var v = $('#video');
      v.srcObject = stream;
      v.play();
      var caps = S.track.getCapabilities ? S.track.getCapabilities() : {};
      $('#torch').hidden = !caps.torch;
      startLive();
    }).catch(function (err) {
      $('#camMsg').textContent = err && err.name === 'NotAllowedError'
        ? 'The camera is blocked for this site. Allow it in the browser settings, or use Photos.'
        : 'The camera did not open. Use Photos.';
    });
  }

  function stopCamera() {
    clearInterval(S.liveTimer); S.liveTimer = null;
    if (S.stream) { S.stream.getTracks().forEach(function (t) { t.stop(); }); S.stream = null; S.track = null; }
    $('#video').srcObject = null;
  }

  function startLive() {
    var v = $('#video'), c = $('#overlay'), ctx = c.getContext('2d');
    S.liveTimer = setInterval(function () {
      if (!v.videoWidth) return;
      var r = c.getBoundingClientRect();
      if (c.width !== Math.round(r.width) || c.height !== Math.round(r.height)) {
        c.width = Math.round(r.width); c.height = Math.round(r.height);
      }
      var q = null;
      try { q = IMG.detectQuad(v, v.videoWidth, v.videoHeight); } catch (e) { q = null; }
      S.live = q;
      ctx.clearRect(0, 0, c.width, c.height);
      if (!q) return;
      var scale = Math.max(c.width / v.videoWidth, c.height / v.videoHeight);
      var dx = (c.width - v.videoWidth * scale) / 2, dy = (c.height - v.videoHeight * scale) / 2;
      ctx.beginPath();
      q.forEach(function (p, i) {
        var x = dx + p[0] * scale, y = dy + p[1] * scale;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      });
      ctx.closePath();
      ctx.fillStyle = 'rgba(29,95,180,.22)';
      ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = '#8ab4f8';
      ctx.stroke();
    }, 420);
  }

  $('#torch').onclick = function () {
    if (!S.track) return;
    var on = $('#torch').getAttribute('aria-pressed') === 'true';
    S.track.applyConstraints({ advanced: [{ torch: !on }] })
      .then(function () { $('#torch').setAttribute('aria-pressed', String(!on)); })
      .catch(function () { toast('The light did not turn on.'); });
  };

  $('#capBack').onclick = function () { stopCamera(); finishCapture(); };
  $('#capDone').onclick = function () { stopCamera(); finishCapture(); };

  function finishCapture() {
    if (S.pages.length === 0 && S.doc) {
      STORE.deleteDoc(S.doc.id).then(function () { S.doc = null; show('home'); renderHome(); });
      return;
    }
    openDoc(S.doc.id);
  }

  function grabFrame() {
    var v = $('#video');
    if (!v.videoWidth) return Promise.reject(new Error('no frame'));
    if (S.track && typeof ImageCapture !== 'undefined') {
      try {
        var ic = new ImageCapture(S.track);
        return ic.takePhoto().catch(function () { return canvasFrame(v); });
      } catch (e) { /* fall through */ }
    }
    return canvasFrame(v);
  }

  function canvasFrame(v) {
    var c = IMG.makeCanvas(v.videoWidth, v.videoHeight);
    c.getContext('2d').drawImage(v, 0, 0);
    return IMG.toBlob(c, 'image/jpeg', 0.92);
  }

  $('#shutter').onclick = function () {
    $('#shutter').disabled = true;
    grabFrame().then(addPhoto).catch(function () {
      toast('That shot did not come through.');
    }).then(function () {
      $('#shutter').disabled = false;
      $('#capCount').textContent = S.pages.length + (S.pages.length === 1 ? ' page' : ' pages');
    });
  };

  $('#pickFiles').onclick = function () { $('#fileInput').click(); };
  $('#addPages').onclick = function () { startCamera(); };

  $('#fileInput').onchange = function (e) {
    var files = [].slice.call(e.target.files || []);
    e.target.value = '';
    if (!files.length) return;
    busy(true, 'Reading ' + files.length + (files.length === 1 ? ' photo' : ' photos'));
    var chain = Promise.resolve();
    files.forEach(function (f) { chain = chain.then(function () { return addPhoto(f); }); });
    chain.catch(function () { toast('One of those would not open.'); }).then(function () {
      busy(false);
      if ($('#capture').classList.contains('show')) {
        $('#capCount').textContent = S.pages.length + (S.pages.length === 1 ? ' page' : ' pages');
      } else openDoc(S.doc.id);
    });
  };

  function bitmapOf(blob) {
    return createImageBitmap(blob, { imageOrientation: 'from-image' })
      .catch(function () { return createImageBitmap(blob); });
  }

  /* Keep a working copy of the photo rather than the full sensor frame: enough
     pixels to crop again later, small enough to sit in storage. */
  function normalize(blob) {
    return bitmapOf(blob).then(function (bmp) {
      var max = 2600, s = Math.min(1, max / Math.max(bmp.width, bmp.height));
      if (s === 1 && blob.type === 'image/jpeg') { bmp.close(); return blob; }
      var c = IMG.makeCanvas(Math.round(bmp.width * s), Math.round(bmp.height * s));
      c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
      bmp.close();
      return IMG.toBlob(c, 'image/jpeg', 0.92);
    });
  }

  function addPhoto(blob) {
    var page = { id: STORE.id(), docId: S.doc.id, filter: S.doc.filter || 'colour', rotate: 0 };
    return normalize(blob).then(function (orig) {
      page.original = orig;
      return bitmapOf(orig);
    }).then(detect).then(function (quad) {
      page.quad = quad;
      return bitmapOf(page.original);
    }).then(function (bmp) {
      return process(bmp, { quad: page.quad, filter: page.filter, rotate: 0, quality: S.doc.quality });
    }).then(function (r) {
      return finishPage(page, r);
    }).then(function () {
      return STORE.putPage(page);
    }).then(function () {
      S.pages.push(page);
      S.doc.order.push(page.id);
      if (S.doc.order.length === 1) S.doc.cover = page.thumb;
      return STORE.putDoc(S.doc);
    });
  }

  // ---------------------------------------------------------------- document

  function openDoc(docId) {
    return STORE.getDoc(docId).then(function (d) {
      S.doc = d;
      return STORE.pagesOf(docId);
    }).then(function (pages) {
      var byId = {};
      pages.forEach(function (p) { byId[p.id] = p; });
      S.pages = S.doc.order.map(function (id) { return byId[id]; }).filter(Boolean);
      if (S.pages.length !== S.doc.order.length) {
        S.doc.order = S.pages.map(function (p) { return p.id; });
        STORE.putDoc(S.doc);
      }
      show('doc');
      renderDoc();
    });
  }

  function renderDoc() {
    freeUrls();
    $('#docName').textContent = S.doc.name;
    var list = $('#pageList');
    list.innerHTML = '';
    S.pages.forEach(function (p, i) {
      var li = el('li');
      var open = el('button', { class: 'thumbwrap', 'aria-label': 'Open page ' + (i + 1) });
      var img = el('img', { class: 'thumb', alt: '' });
      if (p.thumb) img.src = url(p.thumb);
      open.appendChild(img);
      open.onclick = function () { openPage(i); };

      var n = el('button', { class: 'n' }, 'Page ' + (i + 1));
      n.appendChild(el('small', null, FILTERS[p.filter] + ' · ' + p.w + '×' + p.h));
      n.onclick = function () { openPage(i); };

      var col = el('div', { class: 'col' });
      var up = el('button', { 'aria-label': 'Move page ' + (i + 1) + ' up' }, '↑');
      up.disabled = i === 0;
      up.onclick = function () { move(i, -1); };
      var down = el('button', { 'aria-label': 'Move page ' + (i + 1) + ' down' }, '↓');
      down.disabled = i === S.pages.length - 1;
      down.onclick = function () { move(i, 1); };
      col.appendChild(up); col.appendChild(down);

      li.appendChild(open); li.appendChild(n); li.appendChild(col);
      list.appendChild(li);
    });
  }

  function move(i, d) {
    var j = i + d;
    if (j < 0 || j >= S.pages.length) return;
    var t = S.pages[i]; S.pages[i] = S.pages[j]; S.pages[j] = t;
    S.doc.order = S.pages.map(function (p) { return p.id; });
    S.doc.cover = S.pages[0].thumb;
    STORE.putDoc(S.doc).then(renderDoc);
  }

  $('#docBack').onclick = function () { show('home'); renderHome(); };
  $('#docName').onclick = function () { rename(S.doc, renderDoc); };

  $('#docMenu').onclick = function () {
    sheet(function (body, close) {
      body.appendChild(el('h2', null, 'Settings'));

      body.appendChild(el('label', null, 'Page size'));
      body.appendChild(pick(SIZES, S.doc.pageSize, function (v) {
        S.doc.pageSize = v; STORE.putDoc(S.doc);
      }));

      body.appendChild(el('label', null, 'Detail'));
      body.appendChild(pick({ small: 'Small', normal: 'Normal', large: 'Large' }, S.doc.quality, function (v) {
        S.doc.quality = v; STORE.putDoc(S.doc);
      }));

      body.appendChild(el('label', null, 'Every page'));
      body.appendChild(pick(FILTERS, S.doc.filter, function (v) {
        S.doc.filter = v;
        close();
        reprocessAll(v);
      }));

      var stack = el('div', { class: 'stack' });
      var del = el('button', { class: 'danger' }, 'Delete this document');
      del.onclick = function () {
        close();
        if (!confirm('Delete "' + S.doc.name + '" and its ' + S.pages.length + ' pages?')) return;
        STORE.deleteDoc(S.doc.id).then(function () { show('home'); renderHome(); });
      };
      stack.appendChild(del);
      body.appendChild(stack);
    });
  };

  function pick(map, current, onPick) {
    var row = el('div', { class: 'row' });
    Object.keys(map).forEach(function (k) {
      var b = el('button', { 'aria-pressed': String(k === current) }, map[k]);
      b.onclick = function () {
        [].forEach.call(row.children, function (c) { c.setAttribute('aria-pressed', 'false'); });
        b.setAttribute('aria-pressed', 'true');
        onPick(k);
      };
      row.appendChild(b);
    });
    return row;
  }

  function reprocessAll(filter) {
    busy(true, 'Redoing ' + S.pages.length + ' pages');
    var chain = Promise.resolve();
    S.pages.forEach(function (p) {
      chain = chain.then(function () { p.filter = filter; return reprocess(p); });
    });
    chain.then(function () {
      S.doc.cover = S.pages[0] && S.pages[0].thumb;
      return STORE.putDoc(S.doc);
    }).catch(function () { toast('Some pages would not redo.'); })
      .then(function () { busy(false); renderDoc(); });
  }

  function reprocess(p) {
    return bitmapOf(p.original).then(function (bmp) {
      return process(bmp, { quad: p.quad, filter: p.filter, rotate: p.rotate, quality: S.doc.quality });
    }).then(function (r) {
      return finishPage(p, r);
    }).then(function () {
      return STORE.putPage(p);
    });
  }

  /* A signature is kept beside the page rather than burnt into the photo, so
     changing the filter or turning the page keeps it where it was put. */
  function finishPage(p, r) {
    if (!p.marks || !p.marks.length) {
      p.blob = r.blob; p.thumb = r.thumb; p.w = r.w; p.h = r.h;
      return Promise.resolve(p);
    }
    return stampMarks(r.blob, p).then(function (c) {
      return Promise.all([
        IMG.toBlob(c, 'image/jpeg', 0.88),
        IMG.toBlob(IMG.thumbnail(c, 320), 'image/jpeg', 0.7)
      ]).then(function (o) {
        p.blob = o[0]; p.thumb = o[1]; p.w = c.width; p.h = c.height;
        return p;
      });
    });
  }

  function stampMarks(blob, page) {
    return createImageBitmap(blob).then(function (bmp) {
      var c = IMG.makeCanvas(bmp.width, bmp.height);
      var ctx = c.getContext('2d');
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      var chain = Promise.resolve();
      page.marks.forEach(function (m) {
        chain = chain.then(function () {
          return createImageBitmap(m.blob).then(function (sig) {
            var delta = (((page.rotate || 0) - (m.rot || 0)) % 360 + 360) % 360;
            var x = m.x, y = m.y, w = m.w, h = m.h, nx, ny, nw, nh;
            if (delta === 90) { nx = 1 - y - h; ny = x; nw = h; nh = w; }
            else if (delta === 180) { nx = 1 - x - w; ny = 1 - y - h; nw = w; nh = h; }
            else if (delta === 270) { nx = y; ny = 1 - x - w; nw = h; nh = w; }
            else { nx = x; ny = y; nw = w; nh = h; }
            var px = nx * c.width, py = ny * c.height, pw = nw * c.width, ph = nh * c.height;
            ctx.save();
            ctx.translate(px + pw / 2, py + ph / 2);
            ctx.rotate(delta * Math.PI / 180);
            if (delta === 90 || delta === 270) ctx.drawImage(sig, -ph / 2, -pw / 2, ph, pw);
            else ctx.drawImage(sig, -pw / 2, -ph / 2, pw, ph);
            ctx.restore();
            sig.close();
          });
        });
      });
      return chain.then(function () { return c; });
    });
  }

  // ---------------------------------------------------------------- one page

  function openPage(i) {
    S.idx = i;
    var p = S.pages[i];
    freeUrls();
    $('#pageImg').src = url(p.blob);
    $('#pageNum').textContent = 'Page ' + (i + 1) + ' of ' + S.pages.length;
    [].forEach.call($('#filterChips').children, function (b) {
      b.setAttribute('aria-pressed', String(b.dataset.f === p.filter));
    });
    show('page');
  }

  $('#pageBack').onclick = function () { show('doc'); renderDoc(); };

  [].forEach.call($('#filterChips').children, function (b) {
    b.onclick = function () {
      var p = S.pages[S.idx];
      if (p.filter === b.dataset.f) return;
      p.filter = b.dataset.f;
      busy(true, 'Redoing the page');
      reprocess(p).then(function () {
        if (S.idx === 0) { S.doc.cover = p.thumb; return STORE.putDoc(S.doc); }
      }).catch(function () { toast('That page would not redo.'); })
        .then(function () { busy(false); openPage(S.idx); });
    };
  });

  function turn(d) {
    var p = S.pages[S.idx];
    p.rotate = ((p.rotate + d) % 360 + 360) % 360;
    busy(true, 'Turning the page');
    reprocess(p).then(function () {
      if (S.idx === 0) { S.doc.cover = p.thumb; return STORE.putDoc(S.doc); }
    }).catch(function () { toast('That page would not turn.'); })
      .then(function () { busy(false); openPage(S.idx); });
  }
  $('#rotL').onclick = function () { turn(-90); };
  $('#rotR').onclick = function () { turn(90); };

  $('#pageDel').onclick = function () {
    var p = S.pages[S.idx], i = S.idx;
    S.pages.splice(i, 1);
    S.doc.order = S.pages.map(function (x) { return x.id; });
    S.doc.cover = S.pages[0] && S.pages[0].thumb;
    S.lastDeleted = { page: p, at: i };
    STORE.putDoc(S.doc).then(function () {
      show('doc'); renderDoc();
      toast('Page ' + (i + 1) + ' deleted', 'Undo', function () {
        S.pages.splice(S.lastDeleted.at, 0, S.lastDeleted.page);
        S.doc.order = S.pages.map(function (x) { return x.id; });
        S.doc.cover = S.pages[0].thumb;
        STORE.putDoc(S.doc).then(renderDoc);
      });
      setTimeout(function () {
        if (S.lastDeleted && S.lastDeleted.page === p && S.doc.order.indexOf(p.id) < 0) {
          STORE.deletePage(p.id);
          S.lastDeleted = null;
        }
      }, 7500);
    });
  };

  // ---------------------------------------------------------------- crop

  $('#recrop').onclick = function () { openCrop(); };

  function openCrop() {
    var p = S.pages[S.idx];
    freeUrls();
    var img = $('#cropImg');
    img.onload = function () {
      S.cropQuad = (p.quad && p.quad.length === 4)
        ? p.quad.map(function (c) { return [c[0], c[1]]; })
        : fullQuad(img.naturalWidth, img.naturalHeight);
      layoutHandles();
      show('crop');
      setTimeout(layoutHandles, 60);
    };
    img.src = url(p.original);
    bitmapOf(p.original).then(function (b) { S.cropBitmap = b; });
  }

  function fullQuad(w, h) { return [[0, 0], [w, 0], [w, h], [0, h]]; }

  function imgBox() {
    var img = $('#cropImg'), stage = $('#cropStage');
    var r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
    return {
      left: r.left - s.left, top: r.top - s.top,
      w: r.width, h: r.height,
      nw: img.naturalWidth || 1, nh: img.naturalHeight || 1,
      pageLeft: r.left, pageTop: r.top
    };
  }

  function layoutHandles() {
    var b = imgBox();
    var hs = document.querySelectorAll('#cropStage .handle');
    for (var i = 0; i < 4; i++) {
      var p = S.cropQuad[i];
      hs[i].style.left = (b.left + p[0] * b.w / b.nw) + 'px';
      hs[i].style.top = (b.top + p[1] * b.h / b.nh) + 'px';
    }
    var c = $('#cropLines'), r = c.getBoundingClientRect();
    if (c.width !== Math.round(r.width) || c.height !== Math.round(r.height)) {
      c.width = Math.round(r.width); c.height = Math.round(r.height);
    }
    var ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.beginPath();
    S.cropQuad.forEach(function (p, i) {
      var x = b.left + p[0] * b.w / b.nw, y = b.top + p[1] * b.h / b.nh;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
    ctx.fillStyle = 'rgba(29,95,180,.18)';
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = '#8ab4f8'; ctx.stroke();
  }

  function loupeAt(pt) {
    var c = $('#loupe'), ctx = c.getContext('2d');
    if (!S.cropBitmap) return;
    var z = 3, side = 150 / z;
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, 150, 150);
    ctx.drawImage(S.cropBitmap, pt[0] - side / 2, pt[1] - side / 2, side, side, 0, 0, 150, 150);
    ctx.strokeStyle = '#8ab4f8'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(75, 55); ctx.lineTo(75, 95); ctx.moveTo(55, 75); ctx.lineTo(95, 75); ctx.stroke();
    c.classList.add('on');
  }

  (function bindHandles() {
    var hs = document.querySelectorAll('#cropStage .handle');
    [].forEach.call(hs, function (h) {
      h.addEventListener('pointerdown', function (e) {
        S.drag = Number(h.dataset.i);
        h.setPointerCapture(e.pointerId);
        e.preventDefault();
      });
      h.addEventListener('pointermove', function (e) {
        if (S.drag < 0) return;
        var b = imgBox();
        var x = (e.clientX - b.pageLeft) * b.nw / b.w;
        var y = (e.clientY - b.pageTop) * b.nh / b.h;
        x = Math.max(0, Math.min(b.nw, x));
        y = Math.max(0, Math.min(b.nh, y));
        S.cropQuad[S.drag] = [x, y];
        layoutHandles();
        loupeAt([x, y]);
        e.preventDefault();
      });
      function end() { S.drag = -1; $('#loupe').classList.remove('on'); }
      h.addEventListener('pointerup', end);
      h.addEventListener('pointercancel', end);
    });
  })();

  window.addEventListener('resize', function () {
    if ($('#crop').classList.contains('show')) layoutHandles();
  });

  $('#cropAll').onclick = function () {
    var img = $('#cropImg');
    S.cropQuad = fullQuad(img.naturalWidth, img.naturalHeight);
    layoutHandles();
  };

  $('#cropAuto').onclick = function () {
    var p = S.pages[S.idx];
    busy(true, 'Looking for the page');
    bitmapOf(p.original).then(detect).then(function (q) {
      var img = $('#cropImg');
      if (q) S.cropQuad = q;
      else { toast('No page edge found. Drag the corners.'); S.cropQuad = fullQuad(img.naturalWidth, img.naturalHeight); }
      layoutHandles();
    }).then(function () { busy(false); });
  };

  $('#cropCancel').onclick = function () { openPage(S.idx); };

  $('#cropSave').onclick = function () {
    var p = S.pages[S.idx];
    p.quad = S.cropQuad.map(function (c) { return [c[0], c[1]]; });
    busy(true, 'Redoing the page');
    reprocess(p).then(function () {
      if (S.idx === 0) { S.doc.cover = p.thumb; return STORE.putDoc(S.doc); }
    }).catch(function () { toast('That crop would not take.'); })
      .then(function () { busy(false); openPage(S.idx); });
  };

  // ---------------------------------------------------------------- signing

  S.sig = { blob: null, w: 1, h: 1, box: null, ink: '#101214', fresh: false };

  var pad = $('#signPad'), padCtx = null, drawing = false, last = null, inked = false;

  function sizePad() {
    var r = pad.getBoundingClientRect();
    var dpr = Math.min(3, window.devicePixelRatio || 1);
    var w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    if (pad.width === w && pad.height === h) return;
    pad.width = w; pad.height = h;
    padCtx = pad.getContext('2d', { willReadFrequently: true });
    padCtx.lineCap = 'round';
    padCtx.lineJoin = 'round';
    inked = false;
    $('#pad').classList.remove('inked');
  }

  function padPoint(e) {
    var r = pad.getBoundingClientRect();
    return [(e.clientX - r.left) * pad.width / r.width, (e.clientY - r.top) * pad.height / r.height];
  }

  function strokeWidth() { return Math.max(3, Math.min(pad.width, pad.height) * 0.011); }

  pad.addEventListener('pointerdown', function (e) {
    sizePad();
    drawing = true;
    last = padPoint(e);
    padCtx.strokeStyle = S.sig.ink;
    padCtx.fillStyle = S.sig.ink;
    padCtx.lineWidth = strokeWidth();
    padCtx.beginPath();
    padCtx.arc(last[0], last[1], strokeWidth() / 2, 0, Math.PI * 2);
    padCtx.fill();
    padCtx.beginPath();
    padCtx.moveTo(last[0], last[1]);
    if (!inked) { inked = true; $('#pad').classList.add('inked'); }
    pad.setPointerCapture(e.pointerId);
    e.preventDefault();
  });

  pad.addEventListener('pointermove', function (e) {
    if (!drawing) return;
    var pts = (e.getCoalescedEvents && e.getCoalescedEvents().length) ? e.getCoalescedEvents() : [e];
    padCtx.strokeStyle = S.sig.ink;
    padCtx.lineWidth = strokeWidth();
    // each curve starts where the last one ended, with the raw point as the
    // control, so the line stays unbroken and the corners round off
    pts.forEach(function (ev) {
      var p = padPoint(ev);
      var mid = [(last[0] + p[0]) / 2, (last[1] + p[1]) / 2];
      padCtx.quadraticCurveTo(last[0], last[1], mid[0], mid[1]);
      padCtx.stroke();
      padCtx.beginPath();
      padCtx.moveTo(mid[0], mid[1]);
      last = p;
    });
    e.preventDefault();
  });

  function endStroke() {
    if (drawing && last) {
      padCtx.lineTo(last[0], last[1]);
      padCtx.stroke();
    }
    drawing = false;
  }
  pad.addEventListener('pointerup', endStroke);
  pad.addEventListener('pointercancel', endStroke);
  pad.addEventListener('pointerleave', endStroke);

  [].forEach.call(document.querySelectorAll('#sign .swatch'), function (b) {
    b.onclick = function () {
      [].forEach.call(document.querySelectorAll('#sign .swatch'), function (x) {
        x.setAttribute('aria-pressed', 'false');
      });
      b.setAttribute('aria-pressed', 'true');
      S.sig.ink = b.dataset.ink;
    };
  });

  function clearPad() {
    sizePad();
    padCtx.clearRect(0, 0, pad.width, pad.height);
    inked = false;
    $('#pad').classList.remove('inked');
  }
  $('#signClear').onclick = clearPad;

  $('#signBtn').onclick = function () {
    show('sign');
    setTimeout(function () { sizePad(); clearPad(); }, 60);
  };
  $('#signBack').onclick = function () { openPage(S.idx); };

  window.addEventListener('resize', function () {
    if ($('#sign').classList.contains('show')) setTimeout(sizePad, 80);
  });

  $('#signUse').onclick = function () {
    if (!inked) { toast('Nothing drawn yet.'); return; }
    var trimmed = IMG.trimAlpha(pad);
    if (!trimmed) { toast('Nothing drawn yet.'); return; }
    IMG.toBlob(trimmed, 'image/png').then(function (b) {
      useSignature(b, true);
    });
  };

  $('#signPhoto').onclick = function () { $('#sigInput').click(); };

  $('#sigInput').onchange = function (e) {
    var f = (e.target.files || [])[0];
    e.target.value = '';
    if (!f) return;
    busy(true, 'Lifting the ink');
    bitmapOf(f).then(function (bmp) {
      var c = IMG.inkFromPhoto(bmp);
      bmp.close();
      if (!c) { toast('No ink found in that photo.'); return null; }
      return IMG.toBlob(c, 'image/png');
    }).then(function (b) {
      busy(false);
      if (b) useSignature(b, true);
    }).catch(function () { busy(false); toast('That photo would not open.'); });
  };

  function useSignature(blob, fresh) {
    return createImageBitmap(blob).then(function (bmp) {
      S.sig.blob = blob; S.sig.w = bmp.width; S.sig.h = bmp.height; S.sig.fresh = !!fresh;
      bmp.close();
      openPlace();
    });
  }

  // ---- putting it on the page ----

  function placeBox() {
    var img = $('#placeImg'), stage = $('#placeStage');
    var r = img.getBoundingClientRect(), s = stage.getBoundingClientRect();
    return { left: r.left - s.left, top: r.top - s.top, w: r.width, h: r.height,
             pageLeft: r.left, pageTop: r.top };
  }

  function openPlace() {
    var p = S.pages[S.idx];
    freeUrls();
    var img = $('#placeImg');
    img.onload = function () {
      var aspect = S.sig.h / S.sig.w;
      var w = 0.34;
      S.sig.box = { x: 0.5 - w / 2, y: 0.72, w: w, h: 0 };
      fitSigBox(aspect);
      show('place');
      setTimeout(layoutSig, 60);
    };
    img.src = url(p.blob);
    $('#placeSig').src = url(S.sig.blob);
  }

  function fitSigBox(aspect) {
    var b = placeBox();
    var pxW = S.sig.box.w * (b.w || 1);
    var pxH = pxW * (aspect || S.sig.h / S.sig.w);
    S.sig.box.h = pxH / (b.h || 1);
  }

  function layoutSig() {
    var b = placeBox();
    fitSigBox();
    var box = S.sig.box;
    box.x = Math.max(0, Math.min(1 - box.w, box.x));
    box.y = Math.max(0, Math.min(1 - box.h, box.y));
    var sig = $('#placeSig');
    sig.style.left = (b.left + box.x * b.w) + 'px';
    sig.style.top = (b.top + box.y * b.h) + 'px';
    sig.style.width = (box.w * b.w) + 'px';
    sig.style.height = 'auto';
  }

  (function dragSig() {
    var sig = $('#placeSig'), grab = null;
    sig.addEventListener('pointerdown', function (e) {
      var b = placeBox();
      grab = [(e.clientX - b.pageLeft) / b.w - S.sig.box.x, (e.clientY - b.pageTop) / b.h - S.sig.box.y];
      sig.setPointerCapture(e.pointerId);
      e.preventDefault();
    });
    sig.addEventListener('pointermove', function (e) {
      if (!grab) return;
      var b = placeBox();
      S.sig.box.x = (e.clientX - b.pageLeft) / b.w - grab[0];
      S.sig.box.y = (e.clientY - b.pageTop) / b.h - grab[1];
      layoutSig();
      e.preventDefault();
    });
    function up() { grab = null; }
    sig.addEventListener('pointerup', up);
    sig.addEventListener('pointercancel', up);
  })();

  function resize(f) {
    var box = S.sig.box, cx = box.x + box.w / 2, cy = box.y + box.h / 2;
    box.w = Math.max(0.08, Math.min(0.95, box.w * f));
    fitSigBox();
    box.x = cx - box.w / 2;
    box.y = cy - box.h / 2;
    layoutSig();
  }
  $('#sigSmall').onclick = function () { resize(1 / 1.18); };
  $('#sigBig').onclick = function () { resize(1.18); };
  $('#placeBack').onclick = function () { openPage(S.idx); };

  $('#sigApply').onclick = function () {
    var p = S.pages[S.idx];
    var box = S.sig.box, blob = S.sig.blob, fresh = S.sig.fresh;
    p.marks = (p.marks || []).concat([{
      blob: blob, x: box.x, y: box.y, w: box.w, h: box.h, rot: p.rotate || 0
    }]);
    busy(true, 'Putting it on the page');
    reprocess(p).then(function () {
      if (S.idx === 0) { S.doc.cover = p.thumb; return STORE.putDoc(S.doc); }
    }).catch(function () { toast('The signature would not go on.'); })
      .then(function () {
        busy(false);
        openPage(S.idx);
        if (fresh) offerToKeep(blob);
      });
  };

  function offerToKeep(blob) {
    toast('Keep this signature for next time?', 'Keep it', function () {
      keepSignature(blob);
    });
  }

  // ---- the saved signatures, and what guards them ----

  function keepSignature(blob) {
    LOCK.state().then(function (st) {
      if (!LOCK.available()) { toast('This browser has no way to lock it away.'); return; }
      if (!st.pinSet) return askNewPin(blob);
      if (LOCK.isOpen()) return storeSignature(blob);
      return unlockThen(function () { storeSignature(blob); });
    });
  }

  function storeSignature(blob) {
    return LOCK.encrypt(blob).then(function (rec) {
      rec.id = STORE.id();
      rec.created = Date.now();
      return STORE.putSig(rec);
    }).then(function () { toast('Saved.'); })
      .catch(function () { toast('It did not save.'); });
  }

  function pinSheet(opts) {
    sheet(function (body, close) {
      body.appendChild(el('h2', null, opts.title));
      if (opts.note) body.appendChild(el('p', null, opts.note));
      var dots = el('div', { class: 'dots' });
      for (var i = 0; i < 8; i++) dots.appendChild(el('i'));
      body.appendChild(dots);
      var msg = el('p', { class: 'pinmsg' }, '');
      body.appendChild(msg);

      var pin = '';
      function paint() {
        [].forEach.call(dots.children, function (d, i) { d.classList.toggle('on', i < pin.length); });
      }
      var keys = el('div', { class: 'keys' });
      '123456789'.split('').forEach(function (k) { keys.appendChild(key(k)); });
      keys.appendChild(back());
      keys.appendChild(key('0'));
      keys.appendChild(go());

      function key(k) {
        var b = el('button', null, k);
        b.onclick = function () { if (pin.length < 8) { pin += k; paint(); } };
        return b;
      }
      function back() {
        var b = el('button', { class: 'wide', 'aria-label': 'Delete' }, '⌫');
        b.onclick = function () { pin = pin.slice(0, -1); paint(); };
        return b;
      }
      function go() {
        var b = el('button', { class: 'wide primary' }, 'OK');
        b.onclick = function () {
          if (pin.length < 4) { msg.textContent = 'Four numbers or more.'; return; }
          var v = pin; pin = ''; paint();
          opts.onPin(v, function (err) { msg.textContent = err; }, close);
        };
        return b;
      }
      body.appendChild(keys);
      var stack = el('div', { class: 'stack' });
      var cancel = el('button', null, 'Cancel');
      cancel.onclick = close;
      stack.appendChild(cancel);
      body.appendChild(stack);
      paint();
    });
  }

  function askNewPin(blob) {
    pinSheet({
      title: 'Choose a PIN',
      note: 'The PIN unlocks the saved signature. It is not written down anywhere, so nobody can look it up — and neither can you.',
      onPin: function (first, fail, close) {
        close();
        pinSheet({
          title: 'Again, to be sure',
          onPin: function (second, fail2, close2) {
            if (second !== first) { fail2('Those two did not match.'); return; }
            close2();
            busy(true, 'Locking it');
            LOCK.setPin(first).then(function () {
              busy(false);
              if (blob) storeSignature(blob);
              offerBiometric();
            }).catch(function () { busy(false); toast('The PIN did not take.'); });
          }
        });
      }
    });
  }

  function offerBiometric() {
    if (!window.PublicKeyCredential || !window.isSecureContext) return;
    sheet(function (body, close) {
      body.appendChild(el('h2', null, 'Fingerprint'));
      body.appendChild(el('p', null,
        'The phone can hold the key behind your fingerprint, so the PIN is only needed as a fallback.'));
      var stack = el('div', { class: 'stack' });
      var yes = el('button', { class: 'primary' }, 'Turn it on');
      yes.onclick = function () {
        close();
        busy(true, 'Ask the phone');
        LOCK.addBiometric().then(function () {
          busy(false); toast('The fingerprint opens it now.');
        }).catch(function (e) {
          busy(false);
          toast(e && e.message === 'no-prf'
            ? 'This phone will not hold a key behind the fingerprint. The PIN still works.'
            : 'The fingerprint was not set up.');
        });
      };
      var no = el('button', null, 'Not now');
      no.onclick = close;
      stack.appendChild(yes); stack.appendChild(no);
      body.appendChild(stack);
    });
  }

  function unlockThen(after) {
    LOCK.state().then(function (st) {
      if (!st.pinSet) { toast('Nothing is saved yet.'); return; }
      if (st.bioSet) {
        busy(true, 'Ask the phone');
        LOCK.openWithBiometric().then(function () {
          busy(false); after();
        }).catch(function () {
          busy(false); pinUnlock(after);
        });
        return;
      }
      pinUnlock(after);
    });
  }

  function pinUnlock(after) {
    pinSheet({
      title: 'PIN',
      onPin: function (v, fail, close) {
        busy(true, 'Opening');
        LOCK.openWithPin(v).then(function () {
          busy(false); close(); after();
        }).catch(function () {
          busy(false);
          fail('That PIN did not open it.');
        });
      }
    });
  }

  $('#signSaved').onclick = function () {
    LOCK.state().then(function (st) {
      if (!st.pinSet) { toast('No signature is saved yet.'); return; }
      if (LOCK.isOpen()) return savedSheet();
      unlockThen(savedSheet);
    });
  };

  function savedSheet() {
    STORE.listSigs().then(function (sigs) {
      return Promise.all(sigs.map(function (s) {
        return LOCK.decrypt(s).then(function (b) { return { id: s.id, blob: b }; });
      }));
    }).then(function (items) {
      sheet(function (body, close) {
        body.appendChild(el('h2', null, 'Saved signatures'));
        if (!items.length) body.appendChild(el('p', null, 'None kept yet.'));
        var row = el('div', { class: 'sigrow' });
        items.forEach(function (it) {
          var line = el('div', { class: 'item' });
          var img = el('img', { alt: 'A saved signature' });
          img.src = url(it.blob);
          var use = el('button', { class: 'use' }, 'Use');
          use.onclick = function () { close(); useSignature(it.blob, false); };
          var del = el('button', null, 'Delete');
          del.onclick = function () {
            STORE.deleteSig(it.id).then(function () { close(); savedSheet(); });
          };
          line.appendChild(img); line.appendChild(use); line.appendChild(del);
          row.appendChild(line);
        });
        body.appendChild(row);

        var stack = el('div', { class: 'stack' });
        var bio = el('button', null, 'Use the fingerprint');
        bio.onclick = function () { close(); offerBiometric(); };
        var chg = el('button', null, 'Change the PIN');
        chg.onclick = function () { close(); askNewPin(null); };
        var lock = el('button', null, 'Lock it again');
        lock.onclick = function () { LOCK.close(); close(); toast('Locked.'); };
        var forget = el('button', { class: 'danger' }, 'Forget all of them');
        forget.onclick = function () {
          if (!confirm('Delete every saved signature and the PIN?')) return;
          LOCK.forget().then(function () { close(); toast('Gone.'); });
        };
        [bio, chg, lock, forget].forEach(function (b) { stack.appendChild(b); });
        body.appendChild(stack);
      });
    }).catch(function () { toast('They would not open.'); });
  }

  // ---------------------------------------------------------------- export

  function buildPdf() {
    var jobs = S.pages.map(function (p) {
      return p.blob.arrayBuffer().then(function (buf) {
        return { bytes: new Uint8Array(buf), w: p.w, h: p.h };
      });
    });
    return Promise.all(jobs).then(function (pages) {
      return PDF.build(pages, {
        pageSize: S.doc.pageSize, title: S.doc.name, date: new Date(S.doc.created)
      });
    });
  }

  function exportPdf(share) {
    if (!S.pages.length) { toast('Nothing to put in a PDF yet.'); return Promise.resolve(); }
    busy(true, 'Building the PDF');
    return buildPdf().then(function (blob) {
      busy(false);
      var name = safeName(S.doc.name) + '.pdf';
      if (share && navigator.canShare) {
        var file = new File([blob], name, { type: 'application/pdf' });
        if (navigator.canShare({ files: [file] })) {
          return navigator.share({ files: [file], title: S.doc.name })
            .catch(function (e) { if (e && e.name !== 'AbortError') download(blob, name); });
        }
      }
      download(blob, name);
      toast(share ? 'Sharing is off here. The PDF was saved instead.' : 'Saved ' + name);
    }).catch(function (e) {
      busy(false);
      toast('The PDF did not build.');
    });
  }

  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }

  $('#savePdf').onclick = function () { exportPdf(false); };
  $('#sharePdf').onclick = function () { exportPdf(true); };

  // ---------------------------------------------------------------- start

  window.addEventListener('popstate', function () {
    if ($('#crop').classList.contains('show')) { openPage(S.idx); history.pushState(null, ''); }
    else if ($('#place').classList.contains('show')) { openPage(S.idx); history.pushState(null, ''); }
    else if ($('#sign').classList.contains('show')) { openPage(S.idx); history.pushState(null, ''); }
    else if ($('#page').classList.contains('show')) { show('doc'); renderDoc(); history.pushState(null, ''); }
    else if ($('#capture').classList.contains('show')) { stopCamera(); finishCapture(); history.pushState(null, ''); }
    else if ($('#tables').classList.contains('show')) { S.tbl = null; show('home'); renderHome(); history.pushState(null, ''); }
    else if ($('#doc').classList.contains('show')) { show('home'); renderHome(); history.pushState(null, ''); }
  });
  history.pushState(null, '');

  renderHome();

  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () { });
  }
})();
