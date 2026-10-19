# Сторонние компоненты

Код Gault распространяется по MIT. Лицензии зависимостей сохраняют действие.

- Typage / `age-encryption` 0.3.1 — BSD-3-Clause, [официальный проект](https://github.com/FiloSottile/typage).
- Noble и Scure — MIT; React — MIT; Vite — MIT; Lucide — ISC; Tailwind CSS — MIT; компоненты shadcn/ui — MIT; Radix — MIT; zxcvbn-ts — MIT. Точные версии и зависимости зафиксированы в `frontend/package-lock.json`.
- Полные доступные npm-тексты runtime-лицензий собираются командой `node scripts/licenses.mjs` в `frontend/public/third-party-licenses.txt`, поставляются в обеих сборках и включены в PWA-кэш. Обновляйте этот файл вместе с lockfile.
- Python-компоненты сохраняют свои лицензии в установленном окружении; версии и SHA-256 дистрибутивов закреплены в `backend/requirements*.txt`.

## EFF Long Wordlist

Источник: Electronic Frontier Foundation, [Dice-Generated Passphrases](https://www.eff.org/dice), [официальный словарь](https://www.eff.org/files/2016/07/18/eff_large_wordlist.txt).

Лицензия: [Creative Commons Attribution 3.0](https://creativecommons.org/licenses/by/3.0/). Из исходного списка удалены цифровые номера бросков, 7776 слов сохранены. Локальная копия: `frontend/src/features/passphrase/eff-words.txt`; SHA-256: `6d557f0693958fb5e650b68b5bee585eb82cf4da32965505c789e924743bc522`.

## SecLists

Источник: [danielmiessler/SecLists — 10k-most-common.txt](https://github.com/danielmiessler/SecLists/blob/master/Passwords/Common-Credentials/10k-most-common.txt), получен 19.10.2026. Локальная копия: `backend/app/data/common-passwords.txt`; SHA-256: `68782d6a4a19a4768d5f15dd66bd534e7a33055cc755411e33f16d18c50fdcce`.

MIT, полный текст: `backend/app/data/SECLISTS-LICENSE.txt`. Это ограниченный локальный список распространённых скомпрометированных значений, а не полная база всех утечек. Пароли аккаунтов не передаются сервисам проверки.

## Тестовые CLI

age, rage и Mailpit скачиваются только из официальных GitHub Releases в исключённый из публикации каталог `.tools`. URL и опубликованные GitHub SHA-256 закреплены в `scripts/tools-lock.json`. Эти бинарные файлы не поставляются как часть frontend/backend.

Windows ConPTY-обвязка использует [pywinpty 3.1.0](https://github.com/andfoy/pywinpty/tree/v3.1.0), MIT. Это отдельная тестовая зависимость Windows/CPython 3.13, wheels и SHA-256 закреплены в `frontend/scripts/requirements-windows.txt`; в runtime Gault и PWA она не включается.
