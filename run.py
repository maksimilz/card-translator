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
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

# SSL context that avoids CRL check timeouts in corporate Windows environments
SSL_CTX = ssl._create_unverified_context()

import gzip

# Headers to ignore when forwarding
IGNORED_FORWARD_HEADERS = {
    'host', 'origin', 'referer', 'content-length', 'connection',
    'sec-fetch-mode', 'sec-fetch-site', 'sec-fetch-dest', 'accept-encoding'
}

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
            self.send_header('Content-Type', 'application/json; charset=utf-8')
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
            if k.lower() in IGNORED_FORWARD_HEADERS:
                continue
            forward_headers[k] = v

        # Check authentication headers and ensure both Authorization and x-api-key are passed
        auth_val = forward_headers.get('Authorization') or forward_headers.get('authorization')
        api_key_val = forward_headers.get('x-api-key') or forward_headers.get('X-Api-Key')

        if auth_val and not api_key_val:
            raw_key = auth_val.replace('Bearer ', '').replace('bearer ', '').strip()
            forward_headers['x-api-key'] = raw_key
        elif api_key_val and not auth_val:
            forward_headers['Authorization'] = f"Bearer {api_key_val.strip()}"

        has_key = bool(forward_headers.get('x-api-key') or forward_headers.get('Authorization'))
        target_short = target_url.split('?')[0]
        print(f"[Proxy] {self.command} {target_short} | Auth: {'✓ (Ключ передан)' if has_key else '✗ (КЛЮЧ ОТСУТСТВУЕТ!)'}")

        try:
            req = urllib.request.Request(target_url, data=body, headers=forward_headers, method=self.command)
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=180) as resp:
                status = resp.status
                resp_headers = resp.headers
                resp_data = resp.read()

                # Automatically decompress gzip if the upstream server compressed it
                enc = resp_headers.get('Content-Encoding', '').lower()
                if enc == 'gzip' or resp_data[:2] == b'\x1f\x8b':
                    try:
                        resp_data = gzip.decompress(resp_data)
                    except Exception:
                        pass

                print(f"[Proxy] -> Ответ от сервера: HTTP {status}")
                self.send_response(status)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                self.wfile.write(resp_data)
        except urllib.error.HTTPError as e:
            err_data = e.read()
            enc = e.headers.get('Content-Encoding', '').lower()
            if enc == 'gzip' or err_data[:2] == b'\x1f\x8b':
                try:
                    err_data = gzip.decompress(err_data)
                except Exception:
                    pass

            print(f"[Proxy] -> Сервер вернул HTTP {e.code}")

            # Friendly message for 403 Forbidden with HTML Cloudflare/Vercel page
            if e.code == 403 and (b'<!DOCTYPE' in err_data or b'<html' in err_data):
                self.send_response(403)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.end_headers()
                friendly_err = json.dumps({
                    "error": {
                        "message": "Nano-GPT отклонил запрос (403 Forbidden). Проверьте: 1) Введен ли API-ключ в окне «⚙️ Настройки API». 2) Есть ли средства на балансе nano-gpt.com."
                    }
                })
                self.wfile.write(friendly_err.encode('utf-8'))
                return

            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            self.wfile.write(err_data)
        except (TimeoutError, socket.timeout):
            self.send_response(504)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            err_msg = json.dumps({"error": {"message": "Превышено время ожидания ответа (таймаут 180 сек). Попробуйте перевести это поле отдельно."}})
            self.wfile.write(err_msg.encode('utf-8'))
        except Exception as e:
            self.send_response(502)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.end_headers()
            err_detail = str(e).strip() or repr(e)
            err_msg = json.dumps({"error": {"message": f"Proxy connection error: {err_detail}"}})
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
    print(" Встроенный многопоточный CORS-прокси активен на /api-proxy")
    print(" Открываем страницу в браузере...")
    print(" Для остановки закройте это окно или нажмите Ctrl+C")
    print("=" * 60)

    def open_browser():
        time.sleep(0.5)
        webbrowser.open(url)

    threading.Thread(target=open_browser, daemon=True).start()

    server = ThreadingHTTPServer(('127.0.0.1', port), ProxyAndStaticServer)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")

if __name__ == '__main__':
    main()
