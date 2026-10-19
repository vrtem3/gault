"""Регистрация, подтверждение email, отзываемые сессии и восстановление аккаунта."""

import secrets
from datetime import timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Request, Response
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.basic_functions import (
    check_rate, digest, dummy_hash, get_db, hash_password, hasher, issue_csrf,
    now_utc, public_user, queue_account_token, require_csrf, require_session,
    session_cookie, set_session_cookie, validate_account_password, verify_password,
)
from app.core.config import settings
from app.models import EmailVerificationToken, PasswordResetToken, Session, User
from app.schemas import Credentials, EmailInput, ResetInput, TokenInput

router = APIRouter(prefix="/auth", tags=["Учётная запись"])
generic_email_message = {"message": "Если адрес подходит для этого действия, на него придёт письмо с дальнейшими шагами."}


@router.get("/csrf")
async def csrf(response: Response) -> dict:
    """Выдаёт CSRF-cookie в response; возвращает dict с токеном для памяти клиента."""
    return {"csrf_token": issue_csrf(response)}


@router.post("/register", status_code=202, dependencies=[Depends(require_csrf)])
async def register(data: Credentials, request: Request, tasks: BackgroundTasks, db: AsyncSession = Depends(get_db)) -> dict:
    """Регистрирует Credentials через Request/db и планирует tasks; возвращает одинаковое сообщение без наличия email."""
    check_rate(request, "register", 5, 3600)
    email = str(data.email).casefold()
    password = validate_account_password(data.password.get_secret_value(), email)
    encoded = await hash_password(password)
    if not settings.smtp_host:
        raise HTTPException(503, "Отправка писем пока не настроена. Локальное шифрование доступно.")
    existing = await db.scalar(select(User).where(User.email == email))
    if existing:
        if existing.email_verified_at is None:
            await queue_account_token(db, tasks, existing, "verify-email")
            await db.commit()
        return generic_email_message
    user = User(email=email, password_hash=encoded)
    db.add(user)
    try:
        await db.flush()
        await queue_account_token(db, tasks, user, "verify-email")
        await db.commit()
    except IntegrityError:
        await db.rollback()
        tasks.tasks.clear()
    return generic_email_message


@router.post("/verify-email", dependencies=[Depends(require_csrf)])
async def verify_email(data: TokenInput, request: Request, db: AsyncSession = Depends(get_db)) -> dict:
    """Погашает TokenInput через Request/db; возвращает сообщение подтверждения либо 400."""
    check_rate(request, "verify-email", 20, 900)
    user_id = await db.scalar(update(EmailVerificationToken).where(
        EmailVerificationToken.token_hash == digest(data.token.get_secret_value()),
        EmailVerificationToken.consumed_at.is_(None), EmailVerificationToken.expires_at > now_utc(),
    ).values(consumed_at=now_utc()).returning(EmailVerificationToken.user_id))
    if user_id is None:
        raise HTTPException(400, "Ссылка недействительна или срок её действия истёк.")
    await db.execute(update(User).where(User.id == user_id, User.status == "active").values(email_verified_at=now_utc()))
    await db.commit()
    return {"message": "Email подтверждён. Теперь можно войти."}


@router.post("/login", dependencies=[Depends(require_csrf)])
async def login(data: Credentials, request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> dict:
    """Проверяет Credentials/Request через db, устанавливает cookie response; возвращает публичного пользователя и CSRF."""
    check_rate(request, "login-ip", 20, 900)
    email = str(data.email).casefold()
    check_rate(request, "login-email", 10, 900, email)
    user = await db.scalar(select(User).where(User.email == email))
    correct = await verify_password(user.password_hash if user else dummy_hash, data.password.get_secret_value())
    if not correct or not user or user.status != "active" or user.email_verified_at is None:
        raise HTTPException(401, "Не удалось войти. Проверьте email, пароль и подтверждение почты.")
    if hasher.check_needs_rehash(user.password_hash):
        user.password_hash = await hash_password(data.password.get_secret_value())
    raw = secrets.token_urlsafe(32)
    db.add(Session(user_id=user.id, token_hash=digest(raw), expires_at=now_utc() + timedelta(days=settings.session_days)))
    await db.commit()
    set_session_cookie(response, raw)
    return {"user": public_user(user), "csrf_token": issue_csrf(response)}


@router.post("/logout", dependencies=[Depends(require_csrf)])
async def logout(response: Response, session: Session = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict:
    """Отзывает Session через db, удаляет cookie response; возвращает сообщение выхода."""
    session.revoked_at = now_utc()
    await db.commit()
    response.delete_cookie(session_cookie, path="/", secure=settings.cookie_secure, httponly=True, samesite="strict")
    return {"message": "Вы вышли из личного кабинета."}


@router.get("/me")
async def me(session: Session = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict:
    """Получает пользователя Session из db; возвращает безопасный публичный dict."""
    return public_user(await db.get(User, session.user_id))


@router.post("/forgot-password", status_code=202, dependencies=[Depends(require_csrf)])
async def forgot_password(data: EmailInput, request: Request, tasks: BackgroundTasks, db: AsyncSession = Depends(get_db)) -> dict:
    """Принимает EmailInput и Request, добавляет письмо в tasks через db; возвращает одинаковый публичный ответ."""
    check_rate(request, "forgot-ip", 5, 3600)
    email = str(data.email).casefold()
    check_rate(request, "forgot-email", 3, 3600, email)
    user = await db.scalar(select(User).where(User.email == email, User.status == "active", User.email_verified_at.is_not(None)))
    if user:
        await queue_account_token(db, tasks, user, "reset-password")
        await db.commit()
    return generic_email_message


@router.post("/resend-verification", status_code=202, dependencies=[Depends(require_csrf)])
async def resend_verification(data: EmailInput, request: Request, tasks: BackgroundTasks, db: AsyncSession = Depends(get_db)) -> dict:
    """Повторяет письмо EmailInput через Request/tasks/db; возвращает ответ без раскрытия наличия адреса."""
    check_rate(request, "resend-verification", 5, 3600)
    user = await db.scalar(select(User).where(User.email == str(data.email).casefold(), User.email_verified_at.is_(None), User.status == "active"))
    if user:
        await queue_account_token(db, tasks, user, "verify-email")
        await db.commit()
    return generic_email_message


@router.post("/reset-password", dependencies=[Depends(require_csrf)])
async def reset_password(data: ResetInput, request: Request, response: Response, db: AsyncSession = Depends(get_db)) -> dict:
    """Погашает ResetInput через Request/db и очищает response; возвращает сообщение, отзывая все сессии."""
    check_rate(request, "reset-password", 10, 900)
    password = validate_account_password(data.password.get_secret_value())
    user_id = await db.scalar(update(PasswordResetToken).where(
        PasswordResetToken.token_hash == digest(data.token.get_secret_value()),
        PasswordResetToken.consumed_at.is_(None), PasswordResetToken.expires_at > now_utc(),
    ).values(consumed_at=now_utc()).returning(PasswordResetToken.user_id))
    if user_id is None:
        raise HTTPException(400, "Ссылка недействительна или срок её действия истёк.")
    user = await db.get(User, user_id)
    validate_account_password(password, user.email)
    user.password_hash = await hash_password(password)
    await db.execute(update(Session).where(Session.user_id == user_id, Session.revoked_at.is_(None)).values(revoked_at=now_utc()))
    await db.commit()
    response.delete_cookie(session_cookie, path="/", secure=settings.cookie_secure, httponly=True, samesite="strict")
    return {"message": "Пароль обновлён. Все сессии завершены; войдите снова."}
