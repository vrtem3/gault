"""Профиль и безопасность текущего пользователя с фильтрацией по владельцу."""

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.basic_functions import check_rate, get_db, hash_password, now_utc, public_user, require_csrf, require_session, session_cookie, validate_account_password, verify_password
from app.core.config import settings
from app.models import Session, User
from app.schemas import PasswordChangeInput, ProfileInput

router = APIRouter(prefix="/me", tags=["Профиль"])


@router.get("")
async def profile(session: Session = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict:
    """Получает профиль Session через db; возвращает публичный dict текущего пользователя."""
    return public_user(await db.get(User, session.user_id))


@router.patch("", dependencies=[Depends(require_csrf)])
async def update_profile(data: ProfileInput, session: Session = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict:
    """Сохраняет ProfileInput для владельца Session через db; возвращает обновлённый профиль."""
    user = await db.get(User, session.user_id)
    user.display_name = data.display_name.strip()
    await db.commit()
    return public_user(user)


@router.get("/sessions")
async def sessions(session: Session = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[dict]:
    """Выбирает активные сессии владельца Session из db; возвращает список без секретов, IP и User-Agent."""
    rows = await db.scalars(select(Session).where(Session.user_id == session.user_id, Session.revoked_at.is_(None), Session.expires_at > now_utc()).order_by(Session.created_at.desc()))
    return [{"id": row.id, "created_at": row.created_at.isoformat(), "expires_at": row.expires_at.isoformat(), "current": row.id == session.id} for row in rows]


@router.delete("/sessions/{session_id}", dependencies=[Depends(require_csrf)])
async def revoke_session(session_id: str, response: Response, session: Session = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict:
    """Отзывает session_id (str) владельца Session через db/response; возвращает сообщение либо одинаковый 404."""
    target = await db.scalar(select(Session).where(Session.id == session_id, Session.user_id == session.user_id, Session.revoked_at.is_(None)))
    if target is None:
        raise HTTPException(404, "Сессия не найдена.")
    target.revoked_at = now_utc()
    await db.commit()
    if target.id == session.id:
        response.delete_cookie(session_cookie, path="/", secure=settings.cookie_secure, httponly=True, samesite="strict")
    return {"message": "Сессия завершена."}


@router.post("/password", dependencies=[Depends(require_csrf)])
async def change_password(data: PasswordChangeInput, request: Request, response: Response, session: Session = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict:
    """Проверяет PasswordChangeInput/Request/Session через db, очищает response; возвращает сообщение с отзывом всех сессий."""
    check_rate(request, "change-password", 10, 900, session.user_id)
    user = await db.get(User, session.user_id)
    if not await verify_password(user.password_hash, data.current_password.get_secret_value()):
        raise HTTPException(400, "Текущий пароль не подходит.")
    password = validate_account_password(data.password.get_secret_value(), user.email)
    user.password_hash = await hash_password(password)
    await db.execute(update(Session).where(Session.user_id == user.id, Session.revoked_at.is_(None)).values(revoked_at=now_utc()))
    await db.commit()
    response.delete_cookie(session_cookie, path="/", secure=settings.cookie_secure, httponly=True, samesite="strict")
    return {"message": "Пароль изменён. Войдите снова."}
