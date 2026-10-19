/** Общий визуальный каркас: статические ссылки без импорта сетевого кода кабинета. */
import { useEffect, useState, type ReactNode } from 'react';
import { ArrowUpRight, Monitor, Moon, ShieldCheck, Sun } from 'lucide-react';
import { config } from '../app/config';
import { watchOfflineUpdates } from '../platform/offline';

/** Устанавливает theme (light/dark/system); возвращает void, сохраняет только несекретную настройку темы. */
export function applyTheme(theme: string): void {
  document.documentElement.dataset.theme = theme === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : theme;
}

/** Принимает children и параметры Shell; возвращает шапку, контент и подвал приложения. */
export function Shell({ children, account = false, busy = false }: { children: ReactNode; account?: boolean; busy?: boolean }) {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('gault-theme') || 'light'; } catch { return 'light'; } });
  const [updateAvailable, setUpdateAvailable] = useState(false);
  const [updateConfirmed, setUpdateConfirmed] = useState(false);
  useEffect(() => account ? undefined : watchOfflineUpdates(setUpdateAvailable), [account]);
  return <div className="site-shell">
    <a className="skip-link" href="#main">Перейти к содержимому</a>
    <header className="header">
      <a className="logo" href={account ? config.cipherOrigin : '#'} aria-label="Gault — главная">gault<span>.</span></a>
      <nav className="nav" aria-label="Основная навигация">
        <a href={account ? config.cipherOrigin : '#'} onClick={(event) => { if (busy) event.preventDefault(); }}>Шифрование</a>
        <a href={account ? `${config.cipherOrigin}/#instructions` : '#instructions'} onClick={(event) => { if (busy) event.preventDefault(); }}>Инструкция</a>
        {account && <a className="account-link" href="/">Личный кабинет <ArrowUpRight size={14} aria-hidden="true" /></a>}
      </nav>
    </header>
    {updateAvailable && <div className="notice neutral update-notice" role="status">
      <div><strong>Доступно обновление Gault</strong><p>{busy ? 'Обновление ждёт завершения операции. Оставьте вкладку открытой.' : updateConfirmed ? 'Сохраните фразу и результаты. Закройте все вкладки Gault, затем откройте сайт снова — новая версия включится автоматически. Несохранённая фраза исчезнет из формы.' : 'Новая версия загружена и ожидает. Текущая вкладка продолжает работать.'}</p></div>
      {!updateConfirmed && <button type="button" disabled={busy} onClick={() => setUpdateConfirmed(true)}>Подготовить обновление</button>}
    </div>}
    <main id="main" tabIndex={-1}>{children}</main>
    <footer className="footer">
      <div><a className="logo footer-logo" href={account ? config.cipherOrigin : '#'}>gault<span>.</span></a><p>Защищай свои данные. Владей своими ключами.</p></div>
      <div className="footer-links">
        {config.githubUrl ? <a href={config.githubUrl} target="_blank" rel="noopener noreferrer">Исходный код на GitHub <ArrowUpRight size={13} aria-hidden="true" /></a> : <span className="muted">Исходный код: публикация готовится</span>}
        <a href={account ? `${config.cipherOrigin}/#privacy` : '#privacy'}>Конфиденциальность</a>
        <span className="muted">v{config.version}</span>
        {!account && config.buildId && <span className="muted" title={`SHA-256 исходников и публичных параметров: ${config.buildId}`}>Сборка {config.buildId.slice(0, 12)}</span>}
        <label className="theme-control">{theme === 'dark' ? <Moon size={15} aria-hidden="true" /> : theme === 'system' ? <Monitor size={15} aria-hidden="true" /> : <Sun size={15} aria-hidden="true" />}<select aria-label="Тема интерфейса" value={theme} onChange={(event) => { setTheme(event.target.value); applyTheme(event.target.value); try { localStorage.setItem('gault-theme', event.target.value); } catch { /* Тема работает и без хранилища. */ } }}><option value="light">Светлая</option><option value="dark">Тёмная</option><option value="system">Как в системе</option></select></label>
      </div>
    </footer>
  </div>;
}

/** Возвращает ReactNode маркировки локальной обработки без неподтверждённых обещаний об офлайне. */
export function LocalNotice() {
  return <div className="local-notice"><ShieldCheck size={21} aria-hidden="true" /><div><strong>Только на вашем устройстве</strong><p>Файл и секретная фраза остаются в браузере.</p></div></div>;
}
