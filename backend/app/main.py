"""FastAPI Gault: аккаунты и агрегаты; endpoint загрузки файлов отсутствует."""

from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from sqlalchemy import text

from app.api import auth, storage_connections, usage, users
from app.basic_functions import check_rate
from app.core.db import engine


@asynccontextmanager
async def lifespan(_app: FastAPI):
    """Управляет ресурсами _app (FastAPI); выдаёт None и закрывает engine при остановке."""
    yield
    await engine.dispose()


app = FastAPI(title="Gault API", version="0.1.0", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url="/api/v1/openapi.json")


@app.middleware("http")
async def security_headers(request: Request, call_next):
    """Проверяет размер Request и вызывает call_next; возвращает response с безопасными заголовками."""
    try:
        check_rate(request, "all", 300, 60)
        if request.method in ("POST", "PATCH", "PUT", "DELETE"):
            length = request.headers.get("content-length", "0")
            if not length.isdecimal() or int(length) > 8192 or request.headers.get("transfer-encoding"):
                raise HTTPException(413, "Максимальный размер запроса — 8 КБ.")
            if len(await request.body()) > 8192:
                raise HTTPException(413, "Максимальный размер запроса — 8 КБ.")
        response = await call_next(request)
    except HTTPException as exc:
        response = JSONResponse({"error": {"code": str(exc.status_code), "message": str(exc.detail)}}, status_code=exc.status_code, headers=exc.headers)
    response.headers.update({"Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY", "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'", "Permissions-Policy": "camera=(), microphone=(), geolocation=()"})
    return response


@app.exception_handler(HTTPException)
async def http_error(_request: Request, exc: HTTPException) -> JSONResponse:
    """Преобразует HTTPException exc и _request; возвращает единый JSONResponse без входных данных."""
    return JSONResponse({"error": {"code": str(exc.status_code), "message": str(exc.detail)}}, status_code=exc.status_code, headers=exc.headers)


@app.exception_handler(RequestValidationError)
async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """Обрабатывает RequestValidationError exc и _request; возвращает JSONResponse без input, ctx и секретов."""
    fields = [".".join(map(str, item["loc"][1:])) for item in exc.errors()[:10]]
    return JSONResponse({"error": {"code": "validation_error", "message": "Проверьте заполнение полей.", "fields": fields}}, status_code=422)


@app.get("/api/v1/health", tags=["Система"])
async def health() -> dict:
    """Проверяет соединение с SQLite; возвращает dict состояния API."""
    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))
    return {"status": "ok"}


@app.get("/api/v1/version", tags=["Система"])
async def version() -> dict:
    """Возвращает публичный dict версии API без конфигурации окружения."""
    return {"version": "0.1.0"}


for router in (auth.router, users.router, storage_connections.router, usage.router):
    app.include_router(router, prefix="/api/v1")
