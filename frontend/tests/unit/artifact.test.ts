/** Негативная проверка локального release-gate на синтетической статике, без настоящих секретов. */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let directory: string;
/** Пересчитывает суммы малого тестового каталога; возвращает Promise<void> без изменения production dist. */
async function checksums(): Promise<void> {
  const result = spawnSync(process.execPath, ['scripts/release-hashes.mjs', directory]);
  expect(result.status).toBe(0);
}
/** Запускает artifact gate для синтетического каталога; возвращает код завершения. */
function check(): number {
  const result = spawnSync(process.execPath, ['scripts/artifact-check.mjs', directory], { cwd: resolve('.') });
  expect(result.error).toBeUndefined(); expect(result.status).not.toBeNull();
  return result.status!;
}
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'gault-artifact-test-'));
  await mkdir(join(directory, 'assets'));
  const id = 'a'.repeat(64);
  for (const [path, data] of Object.entries({
    'index.html': '<!doctype html><title>Synthetic test only</title>', 'sw.js': `const BUILD_ID='${id}';`,
    'build-info.json': JSON.stringify({ buildId: id }), 'SHA256SUMS': '', 'manifest.webmanifest': '{}',
    'favicon.svg': '<svg/>', 'third-party-licenses.txt': 'synthetic test only',
    'assets/index-test.js': '/* public synthetic */', 'assets/index-test.css': 'body{}', 'assets/crypto.worker-test.js': '/* public synthetic */',
  })) await writeFile(join(directory, path), data);
  await checksums();
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });
it('принимает полный синтетический allowlist с верными суммами', () => { expect(check()).toBe(0); });
it('отклоняет env-файл даже при его наличии в SHA256SUMS', async () => {
  await writeFile(join(directory, '.env'), 'PUBLIC_SYNTHETIC_TEST_ONLY=yes'); await checksums(); expect(check()).not.toBe(0);
});
it('отклоняет изменённые байты разрешённого JS', async () => {
  await writeFile(join(directory, 'assets/index-test.js'), '/* changed */'); expect(check()).not.toBe(0);
});
it('отклоняет маркер приватного ключа даже с корректной суммой', async () => {
  await writeFile(join(directory, 'assets/index-test.js'), '-----BEGIN PRIVATE KEY-----'); await checksums(); expect(check()).not.toBe(0);
});
it('отклоняет отсутствие Worker даже после пересчёта сумм', async () => {
  await rm(join(directory, 'assets/crypto.worker-test.js')); await checksums();
  expect((await readFile(join(directory, 'SHA256SUMS'), 'utf8')).includes('crypto.worker')).toBe(false);
  expect(check()).not.toBe(0);
});
