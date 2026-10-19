/** Проверка фактического наличия всей cipher-сборки в Cache API. */
import { config } from '../app/config';

let registration: Promise<ServiceWorkerRegistration> | undefined;

/** Возвращает единственную регистрацию SW без сетевых запросов из документа; загрузку SW выполняет браузер. */
function registerOffline(): Promise<ServiceWorkerRegistration> {
  return registration ??= navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
}

/** Подписывает listener (bool) на установленную ожидающую версию; возвращает функцию снятия подписки. */
export function watchOfflineUpdates(listener: (available: boolean) => void): () => void {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return () => {};
  let disposed = false;
  const cleanups: (() => void)[] = [];
  void registerOffline().then((reg) => {
    if (disposed) return;
    const check = () => {
      if (!disposed) listener(!!navigator.serviceWorker.controller && (reg.waiting?.state === 'installed' || reg.installing?.state === 'installed'));
    };
    const found = () => {
      const worker = reg.installing;
      if (worker) {
        worker.addEventListener('statechange', check);
        cleanups.push(() => worker.removeEventListener('statechange', check));
      }
      check();
    };
    reg.addEventListener('updatefound', found);
    cleanups.push(() => reg.removeEventListener('updatefound', found));
    found();
  }).catch(() => { if (!disposed) listener(false); });
  return () => { disposed = true; for (const cleanup of cleanups) cleanup(); };
}

/** Регистрирует локальный service worker; возвращает bool подтверждённой готовности всех ресурсов офлайн. */
export async function prepareOffline(): Promise<boolean> {
  if (!('serviceWorker' in navigator) || !import.meta.env.PROD) return false;
  try {
    await registerOffline();
    // ready не отклоняется даже при провале первого install: ожидание должно быть конечным.
    let readyTimeout = 0;
    const registration = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise<undefined>((resolve) => { readyTimeout = window.setTimeout(() => resolve(undefined), 8000); }),
    ]).finally(() => window.clearTimeout(readyTimeout));
    if (!registration?.active) return false;
    return await new Promise<boolean>((resolve) => {
      const channel = new MessageChannel();
      const timeout = window.setTimeout(() => { channel.port1.close(); resolve(false); }, 8000);
      channel.port1.onmessage = (event) => {
        window.clearTimeout(timeout);
        channel.port1.close();
        resolve(event.data?.ready === true && event.data?.buildId === config.buildId);
      };
      registration.active!.postMessage({ type: 'CHECK_CACHE' }, [channel.port2]);
    });
  } catch { return false; }
}
