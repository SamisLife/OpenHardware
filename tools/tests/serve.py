"""
tests for tools/serve.py.

    python tools/tests/serve.py

One property, because it is the one that has cost real time three times over:
nothing this server sends may be cached. A stale module or stylesheet looks
exactly like an edit that did not work, and the page has no way to say so.
"""

import pathlib
import sys
import threading
import urllib.request
from http.server import ThreadingHTTPServer

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tools'))
import serve  # noqa: E402

passed = failed = 0


def ok(name, cond, detail=''):
    global passed, failed
    if cond:
        passed += 1
        print('  PASS  ' + name)
    else:
        failed += 1
        print('  FAIL  ' + name + (('  — ' + str(detail)) if detail else ''))


print('\n  serve\n')

httpd = ThreadingHTTPServer(('127.0.0.1', 0), serve.NoStore)
port = httpd.server_address[1]
threading.Thread(target=httpd.serve_forever, daemon=True).start()

try:
    with urllib.request.urlopen('http://127.0.0.1:%d/frontend/index.html' % port) as r:
        ok('the page is served from the repository root', r.status == 200)
        ok('and told not to be cached', r.headers.get('Cache-Control') == 'no-store',
           r.headers.get('Cache-Control'))

    with urllib.request.urlopen('http://127.0.0.1:%d/frontend/js/main.js' % port) as r:
        ok('a module carries the same header', r.headers.get('Cache-Control') == 'no-store')
        ok('and a JavaScript content type, or the browser refuses to import it',
           'javascript' in (r.headers.get('Content-Type') or ''), r.headers.get('Content-Type'))

    with urllib.request.urlopen('http://127.0.0.1:%d/frontend/styles/panels.css' % port) as r:
        ok('and so does a stylesheet', r.headers.get('Cache-Control') == 'no-store')
finally:
    httpd.shutdown()

print('\n  %d passed, %d failed\n' % (passed, failed))
sys.exit(1 if failed else 0)
