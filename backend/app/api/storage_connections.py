"""Только чтение подключений текущего пользователя; облачные интеграции отложены."""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.basic_functions import get_db, require_session
from app.models import Session, StorageConnection

router = APIRouter(prefix="/storage-connections", tags=["Будущие подключения"])


@router.get("")
async def connections(session: Session = Depends(require_session), db: AsyncSession = Depends(get_db)) -> list[dict]:
    """Выбирает подключения владельца Session через db; возвращает список без учётных данных провайдеров."""
    rows = await db.scalars(select(StorageConnection).where(StorageConnection.user_id == session.user_id))
    return [{"id": row.id, "provider_type": row.provider_type, "display_name": row.display_name, "status": row.status} for row in rows]
