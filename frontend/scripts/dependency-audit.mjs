/** Проверяет закреплённые npm-зависимости по официальному advisory API; отправляет только публичные имена/версии. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const packages = {};
for (const [path, item] of Object.entries(lock.packages)) {
  if (!path) continue;
  const name = path.split('node_modules/').at(-1);
  (packages[name] ??= new Set()).add(item.version);
}
const body = Object.fromEntries(Object.entries(packages).map(([name, versions]) => [name, [...versions].sort()]));
const response = await fetch('https://registry.npmjs.org/-/npm/v1/security/advisories/bulk', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(30_000),
});
assert(response.ok, 'Не удалось проверить advisories; результат не считается чистым');
const advisories = await response.json();
assert(advisories && typeof advisories === 'object' && !Array.isArray(advisories), 'Неожиданный ответ advisory API');
await mkdir('../artifacts', { recursive: true });
await writeFile('../artifacts/dependency-audit.json', JSON.stringify({ date: new Date().toISOString(), source: 'npm bulk advisory API', packages: Object.keys(packages).length, advisories }, null, 2) + '\n');
assert.equal(Object.keys(advisories).length, 0, 'Есть известные advisories: см. локальный artifacts/dependency-audit.json');
console.log(`Зависимости: ${Object.keys(packages).length} пакетов, известных advisories нет`);
