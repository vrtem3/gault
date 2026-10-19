"""Строго ограниченные добровольные события и закрытая числовая сводка."""

import hmac
import re

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.basic_functions import check_rate, get_db, optional_session, record_usage, require_csrf, require_session, week_bounds, weekly_snapshot
from app.core.config import settings
from app.models import Session
from app.schemas import UsageEventInput, VisitInput

router = APIRouter(tags=["Добровольная статистика"])


@router.post("/usage/events", status_code=202, dependencies=[Depends(require_csrf)])
async def event(data: UsageEventInput, request: Request, db: AsyncSession = Depends(get_db), session=Depends(optional_session)) -> dict:
    """Принимает только UsageEventInput с Request/Session через db; возвращает факт учёта без хранения истории."""
    check_rate(request, "usage-ip", 120, 60)
    current, _, _ = week_bounds()
    if data.week_key != current:
        raise HTTPException(422, "События принимаются только за текущую отчётную неделю.")
    kind = "auth" if session else "guest"
    if data.guest_or_auth != kind:
        raise HTTPException(422, "Категория события не соответствует текущей сессии.")
    subject = session.user_id if session else request.headers.get("x-guest-token", "")
    if not session and not re.fullmatch(r"[A-Za-z0-9_-]{32,64}", subject):
        raise HTTPException(422, "Нужен случайный недельный гостевой токен.")
    check_rate(request, "usage-subject", 60, 60, subject)
    accepted = await record_usage(db, current, kind, subject, str(data.event_id), data.operation_type)
    await db.commit()
    return {"accepted": accepted}


@router.post("/usage/visit", status_code=202, dependencies=[Depends(require_csrf)])
async def visit(data: VisitInput, request: Request, session: Session = Depends(require_session), db: AsyncSession = Depends(get_db)) -> dict:
    """Учитывает согласованное посещение VisitInput/Request/Session через db; возвращает bool accepted."""
    check_rate(request, "usage-visit", 60, 60)
    current, _, _ = week_bounds()
    if data.week_key != current:
        raise HTTPException(422, "Неверная отчётная неделя.")
    await record_usage(db, current, "auth", session.user_id)
    await db.commit()
    return {"accepted": True}


@router.get("/admin/usage/weekly")
async def admin_weekly(request: Request, week: str | None = None, db: AsyncSession = Depends(get_db)) -> dict:
    """Проверяет admin Bearer Request и неделю week через db; возвращает только агрегированную сводку."""
    check_rate(request, "admin-usage", 30, 60)
    configured = settings.admin_api_token.get_secret_value()
    supplied = request.headers.get("authorization", "")
    if len(configured) < 32 or not hmac.compare_digest(supplied, f"Bearer {configured}"):
        raise HTTPException(403, "Доступ закрыт.")
    try:
        key, _, _ = week_bounds(week)
    except ValueError:
        raise HTTPException(422, "Неделя должна иметь формат YYYY-Www.") from None
    return await weekly_snapshot(db, key)
