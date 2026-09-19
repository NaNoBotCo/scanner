/* store.js — documents and pages in IndexedDB on this phone. */
(function (root) {
  'use strict';

  var DB = 'scanner', VER = 2, db = null;

  function open() {
    if (db) return Promise.resolve(db);
    return new Promise(function (res, rej) {
      var rq = indexedDB.open(DB, VER);
      rq.onupgradeneeded = function () {
        var d = rq.result;
        if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('pages')) {
          var s = d.createObjectStore('pages', { keyPath: 'id' });
          s.createIndex('docId', 'docId');
        }
        if (!d.objectStoreNames.contains('sigs')) d.createObjectStore('sigs', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'id' });
      };
      rq.onsuccess = function () { db = rq.result; res(db); };
      rq.onerror = function () { rej(rq.error); };
    });
  }

  function req(r) {
    return new Promise(function (res, rej) {
      r.onsuccess = function () { res(r.result); };
      r.onerror = function () { rej(r.error); };
    });
  }

  function id() {
    return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  }

  function listDocs() {
    return open().then(function (d) {
      return req(d.transaction('docs').objectStore('docs').getAll());
    }).then(function (rows) {
      rows.sort(function (a, b) { return b.updated - a.updated; });
      return rows;
    });
  }

  function getDoc(docId) {
    return open().then(function (d) { return req(d.transaction('docs').objectStore('docs').get(docId)); });
  }

  function putDoc(doc) {
    doc.updated = Date.now();
    return open().then(function (d) {
      return req(d.transaction('docs', 'readwrite').objectStore('docs').put(doc));
    }).then(function () { return doc; });
  }

  function newDoc(name) {
    var now = Date.now();
    return putDoc({
      id: id(), name: name, created: now, updated: now,
      order: [], pageSize: 'auto', filter: 'colour', quality: 'normal'
    });
  }

  function deleteDoc(docId) {
    return pagesOf(docId).then(function (pages) {
      return open().then(function (d) {
        var t = d.transaction(['docs', 'pages'], 'readwrite');
        t.objectStore('docs').delete(docId);
        pages.forEach(function (p) { t.objectStore('pages').delete(p.id); });
        return new Promise(function (res, rej) { t.oncomplete = res; t.onerror = function () { rej(t.error); }; });
      });
    });
  }

  function pagesOf(docId) {
    return open().then(function (d) {
      return req(d.transaction('pages').objectStore('pages').index('docId').getAll(docId));
    });
  }

  function getPage(pageId) {
    return open().then(function (d) { return req(d.transaction('pages').objectStore('pages').get(pageId)); });
  }

  function putPage(page) {
    return open().then(function (d) {
      return req(d.transaction('pages', 'readwrite').objectStore('pages').put(page));
    }).then(function () { return page; });
  }

  function deletePage(pageId) {
    return open().then(function (d) {
      return req(d.transaction('pages', 'readwrite').objectStore('pages').delete(pageId));
    });
  }


  function listSigs() {
    return open().then(function (d) {
      return req(d.transaction('sigs').objectStore('sigs').getAll());
    }).then(function (rows) {
      rows.sort(function (a, b) { return b.created - a.created; });
      return rows;
    });
  }

  function putSig(sig) {
    return open().then(function (d) {
      return req(d.transaction('sigs', 'readwrite').objectStore('sigs').put(sig));
    }).then(function () { return sig; });
  }

  function deleteSig(sigId) {
    return open().then(function (d) {
      return req(d.transaction('sigs', 'readwrite').objectStore('sigs').delete(sigId));
    });
  }

  function getMeta(k) {
    return open().then(function (d) { return req(d.transaction('meta').objectStore('meta').get(k)); });
  }

  function putMeta(m) {
    return open().then(function (d) {
      return req(d.transaction('meta', 'readwrite').objectStore('meta').put(m));
    }).then(function () { return m; });
  }

  function usage() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return navigator.storage.estimate();
  }

  root.STORE = {
    id: id, listDocs: listDocs, getDoc: getDoc, putDoc: putDoc, newDoc: newDoc,
    deleteDoc: deleteDoc, pagesOf: pagesOf, getPage: getPage, putPage: putPage,
    deletePage: deletePage, usage: usage,
    listSigs: listSigs, putSig: putSig, deleteSig: deleteSig, getMeta: getMeta, putMeta: putMeta
  };
})(typeof self !== 'undefined' ? self : this);
