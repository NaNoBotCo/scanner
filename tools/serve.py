#!/usr/bin/env python3
"""Local server for working on the app. Serves the tree, and accepts
POST /_save/<name> so a test run in the browser can drop a file in
tools/testdata/out/ for inspection."""
import http.server, pathlib, socketserver, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / "tools" / "testdata" / "out"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    def do_POST(self):
        if not self.path.startswith("/_save/"):
            self.send_error(404)
            return
        name = pathlib.Path(self.path[len("/_save/"):]).name
        if not name:
            self.send_error(400)
            return
        n = int(self.headers.get("Content-Length", 0))
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / name).write_bytes(self.rfile.read(n))
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"ok")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, *a):
        pass


port = int(sys.argv[1]) if len(sys.argv) > 1 else 8821
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("127.0.0.1", port), Handler) as srv:
    print("scanner on http://127.0.0.1:%d/docs/" % port, flush=True)
    srv.serve_forever()
