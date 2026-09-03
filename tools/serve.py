"""
serve.py — the repository, served with no cache.

    python tools/serve.py            # http://localhost:8000/frontend/
    python tools/serve.py 8080

The frontend has no build step: the browser loads the ES modules and the
stylesheets straight off disk. That is the point of it, and it has one cost.
`python -m http.server` sends a Last-Modified header and nothing else, which
lets the browser apply its own heuristic freshness — and under that heuristic
a file edited a minute ago is fetched but a file edited an hour ago is served
from cache without a request. The symptom is an edit that plainly took (the
server log shows one file re-fetched) beside an edit that plainly did not (the
file it imports never appears in the log), and it has been mistaken for a bug
in the firmware, in the flasher and in the stylesheet in turn.

So every response here carries Cache-Control: no-store. A reload is a reload.
Nothing else differs from the standard server: same root, same paths, same
port by default, and the flasher finds the manifest where it always did.
"""

import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


class NoStore(SimpleHTTPRequestHandler):
    """Static files, never cached."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store')
        super().end_headers()

    # Chunked module loads make the default log a wall; one line per request
    # is still wanted, because "that file was never requested" is the finding
    # this server exists to make visible.
    def log_message(self, fmt, *args):
        sys.stderr.write('%s  %s\n' % (self.log_date_time_string(), fmt % args))


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    with ThreadingHTTPServer(('', port), NoStore) as httpd:
        print('serving %s with Cache-Control: no-store' % ROOT)
        print()
        print('    frontend  http://localhost:%d/frontend/' % port)
        print('    baseline  http://localhost:%d/firmware/baseline/manifest.json' % port)
        print()
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == '__main__':
    main()
