"""Строгие DTO API: неизвестные поля и файловые метаданные не принимаются."""

from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, SecretStr


class StrictModel(BaseModel):
    """Базовая схема, запрещающая неизвестные поля входного JSON."""
    model_config = ConfigDict(extra="forbid")


class Credentials(StrictModel):
    """Email и скрытый пароль аккаунта; политика регистрации проверяется отдельно."""
    email: EmailStr = Field(max_length=254)
    password: SecretStr = Field(min_length=1, max_length=512)


class EmailInput(StrictModel):
    """Email для одинакового публичного ответа при наличии и отсутствии аккаунта."""
    email: EmailStr = Field(max_length=254)


class TokenInput(StrictModel):
    """Одноразовый непрозрачный токен без возможности вывода секрета в repr."""
    token: SecretStr = Field(min_length=32, max_length=128)


class ResetInput(TokenInput):
    """Токен сброса и новый пароль аккаунта."""
    password: SecretStr = Field(min_length=1, max_length=512)


class ProfileInput(StrictModel):
    """Редактируемая часть профиля без пользовательского id или email."""
    display_name: str = Field(max_length=80)


class PasswordChangeInput(StrictModel):
    """Старый и новый пароли аккаунта для изменения с отзывом всех сессий."""
    current_password: SecretStr = Field(min_length=1, max_length=512)
    password: SecretStr = Field(min_length=1, max_length=512)


class UsageEventInput(StrictModel):
    """Единственные четыре разрешённые поля события добровольной статистики."""
    operation_type: Literal["encrypt", "decrypt"]
    week_key: str = Field(pattern=r"^\d{4}-W\d{2}$")
    guest_or_auth: Literal["guest", "auth"]
    event_id: UUID


class VisitInput(StrictModel):
    """Добровольное посещение кабинета без выдуманной файловой операции."""
    week_key: str = Field(pattern=r"^\d{4}-W\d{2}$")
