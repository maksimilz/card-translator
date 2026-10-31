"""
Local launcher for AI Card Translator.

Serves the static app on 127.0.0.1 and exposes /api-proxy?target=<url> — a small
CORS proxy so the browser can talk to LLM APIs that do not send CORS headers.
Streaming (text/event-stream) responses are passed through chunk by chunk.

    python run.py [--port 8000] [--no-browser] [--insecure]
"""
import argparse
import gzip
import ipaddress
import json
import os
import socket
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

LOCAL_HOSTS = ('127.0.0.1', 'localhost', '::1')

# Seconds of upstream silence before giving up. Applies per socket read, so a
# streaming response may run longer as long as tokens keep arriving.
UPSTREAM_TIMEOUT = 300

# Verified TLS by default; main() swaps in an unverified context for --insecure.
SSL_CTX = ssl.create_default_context()

# Request headers that must not be forwarded upstream
SKIP_FORWARD_HEADERS = {
    'host', 'origin', 'referer', 'content-length', 'connection', 'cookie',
    'accept-encoding', 'x-target-url', 'upgrade-insecure-requests',
}

METADATA_HOSTS = ('metadata.google.internal', 'metadata', 'instance-data')


def is_local_hostname(hostname):
    return (hostname or '').strip('[]').lower() in LOCAL_HOSTS


def is_metadata_host(hostname):
    """Blocks cloud metadata endpoints and link-local addresses (SSRF protection)."""
    host = hostname.rstrip('.').lower()
    if host in METADATA_HOSTS or host.endswith('.metadata.google.internal'):
        return True
    try:
        ip = ipaddress.ip_address(host)
    except ValueError:
        return host.startswith('169.254.')
    if ip.version == 6 and ip.ipv4_mapped:
        ip = ip.ipv4_mapped
    return ip.is_link_local


def maybe_gunzip(data, encoding):
    if encoding == 'gzip' or data[:2] == b'\x1f\x8b':
        try:
            return gzip.decompress(data)
        except OSError:
            pass
    return data


def log(tag, message):
    print(f"[{time.strftime('%H:%M:%S')}] [{tag}] {message}", flush=True)


