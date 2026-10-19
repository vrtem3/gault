"""Контракт будущих провайдеров; реализации и хранение токенов не входят в MVP."""

from typing import AsyncIterator, Protocol


class StorageProvider(Protocol):
    """Единый интерфейс будущего удалённого хранилища без привязки к бренду."""

    async def upload(self, path: str, data: AsyncIterator[bytes]) -> dict:
        """Загружает поток data (AsyncIterator[bytes]) в path (str); возвращает метаданные dict."""
        ...

    def download(self, path: str) -> AsyncIterator[bytes]:
        """Читает path (str); возвращает асинхронный поток bytes."""
        ...

    async def delete(self, path: str) -> None:
        """Удаляет path (str); возвращает None после подтверждения провайдера."""
        ...

    async def list(self, path: str) -> list[dict]:
        """Перечисляет каталог path (str); возвращает список метаданных dict."""
        ...

    async def stat(self, path: str) -> dict:
        """Получает метаданные path (str); возвращает dict без содержимого файла."""
        ...
