"""
Tests for run.py: CORS, SSRF guards, Host check and the streaming pass-through proxy.
Run: python -m unittest discover -s tests
"""
import json
import os
import sys
import threading
import unittest
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))
import run  # noqa: E402
from run import ProxyAndStaticServer  # noqa: E402


class MockProxyHandler(ProxyAndStaticServer):
    """Handler instance without a socket: records status and headers."""

    def __init__(self, headers=None, path='/', method='GET', body=b''):
        self.headers = headers or {}
        self.path = path
        self.command = method
        self.request_version = 'HTTP/1.1'
        self.requestline = f'{method} {path} HTTP/1.1'
        self.rfile = BytesIO(body)
        self.wfile = BytesIO()
        self._headers_buffer = []
        self.sent_headers = {}
        self.status_code = None

    def send_response(self, code, message=None):
        self.status_code = code

    def send_header(self, keyword, value):
        self.sent_headers[keyword.lower()] = value

    def body_json(self):
        return json.loads(self.wfile.getvalue().decode('utf-8'))


class TestCorsAndGuards(unittest.TestCase):
    def test_cors_local_origins_allowed(self):
        for origin in ('http://127.0.0.1:8000', 'http://localhost:5173', 'http://[::1]:8000'):
            handler = MockProxyHandler(headers={'Origin': origin})
            handler.end_headers()
            self.assertEqual(handler.sent_headers.get('access-control-allow-origin'), origin)

    def test_cors_external_origins_blocked(self):
        for origin in ('https://malicious-site.com', 'http://localhost.evil.com'):
            handler = MockProxyHandler(headers={'Origin': origin})
            handler.end_headers()
            self.assertNotIn('access-control-allow-origin', handler.sent_headers)

    def test_blocked_schemes(self):
        handler = MockProxyHandler(path='/api-proxy?target=file:///etc/passwd')
        handler.handle_proxy()
        self.assertEqual(handler.status_code, 400)
        self.assertIn('only http and https', handler.body_json()['error']['message'])

    def test_blocked_metadata_hosts(self):
        for target in (
            'http://169.254.169.254/latest/meta-data/',
            'http://[::ffff:169.254.169.254]/latest/',
            'http://169.254.169.254./',
            'http://metadata.google.internal/computeMetadata/v1/',
            'http://metadata.google.internal./computeMetadata/v1/',
        ):
            handler = MockProxyHandler(path='/api-proxy?target=' + target)
            handler.handle_proxy()
            self.assertEqual(handler.status_code, 403, target)

    def test_missing_target(self):
        handler = MockProxyHandler(path='/api-proxy')
        handler.handle_proxy()
        self.assertEqual(handler.status_code, 400)

    def test_host_check(self):
        good = MockProxyHandler(headers={'Host': '127.0.0.1:8000'})
        self.assertTrue(good.host_allowed())
        good6 = MockProxyHandler(headers={'Host': '[::1]:8000'})
        self.assertTrue(good6.host_allowed())
        bad = MockProxyHandler(headers={'Host': 'attacker.example:8000'})
        self.assertFalse(bad.host_allowed())
        self.assertEqual(bad.status_code, 403)


class FakeUpstream(BaseHTTPRequestHandler):
    """Upstream LLM API stub: SSE for stream=true, JSON otherwise, 401 for a bad key."""

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        FakeUpstream.last_headers = dict(self.headers)
        if self.headers.get('Authorization') == 'Bearer bad':
            payload = b'{"error": {"message": "invalid key"}}'
            self.send_response(401)
            self.send_header('Content-Type', 'application/json')
            self.send_header('Content-Length', str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        if body.get('stream'):
            self.send_response(200)
            self.send_header('Content-Type', 'text/event-stream')
            self.end_headers()
            for piece in ('При', 'вет'):
                chunk = {"choices": [{"delta": {"content": piece}, "finish_reason": None}]}
                self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode('utf-8'))
                self.wfile.flush()
            self.wfile.write(b'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n')
            return
        payload = json.dumps({"choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def log_message(self, *args):
        pass


class TestProxyIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(('127.0.0.1', 0), FakeUpstream)
        cls.proxy = ThreadingHTTPServer(('127.0.0.1', 0), ProxyAndStaticServer)
        ProxyAndStaticServer.log_message = lambda *a: None
        run.log = lambda *a: None
        for srv in (cls.upstream, cls.proxy):
            threading.Thread(target=srv.serve_forever, daemon=True).start()
        cls.target = f'http://127.0.0.1:{cls.upstream.server_address[1]}/v1/chat/completions'
        cls.proxy_base = f'http://127.0.0.1:{cls.proxy.server_address[1]}'

    @classmethod
    def tearDownClass(cls):
        cls.upstream.shutdown()
        cls.proxy.shutdown()

    def post(self, body, key='good'):
        url = f'{self.proxy_base}/api-proxy?target={urllib.parse.quote(self.target, safe="")}'
        req = urllib.request.Request(url, data=json.dumps(body).encode(), method='POST', headers={
            'Content-Type': 'application/json',
            'Authorization': f'Bearer {key}',
            'Cookie': 'session=secret',
        })
        return urllib.request.urlopen(req, timeout=10)

    def test_stream_pass_through(self):
        with self.post({"model": "m", "stream": True}) as resp:
            self.assertIn('text/event-stream', resp.headers['Content-Type'])
            text = resp.read().decode('utf-8')
        self.assertIn('При', text)
        self.assertIn('[DONE]', text)

    def test_json_response_and_header_forwarding(self):
        with self.post({"model": "m"}) as resp:
            data = json.loads(resp.read())
        self.assertEqual(data['choices'][0]['message']['content'], 'ok')
        sent = {k.lower(): v for k, v in FakeUpstream.last_headers.items()}
        self.assertEqual(sent.get('x-api-key'), 'good')
        self.assertNotIn('cookie', sent)

    def test_upstream_error_is_forwarded(self):
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            self.post({"model": "m"}, key='bad')
        self.assertEqual(ctx.exception.code, 401)
        self.assertIn('invalid key', ctx.exception.read().decode())

    def test_foreign_host_header_rejected(self):
        req = urllib.request.Request(self.proxy_base + '/index.html', headers={'Host': 'evil.example'})
        with self.assertRaises(urllib.error.HTTPError) as ctx:
            urllib.request.urlopen(req, timeout=10)
        self.assertEqual(ctx.exception.code, 403)


if __name__ == '__main__':
    unittest.main()
