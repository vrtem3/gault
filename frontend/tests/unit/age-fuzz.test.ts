/** Ограниченные fuzz/property-проверки guard, настоящего Typage/AEAD и жизненного цикла входного потока. */
import { afterAll, expect, it, onTestFailed } from 'vitest';
import { createHash } from 'node:crypto';
import { Encrypter } from 'age-encryption';
import { InputError, inspectAgeHeader, MAX_HEADER_BYTES, transformAge } from '../../src/crypto/age';

const seed = Number(process.env.GAULT_FUZZ_SEED || 0x67a017);
const iterations = Number(process.env.GAULT_FUZZ_CASES || 2000);
const cryptoCases = Number(process.env.GAULT_FUZZ_CRYPTO_CASES || 16);
if (!Number.isSafeInteger(seed) || seed < 1 || seed > 0xffffffff || !Number.isSafeInteger(iterations) || iterations < 1 || iterations > 20_000 || !Number.isSafeInteger(cryptoCases) || cryptoCases < 1 || cryptoCases > 128) throw new Error('fuzz-budget');
const structuredCases = Math.ceil(iterations / 10);
const MAX_PLAINTEXT_BYTES = 196_609;
const MAX_INPUT_BYTES = MAX_PLAINTEXT_BYTES + MAX_HEADER_BYTES + 80;
const phrase = 'public-test-only-fuzz-no-user-data';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const encoder = new TextEncoder();
const started = performance.now();
const counts = { arbitraryHeaders: 0, structuredHeaders: 0, preKdfRejections: 0, acceptedHeaders: 0, successfulReads: 0, rejectedContainers: 0, postKdfRejections: 0, streamFaults: 0, cancelledSources: 0 };
let largestInputBytes = 0;
let lastCase: { scenario: string; input: Uint8Array; passphrase: string } | undefined;
const failures: { scenario: string; inputBase64: string; passphrase: string }[] = [];

/** Из domain (number) и seed создаёт локальный PRNG теста; возвращает генератор uint32, не для криптографии. */
function randomFor(domain: number): () => number {
  let state = (seed ^ domain) >>> 0 || 1;
  return () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
}

/** Запоминает малый синтетический input и scenario (string) для диагностики; возвращает void без записи на диск. */
function remember(scenario: string, input: Uint8Array, passphrase = phrase): void {
  expect(input.length).toBeLessThanOrEqual(MAX_INPUT_BYTES);
  largestInputBytes = Math.max(largestInputBytes, input.length);
  lastCase = { scenario: `seed=${seed}, ${scenario}`, input, passphrase };
}

/** Сохраняет первый упавший синтетический случай в памяти для локального отчёта; возвращает void. */
function saveFailure(): void {
  if (lastCase && failures.length === 0) failures.push({ scenario: lastCase.scenario, inputBase64: Buffer.from(lastCase.input).toString('base64'), passphrase: lastCase.passphrase });
}

afterAll(() => {
  if (process.env.GAULT_FUZZ_METRICS === '1') console.log('GAULT_FUZZ_METRICS ' + JSON.stringify({ seed, iterations, cryptoCases, structuredCases, counts, largestInputBytes, maxRssKB: process.resourceUsage().maxRSS, seconds: (performance.now() - started) / 1000, failures }));
});

/** Разбивает малые bytes (Uint8Array) на блоки до maxChunk; возвращает поток без изменения содержимого. */
function stream(bytes: Uint8Array, maxChunk = 4096, random = randomFor(0x51)): ReadableStream<Uint8Array> {
  let offset = 0;
  return new ReadableStream({ pull(controller) {
    if (offset === bytes.length) { controller.close(); return; }
    const end = Math.min(bytes.length, offset + 1 + random() % maxChunk);
    controller.enqueue(bytes.slice(offset, end)); offset = end;
  } });
}

/** Читает малый синтетический input; возвращает его байты, вход ограничен MAX_INPUT_BYTES. */
async function collect(input: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(input as ReadableStream<Uint8Array<ArrayBuffer>>).arrayBuffer());
}

