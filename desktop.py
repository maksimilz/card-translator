"""
Desktop entry point for CardTranslator.exe.

Runs the local server (static files + LLM proxy) in a background thread and shows the app
in its own window via Edge WebView2. Settings, API key and drafts live in %APPDATA%\\CardTranslator.
Build with: python build_exe.py
"""
import ctypes
import os
import sys
import threading
import urllib.request
import webbrowser

# Windowed builds have no console: give print() and logging somewhere harmless to write
if sys.stdout is None:
    sys.stdout = open(os.devnull, 'w', encoding='utf-8')
if sys.stderr is None:
    sys.stderr = open(os.devnull, 'w', encoding='utf-8')

import run  # noqa: E402

APP_NAME = 'Card Translator'

# Fixed port on purpose: browser storage (settings, API key, draft) belongs to the page origin,
# so a different port on every launch would look like a fresh install.
APP_PORT = 47821


def data_dir():
    path = os.path.join(os.environ.get('APPDATA') or os.path.expanduser('~'), 'CardTranslator')
    os.makedirs(path, exist_ok=True)
    return path


def is_our_server(port):
    try:
        with urllib.request.urlopen(f'http://127.0.0.1:{port}/index.html', timeout=2) as resp:
            return b'Card Translator' in resp.read(4096)
    except OSError:
        return False


def start_server():
    """Returns (server or None, port). Reuses the server of an already running instance."""
    if is_our_server(APP_PORT):
        return None, APP_PORT
    port = APP_PORT if run.port_is_free(APP_PORT) else 0
    server = run.create_server(port)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server, server.server_address[1]


def use_dark_title_bar(window):
    """Windows 10 20H1+ / 11: dark caption bar to match the app theme. Cosmetic, failures are ignored."""
    try:
        hwnd = window.native.Handle.ToInt64()
        enabled = ctypes.c_int(1)
        for attribute in (20, 19):  # DWMWA_USE_IMMERSIVE_DARK_MODE (newer, then pre-20H1 value)
            if ctypes.windll.dwmapi.DwmSetWindowAttribute(hwnd, attribute, ctypes.byref(enabled), ctypes.sizeof(enabled)) == 0:
                break
    except Exception:
        pass


def message_box(text):
    ctypes.windll.user32.MessageBoxW(None, text, APP_NAME, 0x40)


def main():
    server, port = start_server()
    url = f'http://127.0.0.1:{port}/'
    try:
        import webview

        webview.settings['ALLOW_DOWNLOADS'] = True
        webview.settings['OPEN_EXTERNAL_LINKS_IN_BROWSER'] = True
        window = webview.create_window(
            APP_NAME, url,
            width=1440, height=920, min_size=(900, 600),
            background_color='#0b0f19', text_select=True
        )
        window.events.before_show += use_dark_title_bar
        webview.start(private_mode=False, storage_path=data_dir())
    except Exception as err:
        # No WebView2 runtime or another GUI problem: fall back to the default browser
        webbrowser.open(url)
        message_box(f'Не удалось открыть окно приложения ({err}).\n\n'
                    'Приложение открыто в браузере. Закройте это сообщение, чтобы завершить работу.')
    finally:
        if server:
            server.shutdown()


if __name__ == '__main__':
    main()
