"""Еженедельный SMTP-отчёт с защитой повторов и явным состоянием неопределённой доставки."""

import argparse
import asyncio
import smtplib
from datetime import UTC, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy import update

from app.basic_functions import digest, insert_once, now_utc, purge_usage_identifiers, send_email, week_bounds, weekly_snapshot
from app.core.config import settings
from app.core.db import engine, session_factory
from app.models import ReportDelivery


async def run_report(week: str | None = None, resolve: str | None = None, cleanup_only: bool = False) -> int:
    """Отправляет week/разрешает resolve (str|None) либо очищает TTL при cleanup_only (bool); возвращает код int."""
    async with session_factory() as db:
        await purge_usage_identifiers(db)
        await db.commit()
    if cleanup_only:
        print("Истёкшие идентификаторы статистики удалены; числовые агрегаты сохранены.")
        return 0
    if week is None:
        _, current_start, _ = week_bounds()
        week, _, _ = week_bounds(at=(current_start - timedelta(microseconds=1)).replace(tzinfo=UTC))
    try:
        week, start, end = week_bounds(week)
    except ValueError:
        print("Неверная неделя: используйте YYYY-Www.")
        return 2
    if end > now_utc():
        print("Отчёт можно отправить только за завершённую неделю.")
        return 2
    if not settings.admin_report_email or not settings.smtp_host:
        print("Заполните ADMIN_REPORT_EMAIL и параметры SMTP.")
        return 2
    async with session_factory() as db:
        if resolve:
            result = await db.execute(update(ReportDelivery).where(ReportDelivery.week_key == week, ReportDelivery.status.in_(["sending", "uncertain"])).values(status=resolve))
            await db.commit()
            print("Статус доставки обновлён." if result.rowcount else "Нет неопределённой доставки для этой недели.")
            return 0 if result.rowcount else 2
        snapshot = await weekly_snapshot(db, week)
        await insert_once(db, ReportDelivery, {"week_key": week, "status": "pending", "attempts": 0, "snapshot": snapshot, "updated_at": now_utc()}, ["week_key"])
        claimed = await db.scalar(update(ReportDelivery).where(ReportDelivery.week_key == week, ReportDelivery.status.in_(["pending", "failed"])).values(status="sending", attempts=ReportDelivery.attempts + 1, updated_at=now_utc()).returning(ReportDelivery.week_key))
        await db.commit()
        if claimed is None:
            previous = await db.get(ReportDelivery, week)
            print("Отчёт уже отправлен." if previous.status == "sent" else "Исход прошлой доставки неизвестен. Проверьте SMTP и явно задайте --resolve sent или --resolve failed.")
            return 0 if previous.status == "sent" else 2
        delivery = await db.get(ReportDelivery, week)
        snapshot = delivery.snapshot
    zone = ZoneInfo(settings.report_timezone)
    first = start.replace(tzinfo=UTC).astimezone(zone).strftime("%d.%m.%Y")
    last = (end.replace(tzinfo=UTC).astimezone(zone) - timedelta(days=1)).strftime("%d.%m.%Y")
    authenticated, guest = snapshot["auth"], snapshot["guest"]
    body = f"gault.\n\nСтатистика за {first} — {last} ({settings.report_timezone})\n\nАвторизованные пользователи: {authenticated['unique_count']}\nГостевые браузеры (оценка): {guest['unique_count']}\nУспешные шифрования: {authenticated['encrypt_count'] + guest['encrypt_count']}\n  авторизованные: {authenticated['encrypt_count']}; гости: {guest['encrypt_count']}\nУспешные расшифрования: {authenticated['decrypt_count'] + guest['decrypt_count']}\n  авторизованные: {authenticated['decrypt_count']}; гости: {guest['decrypt_count']}\n\nТолько согласованные онлайн-события. Офлайн-операции и операции без согласия не учитываются.\nГостевые браузеры — приблизительная оценка, не число физических людей.\nСодержимое файлов, их метаданные и парольные фразы не собираются.\n"
    status = "sent"
    try:
        await asyncio.to_thread(send_email, settings.admin_report_email, f"Gault — статистика за {first} — {last}", body, f"<gault-week-{digest(week, 'report')[:24]}@gault.ru>")
    except (ConnectionRefusedError, smtplib.SMTPConnectError, smtplib.SMTPAuthenticationError, smtplib.SMTPRecipientsRefused, smtplib.SMTPSenderRefused, smtplib.SMTPDataError):
        status = "failed"
    except (OSError, smtplib.SMTPException, RuntimeError):
        # SMTP не предоставляет атомарной транзакции с SQLite: не рискуем повторить принятое письмо.
        status = "uncertain"
    async with session_factory() as db:
        await db.execute(update(ReportDelivery).where(ReportDelivery.week_key == week).values(status=status, updated_at=now_utc()))
        await db.commit()
    print({"sent": "Отчёт отправлен.", "failed": "SMTP отклонил доставку. Команду можно повторить.", "uncertain": "Исход SMTP-доставки неизвестен. Автоматический повтор заблокирован."}[status])
    return 0 if status == "sent" else 1


def main() -> None:
    """Читает --week/--resolve/--cleanup-only из CLI; возвращает None и код через SystemExit."""
    parser = argparse.ArgumentParser(description="Gault: недельный отчёт без персональных данных")
    parser.add_argument("--week")
    parser.add_argument("--resolve", choices=["sent", "failed"])
    parser.add_argument("--cleanup-only", action="store_true")
    args = parser.parse_args()
    try:
        code = asyncio.run(run_report(args.week, args.resolve, args.cleanup_only))
    finally:
        asyncio.run(engine.dispose())
    raise SystemExit(code)


if __name__ == "__main__":
    main()
