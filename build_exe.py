"""
Builds dist/CardTranslator.exe — a single file, no console, opens the app in its own window.

    python build_exe.py

Creates .venv-build with PyInstaller and pywebview on first run, so the system Python stays clean.
"""
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
VENV = os.path.join(ROOT, '.venv-build')
VENV_PY = os.path.join(VENV, 'Scripts', 'python.exe') if os.name == 'nt' else os.path.join(VENV, 'bin', 'python')
REQUIREMENTS = ['pyinstaller>=6.0', 'pywebview>=5.0']


def sh(*cmd):
    print('>', ' '.join(cmd), flush=True)
    subprocess.run(cmd, check=True, cwd=ROOT)


def main():
    if not os.path.exists(VENV_PY):
        sh(sys.executable, '-m', 'venv', VENV)
    sh(VENV_PY, '-m', 'pip', 'install', '--disable-pip-version-check', '-q', *REQUIREMENTS)

    def data(rel, dest):
        return f'{os.path.join(ROOT, rel)}{os.pathsep}{dest}'

    sh(
        VENV_PY, '-m', 'PyInstaller',
        '--noconfirm', '--clean',
        '--onefile', '--windowed',
        '--name', 'CardTranslator',
        '--icon', os.path.join(ROOT, 'assets', 'icon.ico'),
        '--add-data', data('index.html', '.'),
        '--add-data', data('css', 'css'),
        '--add-data', data('js', 'js'),
        '--add-data', data('assets', 'assets'),
        '--distpath', os.path.join(ROOT, 'dist'),
        '--workpath', os.path.join(ROOT, 'build'),
        '--specpath', os.path.join(ROOT, 'build'),
        os.path.join(ROOT, 'desktop.py'),
    )
    print(f"\nГотово: {os.path.join(ROOT, 'dist', 'CardTranslator.exe')}")


if __name__ == '__main__':
    main()
