import os
import sys
import time
import socket
import threading
import webbrowser
from http.server import HTTPServer, SimpleHTTPRequestHandler

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
    # Guarantee working directory is the script folder
    script_dir = os.path.dirname(os.path.abspath(__file__))
    os.chdir(script_dir)

    port = find_free_port(8000)
    url = f"http://127.0.0.1:{port}"

    print("=" * 55)
    print(" AI Character Card Translator & Editor")
    print(f" Адрес: {url}")
    print(" Открываем страницу в браузере...")
    print(" Для остановки закройте это окно или нажмите Ctrl+C")
    print("=" * 55)

    def open_browser():
        time.sleep(0.5)
        webbrowser.open(url)

    threading.Thread(target=open_browser, daemon=True).start()

    class QuietHandler(SimpleHTTPRequestHandler):
        def log_message(self, format, *args):
            # Keep terminal clean and readable
            pass

    server = HTTPServer(('127.0.0.1', port), QuietHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nСервер остановлен.")

if __name__ == '__main__':
    main()
