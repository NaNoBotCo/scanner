/* pdfdoc.js — a PDF opened as pages to move, turn, delete or sign.
   pdf.js (already here for PDF → sheet) draws each page as a picture for the
   screen. On the way out, pdf-lib copies the original pages in the new order,
   so their text and lines stay as they were. A page with a signature on it, or
   from a PDF pdf-lib cannot copy (a locked one), goes out as its picture. */
(function (root) {
  'use strict';

  var LIB = 'js/vendor/pdflib/pdf-lib.min.js';
  var libPromise = null;

  /* Load pdf-lib the first time it is asked for, not at start-up. */
  function ensureLib() {
    if (root.PDFLib) return Promise.resolve(root.PDFLib);
    if (libPromise) return libPromise;
    libPromise = new Promise(function (res, rej) {
      var s = document.createElement('script');
      s.src = LIB;
      s.onload = function () {
        if (root.PDFLib) res(root.PDFLib);
        else rej(new Error('pdf-lib did not load'));
      };
      s.onerror = function () { libPromise = null; rej(new Error('pdf-lib did not load')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  /* Draw every page of a PDF, longest side maxEdge pixels, white behind it.
     onPage(i, n, { blob, thumb, w, h, scale }) runs for each page in turn and may
     return a promise; scale is pixels per PDF point. Resolves to the page count. */
  function render(bytes, maxEdge, onPage) {
    var pdf;
    return TABLES.ensureLib().then(function (lib) {
      return lib.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
    }).then(function (d) {
      pdf = d;
      var n = pdf.numPages, chain = Promise.resolve();
      function one(i) {
        return pdf.getPage(i).then(function (page) {
          var base = page.getViewport({ scale: 1 });
          var scale = Math.min(maxEdge / Math.max(base.width, base.height), 4);
          var vp = page.getViewport({ scale: scale });
          var c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(vp.width));
          c.height = Math.max(1, Math.round(vp.height));
          var ctx = c.getContext('2d');
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, c.width, c.height);
          return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
            page.cleanup();
            return Promise.all([
              IMG.toBlob(c, 'image/jpeg', 0.88),
              IMG.toBlob(IMG.thumbnail(c, 320), 'image/jpeg', 0.7)
            ]);
          }).then(function (b) {
            var out = { blob: b[0], thumb: b[1], w: c.width, h: c.height, scale: c.width / base.width };
            c.width = c.height = 0;
            return onPage(i, n, out);
          });
        });
      }
      for (var i = 1; i <= n; i++) chain = chain.then(one.bind(null, i));
      return chain.then(function () { return n; });
    }).then(function (n) {
      pdf.destroy();
      return n;
    }, function (err) {
      if (pdf) pdf.destroy();
      throw err;
    });
  }

  /* pages: the document's pages in order. A page from a PDF carries src (its
     source's id) and n (its index there); any other page is a JPEG in p.blob.
     srcBytes(id) resolves to that source's bytes.
     Resolves to { blob, pictured }: pictured counts PDF pages that had to go
     out as pictures because their PDF would not copy. */
  function build(pages, opts, srcBytes) {
    opts = opts || {};
    var L, out, copied = {}, pictured = 0;

    function signed(p) { return !!(p.marks && p.marks.length); }

    return ensureLib().then(function (lib) {
      L = lib;
      return L.PDFDocument.create();
    }).then(function (d) {
      out = d;
      out.setTitle(opts.title || 'Scan');
      out.setProducer('Scanner');
      out.setCreator('Scanner');
      out.setCreationDate(opts.date || new Date());

      /* One copyPages per source, so fonts its pages share are copied once. */
      var want = {};
      pages.forEach(function (p) {
        if (!p.src || signed(p)) return;
        var list = want[p.src] = want[p.src] || [];
        if (list.indexOf(p.n) < 0) list.push(p.n);
      });
      var chain = Promise.resolve();
      Object.keys(want).forEach(function (id) {
        chain = chain.then(function () {
          return srcBytes(id).then(function (bytes) {
            return L.PDFDocument.load(bytes, { updateMetadata: false });
          }).then(function (src) {
            return out.copyPages(src, want[id]);
          }).then(function (cps) {
            copied[id] = {};
            want[id].forEach(function (n, k) { copied[id][n] = cps[k]; });
          }).catch(function () { copied[id] = null; });
        });
      });
      return chain;
    }).then(function () {
      var chain = Promise.resolve();
      pages.forEach(function (p) {
        chain = chain.then(function () {
          var cp = p.src && !signed(p) && copied[p.src] ? copied[p.src][p.n] : null;
          if (cp) {
            if (p.rotate) cp.setRotation(L.degrees((((cp.getRotation().angle + p.rotate) % 360) + 360) % 360));
            out.addPage(cp);
            return;
          }
          if (p.src && !signed(p)) pictured++;
          return p.blob.arrayBuffer().then(function (buf) {
            return out.embedJpg(new Uint8Array(buf));
          }).then(function (img) {
            var box = p.src
              ? { W: p.w / p.scale, H: p.h / p.scale, x: 0, y: 0, w: p.w / p.scale, h: p.h / p.scale }
              : PDF.pageBox(p, opts.pageSize || 'auto', opts.dpi || 200);
            out.addPage([box.W, box.H]).drawImage(img, { x: box.x, y: box.y, width: box.w, height: box.h });
          });
        });
      });
      return chain;
    }).then(function () {
      return out.save();
    }).then(function (bytes) {
      return { blob: new Blob([bytes], { type: 'application/pdf' }), pictured: pictured };
    });
  }

  root.PDFDOC = { ensureLib: ensureLib, render: render, build: build };
})(typeof self !== 'undefined' ? self : this);
