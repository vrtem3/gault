/** Регрессия старых файлов через настоящий production Worker и FileSystemWritableFileStream. */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const directory = resolve('tests/fixtures/compatibility/v0.1.0');
const manifest = JSON.parse(readFileSync(resolve(directory, 'manifest.json'), 'utf8')) as {
  passphrase: string;
  files: { id: string; ciphertext: string; plaintextSha256: string; plaintextBytes: number }[];
};

for (const file of manifest.files) {
  const prefix = readFileSync(resolve(directory, file.ciphertext)).subarray(0, 200).toString();
  const workFactor = Number(/-> scrypt \S+ (\d+)/.exec(prefix)![1]);
  test(`профиль Gault для неизменяемого v0.1.0/${file.id} (logN=${workFactor})`, async ({ page }) => {
    await page.addInitScript(() => { window.showSaveFilePicker = async (options) => (await navigator.storage.getDirectory()).getFileHandle(options!.suggestedName!, { create: true }); });
    await page.goto('/');
    await expect(page.getByText('Готово к работе без интернета', { exact: true })).toBeVisible();
    await page.getByRole('tab', { name: 'Расшифровать', exact: true }).click();
    await page.getByTestId('file-input').setInputFiles(resolve(directory, file.ciphertext));
    await page.getByLabel('Секретная фраза', { exact: true }).fill(manifest.passphrase);
    await page.getByRole('button', { name: 'Расшифровать файл', exact: true }).click();
    if (workFactor > 18) {
      await expect(page.getByRole('alert')).toContainText('требуют слишком много памяти');
      await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toHaveCount(0);
      const bytes = await page.evaluate(async (name) => { try { return (await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()).size; } catch { return 0; } }, file.ciphertext.replace(/\.age$/, ''));
      expect(bytes).toBe(0);
      return;
    }
    await expect(page.getByRole('heading', { name: 'Файл записан', exact: true })).toBeVisible();
    const output = Buffer.from(await page.evaluate(async (name) => Array.from(new Uint8Array(await (await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile()).arrayBuffer())), file.ciphertext.replace(/\.age$/, '')));
    expect(output.byteLength).toBe(file.plaintextBytes);
    expect(createHash('sha256').update(output).digest('hex')).toBe(file.plaintextSha256);
  });
}
