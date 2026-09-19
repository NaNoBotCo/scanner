/* worker.js — crop, flatten and encode off the main thread, so the page keeps
   responding while a scan is worked on. */
importScripts('imaging.js');

var QUALITY = { small: 1400, normal: 2200, large: 3000 };

self.onmessage = function (e) {
  var m = e.data;
  try {
    if (m.op === 'detect') {
      var q = IMG.detectQuad(m.bitmap, m.bitmap.width, m.bitmap.height);
      m.bitmap.close();
      self.postMessage({ id: m.id, quad: q });
      return;
    }
    if (m.op === 'process') {
      var maxEdge = QUALITY[m.quality] || QUALITY.normal;
      var r = IMG.processPage(m.bitmap, { quad: m.quad, filter: m.filter, rotate: m.rotate, maxEdge: maxEdge });
      var thumb = IMG.thumbnail(r.canvas, 320);
      Promise.all([
        IMG.toBlob(r.canvas, 'image/jpeg', m.filter === 'bw' ? 0.82 : 0.86),
        IMG.toBlob(thumb, 'image/jpeg', 0.7)
      ]).then(function (out) {
        m.bitmap.close();
        self.postMessage({ id: m.id, blob: out[0], thumb: out[1], w: r.w, h: r.h });
      }).catch(function (err) {
        self.postMessage({ id: m.id, error: String(err) });
      });
      return;
    }
  } catch (err) {
    self.postMessage({ id: m.id, error: String(err && err.message || err) });
  }
};