/** Разбивает bytes по точным cuts и вставляет конечные пустые блоки при empty; возвращает поток тех же байтов. */
function partition(bytes: Uint8Array, cuts: number[], empty = false): ReadableStream<Uint8Array> {
  const ends = [...new Set([...cuts, bytes.length])].filter((n) => n > 0 && n <= bytes.length).sort((a, b) => a - b);
  let index = 0; let offset = 0; let blank = empty;
  return new ReadableStream({ pull(controller) {
    if (blank) { controller.enqueue(new Uint8Array()); blank = false; return; }
    if (index === ends.length) { controller.close(); return; }
    const end = ends[index++]; controller.enqueue(bytes.subarray(offset, end)); offset = end; blank = empty;
  } }, { highWaterMark: 0 });
}

/** Создаёт из next (PRNG) канонический синтетический заголовок с logN; возвращает string без действительного MAC. */
function header(next: () => number, logN = '18'): string {
  const fields = [16, 32, 32].map((length) => Buffer.from(Uint8Array.from({ length }, () => next() & 255)).toString('base64').replace(/=+$/, ''));
  return `age-encryption.org/v1\n-> scrypt ${fields[0]} ${logN}\n${fields[1]}\n--- ${fields[2]}\n`;
}

/** Находит конец четырёх строк синтетического age input; возвращает смещение первого байта nonce. */
function headerEnd(input: Uint8Array): number {
  let lines = 0;
  for (let i = 0; i < input.length; i++) if (input[i] === 10 && ++lines === 4) return i + 1;
  throw new Error('synthetic-header-incomplete');
}

/** Проверяет успешное чтение input с cuts и empty; сравнивает SHA-256 с plain, возвращает Promise<void>. */
async function accepted(input: Uint8Array, plain: Uint8Array, scenario: string, cuts: number[] = [], empty = false): Promise<void> {
  remember(scenario, input);
  const result = await collect(await transformAge(cuts.length ? partition(input, cuts, empty) : stream(input), phrase, 'decrypt'));
  expect(createHash('sha256').update(result).digest('hex'), lastCase!.scenario).toBe(createHash('sha256').update(plain).digest('hex'));
  counts.successfulReads++;
}

/** Требует отказ на input/scenario, опционально проверяет число deriving; возвращает Promise<void> без ложного успеха. */
async function rejected(input: Uint8Array, scenario: string, deriving?: number, passphrase = phrase): Promise<void> {
  remember(scenario, input, passphrase);
  let calls = 0;
  await expect((async () => collect(await transformAge(stream(input), passphrase, 'decrypt', () => { calls++; })))(), lastCase!.scenario).rejects.toThrow();
  if (deriving !== undefined) expect(calls, lastCase!.scenario).toBe(deriving);
  counts.rejectedContainers++; if (calls === 1) counts.postKdfRejections++;
}

it(`seed=${seed}: ${iterations} произвольных входов дают только контролируемую ошибку`, () => {
  onTestFailed(saveFailure);
  const random = randomFor(1);
  for (let n = 0; n < iterations; n++) {
    const bytes = Uint8Array.from({ length: random() % (MAX_HEADER_BYTES + 1) }, () => random() & 255);
    remember(`arbitrary-header case=${n}`, bytes);
    expect(() => inspectAgeHeader(bytes), `seed=${seed}, case=${n}`).toThrow(InputError);
    counts.arbitraryHeaders++;
  }
});

it('все усечения заголовка, неканоничный base64, лишние строки и высокие KDF отклоняются до KDF', async () => {
  onTestFailed(saveFailure);
  const header = `age-encryption.org/v1\n-> scrypt ${'A'.repeat(22)} 18\n${'A'.repeat(43)}\n--- ${'A'.repeat(43)}\n`;
  const encoded = new TextEncoder().encode(header);
  const malformed = [
    ...Array.from({ length: encoded.length }, (_, i) => encoded.slice(0, i)),
    ...['19', '20', '999999999999999999999999', '0', '01', '-1', 'NaN'].map((n) => new TextEncoder().encode(header.replace(' 18\n', ` ${n}\n`))),
    ...[header.replace('A'.repeat(22), 'A'.repeat(21) + 'B'), header.replace('A'.repeat(43), 'A'.repeat(42) + 'B'), header.replace('-> scrypt', '-> X25519'), header.replace('\n---', '\n-> scrypt AA 1\nAA\n---'), header.replace(/\n/g, '\r\n'), '\ufeff' + header].map((s) => new TextEncoder().encode(s)),
    new Uint8Array(MAX_HEADER_BYTES + 100).fill(65),
  ];
  let deriving = 0;
  for (const bytes of malformed) {
    remember(`malformed-header case=${counts.preKdfRejections}`, bytes);
    await expect(transformAge(stream(bytes, 17), phrase, 'decrypt', () => { deriving++; })).rejects.toBeInstanceOf(InputError);
    counts.preKdfRejections++;
  }
  expect(deriving).toBe(0);
});

