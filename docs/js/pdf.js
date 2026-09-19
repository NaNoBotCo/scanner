/* pdf.js — assembles a PDF around JPEG pages. The JPEG bytes go in untouched
   (DCTDecode), so export re-encodes nothing and the file stays small. */
(function (root) {
  'use strict';

  var PAGE_SIZES = {
    a4: [595.28, 841.89],
    letter: [612, 792],
    legal: [612, 1008]
  };

  function esc(s) {
    return String(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  }

  function textString(s) {
    var ascii = true, i;
    for (i = 0; i < s.length; i++) if (s.charCodeAt(i) > 126 || s.charCodeAt(i) < 32) { ascii = false; break; }
    if (ascii) return '(' + esc(s) + ')';
    var hex = 'FEFF';
    for (i = 0; i < s.length; i++) hex += ('000' + s.charCodeAt(i).toString(16).toUpperCase()).slice(-4);
    return '<' + hex + '>';
  }

  function pdfDate(d) {
    function p(n) { return ('0' + n).slice(-2); }
    var off = -d.getTimezoneOffset(), sign = off < 0 ? '-' : '+';
    off = Math.abs(off);
    return 'D:' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) +
      p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()) +
      sign + p(Math.floor(off / 60)) + "'" + p(off % 60) + "'";
  }

  /* JPEG colour components, so a grayscale-encoded page gets /DeviceGray. */
  function jpegChannels(bytes) {
    var i = 2;
    while (i < bytes.length - 9) {
      if (bytes[i] !== 0xFF) { i++; continue; }
      var marker = bytes[i + 1];
      if (marker >= 0xC0 && marker <= 0xCF && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC) {
        return bytes[i + 9];
      }
      i += 2 + (bytes[i + 2] << 8 | bytes[i + 3]);
    }
    return 3;
  }

  function pageBox(page, sizeName, dpi) {
    var pw = page.w, ph = page.h;
    if (sizeName === 'auto') {
      return { W: pw * 72 / dpi, H: ph * 72 / dpi, x: 0, y: 0, w: pw * 72 / dpi, h: ph * 72 / dpi };
    }
    var s = PAGE_SIZES[sizeName] || PAGE_SIZES.a4;
    var W = s[0], H = s[1];
    if (pw > ph) { W = s[1]; H = s[0]; }
    var scale = Math.min(W / pw, H / ph);
    var w = pw * scale, h = ph * scale;
    return { W: W, H: H, x: (W - w) / 2, y: (H - h) / 2, w: w, h: h };
  }

  /* pages: [{ bytes: Uint8Array (JPEG), w, h }]  */
  function build(pages, opts) {
    opts = opts || {};
    var sizeName = opts.pageSize || 'auto';
    var dpi = opts.dpi || 200;
    var title = opts.title || 'Scan';

    var chunks = [], length = 0, offsets = [0];
    var enc = new TextEncoder();

    function push(x) {
      var b = typeof x === 'string' ? enc.encode(x) : x;
      chunks.push(b); length += b.length;
    }
    function startObj(n) { offsets[n] = length; push(n + ' 0 obj\n'); }

    var nPages = pages.length;
    var firstPage = 4;                       // 1 catalog, 2 pages, 3 info
    var total = 3 + nPages * 3;

    push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');

    var kids = [], i;
    for (i = 0; i < nPages; i++) kids.push((firstPage + i * 3) + ' 0 R');

    startObj(1);
    push('<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    startObj(2);
    push('<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + nPages + ' >>\nendobj\n');

    startObj(3);
    push('<< /Title ' + textString(title) +
      ' /Producer ' + textString('Scanner') +
      ' /CreationDate ' + textString(pdfDate(opts.date || new Date())) + ' >>\nendobj\n');

    for (i = 0; i < nPages; i++) {
      var p = pages[i];
      var pageObj = firstPage + i * 3, contentObj = pageObj + 1, imgObj = pageObj + 2;
      var box = pageBox(p, sizeName, dpi);
      var content = 'q\n' + box.w.toFixed(2) + ' 0 0 ' + box.h.toFixed(2) + ' ' +
        box.x.toFixed(2) + ' ' + box.y.toFixed(2) + ' cm\n/Im0 Do\nQ\n';

      startObj(pageObj);
      push('<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + box.W.toFixed(2) + ' ' + box.H.toFixed(2) +
        '] /Resources << /XObject << /Im0 ' + imgObj + ' 0 R >> >> /Contents ' + contentObj + ' 0 R >>\nendobj\n');

      startObj(contentObj);
      push('<< /Length ' + content.length + ' >>\nstream\n' + content + 'endstream\nendobj\n');

      var cs = jpegChannels(p.bytes) === 1 ? '/DeviceGray' : '/DeviceRGB';
      startObj(imgObj);
      push('<< /Type /XObject /Subtype /Image /Width ' + p.w + ' /Height ' + p.h +
        ' /ColorSpace ' + cs + ' /BitsPerComponent 8 /Filter /DCTDecode /Length ' + p.bytes.length + ' >>\nstream\n');
      push(p.bytes);
      push('\nendstream\nendobj\n');
    }

    var xref = length;
    var out = 'xref\n0 ' + (total + 1) + '\n0000000000 65535 f \n';
    for (i = 1; i <= total; i++) out += ('0000000000' + offsets[i]).slice(-10) + ' 00000 n \n';
    out += 'trailer\n<< /Size ' + (total + 1) + ' /Root 1 0 R /Info 3 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
    push(out);

    return new Blob(chunks, { type: 'application/pdf' });
  }

  root.PDF = { build: build, sizes: PAGE_SIZES };
})(typeof self !== 'undefined' ? self : this);
