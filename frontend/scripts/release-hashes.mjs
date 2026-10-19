/** Создаёт SHA256SUMS указанных сборок; по умолчанию только самостоятельного шифратора. */
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Рекурсивно читает directory (str); возвращает Promise<str[]> путей всех файлов, кроме SHA256SUMS. */
async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (await Promise.all(entries.filter((entry) => entry.name !== 'SHA256SUMS').map((entry) => entry.isDirectory() ? files(join(directory, entry.name)) : [join(directory, entry.name)]))).flat();
}

for (const directory of (process.argv.length > 2 ? process.argv.slice(2) : ['dist'])) {
  const lines = [];
  const paths = (await files(directory)).map((path) => ({ path, name: relative(directory, path).split(sep).join('/') })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const { path, name } of paths) lines.push(`${createHash('sha256').update(await readFile(path)).digest('hex')}  ${name}`);
  await writeFile(join(directory, 'SHA256SUMS'), `${lines.join('\n')}\n`);
}
