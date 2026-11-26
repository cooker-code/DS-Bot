"""Serve a fixed asset allowlist and bounded JSON APIs on loopback only."""
import json
import mimetypes
import sqlite3
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit
from .store import Store, CatalogError, Conflict
from . import community
from .source import branch, writable, group_names, ledger_path, coverage

ASSETS = Path(__file__).parent / 'assets'


def server(repo, database, port):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def send(self, status, body, content_type='application/json; charset=utf-8'):
            if not isinstance(body, bytes):body = json.dumps(body, ensure_ascii=False).encode()
            self.send_response(status)
            self.send_header('Content-Type', content_type)
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-store')
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'")
            self.end_headers();self.wfile.write(body)

        def host_ok(self):
            return self.headers.get('Host') == f'127.0.0.1:{self.server.server_port}'

        def do_GET(self):
            if not self.host_ok():return self.send(403, {'error': 'Invalid Host'})
            url = urlsplit(self.path)
            try:
                if url.path in ('/', '/app.js', '/style.css'):
                    file = ASSETS / ('index.html' if url.path == '/' else url.path[1:])
                    return self.send(200, file.read_bytes(), (mimetypes.guess_type(str(file))[0] or 'text/plain') + '; charset=utf-8')
                with Store(database, readonly=True) as db:
                    if url.path == '/api/meta':
                        current = branch(repo)
                        result = db.stats();result.update(branch=current, canExport=bool(current and current not in ('dev','main','master')), repo=str(repo), database=str(database), coverage=coverage(db,repo), groupNames=group_names(repo), groups=[r[0] for r in db.db.execute('SELECT DISTINCT dependency_group FROM prs WHERE dependency_group IS NOT NULL ORDER BY dependency_group')])
                        return self.send(200, result)
                    if url.path == '/api/community':return self.send(200,community.list_entries(db,{k:v[0] for k,v in parse_qs(url.query).items()}))
                    if url.path.startswith('/api/design/') and url.path[12:].isdigit():return self.send(200,community.design_detail(db,int(url.path[12:])))
                    if url.path == '/api/prs':return self.send(200, db.list({k: v[0] for k, v in parse_qs(url.query).items()}))
                    if url.path.startswith('/api/pr/') and url.path[8:].isdigit():return self.send(200, db.detail(int(url.path[8:])))
                self.send(404, {'error': 'Not found'})
            except CatalogError as exc:self.send(400, {'error': str(exc)})
            except sqlite3.Error:self.send(503, {'error': '台账暂忙或不可用，请稍后重试'})

        def do_POST(self):
            origin = f'http://127.0.0.1:{self.server.server_port}'
            if not self.host_ok() or self.headers.get('Origin') != origin:return self.send(403, {'error': '写入仅允许本地同源页面'})
            try:
                size = int(self.headers.get('Content-Length', '0'))
                if not 0 < size <= 12000:raise CatalogError('Invalid body size')
                if self.headers.get('Content-Type', '').split(';')[0] != 'application/json':raise CatalogError('JSON required')
                data = json.loads(self.rfile.read(size))
                if not isinstance(data, dict):raise CatalogError('JSON object required')
                with Store(database) as db:
                    if self.path == '/api/preference':
                        if type(data.get('number')) is not int or type(data.get('revision')) is not int:raise CatalogError('Invalid PR/revision')
                        return self.send(200, db.preference(data['number'], data.get('wanted'), data.get('reason', ''), data['revision']))
                    if self.path == '/api/export':
                        writable(repo)
                        return self.send(200, db.export(ledger_path(repo)))
                self.send(404, {'error': 'Not found'})
            except Conflict as exc:self.send(409, {'error': str(exc)})
            except (CatalogError, ValueError, TypeError) as exc:self.send(400, {'error': str(exc)})
            except sqlite3.Error:self.send(503, {'error': '台账暂忙，未保存，请稍后重试'})
    return ThreadingHTTPServer(('127.0.0.1', port), Handler)
