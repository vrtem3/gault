/** Сбои настоящего Worker/OPFS на малых синтетических входах; диск не заполняется. */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const directory = resolve('tests/fixtures/compatibility/v0.1.0');
const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8'));
const previous = 'previous-committed-output';
type Mode = 'encrypt' | 'decrypt';
type Fault = 'read' | 'write' | 'quota' | 'close' | 'worker' | 'cancel-write' | 'cancel-close' | 'none';
interface State { received: number; written: number; outstanding: number; aborted: boolean; closeStarted: boolean; closed: boolean; release?: () => void }

/** Включает fault (Fault) только внутри теста page; возвращает Promise<void> после подготовки приложения. */
async function configure(page: Page, fault: Fault): Promise<void> {
  await page.route('**/_telemetry.html', (route) => route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>synthetic telemetry sink</title>' }));
  if (fault === 'read' || fault === 'worker') {
    await page.route(/\/assets\/crypto\.worker-[^/]+\.js$/, async (route) => {
      const response = await route.fetch();
      const prefix = fault === 'read'
        ? `const nativeStream = File.prototype.stream; File.prototype.stream = function() { const reader = nativeStream.call(this).getReader(); let pulls = 0; return new ReadableStream({async pull(controller) { if (pulls++ > 0) { controller.error(new Error('synthetic-read-failure')); return; } const next = await reader.read(); if (next.done) controller.close(); else controller.enqueue(next.value); }, cancel() { return reader.cancel(); }}); };\n`
        : `self.addEventListener('message', event => { if(event.data?.type === 'start') setTimeout(() => { throw new Error('synthetic-worker-stop'); }, 10); });\n`;
      await route.fulfill({ response, body: prefix + await response.text() });
    });
  }
  await page.addInitScript(({ fault, previous }) => {
    const state: State = { received: 0, written: 0, outstanding: 0, aborted: false, closeStarted: false, closed: false };
    (window as unknown as { faultState: State }).faultState = state;
    localStorage.setItem('gault-usage-consent', 'yes');
    const NativeWorker = window.Worker;
    window.Worker = class extends NativeWorker {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        this.addEventListener('message', (event) => {
          if (event.data?.type === 'chunk') { state.received++; state.outstanding = Math.max(state.outstanding, state.received - state.written); }
        });
      }
    };
    window.showSaveFilePicker = async () => {
      const handle = await (await navigator.storage.getDirectory()).getFileHandle('target-output', { create: true });
      const initial = await handle.createWritable(); await initial.write(previous); await initial.close();
      return { name: handle.name, createWritable: async () => {
        const stream = await handle.createWritable();
        return {
          async write(chunk: Uint8Array<ArrayBuffer>) {
            if (fault === 'write') throw new DOMException('synthetic-write-failure', 'NotReadableError');
            if (fault === 'quota') throw new DOMException('synthetic-quota-failure', 'QuotaExceededError');
            await stream.write(chunk);
            if (fault === 'cancel-write' && !state.release) await new Promise<void>((done) => { state.release = done; });
            state.written++;
          },
          async close() {
            state.closeStarted = true;
            if (fault === 'close') throw new DOMException('synthetic-close-failure', 'NotReadableError');
            if (fault === 'cancel-close') await new Promise<void>((done) => { state.release = done; });
            await stream.close(); state.closed = true;
          },
          async abort() { await stream.abort(); state.aborted = true; },
        };
      } } as FileSystemFileHandle;
    };
  }, { fault, previous });
  await page.goto('/');
  await expect(page.getByText('Готово к работе без интернета', { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** Заполняет page для mode с неизменяемым малым входом; возвращает исходный SHA-256. */
async function fill(page: Page, mode: Mode): Promise<{ path: string; sha256: string }> {
  const path = resolve(directory, mode === 'encrypt' ? 'boundary-65537.bin' : 'gault-boundary-65537.age');
  const sha256 = createHash('sha256').update(readFileSync(path)).digest('hex');
  if (mode === 'decrypt') await page.getByRole('tab', { name: 'Расшифровать', exact: true }).click();
  else await page.getByRole('button', { name: 'Ввести свою', exact: true }).click();
  await page.getByTestId('file-input').setInputFiles(path);
  await page.getByLabel('Секретная фраза', { exact: true }).fill(manifest.passphrase);
  if (mode === 'encrypt') await page.getByLabel('Повторите фразу', { exact: true }).fill(manifest.passphrase);
  return { path, sha256 };
}

/** Читает последний зафиксированный target-output в OPFS page; возвращает текст прежнего файла. */
async function committed(page: Page): Promise<string> {
  return page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('target-output')).getFile()).text());
}

for (const mode of ['encrypt', 'decrypt'] as const) {
  for (const fault of ['read', 'write', 'quota', 'close', 'worker', 'cancel-write', 'cancel-close'] as const) {
    test(`${mode}: ${fault} не коммитит неполный файл и не отправляет успех`, async ({ page }) => {
      await configure(page, fault);
      const source = await fill(page, mode);
      const events: string[] = [];
      page.on('request', (request) => { if (request.url().includes('_telemetry.html') || request.url().endsWith('/usage/events')) events.push(request.url()); });
      await page.getByRole('button', { name: mode === 'encrypt' ? 'Зашифровать файл' : 'Расшифровать файл', exact: true }).click();
      if (fault.startsWith('cancel-')) {
        await expect.poll(() => page.evaluate(() => typeof (window as unknown as { faultState: State }).faultState.release)).toBe('function');
        await page.getByRole('button', { name: 'Отменить', exact: true }).click();
      }
      await expect(page.getByRole('alert')).toBeVisible();
      if (fault === 'quota') await expect(page.getByRole('alert')).toContainText('Недостаточно места');
      if (fault.startsWith('cancel-')) await expect(page.getByRole('alert')).toContainText('Операция отменена');
      await expect.poll(() => page.evaluate(() => (window as unknown as { faultState: State }).faultState.aborted)).toBe(true);
      await page.evaluate(() => (window as unknown as { faultState: State }).faultState.release?.());
      await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toHaveCount(0);
      expect(await committed(page)).toBe(previous);
      expect(createHash('sha256').update(readFileSync(source.path)).digest('hex')).toBe(source.sha256);
      expect(events).toEqual([]);
    });
  }
  for (const action of ['reload', 'close'] as const) {
    test(`${mode}: ${action} вкладки сохраняет прежний файл; повтор начинается заново`, async ({ page, context }) => {
      await configure(page, 'cancel-write');
      const source = await fill(page, mode);
      await page.getByRole('button', { name: mode === 'encrypt' ? 'Зашифровать файл' : 'Расшифровать файл', exact: true }).click();
      await expect.poll(() => page.evaluate(() => typeof (window as unknown as { faultState: State }).faultState.release)).toBe('function');
      page.on('dialog', (dialog) => dialog.accept());
      if (action === 'reload') await page.reload();
      else { await page.close(); page = await context.newPage(); await page.goto('/'); }
      await expect(page.getByRole('heading', { name: 'Защитите свои файлы' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toHaveCount(0);
      expect(await committed(page)).toBe(previous);
      expect(createHash('sha256').update(readFileSync(source.path)).digest('hex')).toBe(source.sha256);
      expect(await page.getByLabel('Секретная фраза', { exact: true }).inputValue()).not.toBe(manifest.passphrase);
      // Следующий запуск действительно проходит с нуля после аварийного прерывания.
      await page.addInitScript(() => { window.showSaveFilePicker = async (options) => (await navigator.storage.getDirectory()).getFileHandle(options!.suggestedName!, { create: true }); });
      await page.reload(); await fill(page, mode);
      await page.getByRole('button', { name: mode === 'encrypt' ? 'Зашифровать файл' : 'Расшифровать файл', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toBeVisible();
    });
  }
}

for (const kind of ['changed-start', 'changed-middle', 'changed-end', 'truncated-start', 'truncated-middle', 'truncated-end']) {
  test(`контейнер ${kind}: проверяется до конца, неполный plaintext не коммитится`, async ({ page }) => {
    await configure(page, 'none');
    const valid = readFileSync(resolve(directory, 'gault-boundary-65537.age'));
    const position = kind.endsWith('start') ? 1 : kind.endsWith('middle') ? Math.floor(valid.length / 2) : valid.length - 1;
    const damaged = kind.startsWith('changed') ? Buffer.from(valid) : valid.subarray(0, position);
    if (kind.startsWith('changed')) damaged[position] ^= 1;
    await page.getByRole('tab', { name: 'Расшифровать', exact: true }).click();
    await page.getByTestId('file-input').setInputFiles({ name: `${kind}.age`, mimeType: 'application/octet-stream', buffer: damaged });
    await page.getByLabel('Секретная фраза', { exact: true }).fill(manifest.passphrase);
    await page.getByRole('button', { name: 'Расшифровать файл', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toHaveCount(0);
    expect(await committed(page)).toBe(previous);
  });
}

test('медленный sink удерживает максимум один неподтверждённый блок', async ({ page }) => {
  await configure(page, 'cancel-write'); await fill(page, 'encrypt');
  const data = Buffer.alloc(4 * 1024 * 1024, 0x73);
  await page.getByTestId('file-input').setInputFiles({ name: 'backpressure.bin', mimeType: 'application/octet-stream', buffer: data });
  await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as unknown as { faultState: State }).faultState.release)).toBe('function');
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as unknown as { faultState: State }).faultState.received)).toBe(1);
  await page.evaluate(() => (window as unknown as { faultState: State }).faultState.release!());
  await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toBeVisible();
  const state = await page.evaluate(() => { const { received, written, outstanding, closed } = (window as unknown as { faultState: State }).faultState; return { received, written, outstanding, closed }; });
  expect(state.received).toBeGreaterThan(2); expect(state.received).toBe(state.written); expect(state.outstanding).toBe(1); expect(state.closed).toBe(true);
});
