/** Настоящий Chromium/OPFS roundtrip и потоковый SHA-256; --smoke использует только 1 и 8 MiB. */
import { chromium } from '@playwright/test';
import { open, mkdir, rm, statfs, writeFile, mkdtemp } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import os from 'node:os';

const smoke = process.argv.includes('--smoke');
assert(process.argv.slice(2).every((argument) => argument === '--smoke'), 'Допустим только --smoke');
const sizes = smoke ? [1024 ** 2, 8 * 1024 ** 2] : [Number(process.env.GAULT_LARGE_BYTES || 30 * 1024 ** 3)];
for (const size of sizes) {
  assert(Number.isSafeInteger(size) && size > 0, 'Неверный размер теста');
  assert(size <= 200_000_000 || process.env.GAULT_ALLOW_LARGE_TEST === '1', 'Большой тест отключён. Нужны отдельный запрос пользователя, подходящий ПК и GAULT_ALLOW_LARGE_TEST=1.');
}
const budget = Number(process.env.GAULT_MEMORY_BUDGET_MB || 2048) * 1024 ** 2;
const growthBudget = Number(process.env.GAULT_MEMORY_GROWTH_MB || 128) * 1024 ** 2;
assert(Number.isSafeInteger(budget) && budget > 0 && Number.isSafeInteger(growthBudget) && growthBudget >= 0, 'Неверный бюджет RAM');
const root = resolve('..');
await mkdir(join(root, '.tools'), { recursive: true });
const lockPath = join(root, '.tools/large-test.lock');
const lock = await open(lockPath, 'wx');
let directory;
let browser;
let persistentContext;
let monitor;
let sampling;
let cancelled = false;
let phase = 'baseline';
let currentSize = 0;
const samples = [];
const samplingErrors = [];
const started = Date.now();
const report = { date: new Date().toISOString(), mode: smoke ? 'small-smoke' : 'manual', platform: os.platform(), architecture: os.arch(), osVersion: os.release(), status: 'running', memoryBudgetBytes: budget, growthBudgetBytes: growthBudget, cases: [], samples, samplingErrors, largeFileCapabilityConfirmed: false };

