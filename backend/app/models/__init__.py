"""Модели аккаунтов, будущих подключений и обезличенных недельных агрегатов."""

from datetime import datetime
from uuid import uuid4

from sqlalchemy import JSON, ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.basic_functions import now_utc
from app.core.db import Base


class User(Base):
    """Учётная запись; пароли файлов и пользовательские файлы здесь отсутствуют."""
    __tablename__ = "users"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    password_hash: Mapped[str] = mapped_column(String(256))
    display_name: Mapped[str] = mapped_column(String(80), default="")
    email_verified_at: Mapped[datetime | None]
    status: Mapped[str] = mapped_column(String(16), default="active")
    created_at: Mapped[datetime] = mapped_column(default=now_utc)
    updated_at: Mapped[datetime] = mapped_column(default=now_utc, onupdate=now_utc)


class Session(Base):
    """Отзываемая серверная сессия с HMAC токена вместо открытого секрета."""
    __tablename__ = "sessions"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(default=now_utc)
    expires_at: Mapped[datetime]
    revoked_at: Mapped[datetime | None]


class EmailVerificationToken(Base):
    """Короткоживущий одноразовый токен подтверждения email."""
    __tablename__ = "email_verification_tokens"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime]
    consumed_at: Mapped[datetime | None]


class PasswordResetToken(Base):
    """Короткоживущий одноразовый токен сброса пароля аккаунта."""
    __tablename__ = "password_reset_tokens"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    expires_at: Mapped[datetime]
    consumed_at: Mapped[datetime | None]


class StorageConnection(Base):
    """Фундамент будущих подключений; токенов и работающих адаптеров в MVP нет."""
    __tablename__ = "storage_connections"
    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid4()))
    user_id: Mapped[str] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    provider_type: Mapped[str] = mapped_column(String(32))
    display_name: Mapped[str] = mapped_column(String(80))
    status: Mapped[str] = mapped_column(String(16), default="inactive")
    created_at: Mapped[datetime] = mapped_column(default=now_utc)


class UsageWeeklyTotal(Base):
    """Сохраняемые агрегаты без индивидуальной истории операций."""
    __tablename__ = "usage_weekly_totals"
    week_key: Mapped[str] = mapped_column(String(8), primary_key=True)
    auth_kind: Mapped[str] = mapped_column(String(8), primary_key=True)
    encrypt_count: Mapped[int] = mapped_column(default=0)
    decrypt_count: Mapped[int] = mapped_column(default=0)
    unique_count: Mapped[int] = mapped_column(default=0)


class UsageWeeklyUnique(Base):
    """Только недельный HMAC субъекта с TTL; без user_id, IP или email."""
    __tablename__ = "usage_weekly_uniques"
    week_key: Mapped[str] = mapped_column(String(8), primary_key=True)
    auth_kind: Mapped[str] = mapped_column(String(8), primary_key=True)
    subject_digest: Mapped[str] = mapped_column(String(64), primary_key=True)
    expires_at: Mapped[datetime] = mapped_column(index=True)


class UsageReceivedEvent(Base):
    """Технический отпечаток event_id для краткосрочной дедупликации; без данных операции."""
    __tablename__ = "usage_received_events"
    event_id_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    week_key: Mapped[str] = mapped_column(String(8))
    expires_at: Mapped[datetime] = mapped_column(index=True)


class ReportDelivery(Base):
    """Статус доставки и числовой снимок отчёта для безопасных повторов."""
    __tablename__ = "report_deliveries"
    week_key: Mapped[str] = mapped_column(String(8), primary_key=True)
    status: Mapped[str] = mapped_column(String(16), default="pending")
    attempts: Mapped[int] = mapped_column(default=0)
    snapshot: Mapped[dict] = mapped_column(JSON)
    updated_at: Mapped[datetime] = mapped_column(default=now_utc, onupdate=now_utc)
