/** Узкий приёмник postMessage: принимает только числовую телеметрию после операции, никогда File/Blob или секреты. */
import { config } from '../../src/app/config';

const nonce = location.hash.slice(1);
history.replaceState(null, '', location.pathname);
let used = false;

/** Проверяет MessageEvent от cipher-origin; возвращает Promise<void> после одной необязательной отправки агрегата. */
window.addEventListener('message', async (event: MessageEvent) => {
  if (used || event.source !== parent || event.origin !== config.cipherOrigin || event.data?.type !== 'usage' || event.data.nonce !== nonce) return;
  const input = event.data;
  const payload = input.payload;
  if (!payload || Object.keys(payload).sort().join(',') !== 'event_id,guest_or_auth,operation_type,week_key' || !['encrypt', 'decrypt'].includes(payload.operation_type) || !/^\d{4}-W\d{2}$/.test(payload.week_key) || !/^[a-f0-9-]{36}$/.test(payload.event_id) || !/^[a-f0-9]{64}$/.test(input.guestToken)) return;
  used = true;
  try {
    if (!navigator.onLine) return;
    const csrfResponse = await fetch('/api/v1/auth/csrf', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    if (!csrfResponse.ok) return;
    const csrf = await csrfResponse.json();
    const session = await fetch('/api/v1/auth/me', { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(4000) });
    // Новая структура строится явно: посторонние поля не могут попасть в тело запроса.
    await fetch('/api/v1/usage/events', {
      method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(4000),
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf.csrf_token, 'X-Guest-Token': input.guestToken },
      body: JSON.stringify({ operation_type: payload.operation_type, week_key: payload.week_key, event_id: payload.event_id, guest_or_auth: session.ok ? 'auth' : 'guest' }),
    });
  } catch { /* Без очереди и повторной отправки при восстановлении сети. */ }
  finally { parent.postMessage({ type: 'complete', nonce }, config.cipherOrigin); }
});

if (parent !== window && /^[a-f0-9-]{36}$/.test(nonce)) parent.postMessage({ type: 'ready', nonce }, config.cipherOrigin);
