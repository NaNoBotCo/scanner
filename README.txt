SCANNER
A page scanner that runs in the phone's browser.


WHAT IT DOES

  Photograph a page.  The app finds the sheet in the photo, straightens it,
  flattens the light so the paper reads white, and keeps it as a page.
  Pages become a PDF.

  Capture          camera, or photos already on the phone
  Straighten       corners found on their own; drag them when they are wrong
  Filters          Colour, Grey, Text (black and white), Photo
  Edit             reorder, turn, crop again, delete with an undo
  Sign             a full-screen pad for a finger, or the ink lifted off a
                   photograph of a signature
  Export           PDF, sized Auto / A4 / Letter / Legal; save or share
  PDF to sheet     read a table off a PDF that carries text and hand back a
                   spreadsheet: CSV, or Excel with a sheet per page.  A ruled
                   table is read off its own borders, so merged cells and
                   stacked headers come out right; a borderless one is read from
                   the spacing.  A photographed page holds no text: it waits on
                   OCR.


WHERE IT RUNS

  https://nanobotco.github.io/scanner/

  Open it once on the phone, then Add to Home Screen.  It runs from the home
  screen like any other app and opens without a connection.

  Everything happens in the browser on the phone: capture, straightening,
  filters, PDF assembly, the signature lock.  Pages and signatures are written
  to the browser's own storage.  Clearing the browser's site data for this
  address clears them too.


THE SIGNATURE LOCK

  A signature is only saved if you ask for it.  Saving one asks for a PIN.

  A random 256-bit key encrypts every saved signature (AES-GCM).  That key is
  wrapped under a second key derived from the PIN (PBKDF2-SHA256, 310,000
  rounds, random salt), and — where the phone offers the WebAuthn PRF extension
  — under a secret the fingerprint sensor returns.  Either one opens it.

  Storage holds ciphertext and salts.  A wrong PIN derives a key that opens
  nothing, so there is no stored value for a guess to be checked against, and
  no way back in once both the PIN and the fingerprint are gone: the signatures
  would have to be added again.

  What this does not do: it is not a second factor, and it does not outrank the
  phone's own lock screen.  Anyone holding the phone unlocked, in this app,
  knowing the PIN, can sign.  A signature used straight away — drawn now, or
  lifted from a photo now — is not locked at all.

  Fingerprint unlock needs Chrome's WebAuthn PRF extension on the phone.  Where
  that is missing the app says so and the PIN carries it.


WORKING ON IT

  ./tools/serve.py 8821          http://127.0.0.1:8821/docs/
  ./publish.sh "what changed"    style gate, icons, push to GitHub Pages
  ./tools/icons.py               redraw the app icons
  ./tools/make_test_photo.py     a synthetic photo of a page on a desk
  ./tools/make_test_signature.py a synthetic photo of a signature

  The camera needs https, or localhost.  Over the LAN by IP the browser
  withholds it; use the published address on the phone.

  docs/  is the site.  No build step.
    index.html   the screens
    app.css      one stylesheet
    js/imaging.js  corner detection, perspective warp, filters, ink lift
    js/pdf.js      PDF assembly, JPEG pages embedded as DCTDecode
    js/tables.js   PDF text -> grid, then CSV or .xlsx
    js/store.js    IndexedDB
    js/lock.js     the PIN, the data key, WebAuthn PRF
    js/worker.js   the heavy work, off the main thread
    js/ui.js       screens and wiring
    js/vendor/pdfjs/  Mozilla's pdf.js, loaded only for PDF to sheet
    sw.js          the offline cache


LICENCE

  MIT.  See LICENSE.

  js/vendor/pdfjs/ is Mozilla's pdf.js, Apache 2.0, bundled unchanged so the
  feature runs offline with nothing fetched at use.
