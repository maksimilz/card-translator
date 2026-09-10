import os
import sys
import time
import socket
import threading
import webbrowser
import ssl
import urllib.request
import urllib.error
import urllib.parse
from http.server import HTTPServer, SimpleHTTPRequestHandler

# SSL context that avoids CRL check timeouts in corporate Windows environments
SSL_CTX = ssl._create_unverified_context()

class ProxyAndStaticServer(SimpleHTTPRequestHandler):
    def end_headers(self):
        # Enable CORS for all local requests
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE')
        self.send_header('Access-Control-Allow-Headers', '*')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/api-proxy'):
            self.handle_proxy()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path.startswith('/api-proxy'):
            self.handle_proxy()
        else:
            self.send_error(404, "Not found")

    def handle_proxy(self):
        parsed = urllib.parse.urlparse(self.path)
        qs = urllib.parse.parse_qs(parsed.query)
        target_url = qs.get('target', [None])[0] or self.headers.get('X-Target-URL')

        if not target_url:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error": "Missing target parameter in query string"}')
            return

        content_length = int(self.headers.get('Content-Length', 0))
        body = self.rfile.read(content_length) if content_length > 0 else None

        # Headers to forward
        forward_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
        for k, v in self.headers.items():
            k_lower = k.lower()
            if k_lower in ('host', 'origin', 'referer', 'content-length', 'connection', 'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest'):
                continue
            forward_headers[k] = v

        try:
            req = urllib.request.Request(target_url, data=body, headers=forward_headers, method=self.command)
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=90) as resp:
                status = resp.status
                resp_headers = resp.headers
                resp_data = resp.read()

                self.send_response(status)
                content_type = resp_headers.get('Content-Type', 'application/json')
                self.send_header('Content-Type', content_type)
                self.end_headers()
                self.wfile.write(resp_data)
        except urllib.error.HTTPError as e:
            err_data = e.read()
            self.send_response(e.code)
            content_type = e.headers.get('Content-Type', 'application/json')
            self.send_header('Content-Type', content_type)
            self.end_headers()
            self.wfile.write(err_data)
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            err_msg = f'{{"error": {{"message": "Proxy connection error: {str(e)}"}} }}'
            self.wfile.write(err_msg.encode('utf-8'))

    def log_message(self, format, *args):
        # Keep console clean
        pass

def find_free_port(start_port=8000, max_attempts=20):
    for p in range(start_port, start_port + max_attempts):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            try:
                s.bind(('127.0.0.1', p))
                return p
            except OSError:
                continue
    return start_port

def main():
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    port = find_free_port(8000)
    url = f"http://127.0.0.1:{port}"

    print("=" * 60)
    print(" AI Character Card Translator & Editor")
    print(f" Сервер запущен: {url}")
    print(" Встроенный CORS-прокси активен на /api-proxy")
    print(" Открываем страницу в браузере...")
    print(" Для остановки закройте это окно или нажмите Ctrl+C")
    print("=" * 60)

    def open_browser():
        time.sleep(0.5)
        webbrowser.open(url)

    threading.Thread(target=open_browser, daemon=True).start()

    server = HTTPServer(('127.0.0.1', port), ProxyAndStaticServer)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")

if __name__ == '__main__':
    main()