it('границы 64 КиБ, произвольная нарезка, мутации MAC/nonce/tag и усечения не обходят AEAD', async () => {
  onTestFailed(saveFailure);
  const random = randomFor(3);
  // logN=1 только у явно синтетических тестовых контейнеров; production всегда шифрует с 18.
  for (const size of [0, 65_535, 65_536, 65_537, 131_073]) {
    const plain = Uint8Array.from({ length: size }, () => random() & 255);
    const cipher = new Encrypter(); cipher.setPassphrase(phrase); cipher.setScryptWorkFactor(1);
    const encrypted = await cipher.encrypt(plain);
    for (const chunk of [1, 17, 4096, 65_552]) {
      remember(`chunk=${chunk}, size=${size}`, encrypted);
      expect(createHash('sha256').update(await collect(await transformAge(stream(encrypted, chunk), phrase, 'decrypt'))).digest('hex')).toBe(createHash('sha256').update(plain).digest('hex'));
      counts.successfulReads++;
    }
    const end = headerEnd(encrypted);
    const text = new TextDecoder().decode(encrypted.subarray(0, end));
    for (const point of [text.indexOf('\n', text.indexOf('-> ')) + 1, text.indexOf('\n--- ') + 5]) {
      const changed = encrypted.slice(); changed[point] = changed[point] === 65 ? 66 : 65;
      await rejected(changed, `canonical-header-mutation size=${size}, byte=${point}`, 1);
    }
    const boundaries = new Set([0, 20, 24, 53, 90, end - 1, end, end + 15, end + 16, end + 16 + 65_552, encrypted.length - 17, encrypted.length - 1]);
    for (const point of boundaries) {
      if (point < 0 || point >= encrypted.length) continue;
      const changed = encrypted.slice(); changed[point] ^= 0x80;
      await rejected(changed, `mutation size=${size}, byte=${point}`);
      await rejected(encrypted.subarray(0, point), `truncation size=${size}, byte=${point}`);
    }
    await rejected(encrypted, `wrong-phrase size=${size}`, 1, 'wrong-public-test-phrase');
    const appended = new Uint8Array(encrypted.length + 1); appended.set(encrypted);
    await rejected(appended, `appended-zero size=${size}`, 1);
  }
});

it('канонические синтетические поля всех разрешённых logN принимаются только синтаксическим guard', () => {
  onTestFailed(saveFailure);
  const random = randomFor(4);
  for (let n = 1; n <= 18; n++) {
    const input = encoder.encode(header(random, String(n)));
    remember(`accepted-syntax logN=${n}`, input);
    expect(() => inspectAgeHeader(input)).not.toThrow(); counts.acceptedHeaders++;
  }
});

