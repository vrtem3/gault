"""Общие функции БД, сессий, CSRF, ограничений запросов и SMTP."""

import asyncio
import hashlib
import hmac
import logging
import secrets
import smtplib
import ssl
import time
import unicodedata
from collections import deque
from datetime import UTC, date, datetime, timedelta
from email.message import EmailMessage
from pathlib import Path
from typing import AsyncIterator
from zoneinfo import ZoneInfo

from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError
from fastapi import BackgroundTasks, Depends, HTTPException, Request, Response
from sqlalchemy import delete, select, update
from sqlalchemy.dialects.sqlite import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings

hasher = PasswordHasher(time_cost=3, memory_cost=65536, parallelism=4, type=Type.ID)
dummy_hash = hasher.hash(secrets.token_urlsafe(32))
session_cookie = "__Host-gault_session" if settings.cookie_secure else "gault_session"
csrf_cookie = "__Host-gault_csrf" if settings.cookie_secure else "gault_csrf"
logger = logging.getLogger("gault")
_attempts: dict[str, deque[float]] = {}
_password_slots = asyncio.Semaphore(2)
_common_passwords = frozenset(
    line.strip().casefold() for line in (Path(__file__).parent / "data/common-passwords.txt").read_text().splitlines()
)


def now_utc() -> datetime:
    """Возвращает datetime текущего UTC без tzinfo для единого хранения в SQLite."""
    return datetime.now(UTC).replace(tzinfo=None)


def digest(value: str, purpose: str = "token") -> str:
    """Хэширует value (str) с разделением purpose (str); возвращает hex HMAC-SHA256."""
    return hmac.new(settings.secret_key.get_secret_value().encode(), f"{purpose}:{value}".encode(), hashlib.sha256).hexdigest()


def normalize_password(password: str) -> str:
    """Нормализует password (str) в Unicode NFC; возвращает str без удаления пробелов."""
    return unicodedata.normalize("NFC", password)


