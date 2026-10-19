/** Сквозные сценарии настоящего Worker, диска, офлайна и безопасных отказов. */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Decrypter, Encrypter } from 'age-encryption';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const phrase = 'test-only-кедр-cobalt-orbit-sunset-lantern';
const original = Buffer.from(Array.from({ length: 131_089 }, (_, index) => index % 256));

/** До загрузки page (Page) подменяет только диалог выбора на реальный дисковый OPFS; возвращает Promise<void>. */
async function diskPicker(page: Page): Promise<void> {
  await page.addInitScript(() => { window.showSaveFilePicker = async (options) => (await navigator.storage.getDirectory()).getFileHandle(options!.suggestedName!, { create: true }); });
}

/** Открывает page и дожидается полного кэша/Worker; возвращает Promise<void>. */
async function ready(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByText('Готово к работе без интернета', { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
}

/** Заполняет page данными малого тестового файла и секретом secret (str); возвращает Promise<void>. */
async function encryptForm(page: Page, secret = phrase): Promise<void> {
  await page.getByRole('button', { name: 'Ввести свою', exact: true }).click();
  await page.getByTestId('file-input').setInputFiles({ name: 'данные.bin', mimeType: 'application/octet-stream', buffer: original });
  await page.getByLabel('Секретная фраза', { exact: true }).fill(secret);
  await page.getByLabel('Повторите фразу', { exact: true }).fill(secret);
}

/** Читает небольшой OPFS name (str) через page; возвращает Promise<Buffer> только для тестового файла. */
async function readOutput(page: Page, name: string): Promise<Buffer> {
  const bytes = await page.evaluate(async (filename) => Array.from(new Uint8Array(await (await (await (await navigator.storage.getDirectory()).getFileHandle(filename)).getFile()).arrayBuffer())), name);
  return Buffer.from(bytes);
}

test('инструкция и конфиденциальность доступны без кабинета и API', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', (request) => { if (request.url().includes('/api/') || request.url().includes('_telemetry.html')) requests.push(request.url()); });
  const response = await page.goto('/#instructions');
  const policy = response!.headers()['content-security-policy'];
  expect(policy).toContain("connect-src 'none'");
  expect(policy).toContain("frame-src 'none'");
  await expect(page.getByRole('link', { name: 'Скачать age', exact: false })).toHaveAttribute('href', 'https://github.com/FiloSottile/age/releases');
  await expect(page.getByRole('link', { name: 'Скачать rage', exact: false })).toHaveAttribute('href', 'https://github.com/str4d/rage/releases');
  await expect(page.getByText('age -d -o restored.zip archive.zip.age', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Личный кабинет', exact: false })).toHaveCount(0);
  await page.getByRole('link', { name: 'Конфиденциальность', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Статистика не собирается', exact: true })).toBeVisible();
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(requests).toEqual([]);
});

test('старое согласие не включает статистику после онлайн roundtrip', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('gault-usage-consent', 'yes'); });
  await diskPicker(page); await ready(page); await encryptForm(page);
  const requests: string[] = [];
  const integrations: string[] = [];
  page.on('request', (request) => {
    requests.push(request.url());
    if (request.url().includes('/api/') || request.url().includes('_telemetry.html')) integrations.push(request.url());
  });
  await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toBeVisible();
  const encrypted = await readOutput(page, 'данные.bin.age');
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(requests).toEqual([]);
  await page.getByRole('tab', { name: 'Расшифровать', exact: true }).click();
  await page.getByTestId('file-input').setInputFiles({ name: 'standalone.bin.age', mimeType: 'application/octet-stream', buffer: encrypted });
  await page.getByLabel('Секретная фраза', { exact: true }).fill(phrase);
  // Предзагрузка нового Worker между операциями не входит в окно обработки файла.
  await page.waitForLoadState('networkidle'); requests.length = 0;
  await page.getByRole('button', { name: 'Расшифровать файл', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toBeVisible();
  const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  expect(sha(await readOutput(page, 'standalone.bin'))).toBe(sha(original));
  await expect(page.locator('iframe')).toHaveCount(0);
  expect(requests).toEqual([]);
  expect(integrations).toEqual([]);
});

test('браузер → age/rage; age/rage → браузер: SHA-256 либо безопасный KDF-отказ', async ({ page }, testInfo) => {
  await diskPicker(page); await ready(page); await encryptForm(page);
  const requests: string[] = [];
  page.on('request', (request) => requests.push(request.url()));
  await page.route('**/*', (route) => route.abort('blockedbyclient'));
  await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  const encrypted = await readOutput(page, 'данные.bin.age');
  const cipherPath = testInfo.outputPath('browser.age'); await writeFile(cipherPath, encrypted);
  const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');
  for (const name of ['age', 'rage']) {
    const output = testInfo.outputPath(`${name}.out`);
    const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['scripts/cli_passphrase.py', resolve(`../.tools/${name}/${name}/${name}${process.platform === 'win32' ? '.exe' : ''}`), '-d', cipherPath], { env: { ...process.env, GAULT_TEST_PASSPHRASE: phrase, GAULT_TEST_OUTPUT: output }, timeout: 120000 });
    expect(result.status, result.stderr?.toString()).toBe(0);
    expect(sha(await readFile(output))).toBe(sha(original));
  }
  const input = testInfo.outputPath('source.bin'); await writeFile(input, original);
  await page.unroute('**/*');
  const matrix = [];
  for (const name of ['age', 'rage']) {
    const fromCli = testInfo.outputPath(`from-${name}.age`);
    const result = spawnSync(process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'), ['scripts/cli_passphrase.py', resolve(`../.tools/${name}/${name}/${name}${process.platform === 'win32' ? '.exe' : ''}`), '-p', input], { env: { ...process.env, GAULT_TEST_PASSPHRASE: phrase, GAULT_TEST_OUTPUT: fromCli }, timeout: 120000 });
    expect(result.status, result.stderr?.toString()).toBe(0);
    const bytes = await readFile(fromCli);
    const logN = Number(/-> scrypt \S+ (\d+)/.exec(bytes.subarray(0, 200).toString())![1]);
    await page.getByRole('tab', { name: 'Расшифровать', exact: true }).click();
    await page.getByTestId('file-input').setInputFiles({ name: `restored-${name}.bin.age`, mimeType: 'application/octet-stream', buffer: bytes });
    await page.getByLabel('Секретная фраза', { exact: true }).fill(phrase);
    await page.getByRole('button', { name: 'Расшифровать файл', exact: true }).click();
    if (logN > 18) {
      await expect(page.getByRole('alert')).toContainText('требуют слишком много памяти');
      await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toHaveCount(0);
    } else {
      await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toBeVisible();
      expect(sha(await readOutput(page, `restored-${name}.bin`))).toBe(sha(original));
    }
    matrix.push({ cli: name, scryptLogN: logN, cliToBrowser: logN > 18 ? 'rejected-kdf-limit' : 'passed', sha256: logN > 18 ? null : sha(original) });
  }
  expect(sha(await readFile(input))).toBe(sha(original));
  await testInfo.attach('native-browser-matrix', { body: JSON.stringify({ platform: process.platform, architecture: process.arch, browser: page.context().browser()?.version(), browserToCli: ['age: passed', 'rage: passed'], cliToBrowser: matrix }, null, 2), contentType: 'application/json' });
});

test('полный офлайн-перезапуск и roundtrip без запросов', async ({ page, context }) => {
  await diskPicker(page); await ready(page);
  await context.setOffline(true); await page.reload();
  await expect(page.getByRole('heading', { name: 'Защитите свои файлы' })).toBeVisible();
  await page.waitForLoadState('networkidle'); await encryptForm(page);
  const requests: string[] = []; page.on('request', (request) => requests.push(request.url()));
  await page.route('**/*', (route) => route.abort('blockedbyclient'));
  await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toBeVisible();
  expect(requests).toEqual([]);
  const encrypted = await readOutput(page, 'данные.bin.age');
  const decrypter = new Decrypter(); decrypter.addPassphrase(phrase);
  expect(Buffer.from(await decrypter.decrypt(encrypted))).toEqual(original);
  await page.getByRole('tab', { name: 'Расшифровать', exact: true }).click();
  await page.getByTestId('file-input').setInputFiles({ name: 'offline.bin.age', mimeType: 'application/octet-stream', buffer: encrypted });
  await page.getByLabel('Секретная фраза', { exact: true }).fill(phrase);
  await page.waitForLoadState('networkidle'); requests.length = 0;
  await page.getByRole('button', { name: 'Расшифровать файл', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toBeVisible();
  expect(await readOutput(page, 'offline.bin')).toEqual(original); expect(requests).toEqual([]);
});

test('слабая фраза разрешена, несовпадение подтверждения блокируется', async ({ page }) => {
  await diskPicker(page); await ready(page); await encryptForm(page, 'password123');
  await page.getByLabel('Повторите фразу', { exact: true }).fill('different');
  await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Фразы не совпадают');
  await page.getByLabel('Повторите фразу', { exact: true }).fill('password123');
  await expect(page.getByText('Можно продолжить с этой фразой.', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toBeVisible();
});

test('экспорт фразы требует явного подтверждения и ничего не сохраняет автоматически', async ({ page }) => {
  await ready(page);
  const downloads: string[] = []; page.on('download', (download) => downloads.push(download.suggestedFilename()));
  expect(downloads).toEqual([]);
  page.once('dialog', async (dialog) => { expect(dialog.message()).toContain('ОТКРЫТОМ ВИДЕ'); await dialog.dismiss(); });
  await page.getByRole('button', { name: 'Скачать фразу (.txt)', exact: true }).click(); expect(downloads).toEqual([]);
  page.once('dialog', (dialog) => dialog.accept());
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Скачать фразу (.txt)', exact: true }).click();
  expect((await download).suggestedFilename()).toBe('secret-phrase.txt');
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  expect(storage).not.toContain(await page.getByLabel('Секретная фраза', { exact: true }).inputValue());
});

test('ошибка записи не приводит к успеху', async ({ page }) => {
  await page.addInitScript(() => { window.showSaveFilePicker = async () => ({ name: 'failed.age', createWritable: async () => ({ async write() { throw new DOMException('disk full', 'QuotaExceededError'); }, async close() {}, async abort() { (window as unknown as Record<string, unknown>).aborted = true; } }) }) as unknown as FileSystemFileHandle; });
  await ready(page); await encryptForm(page);
  await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Недостаточно места');
  await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Record<string, unknown>).aborted)).toBe(true);
});

test('отмена откатывает незавершённую запись и сохраняет предыдущий файл', async ({ page }) => {
  await page.addInitScript(() => { window.showSaveFilePicker = async () => { const handle = await (await navigator.storage.getDirectory()).getFileHandle('cancel-target.age', { create: true }); const initial = await handle.createWritable(); await initial.write('keep-existing-output'); await initial.close(); return handle; }; });
  await ready(page); await encryptForm(page);
  await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
  await page.getByRole('button', { name: 'Отменить', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Операция отменена');
  expect((await readOutput(page, 'cancel-target.age')).toString()).toBe('keep-existing-output');
  await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toHaveCount(0);
});

test('неверная фраза и повреждённый файл не дают успешного результата', async ({ page }) => {
  const cipher = new Encrypter(); cipher.setPassphrase(phrase);
  const valid = await cipher.encrypt(original);
  await diskPicker(page); await ready(page);
  await page.getByRole('tab', { name: 'Расшифровать', exact: true }).click();
  await page.getByTestId('file-input').setInputFiles({ name: 'wrong.bin.age', mimeType: 'application/octet-stream', buffer: Buffer.from(valid) });
  await page.getByLabel('Секретная фраза', { exact: true }).fill('wrong-phrase');
  await page.getByRole('button', { name: 'Расшифровать файл', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось расшифровать');
  valid[valid.length - 1] ^= 1;
  await page.getByTestId('file-input').setInputFiles({ name: 'corrupt.bin.age', mimeType: 'application/octet-stream', buffer: Buffer.from(valid) });
  await page.getByLabel('Секретная фраза', { exact: true }).fill(phrase);
  await page.getByRole('button', { name: 'Расшифровать файл', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Не удалось расшифровать');
  await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toHaveCount(0);
});

test('не допускает выбора исходного имени для перезаписи', async ({ page }) => {
  await page.addInitScript(() => { window.showSaveFilePicker = async () => ({ name: 'ДАННЫЕ.BIN', createWritable: async () => { throw new Error('must not open writer'); } }) as unknown as FileSystemFileHandle; });
  await ready(page); await encryptForm(page);
  await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Выберите новое имя');
});

test('RAM-fallback обозначен явно и предлагает подтверждённый пользователем download', async ({ page }) => {
  await page.addInitScript(() => { delete window.showSaveFilePicker; });
  await ready(page); await encryptForm(page);
  await expect(page.getByText('Ограниченный режим сохранения:', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Файл подготовлен к скачиванию' })).toBeVisible();
  const download = page.waitForEvent('download'); await page.getByRole('link', { name: 'Сохранить результат' }).click();
  expect((await download).suggestedFilename()).toBe('данные.bin.age');
});

test('смартфон: заметный лимит до выбора и блокировка 100 МБ + 1 байт', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148', isMobile: true, hasTouch: true });
  const page = await context.newPage(); await page.goto('http://localhost:5173');
  await expect(page.getByText('На смартфонах действует ограничение 100 МБ', { exact: false })).toBeVisible();
  await page.evaluate(() => { const file = new File(['small'], 'too-large.bin'); Object.defineProperty(file, 'size', { value: 100_000_001 }); const transfer = new DataTransfer(); transfer.items.add(file); const input = document.querySelector<HTMLInputElement>('input[type=file]')!; Object.defineProperty(input, 'files', { configurable: true, value: transfer.files }); input.dispatchEvent(new Event('change', { bubbles: true })); });
  await expect(page.getByRole('alert')).toContainText('до 100 МБ');
  await expect(page.getByRole('button', { name: 'Зашифровать файл', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await context.close();
});

test('тёмная/светлая темы, мобильный экран и WCAG AA', async ({ page }, testInfo) => {
  await ready(page);
  const audit = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa']).analyze();
  expect(audit.violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('desktop-light.png'), fullPage: true });
  await page.getByLabel('Тема интерфейса').selectOption('dark');
  await expect(page.locator('.phrase-actions button').first()).toHaveCSS('color', 'rgb(148, 163, 184)');
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.screenshot({ path: testInfo.outputPath('desktop-dark.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: testInfo.outputPath('mobile-dark.png'), fullPage: true });
  await page.getByLabel('Тема интерфейса').selectOption('light');
  await expect(page.locator('.phrase-actions button').first()).toHaveCSS('color', 'rgb(100, 116, 139)');
  await page.screenshot({ path: testInfo.outputPath('mobile-light.png'), fullPage: true });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
