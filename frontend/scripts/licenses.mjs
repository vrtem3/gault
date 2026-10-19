/** Собирает лицензии runtime-зависимостей, чтобы текст сопровождал статические сборки. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const notices = ['Gault — лицензии сторонних runtime-компонентов.\nИсходники, источники словарей и атрибуция: THIRD_PARTY_NOTICES.md проекта.\n'];
notices.push(await readFile('../LICENSE', 'utf8'));
for (const [path, data] of Object.entries(lock.packages).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) {
  if (!path || data.dev) continue;
  const info = JSON.parse(await readFile(join(path, 'package.json'), 'utf8'));
  const entries = (await readdir(path)).sort();
  const license = entries.find((name) => /^licen[cs]e(?:\.md|\.txt)?$/i.test(name));
  notices.push(`\n${'='.repeat(72)}\n${info.name} ${info.version} — ${info.license || data.license || 'см. репозиторий'}\n`);
  if (license) notices.push(await readFile(join(path, license), 'utf8'));
  else notices.push(`Источник: ${typeof info.repository === 'string' ? info.repository : info.repository?.url || info.homepage || ''}\n`);
}
notices.push('\nEFF Long Wordlist: Electronic Frontier Foundation, https://www.eff.org/dice, https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt\nCreative Commons Attribution 3.0: https://creativecommons.org/licenses/by/3.0/\nИзменение: удалены номера бросков; 7776 слов сохранены без изменений.\n');
await writeFile('public/third-party-licenses.txt', notices.join('\n'));
