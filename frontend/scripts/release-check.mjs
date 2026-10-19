/** Локальная последовательная проверка выпуска: только малые синтетические тесты; без CI, деплоя, push и больших файлов. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const profile = JSON.parse(await readFile('release-profile.json', 'utf8'));
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
assert.equal(process.versions.node, profile.node, 'Node отличается от release-profile.json');
assert.equal(lock.lockfileVersion, profile.lockfileVersion);
for (const [name, version] of [['age-encryption', '0.3.1'], ['@noble/hashes', '2.4.0']]) {
  assert.equal(lock.packages[`node_modules/${name}`].version, version, 'Криптозависимость изменилась: нужна отдельная приёмка');
  assert.equal(JSON.parse(await readFile(`node_modules/${name}/package.json`, 'utf8')).version, version, 'Установленная криптозависимость не соответствует lock');
}
assert.equal(JSON.parse(await readFile('package.json', 'utf8')).packageManager, `npm@${profile.npm}`);
const runId = `${Date.now()}-${process.pid}`;
const report = { date: new Date().toISOString(), node: process.version, status: 'running', checks: [], largeTestsRun: false };
const env = { ...process.env, ...profile.publicEnv, TZ: 'UTC', LANG: 'C', LC_ALL: 'C', NODE_ENV: 'production', GAULT_ALLOW_LARGE_TEST: '0' };
const commands = [
  ['typecheck', 'node_modules/typescript/bin/tsc', '--noEmit'],
  ['unit-and-fuzz', 'node_modules/vitest/vitest.mjs', 'run'],
  ['licenses', 'scripts/licenses.mjs'],
  ['build', 'node_modules/vite/bin/vite.js', 'build'],
  ['checksums', 'scripts/release-hashes.mjs'],
  ['artifact', 'scripts/artifact-check.mjs'],
  ['reproducibility', 'scripts/reproducible-build.mjs', '--compare-dist'],
  ['browser-small', 'node_modules/@playwright/test/cli.js', 'test', '--reporter=list', `--output=../artifacts/e2e-release-${runId}`],
  ['independent-cli', 'scripts/interop.mjs'],
  ['advisories', 'scripts/dependency-audit.mjs'],
];
try {
  for (const [name, script, ...args] of commands) {
    console.log(`Проверка: ${name}`);
    const start = performance.now();
    const result = spawnSync(process.execPath, [resolve(script), ...args], { env, stdio: 'inherit', timeout: name === 'browser-small' || name === 'independent-cli' ? 600_000 : 120_000 });
    report.checks.push({ name, passed: result.status === 0, seconds: Math.round((performance.now() - start) / 10) / 100 });
    assert.equal(result.status, 0, `Не пройдена проверка ${name}`);
  }
  report.status = 'passed'; console.log('Локальная малая проверка выпуска пройдена; ручная приёмка и большие файлы не проверялись');
} catch (error) { report.status = 'failed'; throw error; }
finally {
  await mkdir('../artifacts', { recursive: true });
  await writeFile('../artifacts/release-check.json', JSON.stringify(report, null, 2) + '\n');
}