def validate_account_password(password: str, email: str = "") -> str:
    """Проверяет пароль аккаунта password и email (str); возвращает NFC либо HTTP 422."""
    password = normalize_password(password)
    folded = password.casefold()
    # Никаких правил состава: длина, распространённые/скомпрометированные значения и контекст.
    unleet = folded.translate(str.maketrans({"@": "a", "0": "o", "1": "i", "3": "e", "$": "s", "5": "s", "7": "t"}))
    stem = folded.rstrip("0123456789!?.-_ ").translate(str.maketrans({"@": "a", "0": "o", "$": "s"}))
    repeated_common = len(stem) % 2 == 0 and stem[:len(stem) // 2] in _common_passwords and stem == stem[:len(stem) // 2] * 2
    if not 15 <= len(password) <= 128 or len(set(folded)) < 4 or folded in _common_passwords or unleet in _common_passwords or stem in _common_passwords or repeated_common or (email and folded in (email.casefold(), email.split("@")[0].casefold())):
        raise HTTPException(422, "Используйте от 15 до 128 символов и пароль, которого нет в списке распространённых утечек. Правил состава нет.")
    return password


async def hash_password(password: str) -> str:
    """Хэширует password (str) в рабочем потоке; возвращает Argon2id-строку."""
    async with _password_slots:
        return await asyncio.to_thread(hasher.hash, normalize_password(password))


async def verify_password(encoded: str, password: str) -> bool:
    """Сверяет Argon2id encoded с password (str); возвращает bool без раскрытия ошибок."""
    try:
        async with _password_slots:
            return await asyncio.to_thread(hasher.verify, encoded, normalize_password(password))
    except (VerificationError, InvalidHashError):
        return False


def configure_sqlite_connection(connection, _record) -> None:
    """Настраивает DBAPI connection и record SQLAlchemy; возвращает None."""
    cursor = connection.cursor()
    cursor.execute("PRAGMA foreign_keys=ON")
    cursor.execute("PRAGMA journal_mode=WAL")
    cursor.execute("PRAGMA busy_timeout=5000")
    cursor.close()


async def get_db() -> AsyncIterator[AsyncSession]:
    """Открывает сессию SQLAlchemy; выдаёт AsyncSession и откатывает незавершённую транзакцию."""
    from app.core.db import session_factory

    async with session_factory() as db:
        yield db


def check_rate(request: Request, purpose: str, limit: int, seconds: int, subject: str = "") -> None:
    """Ограничивает Request по purpose/subject (str), limit/seconds (int); возвращает None или 429."""
    key = digest(subject or (request.client.host if request.client else "unknown"), f"rate:{purpose}")
    current = time.monotonic()
    # Записи имеют ограниченный срок; в ключах нет открытых IP или email.
    if len(_attempts) >= 4096:
        for old in list(_attempts):
            if not _attempts[old] or current - _attempts[old][-1] > 3600:
                del _attempts[old]
        if len(_attempts) >= 4096 and key not in _attempts:
            raise HTTPException(429, "Слишком много запросов. Попробуйте позже.", headers={"Retry-After": "60"})
    window = _attempts.setdefault(key, deque())
    while window and window[0] <= current - seconds:
        window.popleft()
    if len(window) >= limit:
        raise HTTPException(429, "Слишком много запросов. Попробуйте позже.", headers={"Retry-After": str(seconds)})
    window.append(current)


def issue_csrf(response: Response) -> str:
    """Записывает подписанную HttpOnly CSRF-cookie в response; возвращает токен для заголовка."""
    body = f"{int(time.time())}.{secrets.token_urlsafe(32)}"
    token = f"{body}.{digest(body, 'csrf')}"
    response.set_cookie(csrf_cookie, token, max_age=7200, secure=settings.cookie_secure, httponly=True, samesite="strict", path="/")
    return token


def require_csrf(request: Request) -> None:
    """Проверяет origin и подписанную двойную CSRF-пару Request; возвращает None или 403."""
    token = request.headers.get("x-csrf-token", "")
    cookie = request.cookies.get(csrf_cookie, "")
    if request.headers.get("origin") != settings.public_account_origin or not token or not hmac.compare_digest(token, cookie):
        raise HTTPException(403, "Проверка безопасности запроса не пройдена. Обновите страницу.")
    try:
        stamp, random, signature = token.split(".")
        valid = 0 <= time.time() - int(stamp) <= 7200
        valid &= hmac.compare_digest(signature, digest(f"{stamp}.{random}", "csrf"))
    except (ValueError, TypeError):
        valid = False
    if not valid:
        raise HTTPException(403, "Срок проверки безопасности истёк. Обновите страницу.")


async def optional_session(request: Request, db: AsyncSession = Depends(get_db)):
    """Ищет активную сессию в Request через db; возвращает Session либо None."""
    from app.models import Session, User

    raw = request.cookies.get(session_cookie, "")
    if not raw or len(raw) > 128:
        return None
    return await db.scalar(select(Session).join(User).where(Session.token_hash == digest(raw), Session.revoked_at.is_(None), Session.expires_at > now_utc(), User.status == "active", User.email_verified_at.is_not(None)))


async def require_session(session=Depends(optional_session)):
    """Проверяет Session/None из Depends; возвращает Session либо HTTP 401."""
    if session is None:
        raise HTTPException(401, "Войдите в личный кабинет.")
    return session


def set_session_cookie(response: Response, raw_token: str) -> None:
    """Записывает raw_token (str) в защищённую cookie response; возвращает None."""
    response.set_cookie(session_cookie, raw_token, max_age=settings.session_days * 86400, httponly=True, secure=settings.cookie_secure, samesite="strict", path="/")


def send_email(recipient: str, subject: str, body: str, message_id: str | None = None) -> None:
    """Отправляет текстовое письмо recipient/subject/body (str), message_id (str|None); возвращает None."""
    if not settings.smtp_host:
        raise RuntimeError("SMTP не настроен")
    message = EmailMessage()
    message["From"], message["To"], message["Subject"] = settings.smtp_from, recipient, subject
    if message_id:
        message["Message-ID"] = message_id
    message.set_content(body)
    factory = smtplib.SMTP_SSL if settings.smtp_tls == "tls" else smtplib.SMTP
    kwargs = {"timeout": 15}
    if settings.smtp_tls == "tls":
        kwargs["context"] = ssl.create_default_context()
    with factory(settings.smtp_host, settings.smtp_port, **kwargs) as smtp:
        if settings.smtp_tls == "starttls":
            smtp.starttls(context=ssl.create_default_context())
        if settings.smtp_user:
            smtp.login(settings.smtp_user, settings.smtp_password.get_secret_value())
        smtp.send_message(message)


def send_account_email(recipient: str, action: str, token: str) -> None:
    """Отправляет recipient одноразовую ссылку action/token (str); возвращает None, сбои логирует без данных."""
    title = "Подтвердите email" if action == "verify-email" else "Сброс пароля"
    try:
        send_email(recipient, f"Gault — {title.lower()}", f"gault.\n\n{title}:\n{settings.public_account_origin}/#{action}={token}\n\nСсылка одноразовая. Если вы не запрашивали письмо, проигнорируйте его.\nПароль аккаунта не связан с фразами шифрования файлов.")
    except (OSError, smtplib.SMTPException, RuntimeError):
        logger.warning('{"event":"account_email_delivery_failed"}')


def week_bounds(week: str | None = None, at: datetime | None = None) -> tuple[str, datetime, datetime]:
    """Вычисляет неделю week (YYYY-Www) или дату at; возвращает ключ и UTC-границы без tzinfo."""
    zone = ZoneInfo(settings.report_timezone)
    if week is None:
        local = (at or datetime.now(UTC)).astimezone(zone)
        iso = local.isocalendar()
        week = f"{iso.year}-W{iso.week:02d}"
    try:
        year, number = week.split("-W")
        monday = date.fromisocalendar(int(year), int(number), 1)
        if week != f"{int(year)}-W{int(number):02d}":
            raise ValueError
    except (ValueError, TypeError):
        raise ValueError("Неделя должна иметь формат YYYY-Www") from None
    start = datetime.combine(monday, datetime.min.time(), tzinfo=zone)
    end = datetime.combine(monday + timedelta(days=7), datetime.min.time(), tzinfo=zone)
    return week, start.astimezone(UTC).replace(tzinfo=None), end.astimezone(UTC).replace(tzinfo=None)


async def insert_once(db: AsyncSession, model, values: dict, conflict_fields: list[str]) -> bool:
    """Вставляет values в model через db без дублей conflict_fields; возвращает факт вставки (bool)."""
    statement = insert(model).values(**values).on_conflict_do_nothing(index_elements=conflict_fields)
    result = await db.execute(statement)
    return result.rowcount == 1


async def queue_account_token(db: AsyncSession, tasks: BackgroundTasks, user, action: str) -> None:
    """Создаёт токен для user/action в db и добавляет письмо в tasks; возвращает None, commit выполняет endpoint."""
    from app.models import EmailVerificationToken, PasswordResetToken

    model = EmailVerificationToken if action == "verify-email" else PasswordResetToken
    lifetime = timedelta(hours=24) if action == "verify-email" else timedelta(minutes=30)
    await db.execute(update(model).where(model.user_id == user.id, model.consumed_at.is_(None)).values(consumed_at=now_utc()))
    raw = secrets.token_urlsafe(32)
    db.add(model(token_hash=digest(raw), user_id=user.id, expires_at=now_utc() + lifetime))
    tasks.add_task(send_account_email, user.email, action, raw)


def public_user(user) -> dict:
    """Возвращает публичный dict из модели User user без хэша пароля и служебных секретов."""
    return {"id": user.id, "email": user.email, "display_name": user.display_name, "email_verified": user.email_verified_at is not None, "created_at": user.created_at.isoformat()}


async def purge_usage_identifiers(db: AsyncSession) -> None:
    """Удаляет истёкшие отпечатки статистики через db; возвращает None, долгосрочные агрегаты сохраняет."""
    from app.models import UsageReceivedEvent, UsageWeeklyUnique

    for model in (UsageWeeklyUnique, UsageReceivedEvent):
        await db.execute(delete(model).where(model.expires_at <= now_utc()))


async def record_usage(db: AsyncSession, week: str, auth_kind: str, subject: str, event_id: str | None = None, operation: str | None = None) -> bool:
    """Агрегирует week/auth_kind/subject и необязательные event_id/operation (str) в db; возвращает bool нового события."""
    from app.models import UsageReceivedEvent, UsageWeeklyTotal, UsageWeeklyUnique

    _, _, end = week_bounds(week)
    expiry = end + timedelta(days=7)
    await purge_usage_identifiers(db)
    if event_id and not await insert_once(db, UsageReceivedEvent, {"event_id_hash": digest(event_id, f"event:{week}"), "week_key": week, "expires_at": expiry}, ["event_id_hash"]):
        return False
    await insert_once(db, UsageWeeklyTotal, {"week_key": week, "auth_kind": auth_kind, "encrypt_count": 0, "decrypt_count": 0, "unique_count": 0}, ["week_key", "auth_kind"])
    unique = await insert_once(db, UsageWeeklyUnique, {"week_key": week, "auth_kind": auth_kind, "subject_digest": digest(subject, f"unique:{week}:{auth_kind}"), "expires_at": expiry}, ["week_key", "auth_kind", "subject_digest"])
    values = {"unique_count": UsageWeeklyTotal.unique_count + int(unique)}
    if operation:
        column = getattr(UsageWeeklyTotal, f"{operation}_count")
        values[f"{operation}_count"] = column + 1
    await db.execute(update(UsageWeeklyTotal).where(UsageWeeklyTotal.week_key == week, UsageWeeklyTotal.auth_kind == auth_kind).values(**values))
    return True


async def weekly_snapshot(db: AsyncSession, week: str) -> dict:
    """Читает числовую сводку week (str) из db; возвращает dict без индивидуальных данных."""
    from app.models import UsageWeeklyTotal

    week_bounds(week)
    result = {"week_key": week, "timezone": settings.report_timezone, "coverage": "Только согласованные онлайн-события", "auth": {"unique_count": 0, "encrypt_count": 0, "decrypt_count": 0}, "guest": {"unique_count": 0, "encrypt_count": 0, "decrypt_count": 0}}
    rows = await db.scalars(select(UsageWeeklyTotal).where(UsageWeeklyTotal.week_key == week))
    for row in rows:
        result[row.auth_kind] = {"unique_count": row.unique_count, "encrypt_count": row.encrypt_count, "decrypt_count": row.decrypt_count}
    return result