it('структурные мутации соли, wrapped key, MAC, разделителей и чисел отклоняются без KDF', async () => {
  onTestFailed(saveFailure);
  const random = randomFor(5);
  const invalidNumbers = ['19', '20', '31', '4294967295', '9007199254740993', 'Infinity', 'NaN', '0', '00', '01', '-1', '+1', '1e1', '1.0', '0x12'];
  for (let n = 0; n < structuredCases; n++) {
    const valid = header(random);
    const lines = valid.trimEnd().split('\n');
    const fields = [lines[1].split(' ')[2], lines[2], lines[3].slice(4)];
    const field = fields[n % 3];
    const noncanonical = field.slice(0, -1) + alphabet[alphabet.indexOf(field.at(-1)!) | 1];
    const variants = [field + '=', field.slice(1), field + 'A', noncanonical, field.slice(0, -1) + '_', field.slice(0, 3) + '\u0000' + field.slice(4)];
    const syntax = [
      valid.replace(field, variants[Math.floor(n / 3) % variants.length]),
      valid.replace(' 18\n', ` ${invalidNumbers[n % invalidNumbers.length]}\n`),
      valid.replace('-> scrypt', ['-> X25519', '->  scrypt', '->\tscrypt', '-> scrypt\u00a0'][n % 4]),
      valid.replace('\n---', '\n-> scrypt AA 1\nAA\n---'),
      valid.replace(/\n/g, '\r\n'), '\ufeff' + valid,
      valid.slice(0, -1), valid.replace('age-encryption.org/v1', 'age-encryption.org/v2'),
    ];
    const input = encoder.encode(syntax[n % syntax.length]);
    remember(`structured-header case=${n}, variant=${n % syntax.length}`, input);
    let deriving = 0;
    const source = stream(input, 1 + random() % 257, random);
    await expect(transformAge(source, phrase, 'decrypt', () => { deriving++; }), lastCase!.scenario).rejects.toBeInstanceOf(InputError);
    expect(deriving).toBe(0); expect(source.locked).toBe(false);
    counts.structuredHeaders++; counts.preKdfRejections++;
  }
  const base = header(random, '');
  for (const length of [MAX_HEADER_BYTES - 1, MAX_HEADER_BYTES, MAX_HEADER_BYTES + 1]) {
    const input = encoder.encode(base.replace(' \n', ` ${'9'.repeat(length - base.length)}\n`));
    expect(input.length).toBe(length);
    await rejected(input, `oversized-number length=${length}`, 0); counts.preKdfRejections++;
  }
});

it('неограниченный хвост неверного заголовка отменяется после ограниченного числа чтений', async () => {
  onTestFailed(saveFailure);
  for (const size of [1, 17, 257, MAX_HEADER_BYTES, MAX_HEADER_BYTES + 1]) {
    const block = new Uint8Array(size).fill(65);
    remember(`bounded-source chunk=${size}`, block);
    let reads = 0; let cancelled = 0; let deriving = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(block); }, cancel() { cancelled++; } }, { highWaterMark: 0 });
    await expect(transformAge(source, phrase, 'decrypt', () => { deriving++; })).rejects.toBeInstanceOf(InputError);
    expect(deriving).toBe(0); expect(reads).toBe(Math.ceil(MAX_HEADER_BYTES / size));
    expect(cancelled).toBe(1); expect(source.locked).toBe(false);
    counts.cancelledSources++; counts.preKdfRejections++;
  }
});

it('случайные малые контейнеры выдерживают точные границы и пустые блоки, а мутации всегда отвергаются', async () => {
  onTestFailed(saveFailure);
  const random = randomFor(7);
  const sizes = [0, 1, 15, 16, 17, 65_535, 65_536, 65_537, 131_071, 131_072, 131_073, 196_608, MAX_PLAINTEXT_BYTES];
  for (let n = 0; n < cryptoCases; n++) {
    const size = n < sizes.length ? sizes[n] : random() % (MAX_PLAINTEXT_BYTES + 1);
    const plain = Uint8Array.from({ length: size }, () => random() & 255);
    const cipher = new Encrypter(); cipher.setPassphrase(phrase); cipher.setScryptWorkFactor(1);
    const encrypted = await cipher.encrypt(plain);
    const end = headerEnd(encrypted); const payload = end + 16;
    const cuts = [...Array.from({ length: end }, (_, i) => i + 1), end + 1, payload - 1, payload, payload + 1];
    for (let i = payload + 65_552; i < encrypted.length; i += 65_552) cuts.push(i - 1, i, i + 1);
    await accepted(encrypted, plain, `partition case=${n}, size=${size}`, cuts, true);
    for (let attempt = 0; attempt < 4; attempt++) {
      const point = end + random() % (encrypted.length - end);
      const mutation = encrypted.slice(); mutation[point] ^= 1 << (random() % 8);
      await rejected(mutation, `payload-bit case=${n}, byte=${point}`, 1);
      const cut = end + random() % (encrypted.length - end);
      await rejected(encrypted.subarray(0, cut), `payload-truncation case=${n}, cut=${cut}`, 1);
    }
    const extra = new Uint8Array(encrypted.length + 1 + random() % 32); extra.set(encrypted);
    await rejected(extra, `payload-append case=${n}`, 1);
  }
});

