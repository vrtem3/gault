/** Последовательная локальная fuzz-кампания: малые синтетические входы, ограниченные время/heap/RSS и закрытые отчёты. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, open, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultSeeds = [1, 2, 0xffffffff, 0x80000000, 0x7fffffff, 0x01010101, 0x55555555, 0xaaaaaaaa, 0x9e3779b9, 27182818, 31415926, 0xdeadbeef, 0x10203040, 0x31415926, 0xabcdef01, 0x6d2b79f5];
const seeds = process.env.GAULT_FUZZ_SEEDS === undefined ? defaultSeeds : process.env.GAULT_FUZZ_SEEDS.split(',').map(Number);
const cases = Number(process.env.GAULT_FUZZ_CASES ?? 20_000);
const cryptoCases = Number(process.env.GAULT_FUZZ_CRYPTO_CASES ?? 64);
const budgetSeconds = Number(process.env.GAULT_FUZZ_BUDGET_SECONDS ?? 600);
assert(seeds.length >= 1 && seeds.length <= 32 && new Set(seeds).size === seeds.length && seeds.every((n) => Number.isSafeInteger(n) && n > 0 && n <= 0xffffffff), 'fuzz-seeds: требуется 1–32 разных uint32 seed, кроме нуля');
assert(Number.isSafeInteger(cases) && cases > 0 && cases <= 20_000, 'fuzz-cases: предел 20000');
assert(Number.isSafeInteger(cryptoCases) && cryptoCases > 0 && cryptoCases <= 128, 'fuzz-crypto-cases: предел 128');
assert(Number.isSafeInteger(budgetSeconds) && budgetSeconds >= 1 && budgetSeconds <= 900, 'fuzz-time-budget: предел 900 секунд');
const heapMiB = 384;
const rssMiB = 512;
const started = Date.now();
const runId = `${new Date(started).toISOString().replace(/[:.]/g, '-')}-${process.pid}`;
const directory = resolve(root, '../artifacts', `fuzz-${runId}`);
const lockPath = resolve(root, '../.tools/fuzz-campaign.lock');
const lockOwner = JSON.stringify({ pid: process.pid, runId });
let interrupted = false;
let terminate;

/** Запрашивает остановку активного дочернего теста и всей кампании; возвращает void. */
function stop() { interrupted = true; terminate?.('interrupted'); }

/** Запускает seed (number) в folder (string) с timeoutMS (number); возвращает Promise с логами, кодом и причиной завершения. */
async function runSeed(seed, folder, timeoutMS) {
  await mkdir(folder, { mode: 0o700 });
  if (interrupted) return { code: null, signal: null, reason: 'interrupted', output: '' };
  const child = spawn(process.execPath, [
    `--max-old-space-size=${heapMiB}`, join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'tests/unit/age-fuzz.test.ts',
    '--pool=threads', '--no-file-parallelism', '--maxWorkers=1', '--testTimeout=30000', '--bail=1', '--retry=0',
    '--reporter=json', `--outputFile=${join(folder, 'vitest.json')}`, '--disableConsoleIntercept', '--no-color',
  ], { cwd: root, env: { ...process.env, NODE_OPTIONS: '', GAULT_FUZZ_SEED: String(seed), GAULT_FUZZ_CASES: String(cases), GAULT_FUZZ_CRYPTO_CASES: String(cryptoCases), GAULT_FUZZ_METRICS: '1', GAULT_ALLOW_LARGE_TEST: '0', NO_COLOR: '1', FORCE_COLOR: '0' }, stdio: ['ignore', 'pipe', 'pipe'] });
  const chunks = [];
  let captured = 0; let reason; let killTimer;
  terminate = (why) => {
    if (reason) return;
    reason = why; child.kill('SIGTERM');
    killTimer = setTimeout(() => child.kill('SIGKILL'), 2000);
  };
  const timer = setTimeout(() => terminate?.('timeout'), timeoutMS);
  for (const output of [child.stdout, child.stderr]) output.on('data', (bytes) => {
    // Ограничение логов не позволяет ошибке теста заполнить диск или память.
    const keep = Math.min(bytes.length, 2 * 1024 * 1024 - captured);
    if (keep > 0) chunks.push(bytes.subarray(0, keep));
    captured += keep;
    if (keep < bytes.length) terminate?.('output-limit');
  });
  const result = await new Promise((accept) => {
    let launchError;
    child.on('error', (error) => { launchError = error.code || 'spawn-error'; });
    child.on('close', (code, signal) => accept({ code, signal, launchError }));
  });
  clearTimeout(timer); clearTimeout(killTimer); terminate = undefined;
  const output = Buffer.concat(chunks).toString('utf8');
  await writeFile(join(folder, 'vitest.log'), output, { mode: 0o600 });
  return { ...result, reason, output };
}

