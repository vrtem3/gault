"""Контракт аккаунтов, CSRF, отзывов, одноразовых токенов и изоляции объектов."""

from datetime import timedelta

import httpx
import pytest
from sqlalchemy import update

from app.basic_functions import digest, now_utc
from app.core.config import Settings
from app.core.db import session_factory
from app.main import app
from app.models import EmailVerificationToken, PasswordResetToken, StorageConnection, User


async def test_health_and_no_upload(client):
    """Проверяет health и отсутствие upload через client; возвращает None."""
    assert (await client.get("/api/v1/health")).json() == {"status": "ok"}
    assert (await client.post("/api/v1/upload", json={})).status_code == 404


async def test_registration_and_session_lifecycle(client, register_user):
    """Проверяет реальную регистрацию helper register_user и жизненный цикл client; возвращает None."""
    account = await register_user(client)
    async with session_factory() as db:
        user = await db.get(User, account["user"]["id"])
        assert user.password_hash.startswith("$argon2id$")
        assert account["password"] not in user.password_hash
        token = await db.get(EmailVerificationToken, digest(account["verification_token"]))
        assert token.consumed_at is not None
    current = (await client.get("/api/v1/auth/me")).json()
    assert current["email_verified"] is True and "password_hash" not in current
    assert (await client.patch("/api/v1/me", json={"display_name": "Артём"})).json()["display_name"] == "Артём"
    sessions = (await client.get("/api/v1/me/sessions")).json()
    assert len(sessions) == 1 and sessions[0]["current"]
    assert (await client.post("/api/v1/auth/logout", json={})).status_code == 200
    assert (await client.get("/api/v1/auth/me")).status_code == 401


async def test_csrf_and_untrusted_origin(client):
    """Проверяет обязательные origin и CSRF-заголовок client; возвращает None."""
    body = {"email": "someone@example.com", "password": "a-long-distinct-password-for-testing"}
    assert (await client.post("/api/v1/auth/register", json=body, headers={"X-CSRF-Token": ""})).status_code == 403
    assert (await client.post("/api/v1/auth/register", json=body, headers={"Origin": "https://evil.example"})).status_code == 403
    assert (await client.post("/api/v1/auth/register", json=body, headers={"X-CSRF-Token": "tampered"})).status_code == 403


async def test_tokens_single_use_and_expiry(client, register_user, mails):
    """Проверяет одноразовость и сроки токенов через client/register_user/mails; возвращает None."""
    account = await register_user(client)
    assert (await client.post("/api/v1/auth/verify-email", json={"token": account["verification_token"]})).status_code == 400
    await client.post("/api/v1/auth/forgot-password", json={"email": account["user"]["email"]})
    reset = mails[-1]["token"]
    async with session_factory() as db:
        await db.execute(update(PasswordResetToken).where(PasswordResetToken.token_hash == digest(reset)).values(expires_at=now_utc() - timedelta(seconds=1)))
        await db.commit()
    response = await client.post("/api/v1/auth/reset-password", json={"token": reset, "password": "another-unrelated-strong-passphrase"})
    assert response.status_code == 400


async def test_password_reset_revokes_sessions(client, register_user, mails):
    """Проверяет сброс пароля и отзыв сессий через client/register_user/mails; возвращает None."""
    account = await register_user(client)
    response = await client.post("/api/v1/auth/forgot-password", json={"email": account["user"]["email"]})
    assert response.status_code == 202
    reset = mails[-1]["token"]
    data = {"token": reset, "password": "new-independent-cloud-cobalt-orbit"}
    assert (await client.post("/api/v1/auth/reset-password", json=data)).status_code == 200
    assert (await client.get("/api/v1/me")).status_code == 401
    assert (await client.post("/api/v1/auth/reset-password", json=data)).status_code == 400
    assert (await client.post("/api/v1/auth/login", json={"email": account["user"]["email"], "password": data["password"]})).status_code == 200


async def test_email_responses_do_not_enumerate(client, register_user):
    """Сравнивает ответы известных и неизвестных email через client/register_user; возвращает None."""
    account = await register_user(client)
    a = await client.post("/api/v1/auth/forgot-password", json={"email": account["user"]["email"]})
    b = await client.post("/api/v1/auth/forgot-password", json={"email": "missing@example.com"})
    assert a.status_code == b.status_code == 202 and a.json() == b.json()
    duplicate = await client.post("/api/v1/auth/register", json={"email": account["user"]["email"], "password": account["password"]})
    assert duplicate.status_code == 202 and duplicate.json() == a.json()


async def test_unverified_and_wrong_password_are_generic(client, mails):
    """Сравнивает неактивированную учётку и неверный пароль client/mails; возвращает None."""
    body = {"email": "pending@example.com", "password": "different-orbit-rainbow-sunset-cobalt"}
    assert (await client.post("/api/v1/auth/register", json=body)).status_code == 202
    first = await client.post("/api/v1/auth/login", json=body)
    second = await client.post("/api/v1/auth/login", json={**body, "password": "wrong"})
    assert first.status_code == second.status_code == 401 and first.json() == second.json()


@pytest.mark.parametrize("password", ["short", "password123", "aaaaaaaaaaaaaaaaaaaaa", "PasswordPassword1!"])
async def test_account_password_policy_and_redaction(client, password):
    """Отвергает слабый password (str) через client без отражения секрета; возвращает None."""
    response = await client.post("/api/v1/auth/register", json={"email": "weak@example.com", "password": password})
    assert response.status_code == 422
    assert password not in response.text


async def test_validation_does_not_reflect_secret(client):
    """Проверяет ошибки схемы client без input и секретных значений; возвращает None."""
    secret = "very-sensitive-test-value"
    response = await client.post("/api/v1/auth/register", json={"email": "invalid", "password": secret, "passphrase": secret})
    assert response.status_code == 422 and secret not in response.text and '"input"' not in response.text
    assert (await client.post("/api/v1/auth/register", content=b"x" * 8193)).status_code == 413


async def test_rate_limit(client):
    """Ограничивает частые попытки входа client; возвращает None."""
    statuses = [(await client.post("/api/v1/auth/login", json={"email": "missing@example.com", "password": "wrong"})).status_code for _ in range(11)]
    assert statuses[-1] == 429


async def test_idor_and_storage_filter(client, register_user):
    """Проверяет межпользовательскую изоляцию client/register_user; возвращает None."""
    first = await register_user(client)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://localhost:5174", headers={"Origin": "http://localhost:5174"}) as other:
        other.headers["X-CSRF-Token"] = (await other.get("/api/v1/auth/csrf")).json()["csrf_token"]
        second = await register_user(other, "second@example.com")
        foreign_session = (await other.get("/api/v1/me/sessions")).json()[0]["id"]
        assert (await client.request("DELETE", f"/api/v1/me/sessions/{foreign_session}", json={})).status_code == 404
        async with session_factory() as db:
            db.add(StorageConnection(user_id=second["user"]["id"], provider_type="future", display_name="Чужое", status="inactive"))
            await db.commit()
        assert (await client.get("/api/v1/storage-connections")).json() == []
        assert len((await other.get("/api/v1/storage-connections")).json()) == 1
        assert (await client.patch("/api/v1/me", json={"display_name": "test", "user_id": second["user"]["id"]})).status_code == 422
        assert (await client.get("/api/v1/me")).json()["id"] == first["user"]["id"]


def test_production_requires_tls():
    """Проверяет конфигурационный запрет production без HTTPS/Secure; возвращает None."""
    with pytest.raises(ValueError):
        Settings(_env_file=None, environment="production", secret_key="x" * 48, cookie_secure=False)
