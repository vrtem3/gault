"""Только тестовый age/rage: POSIX PTY или Windows ConPTY, публичная фраза из окружения."""

import errno
import os
import re
import select
import sys
import time
from pathlib import Path


def main() -> None:
    """Принимает CLI/аргументы из argv и тестовые env; пишет через -o и завершает CLI-кодом."""
    phrase = os.environ.pop("GAULT_TEST_PASSPHRASE").encode()
    output = Path(os.environ.pop("GAULT_TEST_OUTPUT"))
    if output.exists():
        raise SystemExit("Тест не перезаписывает существующий выходной файл")
    arguments = [sys.argv[1], "-o", str(output), *sys.argv[2:]]
    os.environ.update({"LANG": "C", "LC_ALL": "C", "TERM": "dumb"})
    timeout = float(os.environ.pop("GAULT_TEST_TIMEOUT_SECONDS", "90"))
    if not 1 <= timeout <= 90:
        raise SystemExit("Допустимый тестовый тайм-аут: 1–90 секунд")
    # rage иначе может выбрать установленный в ОС GUI pinentry вместо PTY.
    no_pinentry = Path(__file__).resolve().with_name(".gault-no-pinentry-for-tests")
    if no_pinentry.exists():
        raise SystemExit("Зарезервированный тестовый путь занят")
    os.environ["PINENTRY_PROGRAM"] = str(no_pinentry)
    deadline = time.monotonic() + timeout
    pending = b""
    prompts = 0
    pattern = re.compile(r"(?:passphrase|confirm|парол|фраз|повтор)[^\r\n:]*:\s*$", re.IGNORECASE)
    if os.name == "nt":
        # Дополнительная зависимость только Windows-тестов; бинарный результат не проходит через терминал.
        from winpty import PtyProcess

        process = PtyProcess.spawn(arguments, env=dict(os.environ))
        try:
            while time.monotonic() < deadline:
                ready, _, _ = select.select([process], [], [], 0.2)
                if not ready:
                    if not process.isalive():
                        break
                    continue
                try:
                    chunk = process.read(4096).encode()
                except EOFError:
                    break
                pending = (pending + chunk)[-8192:]
                prompt = pending.decode(errors="replace").casefold()
                if pattern.search(prompt):
                    process.write(phrase.decode() + "\r\n")
                    prompts += 1
                    pending = b""
            else:
                raise TimeoutError(f"Windows CLI compatibility timeout; answered prompts={prompts}")
            code = process.exitstatus
            if code is None:
                raise RuntimeError("Windows CLI не сообщил код завершения")
            if code:
                sys.stderr.buffer.write(pending.replace(phrase, b"[test phrase]"))
        finally:
            process.close(force=True)
        raise SystemExit(code)

    import pty
    import termios

    pid, descriptor = pty.fork()
    if pid == 0:
        os.execv(arguments[0], arguments)
    try:
        while time.monotonic() < deadline:
            ready, _, _ = select.select([descriptor], [], [], 0.02)
            if ready:
                try:
                    chunk = os.read(descriptor, 4096)
                except OSError as exc:
                    if exc.errno == errno.EIO:
                        break
                    raise
                if not chunk:
                    break
                pending = (pending + chunk)[-8192:]
            # CLI запрашивают исходную фразу и подтверждение без завершающего LF.
            prompt = pending.decode(errors="replace").casefold()
            # rpassword печатает prompt ДО HiddenInput::new. Ждём фактического ECHO-off,
            # а не произвольной задержки; иначе ранний ввод попадает в обычный терминал.
            if pattern.search(prompt) and not termios.tcgetattr(descriptor)[3] & termios.ECHO:
                os.write(descriptor, phrase + b"\n")
                prompts += 1
                pending = b""
        else:
            raise TimeoutError(f"CLI compatibility timeout; answered prompts={prompts}")
    except BaseException:
        try:
            os.kill(pid, 9)
        except ProcessLookupError:
            pass
        os.waitpid(pid, 0)
        raise
    finally:
        os.close(descriptor)
    _, status = os.waitpid(pid, 0)
    code = os.waitstatus_to_exitcode(status)
    if code:
        sys.stderr.buffer.write(pending.replace(phrase, b"[test phrase]"))
    sys.exit(code)


if __name__ == "__main__":
    main()
