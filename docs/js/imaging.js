/* imaging.js — corner detection, perspective warp, page filters.
   Loaded both as a <script> on the page and via importScripts() in the worker,
   so it defines one global and touches no DOM. */
(function (root) {
  'use strict';

  // ---------- canvas helpers that work on a page or in a worker ----------

  function makeCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(w, h);
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    return c;
  }

  function toBlob(canvas, type, quality) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type: type, quality: quality });
    return new Promise(function (res) { canvas.toBlob(res, type, quality); });
  }

  function drawToData(source, w, h) {
    var c = makeCanvas(w, h);
    var ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(source, 0, 0, w, h);
    return ctx.getImageData(0, 0, w, h);
  }

  // ---------- grayscale, blur, threshold ----------

  function toGray(data, w, h) {
    var g = new Uint8ClampedArray(w * h), d = data.data, i, j;
    for (i = 0, j = 0; j < g.length; i += 4, j++) {
      g[j] = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8;
    }
    return g;
  }

  // Integral image over a Uint8 plane. Returns Float64Array of (w+1)*(h+1).
  function integral(src, w, h) {
    var s = new Float64Array((w + 1) * (h + 1)), x, y, rowSum;
    for (y = 0; y < h; y++) {
      rowSum = 0;
      for (x = 0; x < w; x++) {
        rowSum += src[y * w + x];
        s[(y + 1) * (w + 1) + (x + 1)] = s[y * (w + 1) + (x + 1)] + rowSum;
      }
    }
    return s;
  }

  // Mean of the r-radius box around every pixel, from an integral image.
  function boxMean(sum, w, h, r, out) {
    var x, y, x0, x1, y0, y1, area, W = w + 1;
    out = out || new Float32Array(w * h);
    for (y = 0; y < h; y++) {
      y0 = y - r < 0 ? 0 : y - r;
      y1 = y + r >= h ? h - 1 : y + r;
      for (x = 0; x < w; x++) {
        x0 = x - r < 0 ? 0 : x - r;
        x1 = x + r >= w ? w - 1 : x + r;
        area = (x1 - x0 + 1) * (y1 - y0 + 1);
        out[y * w + x] = (sum[(y1 + 1) * W + (x1 + 1)] - sum[y0 * W + (x1 + 1)]
          - sum[(y1 + 1) * W + x0] + sum[y0 * W + x0]) / area;
      }
    }
    return out;
  }

  function otsu(gray) {
    var hist = new Float64Array(256), i, total = gray.length;
    for (i = 0; i < total; i++) hist[gray[i]]++;
    var sumAll = 0;
    for (i = 0; i < 256; i++) sumAll += i * hist[i];
    var sumB = 0, wB = 0, wF, best = 0, thr = 127, mB, mF, between;
    for (i = 0; i < 256; i++) {
      wB += hist[i]; if (wB === 0) continue;
      wF = total - wB; if (wF === 0) break;
      sumB += i * hist[i];
      mB = sumB / wB; mF = (sumAll - sumB) / wF;
      between = wB * wF * (mB - mF) * (mB - mF);
      if (between > best) { best = between; thr = i; }
    }
    return thr;
  }

  // ---------- document corner detection ----------

  function largestBlob(mask, w, h) {
    var label = new Int32Array(w * h), stack = new Int32Array(w * h);
    var cur = 0, bestSize = 0, bestLabel = -1, i, sp, p, px, py, size;
    for (i = 0; i < mask.length; i++) {
      if (!mask[i] || label[i]) continue;
      cur++; sp = 0; stack[sp++] = i; label[i] = cur; size = 0;
      while (sp > 0) {
        p = stack[--sp]; size++;
        px = p % w; py = (p - px) / w;
        if (px > 0 && mask[p - 1] && !label[p - 1]) { label[p - 1] = cur; stack[sp++] = p - 1; }
        if (px < w - 1 && mask[p + 1] && !label[p + 1]) { label[p + 1] = cur; stack[sp++] = p + 1; }
        if (py > 0 && mask[p - w] && !label[p - w]) { label[p - w] = cur; stack[sp++] = p - w; }
        if (py < h - 1 && mask[p + w] && !label[p + w]) { label[p + w] = cur; stack[sp++] = p + w; }
      }
      if (size > bestSize) { bestSize = size; bestLabel = cur; }
    }
    return { label: label, id: bestLabel, size: bestSize };
  }

  function cornersOf(label, id, w, h) {
    var i, x, y, s, d, best = [Infinity, -Infinity, -Infinity, Infinity];
    var pts = [null, null, null, null];
    for (i = 0; i < label.length; i++) {
      if (label[i] !== id) continue;
      x = i % w; y = (i - x) / w; s = x + y; d = x - y;
      if (s < best[0]) { best[0] = s; pts[0] = [x, y]; }          // top-left
      if (d > best[1]) { best[1] = d; pts[1] = [x, y]; }          // top-right
      if (s > best[2]) { best[2] = s; pts[2] = [x, y]; }          // bottom-right
      if (d < best[3]) { best[3] = d; pts[3] = [x, y]; }          // bottom-left
    }
    return pts;
  }

  function polyArea(q) {
    var a = 0, i, j;
    for (i = 0, j = 3; i < 4; j = i++) a += q[j][0] * q[i][1] - q[i][0] * q[j][1];
    return Math.abs(a) / 2;
  }

  function isConvex(q) {
    var sign = 0, i, a, b, c, cross;
    for (i = 0; i < 4; i++) {
      a = q[i]; b = q[(i + 1) % 4]; c = q[(i + 2) % 4];
      cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
      if (cross === 0) continue;
      if (sign === 0) sign = cross > 0 ? 1 : -1;
      else if ((cross > 0 ? 1 : -1) !== sign) return false;
    }
    return true;
  }

  function dist(a, b) { return Math.hypot(a[0] - b[0], a[1] - b[1]); }

  function tryMask(mask, w, h, area) {
    var blob = largestBlob(mask, w, h);
    if (blob.id < 0 || blob.size < area * 0.12 || blob.size > area * 0.985) return null;
    var q = cornersOf(blob.label, blob.id, w, h);
    if (!q[0] || !q[1] || !q[2] || !q[3]) return null;
    if (!isConvex(q)) return null;
    if (polyArea(q) < area * 0.12) return null;
    var shortest = Math.min(dist(q[0], q[1]), dist(q[1], q[2]), dist(q[2], q[3]), dist(q[3], q[0]));
    if (shortest < Math.min(w, h) * 0.15) return null;
    // the blob should fill most of the quad it implies, or it is not a sheet
    if (blob.size < polyArea(q) * 0.7) return null;
    return q;
  }

  /* Find the page in a photo. Returns four [x,y] corners in FULL-resolution
     coordinates, clockwise from the top left, or null when nothing reads as a
     sheet — in which case the caller keeps the whole frame. */
  function detectQuad(source, fullW, fullH) {
    var W = 360, H = Math.max(1, Math.round(fullH * (W / fullW)));
    if (fullW < fullH) { H = 360; W = Math.max(1, Math.round(fullW * (H / fullH))); }
    var img = drawToData(source, W, H);
    var gray = toGray(img, W, H);
    var mean = boxMean(integral(gray, W, H), W, H, 2);
    var sm = new Uint8ClampedArray(W * H), i;
    for (i = 0; i < sm.length; i++) sm[i] = mean[i];

    var thr = otsu(sm), area = W * H;
    var bright = new Uint8Array(area), dark = new Uint8Array(area);
    for (i = 0; i < area; i++) { bright[i] = sm[i] > thr ? 1 : 0; dark[i] = sm[i] <= thr ? 1 : 0; }

    var q = tryMask(bright, W, H, area) || tryMask(dark, W, H, area);
    if (!q) return null;
    var sx = fullW / W, sy = fullH / H;
    return q.map(function (p) { return [p[0] * sx, p[1] * sy]; });
  }

  // ---------- perspective warp ----------

  // Solve for the homography taking the four src points to the four dst points.
  function homography(src, dst) {
    var A = [], b = [], i, x, y, u, v;
    for (i = 0; i < 4; i++) {
      x = src[i][0]; y = src[i][1]; u = dst[i][0]; v = dst[i][1];
      A.push([x, y, 1, 0, 0, 0, -x * u, -y * u]); b.push(u);
      A.push([0, 0, 0, x, y, 1, -x * v, -y * v]); b.push(v);
    }
    var n = 8, r, c, k, maxRow, tmp, factor;
    for (c = 0; c < n; c++) {
      maxRow = c;
      for (r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[maxRow][c])) maxRow = r;
      tmp = A[c]; A[c] = A[maxRow]; A[maxRow] = tmp;
      tmp = b[c]; b[c] = b[maxRow]; b[maxRow] = tmp;
      if (Math.abs(A[c][c]) < 1e-12) return null;
      for (r = c + 1; r < n; r++) {
        factor = A[r][c] / A[c][c];
        if (!factor) continue;
        for (k = c; k < n; k++) A[r][k] -= factor * A[c][k];
        b[r] -= factor * b[c];
      }
    }
    var h = new Float64Array(9);
    for (r = n - 1; r >= 0; r--) {
      var s = b[r];
      for (k = r + 1; k < n; k++) s -= A[r][k] * h[k];
      h[r] = s / A[r][r];
    }
    h[8] = 1;
    return h;
  }

  function quadSize(q, maxEdge) {
    var w = Math.max(dist(q[0], q[1]), dist(q[3], q[2]));
    var h = Math.max(dist(q[0], q[3]), dist(q[1], q[2]));
    var scale = Math.min(1, maxEdge / Math.max(w, h));
    return { w: Math.max(16, Math.round(w * scale)), h: Math.max(16, Math.round(h * scale)) };
  }

  function warp(img, srcW, srcH, quad, outW, outH) {
    var dstRect = [[0, 0], [outW, 0], [outW, outH], [0, outH]];
    var h = homography(dstRect, quad);
    if (!h) return null;
    var src = img.data;
    var out = new ImageData(outW, outH), o = out.data;
    var x, y, den, sx, sy, x0, y0, fx, fy, i0, i1, i2, i3, w0, w1, w2, w3, p = 0, ch;
    for (y = 0; y < outH; y++) {
      for (x = 0; x < outW; x++, p += 4) {
        den = h[6] * x + h[7] * y + 1;
        sx = (h[0] * x + h[1] * y + h[2]) / den;
        sy = (h[3] * x + h[4] * y + h[5]) / den;
        if (sx < 0) sx = 0; else if (sx > srcW - 1) sx = srcW - 1;
        if (sy < 0) sy = 0; else if (sy > srcH - 1) sy = srcH - 1;
        x0 = sx | 0; y0 = sy | 0;
        fx = sx - x0; fy = sy - y0;
        if (x0 > srcW - 2) { x0 = srcW - 2; fx = 1; }
        if (y0 > srcH - 2) { y0 = srcH - 2; fy = 1; }
        i0 = (y0 * srcW + x0) * 4; i1 = i0 + 4;
        i2 = i0 + srcW * 4; i3 = i2 + 4;
        w0 = (1 - fx) * (1 - fy); w1 = fx * (1 - fy);
        w2 = (1 - fx) * fy; w3 = fx * fy;
        for (ch = 0; ch < 3; ch++) {
          o[p + ch] = src[i0 + ch] * w0 + src[i1 + ch] * w1 + src[i2 + ch] * w2 + src[i3 + ch] * w3;
        }
        o[p + 3] = 255;
      }
    }
    return out;
  }

  // ---------- page filters ----------

  function stretch(v, black, white) {
    var t = (v - black) * 255 / (white - black);
    return t < 0 ? 0 : t > 255 ? 255 : t;
  }

  /* Divide the page by a heavily blurred copy of itself. Uneven light and the
     shadow of the hand holding the phone flatten out; paper reads as paper. */
  function flatten(imgData, w, h, mode) {
    var d = imgData.data, gray = toGray(imgData, w, h);
    var r = Math.round(Math.max(w, h) / 16);
    if (r < 8) r = 8; if (r > 240) r = 240;
    var bg = boxMean(integral(gray, w, h), w, h, r);
    var i, j, b, v, lo;

    if (mode === 'bw') {
      var win = Math.round(Math.max(w, h) / 24);
      if (win < 6) win = 6;
      var local = boxMean(integral(gray, w, h), w, h, win);
      for (i = 0, j = 0; j < gray.length; i += 4, j++) {
        v = gray[j] < local[j] * 0.88 ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      return imgData;
    }

    if (mode === 'gray') {
      for (i = 0, j = 0; j < gray.length; i += 4, j++) {
        b = bg[j] < 1 ? 1 : bg[j];
        v = stretch(gray[j] * 255 / b, 118, 246);
        d[i] = d[i + 1] = d[i + 2] = v;
      }
      return imgData;
    }

    // colour: scale every channel by the same illumination factor, then lift
    lo = 96;
    for (i = 0, j = 0; j < gray.length; i += 4, j++) {
      b = bg[j] < 1 ? 1 : bg[j];
      var k = 255 / b;
      d[i] = stretch(d[i] * k, lo, 250);
      d[i + 1] = stretch(d[i + 1] * k, lo, 250);
      d[i + 2] = stretch(d[i + 2] * k, lo, 250);
    }
    return imgData;
  }

  function rotateData(imgData, w, h, deg) {
    if (!deg) return { data: imgData, w: w, h: h };
    var c = makeCanvas(w, h), ctx = c.getContext('2d');
    ctx.putImageData(imgData, 0, 0);
    var rw = (deg === 90 || deg === 270) ? h : w;
    var rh = (deg === 90 || deg === 270) ? w : h;
    var c2 = makeCanvas(rw, rh), g = c2.getContext('2d', { willReadFrequently: true });
    g.translate(rw / 2, rh / 2);
    g.rotate(deg * Math.PI / 180);
    g.drawImage(c, -w / 2, -h / 2);
    return { data: g.getImageData(0, 0, rw, rh), w: rw, h: rh };
  }

  /* One page, start to finish: crop to the quad, flatten, rotate, encode. */
  function processPage(source, opts) {
    var sw = source.width, sh = source.height;
    var quad;
    if (opts.quad && opts.quad.length === 4) {
      // pull the corners a hair inwards, so the desk behind the sheet does not
      // show up as a dark sliver down one edge
      var cx = (opts.quad[0][0] + opts.quad[1][0] + opts.quad[2][0] + opts.quad[3][0]) / 4;
      var cy = (opts.quad[0][1] + opts.quad[1][1] + opts.quad[2][1] + opts.quad[3][1]) / 4;
      quad = opts.quad.map(function (p) {
        return [p[0] + (cx - p[0]) * 0.005, p[1] + (cy - p[1]) * 0.005];
      });
    } else {
      quad = [[0, 0], [sw, 0], [sw, sh], [0, sh]];
    }
    var maxEdge = opts.maxEdge || 2200;
    var img = drawToData(source, sw, sh);
    var size = quadSize(quad, maxEdge);
    var warped = warp(img, sw, sh, quad, size.w, size.h);
    if (!warped) return null;
    if (opts.filter && opts.filter !== 'photo') flatten(warped, size.w, size.h, opts.filter);
    var rot = rotateData(warped, size.w, size.h, ((opts.rotate || 0) % 360 + 360) % 360);
    var out = makeCanvas(rot.w, rot.h);
    out.getContext('2d').putImageData(rot.data, 0, 0);
    return { canvas: out, w: rot.w, h: rot.h };
  }

  function thumbnail(canvas, maxEdge) {
    var s = Math.min(1, maxEdge / Math.max(canvas.width, canvas.height));
    var w = Math.max(1, Math.round(canvas.width * s));
    var h = Math.max(1, Math.round(canvas.height * s));
    var c = makeCanvas(w, h);
    c.getContext('2d').drawImage(canvas, 0, 0, w, h);
    return c;
  }


  /* Lift the ink off a photograph of a signature: flatten the light, read how
     dark each pixel is against its own paper, and carry that across as alpha.
     Blue pen stays blue; the paper goes. */
  function inkFromPhoto(source) {
    var maxEdge = 1400;
    var sc = Math.min(1, maxEdge / Math.max(source.width, source.height));
    var w = Math.max(1, Math.round(source.width * sc));
    var h = Math.max(1, Math.round(source.height * sc));
    var img = drawToData(source, w, h);
    var d = img.data, gray = toGray(img, w, h);
    var r = Math.round(Math.max(w, h) / 10);
    if (r < 8) r = 8;
    var bg = boxMean(integral(gray, w, h), w, h, r);
    var i, j, b, v, a, k;
    var minX = w, minY = h, maxX = -1, maxY = -1;

    for (i = 0, j = 0; j < gray.length; i += 4, j++) {
      b = bg[j] < 1 ? 1 : bg[j];
      k = 255 / b;
      v = gray[j] * k;
      a = (232 - v) * 255 / 140;
      a = a < 0 ? 0 : a > 255 ? 255 : a;
      if (a < 40) { d[i + 3] = 0; continue; }
      d[i] = stretch(d[i] * k, 40, 250);
      d[i + 1] = stretch(d[i + 1] * k, 40, 250);
      d[i + 2] = stretch(d[i + 2] * k, 40, 250);
      d[i + 3] = a;
      var x = j % w, y = (j - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    if (maxX < 0) return null;

    var pad = Math.round(Math.max(w, h) * 0.012);
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    var cw = maxX - minX + 1, ch = maxY - minY + 1;
    var full = makeCanvas(w, h);
    full.getContext('2d').putImageData(img, 0, 0);
    var out = makeCanvas(cw, ch);
    out.getContext('2d').drawImage(full, minX, minY, cw, ch, 0, 0, cw, ch);
    return out;
  }

  /* Trim a drawn signature down to the ink. */
  function trimAlpha(canvas) {
    var w = canvas.width, h = canvas.height;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    var d = ctx.getImageData(0, 0, w, h).data;
    var minX = w, minY = h, maxX = -1, maxY = -1, x, y, i;
    for (y = 0; y < h; y++) {
      for (x = 0; x < w; x++) {
        i = (y * w + x) * 4 + 3;
        if (d[i] < 16) continue;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    if (maxX < 0) return null;
    var pad = Math.round(Math.max(w, h) * 0.01);
    minX = Math.max(0, minX - pad); minY = Math.max(0, minY - pad);
    maxX = Math.min(w - 1, maxX + pad); maxY = Math.min(h - 1, maxY + pad);
    var cw = maxX - minX + 1, ch = maxY - minY + 1;
    var out = makeCanvas(cw, ch);
    out.getContext('2d').drawImage(canvas, minX, minY, cw, ch, 0, 0, cw, ch);
    return out;
  }

  root.IMG = {
    makeCanvas: makeCanvas, toBlob: toBlob, drawToData: drawToData,
    detectQuad: detectQuad, processPage: processPage, thumbnail: thumbnail,
    quadSize: quadSize, inkFromPhoto: inkFromPhoto, trimAlpha: trimAlpha
  };
})(typeof self !== 'undefined' ? self : this);
