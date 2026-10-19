/** Две чистые копии build-входов с общими закреплёнными зависимостями; сравнивает каждый байт и сохраняет локальный отчёт. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { platform, arch } from 'node:os';

const root = resolve('..');
const frontend = resolve('.');
const profile = JSON.parse(await readFile('release-profile.json', 'utf8'));
assert.equal(process.versions.node, profile.node, 'Для проверки повторяемости нужен Node из release-profile.json');
const env = { ...process.env, ...profile.publicEnv, TZ: 'UTC', LANG: 'C', LC_ALL: 'C', NODE_ENV: 'production' };
await mkdir(join(root, '.tools'), { recursive: true });
const temporary = await mkdtemp(join(root, '.tools', 'repro-'));
const report = { date: new Date().toISOString(), node: process.version, expectedNpm: profile.npm, platform: platform(), arch: arch(), sharedInstalledDependencies: true, status: 'running', files: [] };

/** Запускает JS script с args в cwd; возвращает void после успешного завершения без shell. */
function run(script, args, cwd) {
  const result = spawnSync(process.execPath, [script, ...args], { cwd, env, stdio: 'inherit', timeout: 120_000 });
  assert.equal(result.status, 0, 'Сборка/проверка не завершилась успешно');
}

/** Собирает содержимое directory с относительными именами; возвращает Map<string, Buffer>. */
async function contents(directory, prefix = '') {
  const result = new Map();
  for (const entry of await readdir(join(directory, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) for (const [name, bytes] of await contents(directory, path)) result.set(name, bytes);
    else { assert(entry.isFile(), 'Ссылка в артефакте'); result.set(path, await readFile(join(directory, path))); }
  }
  return result;
}
try {
  const outputs = [];
  for (const name of ['first', 'second']) {
    const source = join(temporary, name, 'frontend');
    await mkdir(source, { recursive: true });
    await cp(join(root, 'LICENSE'), resolve(source, '../LICENSE'));
    for (const path of ['src', 'public', 'account/src', 'index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'release-profile.json', 'scripts/licenses.mjs']) {
      await cp(join(frontend, path), join(source, path), { recursive: true });
    }
    await symlink(join(frontend, 'node_modules'), join(source, 'node_modules'), platform() === 'win32' ? 'junction' : 'dir');
    run(join(source, 'scripts/licenses.mjs'), [], source);
    run(join(frontend, 'node_modules/vite/bin/vite.js'), ['build'], source);
    const output = join(source, 'dist');
    run(join(frontend, 'scripts/release-hashes.mjs'), [output], frontend);
    run(join(frontend, 'scripts/artifact-check.mjs'), [output], frontend);
    outputs.push(await contents(output));
  }
  assert.deepEqual([...outputs[0].keys()].sort(), [...outputs[1].keys()].sort(), 'Состав сборок отличается');
  const reference = process.argv.includes('--compare-dist') ? await contents(resolve('dist')) : undefined;
  if (reference) assert.deepEqual([...outputs[0].keys()].sort(), [...reference.keys()].sort(), 'Состав основной сборки отличается');
  for (const name of [...outputs[0].keys()].sort()) {
    assert(outputs[0].get(name).equals(outputs[1].get(name)), `Различие байтов: ${name}`);
    if (reference) assert(outputs[0].get(name).equals(reference.get(name)), `Основная сборка отличается: ${name}`);
    report.files.push({ path: name, sha256: createHash('sha256').update(outputs[0].get(name)).digest('hex') });
  }
  report.buildId = JSON.parse(outputs[0].get('build-info.json')).buildId;
  report.comparedWithMainBuild = !!reference;
  report.status = 'passed'; console.log(`Две изолированные сборки: ${report.files.length} файлов побайтово совпали`);
} catch (error) { report.status = 'failed'; throw error; }
finally {
  await mkdir(join(root, 'artifacts'), { recursive: true });
  await writeFile(join(root, 'artifacts/reproducibility.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
}
