/** Тонкий адаптер стандартного age v1: никаких собственных KDF или контейнеров. */
import { Encrypter, Decrypter } from 'age-encryption';

export type Operation = 'encrypt' | 'decrypt';
export const SCRYPT_LOG_N = 18;
export const MAX_HEADER_BYTES = 8192;

/** Ошибка предварительной проверки с безопасным кодом вместо содержимого входного файла. */
export class InputError extends Error {
  /** Принимает code (str), создаёт Error для отображения сообщения без входных данных. */
  constructor(public readonly code: 'format' | 'kdf') { super(code); }
}

/** Проверяет prefix (Uint8Array) заголовка до KDF; возвращает void или InputError. Сам формат проверяет Typage. */
export function inspectAgeHeader(prefix: Uint8Array): void {
  // Только ограниченный парольный профиль. Проверку MAC/AEAD выполняет Typage.
  // BOM сохраняется как символ и отклоняется regexp, а не скрывается декодером.
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(prefix.subarray(0, MAX_HEADER_BYTES));
  const match = /^age-encryption.org\/v1\n-> scrypt ([A-Za-z0-9+/]{22}) ([1-9][0-9]*)\n([A-Za-z0-9+/]{43})\n--- ([A-Za-z0-9+/]{43})\n/.exec(text);
  if (!match) throw new InputError('format');
  // atob допускает ненулевые хвостовые биты: обратное кодирование проверяет каноничность.
  for (const field of [match[1], match[3], match[4]]) {
    if (btoa(atob(field)).replace(/=+$/, '') !== field) throw new InputError('format');
  }
  if (Number(match[2]) > SCRYPT_LOG_N) throw new InputError('kdf');
}

/** Проверяет ограниченный префикс reader (ReadableStreamDefaultReader) до KDF; возвращает поток тех же байтов. */
async function checkedInput(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<ReadableStream<Uint8Array>> {
  const prefix = new Uint8Array(MAX_HEADER_BYTES);
  let used = 0;
  let lines = 0;
  let tail: Uint8Array | undefined;
  try {
    while (used < prefix.length) {
      const { value, done } = await reader.read();
      if (done) break;
      const count = Math.min(value.byteLength, prefix.length - used);
      prefix.set(value.subarray(0, count), used);
      for (let i = used; i < used + count; i++) if (prefix[i] === 10) lines++;
      used += count;
      tail = value.subarray(count);
      // У парольного age ровно четыре строки; не ждём данных payload для проверки.
      if (lines >= 4) break;
    }
    inspectAgeHeader(prefix.subarray(0, used));
  } catch (error) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    throw error;
  }
  return new ReadableStream({
    start(controller) {
      controller.enqueue(prefix.subarray(0, used));
      if (tail?.byteLength) controller.enqueue(tail);
    },
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        if (done) { reader.releaseLock(); controller.close(); }
        else controller.enqueue(value);
      } catch (error) { reader.releaseLock(); controller.error(error); }
    },
    async cancel(reason) { try { await reader.cancel(reason); } finally { reader.releaseLock(); } },
  });
}

/** Преобразует input с phrase/mode; onDeriving уведомляет о начале KDF. Возвращает стандартный поток age/открытых данных. */
export async function transformAge(input: ReadableStream<Uint8Array>, phrase: string, mode: Operation, onDeriving?: () => void): Promise<ReadableStream<Uint8Array>> {
  if (!phrase) throw new Error('empty-passphrase');
  if (mode === 'encrypt') {
    onDeriving?.();
    const cipher = new Encrypter();
    cipher.setPassphrase(phrase);
    // Совпадает с default Typage; параметры не ослабляются ради скорости.
    cipher.setScryptWorkFactor(SCRYPT_LOG_N);
    return cipher.encrypt(input);
  }
  const reader = input.getReader();
  const checked = await checkedInput(reader);
  try {
    onDeriving?.();
    const cipher = new Decrypter();
    cipher.addPassphrase(phrase);
    return await cipher.decrypt(checked);
  } catch (error) {
    // Парсер Typage может удерживать checked.locked после ошибки MAC/unwrap.
    // Собственный reader позволяет остановить источник независимо от этого lock.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    if (!checked.locked) await checked.cancel().catch(() => {});
    throw error;
  }
}
