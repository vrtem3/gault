"""Регрессия POSIX PTY-драйвера на синтетическом CLI; криптография и пользовательские данные не нужны."""

import os
import subprocess
import sys
from pathlib import Path

import pytest


@pytest.mark.skipif(os.name == "nt", reason="POSIX termios; ConPTY принимается отдельно на Windows")
def test_prompt_before_terminal_is_ready(tmp_path: Path) -> None:
    """Создаёт CLI в tmp_path (Path); проверяет поздний ECHO-off/повторный prompt, возвращает None."""
    cli = tmp_path / "synthetic-cli"
    cli.write_text(
        f"#!{sys.executable}\n"
        "import os, sys, termios, time\n"
        "from pathlib import Path\n"
        "original = termios.tcgetattr(0)\n"
        "for prompt in [b'Enter passphrase: ', b'Confirm passphrase: ']:\n"
        "    os.write(1, prompt[:8])\n"
        "    time.sleep(0.03)\n"
        "    os.write(1, prompt[8:])\n"
        "    time.sleep(0.08)\n"
        "    hidden = termios.tcgetattr(0)\n"
        "    hidden[3] &= ~termios.ECHO\n"
        "    termios.tcsetattr(0, termios.TCSAFLUSH, hidden)\n"
        "    value = sys.stdin.readline().strip()\n"
        "    termios.tcsetattr(0, termios.TCSANOW, original)\n"
        "    if value != 'public-test-only-driver': sys.exit(4)\n"
        "    os.write(1, b'\\n')\n"
        "Path(sys.argv[2]).write_bytes(b'ok')\n"
    )
    cli.chmod(0o700)
    output = tmp_path / "out.bin"
    result = subprocess.run(
        [sys.executable, "frontend/scripts/cli_passphrase.py", str(cli)],
        cwd=Path(__file__).resolve().parents[1],
        env={**os.environ, "GAULT_TEST_PASSPHRASE": "public-test-only-driver", "GAULT_TEST_OUTPUT": str(output), "GAULT_TEST_TIMEOUT_SECONDS": "5"},
        capture_output=True, timeout=10,
    )
    assert result.returncode == 0, result.stderr.decode()
    assert output.read_bytes() == b"ok"
    assert b"public-test-only-driver" not in result.stdout + result.stderr