it('перестановка, удаление, повтор блока и смешивание контейнеров не обходят счётчик и финальный tag', async () => {
  onTestFailed(saveFailure);
  const random = randomFor(8);
  for (let n = 0; n < Math.ceil(cryptoCases / 4); n++) {
    const plain = Uint8Array.from({ length: MAX_PLAINTEXT_BYTES }, () => random() & 255);
    const cipher = new Encrypter(); cipher.setPassphrase(phrase); cipher.setScryptWorkFactor(1);
    const left = await cipher.encrypt(plain); const right = await cipher.encrypt(plain);
    const payload = headerEnd(left) + 16; const width = 65_552;
    const swapped = left.slice(); swapped.set(left.subarray(payload + width, payload + 2 * width), payload); swapped.set(left.subarray(payload, payload + width), payload + width);
    const repeated = left.slice(); repeated.set(left.subarray(payload, payload + width), payload + width);
    const removed = new Uint8Array(left.length - width); removed.set(left.subarray(0, payload)); removed.set(left.subarray(payload + width), payload);
    const spliced = left.slice(); spliced.set(right.subarray(payload + width, payload + 2 * width), payload + width);
    const finalAsFirst = left.slice(0, left.length - 3 * width); finalAsFirst.set(left.subarray(payload + 3 * width), payload);
    for (const [label, input] of Object.entries({ swapped, repeated, removed, spliced, finalAsFirst })) await rejected(input, `${label} case=${n}`, 1);
  }
});

it('ошибки источника до заголовка, nonce и между блоками доходят до вызывающего кода', async () => {
  onTestFailed(saveFailure);
  const plain = new Uint8Array(MAX_PLAINTEXT_BYTES).fill(42);
  const cipher = new Encrypter(); cipher.setPassphrase(phrase); cipher.setScryptWorkFactor(1);
  const input = await cipher.encrypt(plain); const end = headerEnd(input);
  for (const cut of [0, 1, end - 1, end, end + 15, end + 16, end + 16 + 65_552, input.length - 1]) {
    remember(`source-error cut=${cut}`, input);
    const error = new Error('public-test-source-failure'); let offset = 0;
    const source = new ReadableStream<Uint8Array>({ pull(controller) {
      if (offset === cut) { controller.error(error); return; }
      const next = Math.min(cut, offset + 251); controller.enqueue(input.subarray(offset, next)); offset = next;
    } }, { highWaterMark: 0 });
    await expect((async () => collect(await transformAge(source, phrase, 'decrypt')))()).rejects.toBe(error);
    expect(source.locked).toBe(false); counts.streamFaults++;
  }
});

it.each(['mac', 'wrapped-key', 'salt', 'wrong-phrase'])('отказ %s отменяет источник и освобождает reader после начала KDF', async (kind) => {
  onTestFailed(saveFailure);
  const cipher = new Encrypter(); cipher.setPassphrase(phrase); cipher.setScryptWorkFactor(1);
  const input = await cipher.encrypt(new Uint8Array(MAX_PLAINTEXT_BYTES));
  const end = headerEnd(input); const text = new TextDecoder().decode(input.subarray(0, end));
  const point = kind === 'mac' ? text.indexOf('\n--- ') + 5 : kind === 'salt' ? text.indexOf('-> scrypt ') + 10 : text.indexOf('\n', text.indexOf('-> ')) + 1;
  if (kind !== 'wrong-phrase') input[point] = input[point] === 65 ? 66 : 65;
  const passphrase = kind === 'wrong-phrase' ? 'wrong-public-test-phrase' : phrase;
  remember(`source-cancel-on-${kind}`, input, passphrase);
  let offset = 0; let cancelled = 0;
  const source = new ReadableStream<Uint8Array>({ pull(controller) {
    const next = Math.min(input.length, offset + 257);
    if (next === offset) { controller.close(); return; }
    controller.enqueue(input.subarray(offset, next)); offset = next;
  }, cancel() { cancelled++; } }, { highWaterMark: 0 });
  await expect(transformAge(source, passphrase, 'decrypt')).rejects.toThrow();
  expect(cancelled).toBe(1); expect(source.locked).toBe(false); counts.cancelledSources++;
});
