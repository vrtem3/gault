"""Изолированная SQLite с настоящими миграциями; SMTP заменён локальным захватом токенов."""

import os
import tempfile
from pathlib import Path

import httpx
import pytest
import pytest_asyncio
from alembic import command
from alembic.config import Config

TEST_DIRECTORY = Path(tempfile.mkdtemp(prefix="gault-pytest-"))
os.environ.update({
    "ENVIRONMENT": "test", "SECRET_KEY": "gault-pytest-only-never-production-secret-2026",
    "DATABASE_URL": f"sqlite+aiosqlite:///{TEST_DIRECTORY / 'test.db'}",
    "COOKIE_SECURE": "false", "PUBLIC_ACCOUNT_ORIGIN": "http://localhost:5174",
    "PUBLIC_CIPHER_ORIGIN": "http://localhost:5173", "SMTP_HOST": "mailpit-test",
    "REPORT_TIMEZONE": "Asia/Yekaterinburg",
})

from app import basic_functions  # noqa: E402 — окружение задаётся до импорта приложения
from app.core.db import Base, engine, session_factory  # noqa: E402
from app.main import app  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def migrations():
    """Применяет Alembic к временной БД; выдаёт None и удаляет только тестовый каталог."""
    configuration = Config(str(Path(__file__).resolve().parents[1] / "alembic.ini"))
    command.upgrade(configuration, "head")
    yield
    import shutil
    shutil.rmtree(TEST_DIRECTORY)


@pytest_asyncio.fixture(autouse=True)
async def clean_database(migrations):
    """Очищает модели после миграций migrations; выдаёт None с изолированными данными каждого теста."""
    async with engine.begin() as connection:
        for table in reversed(Base.metadata.sorted_tables):
            await connection.execute(table.delete())
    basic_functions._attempts.clear()
    yield
    await engine.dispose()


@pytest.fixture
def mails(monkeypatch):
    """Через monkeypatch подменяет только SMTP; возвращает список писем-токенов в памяти теста."""
    captured = []

    def capture(recipient: str, action: str, token: str) -> None:
        """Сохраняет тестовые recipient/action/token (str) в captured; возвращает None без вывода."""
        captured.append({"recipient": recipient, "action": action, "token": token})

    monkeypatch.setattr(basic_functions, "send_account_email", capture)
    return captured


@pytest_asyncio.fixture
async def client():
    """Создаёт httpx AsyncClient с CSRF; выдаёт клиент и закрывает его после теста."""
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost:5174", headers={"Origin": "http://localhost:5174"}) as http:
        result = await http.get("/api/v1/auth/csrf")
        http.headers["X-CSRF-Token"] = result.json()["csrf_token"]
        yield http


@pytest.fixture
def register_user(mails):
    """Возвращает async helper регистрации/подтверждения на основе захваченных mails."""
    async def register(http, email: str = "first@example.com", password: str = "uncorrelated-orbit-cobalt-rainbow-2026") -> dict:
        """Регистрирует http/email/password и подтверждает email; возвращает dict тестовых данных."""
        response = await http.post("/api/v1/auth/register", json={"email": email, "password": password})
        assert response.status_code == 202, response.text
        token = mails[-1]["token"]
        result = await http.post("/api/v1/auth/verify-email", json={"token": token})
        assert result.status_code == 200, result.text
        login = await http.post("/api/v1/auth/login", json={"email": email, "password": password})
        assert login.status_code == 200, login.text
        http.headers["X-CSRF-Token"] = login.json()["csrf_token"]
        return {"user": login.json()["user"], "password": password, "verification_token": token}
    return register
