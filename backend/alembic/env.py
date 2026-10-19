"""Асинхронные миграции Alembic с поддержкой batch-изменений SQLite."""

import asyncio

from alembic import context

from app.core.db import Base, engine
from app import models  # noqa: F401 — регистрирует модели в metadata

target_metadata = Base.metadata


def migrate(connection) -> None:
    """Применяет миграции через SQLAlchemy Connection connection; возвращает None."""
    context.configure(connection=connection, target_metadata=target_metadata, render_as_batch=True, compare_type=True)
    with context.begin_transaction():
        context.run_migrations()


async def online() -> None:
    """Открывает async-соединение и применяет миграции; возвращает None после закрытия движка."""
    async with engine.connect() as connection:
        await connection.run_sync(migrate)
    await engine.dispose()


if context.is_offline_mode():
    context.configure(url=str(engine.url), target_metadata=target_metadata, literal_binds=True, render_as_batch=True)
    with context.begin_transaction():
        context.run_migrations()
else:
    asyncio.run(online())
