"""Движок SQLAlchemy async с WAL и закрытыми правами локальной SQLite."""

import os
from pathlib import Path

from sqlalchemy import event
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
from sqlalchemy.orm import DeclarativeBase

from app.basic_functions import configure_sqlite_connection
from app.core.config import settings


class Base(DeclarativeBase):
    """Общая декларативная база моделей SQLAlchemy."""


database_path = make_url(settings.database_url).database
if database_path and database_path != ":memory:":
    path = Path(database_path).resolve()
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    os.chmod(path.parent, 0o700)
    descriptor = os.open(path, os.O_CREAT | os.O_WRONLY, 0o600)
    os.close(descriptor)
    os.chmod(path, 0o600)

engine = create_async_engine(settings.database_url, connect_args={"timeout": 5}, echo=False)
event.listen(engine.sync_engine, "connect", configure_sqlite_connection)
session_factory = async_sessionmaker(engine, expire_on_commit=False)
