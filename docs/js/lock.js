/* lock.js — what guards a saved signature.

   A random 256-bit data key encrypts every saved signature (AES-GCM). That data
   key is then wrapped twice over: once under a key derived from the PIN
   (PBKDF2-SHA256, 310,000 rounds, random salt), and once — where the phone
   offers it — under a secret the fingerprint sensor returns through the WebAuthn
   PRF extension. Either one opens it; neither is written down.

   Storage holds ciphertext and salts. A wrong PIN derives a key that opens
   nothing, so there is no stored value for a guess to be checked against, and
   no way back in if both the PIN and the fingerprint are gone: the saved
   signatures would have to be added again.

   None of this outranks the phone's own lock screen. Anyone holding the phone
   unlocked, in this app, with the PIN, can sign. */
(function (root) {
  'use strict';

  var ROUNDS = 310000;
  var dataKey = null;                       // held in memory while the app is open
  var subtle = (root.crypto && root.crypto.subtle) ? root.crypto.subtle : null;

  function rand(n) { return root.crypto.getRandomValues(new Uint8Array(n)); }
  function available() { return !!subtle; }
  function isOpen() { return dataKey !== null; }
  function close() { dataKey = null; }

  function meta() { return STORE.getMeta('lock'); }

  function state() {
    return meta().then(function (m) {
      return {
        pinSet: !!(m && m.pin),
        bioSet: !!(m && m.bio),
        bioPossible: !!(root.PublicKeyCredential && root.isSecureContext),
        open: isOpen()
      };
    });
  }

  // ---- key handling -------------------------------------------------------

  function pinKey(pin, salt) {
    var enc = new TextEncoder();
    return subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveKey'])
      .then(function (base) {
        return subtle.deriveKey(
          { name: 'PBKDF2', salt: salt, iterations: ROUNDS, hash: 'SHA-256' },
          base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      });
  }

  function rawKey(bytes) {
    return subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  }

  function newDataKey() {
    return subtle.importKey('raw', rand(32), { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  }

  function wrap(wrapper, dk) {
    var iv = rand(12);
    return subtle.exportKey('raw', dk).then(function (raw) {
      return subtle.encrypt({ name: 'AES-GCM', iv: iv }, wrapper, raw);
    }).then(function (cipher) { return { iv: iv, cipher: cipher }; });
  }

  function unwrap(wrapper, rec) {
    return subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, wrapper, rec.cipher)
      .then(function (raw) {
        return subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
      });
  }

  // ---- PIN ----------------------------------------------------------------

  function setPin(pin) {
    return meta().then(function (m) {
      m = m || { id: 'lock' };
      var ready = dataKey ? Promise.resolve(dataKey) : newDataKey();
      return ready.then(function (dk) {
        dataKey = dk;
        var salt = rand(16);
        return pinKey(pin, salt).then(function (pk) {
          return wrap(pk, dk).then(function (w) {
            m.pin = { salt: salt, rounds: ROUNDS, iv: w.iv, cipher: w.cipher };
            m.updated = Date.now();
            return STORE.putMeta(m);
          });
        });
      });
    });
  }

  function openWithPin(pin) {
    return meta().then(function (m) {
      if (!m || !m.pin) return Promise.reject(new Error('no-pin'));
      return pinKey(pin, m.pin.salt).then(function (pk) {
        return unwrap(pk, m.pin);
      });
    }).then(function (dk) {
      dataKey = dk;
      return true;
    }).catch(function (e) {
      if (e && e.message === 'no-pin') throw e;
      throw new Error('wrong-pin');
    });
  }

  // ---- fingerprint / face -------------------------------------------------

  function prfFrom(credId, salt) {
    return navigator.credentials.get({
      publicKey: {
        challenge: rand(32),
        rpId: location.hostname,
        allowCredentials: credId ? [{ type: 'public-key', id: credId }] : [],
        userVerification: 'required',
        timeout: 60000,
        extensions: { prf: { eval: { first: salt } } }
      }
    }).then(function (asrt) {
      var ext = asrt.getClientExtensionResults();
      if (!ext || !ext.prf || !ext.prf.results || !ext.prf.results.first) {
        throw new Error('no-prf');
      }
      return rawKey(new Uint8Array(ext.prf.results.first));
    });
  }

  /* Needs the lock already open: the fingerprint gets its own wrap of the same
     data key, rather than a key of its own. */
  function addBiometric() {
    if (!dataKey) return Promise.reject(new Error('locked'));
    if (!root.PublicKeyCredential) return Promise.reject(new Error('no-bio'));
    var salt = rand(32), credId = null;
    return navigator.credentials.create({
      publicKey: {
        rp: { id: location.hostname, name: 'Scanner' },
        user: { id: rand(16), name: 'signature', displayName: 'Signature' },
        challenge: rand(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred'
        },
        timeout: 60000,
        extensions: { prf: {} }
      }
    }).then(function (cred) {
      if (!cred) throw new Error('no-bio');
      credId = new Uint8Array(cred.rawId);
      var ext = cred.getClientExtensionResults();
      if (ext && ext.prf && ext.prf.enabled === false) throw new Error('no-prf');
      return prfFrom(credId, salt);
    }).then(function (bk) {
      return wrap(bk, dataKey);
    }).then(function (w) {
      return meta().then(function (m) {
        m = m || { id: 'lock' };
        m.bio = { credId: credId, salt: salt, iv: w.iv, cipher: w.cipher };
        m.updated = Date.now();
        return STORE.putMeta(m);
      });
    });
  }

  function openWithBiometric() {
    return meta().then(function (m) {
      if (!m || !m.bio) return Promise.reject(new Error('no-bio'));
      return prfFrom(m.bio.credId, m.bio.salt).then(function (bk) {
        return unwrap(bk, m.bio);
      });
    }).then(function (dk) {
      dataKey = dk;
      return true;
    });
  }

  function removeBiometric() {
    return meta().then(function (m) {
      if (!m) return null;
      delete m.bio;
      return STORE.putMeta(m);
    });
  }

  // ---- the signatures themselves ------------------------------------------

  function encrypt(blob) {
    if (!dataKey) return Promise.reject(new Error('locked'));
    var iv = rand(12);
    return blob.arrayBuffer().then(function (buf) {
      return subtle.encrypt({ name: 'AES-GCM', iv: iv }, dataKey, buf);
    }).then(function (cipher) {
      return { iv: iv, cipher: cipher, type: blob.type || 'image/png' };
    });
  }

  function decrypt(rec) {
    if (!dataKey) return Promise.reject(new Error('locked'));
    return subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, dataKey, rec.cipher)
      .then(function (buf) { return new Blob([buf], { type: rec.type || 'image/png' }); });
  }

  /* Wipes the lock and everything it was holding. */
  function forget() {
    return STORE.listSigs().then(function (sigs) {
      return Promise.all(sigs.map(function (s) { return STORE.deleteSig(s.id); }));
    }).then(function () {
      dataKey = null;
      return STORE.putMeta({ id: 'lock' });
    });
  }

  root.LOCK = {
    available: available, state: state, isOpen: isOpen, close: close,
    setPin: setPin, openWithPin: openWithPin,
    addBiometric: addBiometric, openWithBiometric: openWithBiometric, removeBiometric: removeBiometric,
    encrypt: encrypt, decrypt: decrypt, forget: forget
  };
})(typeof self !== 'undefined' ? self : this);
