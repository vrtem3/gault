/** Проверяет потоковый стандартный age против независимых CLI, без пользовательских секретов. */
import { Encrypter, Decrypter } from 'age-encryption';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { tmpdir, platform, arch, release } from 'node:os';
import { resolve, join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const phrase = 'test-only-orbit-window-harbor-lantern-garden-cobalt';
const dir = await mkdtemp(join(tmpdir(), 'gault-interop-'));
const suffix = platform() === 'win32' ? '.exe' : '';
const age = resolve(process.env.AGE_BIN || `../.tools/age/age/age${suffix}`);
const rage = resolve(process.env.RAGE_BIN || `../.tools/rage/rage/rage${suffix}`);
const python = process.env.PYTHON || (platform() === 'win32' ? 'python' : 'python3');
const hash = (data) => createHash('sha256').update(data).digest('hex');
const report = { date: new Date().toISOString(), platform: platform(), architecture: arch(), osVersion: release(), node: process.version, typage: '0.3.1', status: 'running', cliVersions: {}, cases: [], fixtures: [], negativeCases: [] };
/** Запускает cli/args с публичной testPhrase и новым output; возвращает spawnSync result без shell. */
function runCli(cli, args, output, testPhrase = phrase) {
  return spawnSync(python, ['scripts/cli_passphrase.py', cli, ...args], {
    env: { ...process.env, GAULT_TEST_PASSPHRASE: testPhrase, GAULT_TEST_OUTPUT: output }, timeout: 130_000,
  });
}
/** Читает малый результат path; только ожидаемый пустой выход rage может не создавать файл. */
async function cliOutput(path, expectedBytes) {
  try { return await readFile(path); }
  catch (error) { if (expectedBytes === 0 && error.code === 'ENOENT') return Buffer.alloc(0); throw error; }
}
try {
  for (const [name, cli] of [['age', age], ['rage', rage]]) {
    const version = spawnSync(cli, ['--version'], { encoding: 'utf8' });
    assert.equal(version.status, 0, `${name}: version check failed`);
    report.cliVersions[name] = version.stdout.trim();
  }
  for (const [label, data] of [['binary', randomBytes(262_181)], ['empty', Buffer.alloc(0)], ['unicode', Buffer.from('Русский текст 🔐\0\n')]]) {
    const input = join(dir, label === 'unicode' ? 'проверка с пробелами 🔐.bin' : `${label}.bin`);
    const encrypted = `${input}.age`;
    await writeFile(input, data);
    const encrypter = new Encrypter();
    encrypter.setPassphrase(phrase);
    const stream = await encrypter.encrypt(Readable.toWeb(createReadStream(input, { highWaterMark: 65_536 })));
    await pipeline(Readable.fromWeb(stream), createWriteStream(encrypted));
    for (const cli of [age, rage]) {
      console.log(`${label}: проверка ${cli === age ? 'age' : 'rage'}`);
      const restored = join(dir, label === 'unicode' ? `восстановлено ${cli === age ? 'age' : 'rage'}.out` : `${label}-${cli === age ? 'age' : 'rage'}.out`);
      const result = runCli(cli, ['-d', encrypted], restored);
      assert.equal(result.status, 0, `CLI decryption failed: ${result.error?.message || result.stderr}`);
      assert.equal(hash(await cliOutput(restored, data.byteLength)), hash(data));
      const fromCli = `${restored}.age`;
      const encryptResult = runCli(cli, ['-p', input], fromCli);
      assert.equal(encryptResult.status, 0, `CLI encryption failed: ${encryptResult.stderr}`);
      const decrypter = new Decrypter();
      decrypter.addPassphrase(phrase);
      const output = await decrypter.decrypt(Readable.toWeb(createReadStream(fromCli)));
      const target = `${restored}.roundtrip`;
      await output.pipeTo(Writable.toWeb(createWriteStream(target)));
      assert.equal(hash(await readFile(target)), hash(data));
      const prefix = (await readFile(fromCli)).subarray(0, 200).toString();
      const logN = Number(/-> scrypt \S+ (\d+)/.exec(prefix)?.[1]);
      assert(Number.isInteger(logN), 'CLI did not create a passphrase container');
      report.cases.push({ input: label, cli: cli === age ? 'age' : 'rage', sha256: hash(data), typageToCli: 'passed', cliToTypage: 'passed', scryptLogN: logN, browserHeaderProfile: logN <= 18 ? 'eligible' : 'rejected-kdf-limit' });
    }
    console.log(`${label}: Typage ↔ age / rage; SHA-256 совпадает`);
  }
  const fixtures = resolve('tests/fixtures/compatibility/v0.1.0');
  const manifest = JSON.parse(await readFile(join(fixtures, 'manifest.json'), 'utf8'));
  for (const file of manifest.files) {
    const input = join(fixtures, file.ciphertext);
    assert.equal(hash(await readFile(input)), file.ciphertextSha256, `Fixture changed: ${file.id}`);
    for (const cli of [age, rage]) {
      const target = join(dir, `frozen-${file.id}-${cli === age ? 'age' : 'rage'}.out`);
      const result = runCli(cli, ['-d', input], target, manifest.passphrase);
      assert.equal(result.status, 0, `Old fixture decryption failed: ${file.id}`);
      const output = await cliOutput(target, file.plaintextBytes);
      assert.equal(output.byteLength, file.plaintextBytes);
      assert.equal(hash(output), file.plaintextSha256);
      report.fixtures.push({ id: file.id, cli: cli === age ? 'age' : 'rage', status: 'passed', sha256: hash(output) });
    }
  }
  const valid = await readFile(join(fixtures, 'gault-boundary-65537.age'));
  for (const cli of [age, rage]) {
    for (const kind of ['wrong-phrase', 'corrupt', 'truncated']) {
      const input = join(dir, `negative-${cli === age ? 'age' : 'rage'}-${kind}.age`);
      const bytes = kind === 'truncated' ? valid.subarray(0, -1) : Buffer.from(valid);
      if (kind === 'corrupt') bytes[bytes.length - 1] ^= 1;
      await writeFile(input, bytes);
      const result = runCli(cli, ['-d', input], `${input}.out`, kind === 'wrong-phrase' ? 'wrong-public-test-phrase' : manifest.passphrase);
      assert.equal(result.error, undefined, `CLI could not run: ${kind}`);
      assert.notEqual(result.status, null, 'CLI timed out');
      assert.notEqual(result.status, 0, `CLI incorrectly accepted ${kind}`);
      report.negativeCases.push({ cli: cli === age ? 'age' : 'rage', case: kind, status: 'rejected' });
    }
  }
  console.log(`${manifest.files.length} неизменяемых контейнеров v0.1.0: age / rage, SHA-256 совпадают`);
  const limited = report.cases.filter((item) => item.browserHeaderProfile !== 'eligible').length;
  report.status = limited ? 'passed-with-browser-kdf-limitation' : 'passed';
  report.browserVerification = 'Actual Worker tests are separate: npm run test:compat; header eligibility is not a browser success result';
  if (limited) console.log(`ОГРАНИЧЕНИЕ: ${limited} CLI-входов выше logN=18; полная CLI → браузер совместимость не заявляется.`);
} catch (error) {
  report.status = 'failed';
  throw error;
} finally {
  try {
    await mkdir(resolve('../artifacts'), { recursive: true });
    await writeFile(resolve(`../artifacts/interop-${platform()}-${arch()}.json`), `${JSON.stringify(report, null, 2)}\n`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
