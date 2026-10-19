/** Публичное автономное приложение; сетевой код кабинета сюда не импортируется. */
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Shell, applyTheme } from './components/Shell';
import { Cipher } from './features/encrypt/Cipher';
import { Instructions } from './features/instructions/Instructions';
import { Privacy } from './features/privacy/Privacy';
import './styles.css';

/** Возвращает приложение с локальной hash-навигацией, работающей без backend и сети. */
function App() {
  const [hash, setHash] = useState(location.hash);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const navigate = () => { if (!busy) setHash(location.hash); };
    window.addEventListener('hashchange', navigate);
    return () => window.removeEventListener('hashchange', navigate);
  }, [busy]);
  return <Shell busy={busy}>{hash.startsWith('#instructions') ? <Instructions /> : hash === '#privacy' ? <Privacy /> : <Cipher onBusyChange={setBusy} />}</Shell>;
}

let initialTheme = 'light';
try { initialTheme = localStorage.getItem('gault-theme') || 'light'; } catch { /* Без хранилища остаётся светлая тема. */ }
applyTheme(initialTheme);
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { try { if (localStorage.getItem('gault-theme') === 'system') applyTheme('system'); } catch { /* Несекретная настройка необязательна. */ } });
createRoot(document.getElementById('root')!).render(<App />);
