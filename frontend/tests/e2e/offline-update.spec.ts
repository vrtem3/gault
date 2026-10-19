/** Проверка настоящего PWA: новая сборка ожидает завершения старой офлайн-операции. */
import { expect, test } from '@playwright/test';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, sep } from 'node:path';

test('обновление PWA ждёт закрытия вкладки; старый Worker завершает запись офлайн', async ({ page, context }) => {
  const dist = resolve('dist');
  const source = await readFile(resolve(dist, 'sw.js'), 'utf8');
  let revision = 'a';
  // Отдельный loopback origin позволяет сменить только SW, не трогая пользовательский сервер.
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url!, 'http://localhost').pathname;
      const path = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(`${dist}${sep}`)) { response.writeHead(403).end(); return; }
      response.setHeader('Cache-Control', 'no-store');
      const sw = pathname === '/sw.js';
      response.setHeader('Content-Type', sw || path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.html') ? 'text/html' : 'application/json');
      response.setHeader('Content-Security-Policy', sw ? "default-src 'none'; script-src 'self'; connect-src 'self'" : "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'none'; worker-src 'self'; manifest-src 'self'");
      response.end(sw ? source.replace(/const CACHE = '([^']+)'/, `const CACHE = '$1-update-${revision}'`) : await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const port = (server.address() as { port: number }).port;
  const origin = `http://127.0.0.1:${port}`;
  try {
    await page.addInitScript(() => {
      window.showSaveFilePicker = async (options) => {
        const handle = await (await navigator.storage.getDirectory()).getFileHandle(options!.suggestedName!, { create: true });
        return { name: handle.name, createWritable: async () => {
          const stream = await handle.createWritable();
          let held = false;
          return { async write(chunk: Uint8Array<ArrayBuffer>) {
            if (!held) {
              held = true;
              await new Promise<void>((done) => { (window as unknown as { releaseWrite: () => void }).releaseWrite = done; });
            }
            await stream.write(chunk);
          }, close: () => stream.close(), abort: () => stream.abort() };
        } } as FileSystemFileHandle;
      };
    });
    await page.goto(origin);
    await expect(page.getByText('Готово к работе без интернета', { exact: true })).toBeVisible();
    await expect(page.getByText(/^Сборка [a-f0-9]{12}$/)).toBeVisible();
    await page.evaluate(() => { navigator.serviceWorker.addEventListener('controllerchange', () => { (window as unknown as { controllerChanged: boolean }).controllerChanged = true; }); });
    await page.getByRole('button', { name: 'Ввести свою', exact: true }).click();
    await page.getByTestId('file-input').setInputFiles({ name: 'update.bin', mimeType: 'application/octet-stream', buffer: Buffer.from('old-build-test') });
    await page.getByLabel('Секретная фраза', { exact: true }).fill('public-test-only-pwa-update');
    await page.getByLabel('Повторите фразу', { exact: true }).fill('public-test-only-pwa-update');
    await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as unknown as { releaseWrite?: unknown }).releaseWrite)).toBe('function');
    revision = 'b';
    await page.evaluate(async () => { await (await navigator.serviceWorker.getRegistration())!.update(); });
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe('installed');
    await expect(page.getByText('Доступно обновление Gault', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Подготовить обновление', exact: true })).toBeDisabled();
    expect(await page.evaluate(() => (window as unknown as { controllerChanged?: boolean }).controllerChanged)).not.toBe(true);
    await context.setOffline(true);
    await page.evaluate(() => (window as unknown as { releaseWrite: () => void }).releaseWrite());
    await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Подготовить обновление', exact: true }).click();
    await expect(page.getByText('Закройте все вкладки Gault', { exact: false })).toBeVisible();
    expect(await page.evaluate(() => (window as unknown as { controllerChanged?: boolean }).controllerChanged)).not.toBe(true);
    const second = await context.newPage();
    await second.goto(origin);
    await expect(second.getByRole('heading', { name: 'Защитите свои файлы' })).toBeVisible();
    await page.close();
    // Вторая старая вкладка также препятствует активации, даже после подтверждения первой.
    expect(await second.evaluate(async () => (await navigator.serviceWorker.getRegistration())?.waiting?.state)).toBe('installed');
    await second.close();
    // Только закрытие всех старых клиентов разрешает activate и удаление прежнего кэша.
    await expect.poll(async () => {
      for (const worker of context.serviceWorkers()) {
        try { const keys = await worker.evaluate(() => caches.keys()); if (keys.some((key) => key.endsWith('-update-b')) && !keys.some((key) => key.endsWith('-update-a'))) return true; } catch { /* Предыдущий SW уже завершился. */ }
      }
      return false;
    }).toBe(true);
    const reopened = await context.newPage();
    await reopened.goto(origin);
    await expect(reopened.getByRole('heading', { name: 'Защитите свои файлы' })).toBeVisible();
    await expect(reopened.getByText('Вы офлайн. Локальное шифрование доступно', { exact: true })).toBeVisible();
    await reopened.close();
  } finally {
    await context.setOffline(false);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

test('неполная новая сборка не заменяет рабочий офлайн-кэш', async ({ page, context, browser }) => {
  const dist = resolve('dist');
  const source = await readFile(resolve(dist, 'sw.js'), 'utf8');
  let broken = false;
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url!, 'http://localhost').pathname;
      const path = resolve(dist, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!path.startsWith(`${dist}${sep}`)) { response.writeHead(403).end(); return; }
      const sw = pathname === '/sw.js';
      if (broken && pathname.endsWith('.css')) { response.writeHead(503).end(); return; }
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Content-Type', sw || path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.html') ? 'text/html' : 'application/json');
      response.end(sw && broken ? source.replace(/const CACHE = '([^']+)'/, "const CACHE = '$1-broken'") : await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    await page.goto(origin);
    await expect(page.getByText('Готово к работе без интернета', { exact: true })).toBeVisible();
    broken = true;
    await page.evaluate(async () => {
      const registration = (await navigator.serviceWorker.getRegistration())!;
      const failed = new Promise<void>((done) => registration.addEventListener('updatefound', () => {
        const candidate = registration.installing!;
        candidate.addEventListener('statechange', () => { if (candidate.state === 'redundant') done(); });
      }, { once: true }));
      await registration.update(); await failed;
    });
    await expect(page.getByText('Доступно обновление Gault', { exact: true })).toHaveCount(0);
    expect((await page.evaluate(() => caches.keys())).some((key) => key.endsWith('-broken'))).toBe(false);
    await context.setOffline(true);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Защитите свои файлы' })).toBeVisible();
    await expect(page.getByText('Вы офлайн. Локальное шифрование доступно', { exact: true })).toBeVisible();
    // Частичное удаление браузером кэша больше не должно показывать подтверждённую готовность.
    await page.evaluate(async () => {
      for (const key of await caches.keys()) {
        const cache = await caches.open(key);
        for (const request of await cache.keys()) if (request.url.includes('/assets/crypto.worker-')) await cache.delete(request);
      }
    });
    await page.reload();
    await expect(page.getByText('Вы офлайн. Для повторного запуска кэш ещё не подтверждён', { exact: true })).toBeVisible();
    const fresh = await browser.newContext();
    try {
      const firstLoad = await fresh.newPage();
      await firstLoad.goto(origin);
      // Первый install также неудачен: ready не должен оставлять вечную «подготовку».
      await expect(firstLoad.getByText('Ресурсы для повторного офлайн-запуска загружены не полностью', { exact: true })).toBeVisible();
    } finally { await fresh.close(); }
  } finally {
    await context.setOffline(false); server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
  }
});
