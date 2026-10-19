"""Согласованный SQLite Backup API: проверка целостности и закрытые права копии."""

import argparse
import os
import sqlite3
from pathlib import Path

from sqlalchemy.engine import make_url

from app.core.config import settings


def main() -> None:
    """Читает путь копии из CLI; возвращает None после backup/integrity_check или завершает с ошибкой."""
    parser = argparse.ArgumentParser(description="Gault: безопасное резервное копирование SQLite")
    parser.add_argument("destination", type=Path)
    args = parser.parse_args()
    source = Path(make_url(settings.database_url).database).resolve()
    destination = args.destination.resolve()
    if source == destination or destination.exists():
        parser.error("Назначение должно быть новым файлом, отличным от исходной БД")
    destination.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    descriptor = os.open(destination, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
    os.close(descriptor)
    try:
        with sqlite3.connect(f"{source.as_uri()}?mode=ro", uri=True) as src, sqlite3.connect(destination) as dst:
            src.backup(dst)
            if dst.execute("PRAGMA integrity_check").fetchone()[0] != "ok":
                raise RuntimeError("Проверка целостности копии не пройдена")
    except Exception:
        destination.unlink(missing_ok=True)
        raise
    print("Согласованная резервная копия создана; integrity_check: ok.")


if __name__ == "__main__":
    main()