await mkdir(dirname(lockPath), { recursive: true });
const lock = await open(lockPath, 'wx', 0o600);
const report = {
  startedAt: new Date(started).toISOString(), node: process.version, platform: process.platform, arch: process.arch,
  status: 'running', seeds, cases, cryptoCases, budgetSeconds, seedTimeoutSeconds: 90, heapMiB, rssMiB,
  largestAllowedPlaintextBytes: 196_609, maxLogBytesPerSeed: 2 * 1024 * 1024,
  syntheticKdfLogN: 1, productionKdfLogN: 18, largeTestsRun: false, manualTestsRun: false, sources: {}, versions: {}, runs: [],
};
process.on('SIGINT', stop); process.on('SIGTERM', stop);
try {
  await lock.writeFile(lockOwner);
  await mkdir(dirname(directory), { recursive: true, mode: 0o700 });
  await mkdir(directory, { mode: 0o700 });
  for (const path of ['src/crypto/age.ts', 'tests/unit/age-fuzz.test.ts', 'scripts/fuzz-campaign.mjs', 'package.json', 'package-lock.json', 'vitest.config.ts']) report.sources[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
  for (const name of ['age-encryption', '@noble/hashes', 'vitest']) report.versions[name] = JSON.parse(await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8')).version;
  await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  for (const seed of seeds) {
    const remaining = budgetSeconds * 1000 - (Date.now() - started);
    if (interrupted || remaining <= 0) { report.status = interrupted ? 'interrupted' : 'budget-exhausted'; break; }
    console.log(`Fuzz seed=${seed}, headers=${cases}, crypto=${cryptoCases}`);
    const folder = join(directory, `seed-${seed}`);
    const start = Date.now();
    const result = await runSeed(seed, folder, Math.min(90_000, remaining));
    const row = { seed, seconds: (Date.now() - start) / 1000, code: result.code, signal: result.signal, status: 'failed' };
    try {
      const match = result.output.match(/GAULT_FUZZ_METRICS (\{[^\r\n]+\})/);
      if (match) row.metrics = JSON.parse(match[1]);
      assert(!result.reason && !result.launchError && result.code === 0, result.reason || result.launchError || 'test-failed');
      const tests = JSON.parse(await readFile(join(folder, 'vitest.json'), 'utf8'));
      assert(tests.success === true && tests.numTotalTests >= 13 && tests.numFailedTests === 0 && tests.numPendingTests === 0, 'incomplete-tests');
      assert(match, 'missing-metrics');
      const metrics = row.metrics;
      row.tests = tests.numPassedTests;
      assert(metrics.seed === seed && metrics.iterations === cases && metrics.cryptoCases === cryptoCases && metrics.counts.arbitraryHeaders === cases && metrics.counts.structuredHeaders === Math.ceil(cases / 10), 'incomplete-fuzz');
      assert(metrics.failures.length === 0 && metrics.largestInputBytes <= 196_609 + 8192 + 80, 'input-budget-or-failure');
      assert(metrics.maxRssKB > 0 && metrics.maxRssKB <= rssMiB * 1024, 'rss-budget');
      row.status = 'passed';
    } catch (error) { row.reason = interrupted ? 'interrupted' : result.reason || error.message; }
    report.runs.push(row);
    await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
    if (row.status !== 'passed') { report.status = interrupted ? 'interrupted' : 'failed'; break; }
  }
  if (interrupted) report.status = 'interrupted';
  else if (report.status === 'running') report.status = report.runs.length === seeds.length ? 'passed' : 'failed';
} catch (error) {
  report.status = 'failed'; report.error = error.code || error.message;
} finally {
  report.finishedAt = new Date().toISOString(); report.seconds = (Date.now() - started) / 1000;
  try { await writeFile(join(directory, 'summary.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 }); }
  finally {
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
    await lock.close();
    if (await readFile(lockPath, 'utf8').catch(() => '') === lockOwner) await unlink(lockPath);
  }
}
console.log(`Fuzz ${report.status}: ${report.runs.length}/${seeds.length}; ${directory}/summary.json`);
process.exitCode = report.status === 'passed' ? 0 : 1;
