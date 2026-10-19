/** Только кабинет: HttpOnly-сессия, CSRF в памяти, никакого localStorage для авторизации. */
let csrfToken = '';
let csrfIssuedAt = 0;

/** Ошибка API с безопасным текстом и HTTP-статусом без токенов/входного тела. */
export class ApiError extends Error {
  /** Создаёт ApiError из status (number) и message (str); возвращает экземпляр Error. */
  constructor(public readonly status: number, message: string) { super(message); }
}

/** Выполняет path/method (str), body (unknown) и retry (bool); возвращает типизированный JSON Promise<T>. */
export async function api<T = { message: string }>(path: string, method = 'GET', body?: unknown, retry = true): Promise<T> {
  const mutable = method !== 'GET';
  try {
    if (mutable && (!csrfToken || Date.now() - csrfIssuedAt > 60 * 60 * 1000)) {
      const response = await fetch('/api/v1/auth/csrf', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000) });
      if (!response.ok) throw new ApiError(response.status, 'Не удалось подготовить защищённый запрос.');
      csrfToken = (await response.json()).csrf_token;
      csrfIssuedAt = Date.now();
    }
    const response = await fetch(`/api/v1${path}`, {
      method, credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(20000),
      headers: mutable ? { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken } : {},
      ...(mutable ? { body: JSON.stringify(body ?? {}) } : {}),
    });
    if (response.status === 403 && mutable && retry) { csrfToken = ''; return api<T>(path, method, body, false); }
    const data = await response.json();
    if (!response.ok) throw new ApiError(response.status, data.error?.message || 'Запрос не выполнен. Попробуйте позже.');
    if (data.csrf_token) { csrfToken = data.csrf_token; csrfIssuedAt = Date.now(); }
    return data as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(0, 'Кабинет недоступен. Проверьте сеть. Локальное шифрование продолжает работать.');
  }
}