class ProxyAndStaticServer(SimpleHTTPRequestHandler):
    def end_headers(self):
        origin = self.headers.get('Origin')
        if origin:
            try:
                parsed_origin = urllib.parse.urlparse(origin)
                # Allow only local origins (http://localhost:* or http://127.0.0.1:*)
                if parsed_origin.scheme == 'http' and parsed_origin.hostname in LOCAL_HOSTS:
                    self.send_header('Access-Control-Allow-Origin', origin)
                    self.send_header('Vary', 'Origin')
                    self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
                    self.send_header('Access-Control-Allow-Headers', '*')
                    self.send_header('Access-Control-Max-Age', '86400')
            except ValueError:
                pass
        if not self.path.startswith('/api-proxy'):
            # Always serve fresh JS/CSS so updates apply without a hard reload
            self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def host_allowed(self):
        """Rejects requests whose Host is not local (DNS rebinding protection)."""
        host = self.headers.get('Host', '')
        hostname = urllib.parse.urlsplit('//' + host).hostname if host else ''
        if is_local_hostname(hostname):
            return True
        self.send_json(403, 'Forbidden host')
        return False

    def do_OPTIONS(self):
        if not self.host_allowed():
            return
        self.send_response(204)
        self.end_headers()

    def do_GET(self):
        if not self.host_allowed():
            return
        if self.path.startswith('/api-proxy'):
            self.handle_proxy()
        else:
            super().do_GET()

    def do_POST(self):
        if not self.host_allowed():
            return
        if self.path.startswith('/api-proxy'):
            self.handle_proxy()
        else:
            self.send_error(404, "Not found")

    def send_json(self, status, message):
        body = json.dumps({"error": {"message": message}}, ensure_ascii=False).encode('utf-8')
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def handle_proxy(self):
        parsed = urllib.parse.urlparse(self.path)
        target_url = urllib.parse.parse_qs(parsed.query).get('target', [None])[0]

        if not target_url:
            self.send_json(400, "Missing target parameter in query string")
            return

        parsed_target = urllib.parse.urlparse(target_url)
        if (parsed_target.scheme or '').lower() not in ('http', 'https'):
            self.send_json(400, "Invalid scheme: only http and https are allowed")
            return

        hostname = (parsed_target.hostname or '').lower()
        if not hostname:
            self.send_json(400, "Invalid target host")
            return

        if is_metadata_host(hostname):
            self.send_json(403, "Access to cloud metadata IP (169.254.169.254) is forbidden")
            return

        content_length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(content_length) if content_length > 0 else None

        forward_headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36'
        }
        for k, v in self.headers.items():
            lk = k.lower()
            if lk in SKIP_FORWARD_HEADERS or lk.startswith('sec-'):
                continue
            forward_headers[k] = v

        # Some OpenAI-compatible APIs want Authorization, others x-api-key: send both
        lower_keys = {k.lower(): k for k in forward_headers}
        auth_val = forward_headers.get(lower_keys.get('authorization', ''), '')
        api_key_val = forward_headers.get(lower_keys.get('x-api-key', ''), '')
        if auth_val and not api_key_val:
            forward_headers['x-api-key'] = auth_val.split(' ', 1)[-1].strip()
        elif api_key_val and not auth_val:
            forward_headers['Authorization'] = f"Bearer {api_key_val.strip()}"
        has_key = bool(auth_val or api_key_val)

        model_name = ''
        wants_stream = False
        if body:
            try:
                body_json = json.loads(body.decode('utf-8'))
                model_name = body_json.get('model', '')
                wants_stream = bool(body_json.get('stream'))
            except (ValueError, AttributeError):
                pass

        target_short = target_url.split('?')[0]
        model_tag = f" | Модель: {model_name}" if model_name else ""
        stream_tag = " | stream" if wants_stream else ""
        auth_tag = "✓ (Ключ передан)" if has_key else "✗ (ключа нет)"
        log('LLM Прокси', f"{self.command} {target_short}{model_tag}{stream_tag} | Auth: {auth_tag}")

        t0 = time.time()
        try:
            req = urllib.request.Request(target_url, data=body, headers=forward_headers, method=self.command)
            with urllib.request.urlopen(req, context=SSL_CTX, timeout=UPSTREAM_TIMEOUT) as resp:
                self.relay_response(resp, t0)
        except urllib.error.HTTPError as e:
            elapsed = round(time.time() - t0, 2)
            err_data = maybe_gunzip(e.read(), (e.headers.get('Content-Encoding') or '').lower())
            log('LLM Прокси', f"-> Ошибка API за {elapsed}с: HTTP {e.code}")

            # Cloudflare / gateway HTML pages are useless to the UI: replace with a readable message
            head = err_data[:512].lower()
            if b'<!doctype' in head or b'<html' in head:
                hint = (" Проверьте API-ключ в «Настройках API» и баланс у провайдера."
                        if e.code in (401, 403) else " Сервер провайдера временно недоступен или блокирует запрос.")
                self.send_json(e.code, f"Сервер вернул HTML-страницу ошибки (HTTP {e.code}).{hint}")
                return

            self.send_response(e.code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(err_data)))
            self.end_headers()
            self.wfile.write(err_data)
        except (TimeoutError, socket.timeout):
            self.send_json(504, f"Превышено время ожидания ответа ({UPSTREAM_TIMEOUT} с без данных от сервера).")
        except urllib.error.URLError as e:
            if isinstance(e.reason, ssl.SSLError):
                self.send_json(502, f"Ошибка проверки TLS-сертификата: {e.reason}. "
                                    "Если вы за корпоративным прокси, запустите: python run.py --insecure")
            elif isinstance(e.reason, (TimeoutError, socket.timeout)):
                self.send_json(504, f"Превышено время ожидания ответа ({UPSTREAM_TIMEOUT} с).")
            else:
                self.send_json(502, f"Не удалось подключиться к {target_short}: {e.reason}")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            log('LLM Прокси', "-> Клиент прервал запрос")
        except Exception as e:
            err_detail = str(e).strip() or repr(e)
            try:
                self.send_json(502, f"Proxy connection error: {err_detail}")
            except OSError:
                pass

    def relay_response(self, resp, t0):
        content_type = resp.headers.get('Content-Type', 'application/json')
        encoding = (resp.headers.get('Content-Encoding') or '').lower()

        if 'text/event-stream' in content_type and encoding != 'gzip':
            # Stream pass-through: no Content-Length, connection closes at the end (HTTP/1.0)
            self.send_response(resp.status)
            self.send_header('Content-Type', content_type)
            self.send_header('Cache-Control', 'no-store')
            self.end_headers()
            total = 0
            while True:
                chunk = resp.read1(16384)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
                total += len(chunk)
            log('LLM Прокси', f"-> Поток завершён за {round(time.time() - t0, 2)}с: HTTP {resp.status} ({total} байт)")
            return

        data = maybe_gunzip(resp.read(), encoding)
        log('LLM Прокси', f"-> Ответ получен за {round(time.time() - t0, 2)}с: HTTP {resp.status} ({len(data)} байт)")
        self.send_response(resp.status)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_request(self, code='-', size='-'):
        # Proxy calls have their own log lines; static files are logged only on errors
        if self.path.startswith('/api-proxy'):
            return
        try:
            if int(code) < 400:
                return
        except (TypeError, ValueError):
            pass
        log('HTTP', f'"{self.requestline}" {code}')

    def log_message(self, format, *args):
        log('HTTP', format % args)


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
    global SSL_CTX

    parser = argparse.ArgumentParser(description='AI Card Translator: локальный сервер + CORS-прокси')
    parser.add_argument('--port', type=int, default=0, help='порт (по умолчанию первый свободный начиная с 8000)')
    parser.add_argument('--no-browser', action='store_true', help='не открывать браузер автоматически')
    parser.add_argument('--insecure', action='store_true',
                        help='не проверять TLS-сертификаты (только для корпоративных сетей с подменой сертификатов)')
    args = parser.parse_args()

    if args.insecure:
        SSL_CTX = ssl._create_unverified_context()

    os.chdir(os.path.dirname(os.path.abspath(__file__)))

    port = args.port or find_free_port(8000)
    url = f"http://127.0.0.1:{port}"
    server = ThreadingHTTPServer(('127.0.0.1', port), ProxyAndStaticServer)

    print("=" * 60)
    print(" AI Character Card Translator & Editor")
    print(f" Сервер запущен: {url}")
    print(" CORS-прокси для LLM API активен на /api-proxy")
    if args.insecure:
        print(" ВНИМАНИЕ: проверка TLS-сертификатов отключена (--insecure)")
    print(" Для остановки закройте это окно или нажмите Ctrl+C")
    print("=" * 60, flush=True)

    if not args.no_browser:
        threading.Timer(0.5, webbrowser.open, args=(url,)).start()

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")


if __name__ == '__main__':
    main()
