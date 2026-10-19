"""Типизированные настройки Gault из окружения и локального .env."""

from pathlib import Path
from typing import Literal, Self
from urllib.parse import urlsplit
from zoneinfo import ZoneInfo

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Параметры API; секретные значения не включаются в представление объекта."""

    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[3] / ".env", extra="ignore"
    )
    environment: Literal["development", "production", "test"] = "development"
    secret_key: SecretStr
    database_url: str = "sqlite+aiosqlite:///../data/gault.db"
    public_cipher_origin: str = "http://localhost:5173"
    public_account_origin: str = "http://localhost:5174"
    cookie_secure: bool = False
    session_days: int = 14
    report_timezone: str = "Asia/Yekaterinburg"
    admin_report_email: str = ""
    admin_api_token: SecretStr = SecretStr("")
    smtp_host: str = ""
    smtp_port: int = 587
    smtp_user: str = ""
    smtp_password: SecretStr = SecretStr("")
    smtp_from: str = "Gault <noreply@gault.ru>"
    smtp_tls: Literal["starttls", "tls", "none"] = "starttls"

    @model_validator(mode="after")
    def validate_deployment(self) -> Self:
        """Проверяет настройки self; возвращает валидный Settings или ValueError."""
        if len(self.secret_key.get_secret_value()) < 32:
            raise ValueError("SECRET_KEY должен содержать не менее 32 символов")
        ZoneInfo(self.report_timezone)
        if not 1 <= self.session_days <= 30:
            raise ValueError("SESSION_DAYS: допустимо от 1 до 30")
        for origin in (self.public_cipher_origin, self.public_account_origin):
            parsed = urlsplit(origin)
            if parsed.scheme not in ("http", "https") or not parsed.netloc or parsed.path or parsed.query or parsed.fragment:
                raise ValueError("Укажите origin без пути и завершающего слеша")
        if self.public_cipher_origin == self.public_account_origin:
            raise ValueError("Шифратор и кабинет должны иметь разные origin")
        if not self.database_url.startswith("sqlite+aiosqlite:///"):
            raise ValueError("MVP использует локальную SQLite через aiosqlite")
        if self.environment == "production":
            if not self.cookie_secure or any(not origin.startswith("https://") for origin in (self.public_cipher_origin, self.public_account_origin)):
                raise ValueError("Production требует HTTPS и COOKIE_SECURE=true")
            if self.smtp_host and self.smtp_tls == "none":
                raise ValueError("Production SMTP требует TLS")
        return self


settings = Settings()
