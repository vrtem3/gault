/** Неизменяемость публичных образцов: обычные тесты ничего не генерируют и не перезаписывают. */
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const directory = resolve('tests/fixtures/compatibility/v0.1.0');
const manifestBytes = readFileSync(resolve(directory, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString());

/** Возвращает hex SHA-256 малых публичных data (Uint8Array), не пользовательского файла. */
function hash(data: Uint8Array): string { return createHash('sha256').update(data).digest('hex'); }

it('фиксирует manifest релиза 0.1.0 и все 15 старых контейнеров', () => {
  expect(hash(manifestBytes)).toBe('d74bade90e5d3bb806f3e1b6eb95f38b70f58fef2bdb1dda3a6cdfbada76fe1d');
  expect(manifest.release).toBe('0.1.0');
  expect(manifest.files).toHaveLength(15);
  expect(new Set(manifest.files.map((file: { id: string }) => file.id)).size).toBe(15);
  for (const file of manifest.files) {
    for (const kind of ['plaintext', 'ciphertext']) {
      expect(file[kind]).toMatch(/^[a-z0-9.-]+$/);
      const bytes = readFileSync(resolve(directory, file[kind]));
      expect(bytes.byteLength).toBe(file[`${kind}Bytes`]);
      expect(hash(bytes)).toBe(file[`${kind}Sha256`]);
    }
  }
});
