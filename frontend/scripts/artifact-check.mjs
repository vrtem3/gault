/** Проверяет allowlist статики, SHA256SUMS и отсутствие локальных секретов; ничего не загружает в сеть. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';

const directory = resolve(process.argv[2] || 'dist');
const allowed = /^(?:index\.html|sw\.js|build-info\.json|favicon\.svg|manifest\.webmanifest|third-party-licenses\.txt|SHA256SUMS|assets\/[\w.-]+\.(?:js|css))$/;
const entries = new Map();

/** Читает относительный path без symlink; возвращает Promise<void>, добавляя только разрешённые статические файлы. */
async function visit(path = '') {
  for (const entry of await readdir(resolve(directory, path), { withFileTypes: true })) {
    const name = path ? `${path}/${entry.name}` : entry.name;
    assert(!entry.isSymbolicLink(), 'Символическая ссылка в сборке');
    if (entry.isDirectory()) { assert(name === 'assets', 'Лишний каталог в сборке'); await visit(name); }
    else {
      assert(entry.isFile() && allowed.test(name), 'Файл вне allowlist статики');
      entries.set(name, await readFile(resolve(directory, name)));
    }
  }
}
await visit();
for (const name of ['index.html', 'sw.js', 'build-info.json', 'SHA256SUMS', 'manifest.webmanifest', 'favicon.svg', 'third-party-licenses.txt']) assert(entries.has(name), `Нет ${name}`);
for (const pattern of [/^assets\/index-[\w-]+\.js$/, /^assets\/crypto\.worker-[\w-]+\.js$/, /^assets\/index-[\w-]+\.css$/]) assert([...entries.keys()].some((name) => pattern.test(name)), 'Нет обязательного ресурса приложения');
const expected = new Map();
for (const line of entries.get('SHA256SUMS').toString().trim().split('\n')) {
  const match = /^([a-f0-9]{64})  ([\w./-]+)$/.exec(line);
  assert(match && !expected.has(match[2]), 'Неверный или повторный путь SHA256SUMS');
  expected.set(match[2], match[1]);
}
assert.equal(expected.size, entries.size - 1, 'Состав SHA256SUMS не совпадает');
let local = {};
try { local = parseEnv(await readFile('../.env', 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const secrets = Object.entries(local).filter(([key, value]) => !key.startsWith('PUBLIC_') && /SECRET|PASSWORD|PASSPHRASE|TOKEN|PRIVATE|CREDENTIAL|SMTP_USER|TLS_EMAIL|SSH_KEY|(?:DEPLOY|SSH)_HOST|SSH_USER/.test(key) && value.length >= 6).map(([, value]) => value);
for (const [name, bytes] of entries) {
  if (name !== 'SHA256SUMS') assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.get(name), `SHA-256: ${name}`);
  const text = bytes.toString();
  assert(!/-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/.test(text), 'Приватный ключ в статике');
  assert(!secrets.some((secret) => text.includes(secret)), 'В статике обнаружено приватное значение из локального .env');
}
const info = JSON.parse(entries.get('build-info.json'));
assert.match(info.buildId, /^[a-f0-9]{64}$/);
assert(entries.get('sw.js').toString().includes(info.buildId), 'SW и build-info относятся к разным сборкам');
console.log(`Статика: ${entries.size} файлов, SHA-256 совпали, запрещённых файлов/локальных секретов нет`);
