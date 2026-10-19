/** Добровольная статистика: нет fetch, сетевых очередей, файлов или фраз в API модуля. */
import { config } from '../../app/config';
import type { Operation } from '../../crypto/age';

/** Вычисляет ISO-неделю для now (Date) в timezone (str); возвращает YYYY-Www. */
export function weekKey(now = new Date(), timezone = config.reportTimezone): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const get = (type: string) => Number(parts.find((part) => part.type === type)!.value);
  const local = new Date(Date.UTC(get('year'), get('month') - 1, get('day')));
  local.setUTCDate(local.getUTCDate() + 4 - (local.getUTCDay() || 7));
  const year = local.getUTCFullYear();
  const week = Math.ceil(((local.getTime() - Date.UTC(year, 0, 1)) / 86400000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** Возвращает bool явного локального согласия на статистику; отсутствие хранилища означает отказ. */
export function usageConsent(): boolean {
  try { return localStorage.getItem('gault-usage-consent') === 'yes'; } catch { return false; }
}

/** Устанавливает consent (bool); возвращает void, при отказе удаляет недельный гостевой токен. */
export function setUsageConsent(consent: boolean): void {
  try { localStorage.setItem('gault-usage-consent', consent ? 'yes' : 'no'); if (!consent) localStorage.removeItem('gault-week-guest'); } catch { /* Без хранилища события не отправляются. */ }
}

/** После подтверждённого close передаёт operation (Operation) через изолированный iframe; возвращает void, ошибок UI не создаёт. */
export function reportCompletedOperation(operation: Operation): void {
  if (!usageConsent() || !navigator.onLine) return;
  try {
    const week = weekKey();
    const stored = JSON.parse(localStorage.getItem('gault-week-guest') || 'null');
    const random = new Uint8Array(32);
    crypto.getRandomValues(random);
    const token = stored?.week === week && /^[a-f0-9]{64}$/.test(stored.token) ? stored.token as string : Array.from(random, (byte) => byte.toString(16).padStart(2, '0')).join('');
    random.fill(0);
    localStorage.setItem('gault-week-guest', JSON.stringify({ week, token }));
    const nonce = crypto.randomUUID();
    const frame = document.createElement('iframe');
    frame.hidden = true;
    frame.title = 'Добровольная анонимная статистика';
    frame.referrerPolicy = 'no-referrer';
    frame.src = `${config.accountOrigin}/_telemetry.html#${nonce}`;
    const cleanup = () => { window.removeEventListener('message', receive); frame.remove(); window.clearTimeout(timeout); };
    const receive = (event: MessageEvent) => {
      if (event.origin !== config.accountOrigin || event.source !== frame.contentWindow || event.data?.nonce !== nonce) return;
      if (event.data.type === 'ready') frame.contentWindow!.postMessage({ type: 'usage', nonce, guestToken: token, payload: { operation_type: operation, week_key: week, guest_or_auth: 'guest', event_id: crypto.randomUUID() } }, config.accountOrigin);
      if (event.data.type === 'complete') cleanup();
    };
    const timeout = window.setTimeout(cleanup, 8000);
    window.addEventListener('message', receive);
    document.body.append(frame);
  } catch { /* Статистика необязательна: без повторов и скрытой очереди. */ }
}
