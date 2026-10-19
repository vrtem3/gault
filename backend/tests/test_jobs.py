"""Повторы SMTP, конкурентный запуск, миграции, WAL и восстановление резервной копии."""

import asyncio
import sqlite3
import subprocess
import sys
from pathlib import Path

import pytest
from sqlalchemy import text, update

from app.core.config import settings
from app.core.db import session_factory
from app.jobs import weekly_report
from app.models import ReportDelivery, UsageReceivedEvent, UsageWeeklyTotal
from app.basic_functions import now_utc
from datetime import timedelta


@pytest.fixture
def report_mail(monkeypatch):
    """Подменяет SMTP отчёта через monkeypatch; возвращает список отправленных числовых писем."""
    captured = []
    monkeypatch.setattr(settings, "admin_report_email", "admin@example.com")
    monkeypatch.setattr(weekly_report, "send_email", lambda *values: captured.append(values))
    return captured


async def test_weekly_report_snapshot_and_no_duplicates(report_mail):
    """Проверяет снимок и повтор доставки report_mail; возвращает None."""
    async with session_factory() as db:
        db.add(UsageWeeklyTotal(week_key="2025-W01", auth_kind="auth", unique_count=2, encrypt_count=7, decrypt_count=4))
        db.add(UsageWeeklyTotal(week_key="2025-W01", auth_kind="guest", unique_count=3, encrypt_count=6, decrypt_count=5))
        await db.commit()
    assert await weekly_report.run_report("2025-W01") == 0
    assert await weekly_report.run_report("2025-W01") == 0
    assert len(report_mail) == 1
    body = report_mail[0][2]
    assert "Успешные шифрования: 13" in body and "Успешные расшифрования: 9" in body
    assert "Авторизованные пользователи: 2" in body and "Гостевые браузеры (оценка): 3" in body
    assert "30.12.2024" in body and "05.01.2025" in body
    assert "Только согласованные онлайн-события" in body and "example.com" not in body


async def test_smtp_failure_retry_uses_same_snapshot(report_mail, monkeypatch):
    """Проверяет безопасный retry при отказе подключения с report_mail/monkeypatch; возвращает None."""
    async with session_factory() as db:
        db.add(UsageWeeklyTotal(week_key="2025-W02", auth_kind="guest", unique_count=1, encrypt_count=8, decrypt_count=0))
        await db.commit()
    captured_send = weekly_report.send_email

    def refused(*_args) -> None:
        """Имитирует гарантированный отказ соединения; аргументы служебные, всегда вызывает ConnectionRefusedError."""
        raise ConnectionRefusedError

    monkeypatch.setattr(weekly_report, "send_email", refused)
    assert await weekly_report.run_report("2025-W02") == 1
    async with session_factory() as db:
        await db.execute(update(UsageWeeklyTotal).where(UsageWeeklyTotal.week_key == "2025-W02").values(encrypt_count=99))
        await db.commit()
    monkeypatch.setattr(weekly_report, "send_email", captured_send)
    assert await weekly_report.run_report("2025-W02") == 0
    assert len(report_mail) == 1 and "Успешные шифрования: 8" in report_mail[0][2]
    async with session_factory() as db:
        assert (await db.get(ReportDelivery, "2025-W02")).attempts == 2


async def test_uncertain_smtp_is_not_automatically_repeated(report_mail, monkeypatch):
    """Проверяет timeout и запрет неявных дублей через report_mail/monkeypatch; возвращает None."""
    def timeout(*_args) -> None:
        """Имитирует неоднозначный SMTP timeout; аргументы служебные, вызывает TimeoutError."""
        raise TimeoutError
    monkeypatch.setattr(weekly_report, "send_email", timeout)
    assert await weekly_report.run_report("2025-W03") == 1
    assert await weekly_report.run_report("2025-W03") == 2
    async with session_factory() as db:
        delivery = await db.get(ReportDelivery, "2025-W03")
        assert delivery.status == "uncertain" and delivery.attempts == 1


async def test_concurrent_cron_claim(report_mail):
    """Проверяет два одновременных cron с report_mail; возвращает None, допускает лишь одно письмо."""
    await asyncio.gather(weekly_report.run_report("2025-W04"), weekly_report.run_report("2025-W04"))
    assert len(report_mail) == 1


async def test_cleanup_without_configured_smtp(monkeypatch):
    """Проверяет удаление TTL без SMTP через monkeypatch; возвращает None, сохраняя агрегаты."""
    monkeypatch.setattr(settings, "smtp_host", "")
    monkeypatch.setattr(settings, "admin_report_email", "")
    async with session_factory() as db:
        db.add(UsageWeeklyTotal(week_key="2025-W01", auth_kind="guest", encrypt_count=4, decrypt_count=0, unique_count=2))
        db.add(UsageReceivedEvent(event_id_hash="x" * 64, week_key="2025-W01", expires_at=now_utc() - timedelta(seconds=1)))
        await db.commit()
    assert await weekly_report.run_report(cleanup_only=True) == 0
    async with session_factory() as db:
        assert await db.get(UsageReceivedEvent, "x" * 64) is None
        assert (await db.get(UsageWeeklyTotal, ("2025-W01", "guest"))).encrypt_count == 4


async def test_backup_and_restore(client, register_user, tmp_path):
    """Создаёт backup после регистрации client/register_user и проверяет восстановление в tmp_path; возвращает None."""
    account = await register_user(client)
    destination = tmp_path / "backup.db"
    result = subprocess.run([sys.executable, "-m", "app.jobs.backup", str(destination)], cwd=Path(__file__).resolve().parents[1], capture_output=True, text=True)
    assert result.returncode == 0, result.stderr
    assert destination.stat().st_mode & 0o777 == 0o600
    with sqlite3.connect(destination) as db:
        assert db.execute("PRAGMA integrity_check").fetchone()[0] == "ok"
        assert db.execute("SELECT email FROM users WHERE id=?", (account["user"]["id"],)).fetchone()[0] == account["user"]["email"]
        assert db.execute("SELECT version_num FROM alembic_version").fetchone()[0]
    async with session_factory() as db:
        assert (await db.execute(text("PRAGMA journal_mode"))).scalar() == "wal"
        assert (await db.execute(text("PRAGMA foreign_keys"))).scalar() == 1
