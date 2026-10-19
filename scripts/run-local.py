"""Локальный шифратор на loopback; отложенный контур кабинета включается явно."""

import argparse
import os
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    """Читает режим запуска из CLI; возвращает None после остановки собственных дочерних процессов."""
    parser = argparse.ArgumentParser(description="Gault: запуск на этом компьютере без деплоя")
    parser.add_argument("--dev", action="store_true", help="Vite HMR вместо production preview; PWA отключён")
    parser.add_argument("--test", action="store_true", help="Изолированная БД artifacts/e2e.db")
    parser.add_argument("--no-build", action="store_true", help="Использовать уже проверенную сборку")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--cipher-only", action="store_true", default=True, help="Только шифратор без кабинета/API/SMTP (по умолчанию)")
    mode.add_argument("--with-account", dest="cipher_only", action="store_false", help="Отложенный контур кабинета/API/Mailpit для отдельной разработки")
    args = parser.parse_args()
    node = shutil.which("node")
    bundled = Path.home() / ".cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node"
    if not node and bundled.is_file():
        node = str(bundled)
    python = ROOT / (".venv/Scripts/python.exe" if os.name == "nt" else ".venv/bin/python")
    mailpit = shutil.which("mailpit") or str(ROOT / ".tools/mailpit/mailpit")
    if not node or not (ROOT / "frontend/node_modules").exists() or (not args.cipher_only and (not python.exists() or not Path(mailpit).is_file())):
        parser.error("Нужны Node.js и frontend/node_modules; для --with-account также Python venv и Mailpit. См. docs/TESTING.md.")
    if os.name == "nt" and not args.cipher_only:
        parser.error("Нативный Windows-запуск предназначен для --cipher-only; полный контур описан через Docker.")
    for port in ((5173,) if args.cipher_only else (5173, 5174, 8000, 8025, 1025)):
        try:
            with socket.socket() as connection:
                connection.bind(("127.0.0.1", port))
        except OSError:
            parser.error(f"Порт {port} занят. Остановите предыдущий локальный запуск.")
    environment = os.environ.copy()
    environment.update({
        "PATH": f"{Path(node).parent}{os.pathsep}{environment.get('PATH', '')}",
        "ENVIRONMENT": "test" if args.test else "development",
        "PUBLIC_CIPHER_ORIGIN": "http://localhost:5173", "PUBLIC_ACCOUNT_ORIGIN": "http://localhost:5174",
        "COOKIE_SECURE": "false", "DATABASE_URL": f"sqlite+aiosqlite:///{ROOT / ('artifacts/e2e.db' if args.test else 'data/gault.db')}",
        "SMTP_HOST": "127.0.0.1", "SMTP_PORT": "1025", "SMTP_TLS": "none", "SMTP_USER": "", "SMTP_PASSWORD": "",
        "PYTHONUNBUFFERED": "1",
    })
    if args.test and not args.cipher_only:
        environment["SECRET_KEY"] = "gault-local-tests-only-never-use-in-production-2026"
        for suffix in ("", "-wal", "-shm"):
            (ROOT / f"artifacts/e2e.db{suffix}").unlink(missing_ok=True)
    if not args.dev and not args.no_build:
        builds = [[node, "scripts/licenses.mjs"], [node, "node_modules/typescript/bin/tsc", "--noEmit"], [node, "node_modules/vite/bin/vite.js", "build"]]
        if not args.cipher_only:
            builds += [[node, "node_modules/vite/bin/vite.js", "build", "--config", "vite.account.config.ts"]]
        builds += [[node, "scripts/release-hashes.mjs", "dist", *(["dist-account"] if not args.cipher_only else [])]]
        for command in builds:
            subprocess.run(command, cwd=ROOT / "frontend", env=environment, check=True)
    if not args.cipher_only:
        subprocess.run([str(python), "-m", "alembic", "upgrade", "head"], cwd=ROOT / "backend", env=environment, check=True)
    commands = [
        ([mailpit, "--listen", "127.0.0.1:8025", "--smtp", "127.0.0.1:1025", "--allowed-hosts", "localhost,127.0.0.1", "--disable-version-check", "--smtp-disable-rdns", "--block-remote-css-and-fonts", "--max", "30", "--quiet"], ROOT),
        ([str(python), "-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "8000", "--no-access-log"], ROOT / "backend"),
        ([node, "node_modules/vite/bin/vite.js", *([] if args.dev else ["preview"]), "--host", "127.0.0.1", "--port", "5173"], ROOT / "frontend"),
        ([node, "node_modules/vite/bin/vite.js", *([] if args.dev else ["preview"]), "--config", "vite.account.config.ts", "--host", "127.0.0.1", "--port", "5174"], ROOT / "frontend"),
    ]
    if args.cipher_only:
        commands = [commands[2]]
    processes: list[subprocess.Popen] = []
    stopping = False

    def stop(_signal=None, _frame=None) -> None:
        """Останавливает только дочерние процессы; аргументы signal/frame служебные, возвращает None."""
        nonlocal stopping
        if stopping:
            return
        stopping = True
        for process in processes:
            if process.poll() is None:
                try:
                    if os.name == "nt":
                        subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True, check=False)
                    else:
                        os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass

    signal.signal(signal.SIGINT, stop)
    signal.signal(signal.SIGTERM, stop)
    try:
        for command, cwd in commands:
            processes.append(subprocess.Popen(command, cwd=cwd, env=environment, **({"creationflags": subprocess.CREATE_NEW_PROCESS_GROUP} if os.name == "nt" else {"start_new_session": True})))
        deadline = time.monotonic() + 45
        while time.monotonic() < deadline and not stopping:
            if any(process.poll() is not None for process in processes):
                raise RuntimeError("Один из локальных сервисов завершился. См. сообщение выше.")
            try:
                urls = ("http://127.0.0.1:5173",) if args.cipher_only else ("http://127.0.0.1:8000/api/v1/health", "http://127.0.0.1:5173", "http://127.0.0.1:5174", "http://127.0.0.1:8025")
                for url in urls:
                    with urllib.request.urlopen(url, timeout=2) as response:
                        if response.status != 200:
                            raise urllib.error.URLError("not ready")
                break
            except (OSError, urllib.error.URLError):
                time.sleep(0.3)
        else:
            if not stopping:
                raise RuntimeError("Сервисы не ответили вовремя.")
        if not stopping:
            print("\nШифратор: http://localhost:5173\n" + ("Режим --cipher-only, без API/SMTP.\n" if args.cipher_only else "Кабинет: http://localhost:5174\nПисьма: http://localhost:8025\n") + "Ctrl+C останавливает локальные сервисы.\n", flush=True)
        while not stopping and all(process.poll() is None for process in processes):
            time.sleep(0.5)
    finally:
        stop()
        for process in processes:
            try:
                process.wait(timeout=8)
            except subprocess.TimeoutExpired:
                if os.name == "nt":
                    process.kill()
                else:
                    os.killpg(process.pid, signal.SIGKILL)
                process.wait()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, subprocess.CalledProcessError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
