/** Проверка криптографического контракта, повреждений и стандартного заголовка. */
import { beforeAll, describe, expect, it } from 'vitest';
import { inspectAgeHeader, transformAge } from '../../src/crypto/age';

const phrase = 'test-only-river-coffee-parrot-silver-maple-sunset';
const original = crypto.getRandomValues(new Uint8Array(43_301));
let encrypted: Uint8Array;

/** Упаковывает small bytes (Uint8Array) в поток для теста; возвращает ReadableStream. */
function stream(bytes: Uint8Array): ReadableStream<Uint8Array> { return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close(); } }); }
/** Читает только малый тестовый input (ReadableStream); возвращает Promise<Uint8Array>. */
async function collect(input: ReadableStream<Uint8Array>): Promise<Uint8Array> { return new Uint8Array(await new Response(input as ReadableStream<Uint8Array<ArrayBuffer>>).arrayBuffer()); }

beforeAll(async () => { encrypted = await collect(await transformAge(stream(original), phrase, 'encrypt')); });
describe('стандартный парольный age v1', () => {
  it('пишет стандартный scrypt 18 без имени файла или открытой фразы', () => {
    inspectAgeHeader(encrypted.slice(0, 8192));
    const header = new TextDecoder().decode(encrypted.slice(0, 150));
    expect(header).toMatch(/^age-encryption.org\/v1\n-> scrypt [^\n]+ 18\n/);
    expect(header).not.toContain(phrase);
  });
  it('восстанавливает все байты', async () => { expect(await collect(await transformAge(stream(encrypted), phrase, 'decrypt'))).toEqual(original); });
  it('поддерживает пустой файл', async () => {
    const output = await collect(await transformAge(stream(new Uint8Array()), phrase, 'encrypt'));
    expect(await collect(await transformAge(stream(output), phrase, 'decrypt'))).toHaveLength(0);
  });
  it('отвергает неправильную фразу', async () => { await expect(transformAge(stream(encrypted), 'wrong', 'decrypt')).rejects.toThrow(); });
  it.each(['truncated', 'changed'])('отвергает %s', async (kind) => {
    const bad = kind === 'truncated' ? encrypted.slice(0, -1) : encrypted.slice();
    if (kind === 'changed') bad[bad.length - 3] ^= 1;
    await expect(collect(await transformAge(stream(bad), phrase, 'decrypt'))).rejects.toThrow();
  });
  it('ограничивает KDF до выделения памяти и отклоняет чужие форматы', () => {
    const high = new TextDecoder().decode(encrypted.slice(0, 8192)).replace(/ 18\n/, ' 30\n');
    expect(() => inspectAgeHeader(new TextEncoder().encode(high))).toThrow('kdf');
    expect(() => inspectAgeHeader(new TextEncoder().encode('not age'))).toThrow('format');
  });
});
