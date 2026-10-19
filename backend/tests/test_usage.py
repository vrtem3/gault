"""Проверяет добровольные числовые агрегаты, TTL, недельную дедупликацию и закрытый доступ."""

import secrets
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import select

from app.basic_functions import now_utc, week_bounds
from app.core.db import session_factory
from app.core.config import settings
from app.models import UsageReceivedEvent, UsageWeeklyTotal, UsageWeeklyUnique


async def test_guest_events_and_deduplication(client):
    """Проверяет уникальных гостей и event_id через client; возвращает None."""
    week, _, _ = week_bounds()
    token = secrets.token_hex(32)
    body = {"operation_type": "encrypt", "week_key": week, "guest_or_auth": "guest", "event_id": str(uuid4())}
    headers = {"X-Guest-Token": token}
    assert (await client.post("/api/v1/usage/events", json=body, headers=headers)).json() == {"accepted": True}
    assert (await client.post("/api/v1/usage/events", json=body, headers=headers)).json() == {"accepted": False}
    assert (await client.post("/api/v1/usage/events", json={**body, "event_id": str(uuid4()), "operation_type": "decrypt"}, headers=headers)).status_code == 202
    async with session_factory() as db:
        total = await db.get(UsageWeeklyTotal, (week, "guest"))
        assert (total.encrypt_count, total.decrypt_count, total.unique_count) == (1, 1, 1)
        subjects = list(await db.scalars(select(UsageWeeklyUnique)))
        assert len(subjects) == 1 and subjects[0].subject_digest != token
        events = list(await db.scalars(select(UsageReceivedEvent)))
        assert len(events) == 2 and body["event_id"] not in [event.event_id_hash for event in events]
        assert subjects[0].expires_at - week_bounds()[2] == timedelta(days=7)


async def test_account_visits_are_unique_and_authoritative(client, register_user):
    """Проверяет согласованный визит и авторитетную категорию через client/register_user; возвращает None."""
    await register_user(client)
    week, _, _ = week_bounds()
    for _ in range(2):
        assert (await client.post("/api/v1/usage/visit", json={"week_key": week})).status_code == 202
    bad = {"operation_type": "encrypt", "week_key": week, "guest_or_auth": "guest", "event_id": str(uuid4())}
    assert (await client.post("/api/v1/usage/events", json=bad)).status_code == 422
    assert (await client.post("/api/v1/usage/events", json={**bad, "guest_or_auth": "auth"})).status_code == 202
    async with session_factory() as db:
        total = await db.get(UsageWeeklyTotal, (week, "auth"))
        assert total.unique_count == 1 and total.encrypt_count == 1


async def test_private_payload_and_admin_access(client):
    """Проверяет allowlist входа и закрытую сводку client; возвращает None."""
    week, _, _ = week_bounds()
    base = {"operation_type": "encrypt", "week_key": week, "guest_or_auth": "guest", "event_id": str(uuid4())}
    headers = {"X-Guest-Token": secrets.token_hex(32)}
    for field in ("file", "filename", "size", "passphrase", "email", "ip"):
        result = await client.post("/api/v1/usage/events", json={**base, field: "private-marker"}, headers=headers)
        assert result.status_code == 422 and "private-marker" not in result.text
    assert (await client.get("/api/v1/admin/usage/weekly")).status_code == 403
    async with session_factory() as db:
        assert list(await db.scalars(select(UsageWeeklyTotal))) == []


async def test_expired_identifiers_removed_but_totals_preserved(client):
    """Проверяет TTL отпечатков и сохранение агрегатов через client; возвращает None."""
    async with session_factory() as db:
        expired = now_utc() - timedelta(seconds=1)
        db.add(UsageWeeklyTotal(week_key="2025-W01", auth_kind="guest", unique_count=3, encrypt_count=5, decrypt_count=2))
        db.add(UsageWeeklyUnique(week_key="2025-W01", auth_kind="guest", subject_digest="a" * 64, expires_at=expired))
        db.add(UsageReceivedEvent(event_id_hash="b" * 64, week_key="2025-W01", expires_at=expired))
        await db.commit()
    week, _, _ = week_bounds()
    await client.post("/api/v1/usage/events", json={"operation_type": "encrypt", "week_key": week, "guest_or_auth": "guest", "event_id": str(uuid4())}, headers={"X-Guest-Token": secrets.token_hex(32)})
    async with session_factory() as db:
        assert (await db.get(UsageWeeklyTotal, ("2025-W01", "guest"))).encrypt_count == 5
        assert await db.get(UsageReceivedEvent, "b" * 64) is None
        assert list(await db.scalars(select(UsageWeeklyUnique).where(UsageWeeklyUnique.week_key == "2025-W01"))) == []


async def test_frequency_limit_and_wrong_week(client):
    """Проверяет лимит событий и запрет backfill через client; возвращает None."""
    week, _, _ = week_bounds()
    headers = {"X-Guest-Token": secrets.token_hex(32)}
    body = {"operation_type": "encrypt", "week_key": week, "guest_or_auth": "guest", "event_id": str(uuid4())}
    assert (await client.post("/api/v1/usage/events", json={**body, "week_key": "2025-W01"}, headers=headers)).status_code == 422
    for _ in range(60):
        assert (await client.post("/api/v1/usage/events", json={**body, "event_id": str(uuid4())}, headers=headers)).status_code == 202
    assert (await client.post("/api/v1/usage/events", json=body, headers=headers)).status_code == 429


def test_timezone_week_boundary_and_dst(monkeypatch):
    """Проверяет границу недели, ISO-год и DST через monkeypatch; возвращает None."""
    assert week_bounds(at=datetime(2026, 10, 18, 18, 59, 59, tzinfo=UTC))[0] == "2026-W42"
    assert week_bounds(at=datetime(2026, 10, 18, 19, 0, tzinfo=UTC))[0] == "2026-W43"
    assert week_bounds(at=datetime(2027, 1, 1, tzinfo=UTC))[0] == "2026-W53"
    monkeypatch.setattr(settings, "report_timezone", "America/New_York")
    _, start, end = week_bounds("2026-W10")
    assert end - start == timedelta(hours=167)
    _, start, end = week_bounds("2026-W44")
    assert end - start == timedelta(hours=169)