/** Хэширует файл path потоками Node; возвращает SHA-256 без накопления всего входа. */
async function diskHash(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Хэширует OPFS name через ограниченные 512 KiB срезы и локальный тестовый драйвер, без второго host-файла. */
async function opfsHash(page, name) {
  const size = await page.evaluate(async (filename) => (await (await (await navigator.storage.getDirectory()).getFileHandle(filename)).getFile()).size, name);
  const hash = createHash('sha256');
  for (let offset = 0; offset < size; offset += 512 * 1024) {
    const encoded = await page.evaluate(async ({ name, offset }) => {
      const file = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
      const bytes = new Uint8Array(await file.slice(offset, offset + 512 * 1024).arrayBuffer());
      const text = [];
      for (let index = 0; index < bytes.length; index += 32768) text.push(String.fromCharCode(...bytes.subarray(index, index + 32768)));
      return btoa(text.join(''));
    }, { name, offset });
    const chunk = Buffer.from(encoded, 'base64');
    assert.equal(chunk.byteLength, Math.min(512 * 1024, size - offset));
    hash.update(chunk);
  }
  return { bytes: size, sha256: hash.digest('hex') };
}

/** Завершает только созданный этим тестом Chromium при сигнале; finally очищает его каталог и lock. */
function interrupted() { cancelled = true; process.exitCode = 130; if (browser) void browser.close(); }
process.once('SIGINT', interrupted);
process.once('SIGTERM', interrupted);

try {
  await lock.writeFile(String(process.pid)); await lock.close();
  // Резерв учитывает вход, оба результата и staging; sparse-файлы не используются.
  const capacity = await statfs(root);
  const available = capacity.bavail * capacity.bsize;
  const required = Math.max(...sizes) * 4 + 2 * 1024 ** 3;
  report.diskPreflight = { availableBytes: available, requiredBytes: required, reserveBytes: 2 * 1024 ** 3 };
  assert(available > required, 'Недостаточно свободного диска под вход, два результата, staging и резерв');
  directory = await mkdtemp(join(root, '.tools/gault-streaming-'));
  // Сигналами владеет наш finally: встроенный SIGINT Playwright иначе завершает Node до очистки lock.
  const launchOptions = { headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false };
  if (smoke) browser = await chromium.launch(launchOptions);
  else {
    // Отдельный дисковый профиль не использует пользовательский Chrome или хранилище incognito.
    persistentContext = await chromium.launchPersistentContext(join(directory, 'chromium-profile'), launchOptions);
    browser = persistentContext.browser();
    assert(browser, 'Не получен Chromium отдельного тестового профиля');
  }
  report.browserProfile = smoke ? 'isolated incognito' : 'isolated normal persistent profile in test directory';
  assert(!cancelled, 'Малый тест прерван пользователем');
  report.browser = browser.version();
  report.memoryMethod = os.platform() === 'win32' ? 'Sum of browser process WorkingSet64 (shared pages may be counted twice)' : 'Sum of browser process RSS from ps (shared pages may be counted twice)';
  const cdp = await browser.newBrowserCDPSession();

  /** Снимает реальные RSS/WorkingSet всех процессов данного Chromium; нулевой замер отвергается. */
  async function sample() {
    const label = phase;
    const size = currentSize;
    const { processInfo } = await cdp.send('SystemInfo.getProcessInfo');
    const ids = processInfo.map((item) => Number(item.id));
    assert(ids.length > 0 && ids.every((id) => Number.isSafeInteger(id) && id > 0), 'Нет PID Chromium для измерения');
    let rss;
    if (os.platform() === 'win32') {
      const command = `$items = Get-Process -Id ${ids.join(',')} -ErrorAction SilentlyContinue; ($items | Measure-Object -Property WorkingSet64 -Sum).Sum`;
      rss = Number(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' }).trim());
    } else {
      const values = execFileSync('ps', ['-o', 'rss=', '-p', ids.join(',')], { encoding: 'utf8' }).trim();
      rss = values.split(/\s+/).reduce((sum, value) => sum + Number(value) * 1024, 0);
    }
    assert(Number.isFinite(rss) && rss > 0, 'Не получен действительный RSS/WorkingSet');
    samples.push({ elapsedMs: Date.now() - started, phase: label, inputBytes: size, rssBytes: rss, processes: processInfo.map((item) => ({ type: item.type, pid: item.id })) });
  }

  await sample();
  monitor = setInterval(() => {
    if (!sampling) sampling = sample().catch(() => { samplingErrors.push({ elapsedMs: Date.now() - started, phase }); }).finally(() => { sampling = undefined; });
  }, 250);
  const page = await (persistentContext || browser).newPage();
  await page.addInitScript(() => { window.showSaveFilePicker = async (options) => (await navigator.storage.getDirectory()).getFileHandle(options.suggestedName, { create: true }); });
  await page.goto('http://localhost:5173');
  await page.getByText('Готово к работе без интернета', { exact: true }).waitFor();
  await page.waitForLoadState('networkidle');
  const estimate = await page.evaluate(() => navigator.storage.estimate());
  // Web-оценка Chromium может быть искусственным usage + 10 GiB; CDP здесь только читает квоту.
  const quotaSession = await page.context().newCDPSession(page);
  const quota = await quotaSession.send('Storage.getUsageAndQuota', { origin: new URL(page.url()).origin });
  await quotaSession.detach();
  report.opfsPreflight = { quotaBytes: quota.quota, usageBytes: quota.usage, quotaOverrideActive: quota.overrideActive, reportedEstimateQuotaBytes: estimate.quota ?? null, source: 'CDP Storage.getUsageAndQuota, read-only', requiredBytes: Math.max(...sizes) * 3 + 1024 ** 2 };
  assert(Number.isFinite(quota.quota) && Number.isFinite(quota.usage) && quota.overrideActive === false, 'Не получена действительная квота OPFS без override');
  assert(quota.quota - quota.usage > report.opfsPreflight.requiredBytes, 'Недостаточно квоты OPFS; свободное место ОС не заменяет квоту');
  const requests = [];
  const requestEntries = new WeakMap();
  page.on('request', (request) => {
    const entry = { phase, path: new URL(request.url()).pathname, fromServiceWorker: false, failed: false };
    requests.push(entry); requestEntries.set(request, entry);
  });
  page.on('response', (response) => { const entry = requestEntries.get(response.request()); if (entry) entry.fromServiceWorker = response.fromServiceWorker(); });
  page.on('requestfailed', (request) => { const entry = requestEntries.get(request); if (entry) entry.failed = true; });
  await page.context().setOffline(true);
  report.offline = true;
  for (const size of sizes) {
    currentSize = size;
    const filename = `synthetic-${size}.bin`;
    const inputPath = join(directory, filename);
    const input = await open(inputPath, 'wx', 0o600);
    const generated = createHash('sha256');
    try {
      for (let offset = 0; offset < size; offset += 1024 ** 2) {
        assert(!cancelled, 'Малый тест прерван пользователем');
        const chunk = randomBytes(Math.min(1024 ** 2, size - offset));
        generated.update(chunk); await input.writeFile(chunk);
      }
    } finally { await input.close(); }
    const originalSha256 = generated.digest('hex');
    const result = { inputBytes: size, sourceSha256: originalSha256, status: 'running' };
    report.cases.push(result);
    if (report.cases.length > 1) await page.getByRole('tab', { name: 'Зашифровать', exact: true }).click();
    await page.getByRole('button', { name: 'Ввести свою', exact: true }).click();
    await page.getByTestId('file-input').setInputFiles(inputPath);
    await page.getByLabel('Секретная фраза', { exact: true }).fill('public-streaming-smoke-test-only');
    await page.getByLabel('Повторите фразу', { exact: true }).fill('public-streaming-smoke-test-only');
    await page.waitForLoadState('networkidle');
    phase = 'encrypt';
    const encryptStart = Date.now();
    await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
    await Promise.race([
      page.getByRole('heading', { name: 'Файл записан', exact: true }).waitFor({ timeout: 60 * 60 * 1000 }),
      page.getByRole('alert').waitFor({ timeout: 60 * 60 * 1000 }).then(async () => { throw new Error(await page.getByRole('alert').innerText()); }),
    ]);
    result.encryptMs = Date.now() - encryptStart;
    phase = 'hash';
    result.ciphertext = await opfsHash(page, `${filename}.age`);
    assert(result.ciphertext.bytes > size, 'Нет записанного контейнера OPFS');
    await page.getByRole('tab', { name: 'Расшифровать', exact: true }).click();
    await page.evaluate(async (name) => {
      const file = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
      const transfer = new DataTransfer(); transfer.items.add(file);
      const input = document.querySelector('input[type=file]'); input.files = transfer.files; input.dispatchEvent(new Event('change', { bubbles: true }));
    }, `${filename}.age`);
    await page.getByLabel('Секретная фраза', { exact: true }).fill('public-streaming-smoke-test-only');
    await page.waitForLoadState('networkidle');
    phase = 'decrypt';
    const decryptStart = Date.now();
    await page.getByRole('button', { name: 'Расшифровать файл', exact: true }).click();
    await Promise.race([
      page.getByRole('heading', { name: 'Файл записан', exact: true }).waitFor({ timeout: 60 * 60 * 1000 }),
      page.getByRole('alert').waitFor({ timeout: 60 * 60 * 1000 }).then(async () => { throw new Error(await page.getByRole('alert').innerText()); }),
    ]);
    result.decryptMs = Date.now() - decryptStart;
    phase = 'hash';
    result.restored = await opfsHash(page, filename);
    assert.equal(result.restored.bytes, size);
    assert.equal(result.restored.sha256, originalSha256);
    assert.equal(await diskHash(inputPath), originalSha256, 'Исходник изменился');
    const measured = samples.filter((item) => item.inputBytes === size && ['encrypt', 'decrypt'].includes(item.phase));
    assert(measured.some((item) => item.phase === 'encrypt') && measured.some((item) => item.phase === 'decrypt'), 'Нет реальных замеров каждой операции');
    result.memorySamples = measured.length;
    result.peakRssBytes = Math.max(...measured.map((item) => item.rssBytes));
    assert(result.peakRssBytes <= budget, 'Превышен согласованный бюджет RSS/WorkingSet Chromium');
    result.status = 'passed';
    console.log(`${size / 1024 ** 2} MiB: реальная запись обоих файлов, SHA-256 совпадает; ${measured.length} замеров, peak ${(result.peakRssBytes / 1024 ** 2).toFixed(1)} MiB`);
    await page.evaluate(async (name) => { const root = await navigator.storage.getDirectory(); await root.removeEntry(name); await root.removeEntry(`${name}.age`); }, filename);
    await rm(inputPath);
    phase = 'baseline';
  }
  const processingRequests = requests.filter((item) => ['encrypt', 'decrypt'].includes(item.phase));
  report.processingRequests = processingRequests;
  report.betweenOperationsResourceLoads = requests.filter((item) => !['encrypt', 'decrypt'].includes(item.phase));
  assert.equal(processingRequests.length, 0, 'Во время офлайн-криптоопераций появился запрос');
  assert(report.betweenOperationsResourceLoads.every((item) => item.fromServiceWorker), 'Между операциями ресурс не получен из локального SW');
  if (report.cases.length > 1) {
    report.peakGrowthBytes = report.cases.at(-1).peakRssBytes - report.cases[0].peakRssBytes;
    assert(report.peakGrowthBytes <= growthBudget, 'Превышен бюджет роста памяти малой матрицы');
  }
  report.status = 'passed';
  report.scope = 'Real OPFS disk writes for ciphertext AND restored plaintext; Node SHA-256 reads OPFS in bounded 512 KiB slices over local test driver. Small measurements do not establish large-file asymptotics or 30 GiB support.';
} catch (error) {
  report.status = 'failed';
  report.error = { name: error.name, message: directory ? error.message.replaceAll(directory, '[test-directory]') : error.message };
  throw error;
} finally {
  clearInterval(monitor);
  if (sampling) await sampling;
  if (persistentContext) await persistentContext.close().catch(() => {});
  else if (browser) await browser.close().catch(() => {});
  process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  try {
    await mkdir(join(root, 'artifacts'), { recursive: true });
    await writeFile(join(root, `artifacts/streaming-${smoke ? 'smoke' : 'manual'}-${os.platform()}-${os.arch()}.json`), `${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await lock.close().catch(() => {});
    try { if (directory) await rm(directory, { recursive: true, force: true }); }
    finally { await rm(lockPath, { force: true }); }
  }
}
