/** Изолированный личный кабинет Gault: регистрация, почта, профиль, безопасность и пустое состояние хранилищ. */
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { CheckCircle2, Database, KeyRound, LogOut, MailCheck, Shield, ShieldCheck, UserRound } from 'lucide-react';
import { Shell, applyTheme } from '../../src/components/Shell';
import { Button } from '../../src/components/ui/button';
import { config } from '../../src/app/config';
import { setUsageConsent, usageConsent, weekKey } from '../../src/features/privacy/telemetry';
import { api, ApiError } from './api';
import '../../src/styles.css';

interface User { id: string; email: string; display_name: string; email_verified: boolean; created_at: string }
interface Session { id: string; current: boolean; created_at: string; expires_at: string }
type Page = 'login' | 'register' | 'forgot-password' | 'resend-verification' | 'verify-email' | 'reset-password';

/** Возвращает ReactNode кабинета; секреты форм и email-токены хранятся только в памяти. */
function Account() {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState<Page>('login');
  const token = useRef('');
  const [tab, setTab] = useState<'profile' | 'security' | 'storage'>('profile');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [repeat, setRepeat] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [sessions, setSessions] = useState<Session[]>([]);
  const [consent, setConsent] = useState(usageConsent);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const title: Record<Page, string> = { login: 'С возвращением', register: 'Создайте аккаунт', 'forgot-password': 'Забыли пароль?', 'resend-verification': 'Подтвердите почту', 'verify-email': 'Подтвердите email', 'reset-password': 'Новый пароль' };

  useEffect(() => {
    // Ссылку можно открыть и в уже открытом кабинете: hash-навигация не перезапускает JS.
    const consumeLink = () => {
      const link = /^#(verify-email|reset-password)=([A-Za-z0-9_-]{32,128})$/.exec(location.hash);
      if (!link) return;
      token.current = link[2]; setPage(link[1] as Page);
      setPassword(''); setRepeat(''); setCurrentPassword(''); setError(''); setMessage('');
      history.replaceState(null, '', `/#${link[1]}`);
    };
    consumeLink();
    window.addEventListener('hashchange', consumeLink);
    void api<User>('/auth/me').then((me) => { setUser(me); setDisplayName(me.display_name); }).catch((failure) => { if (failure.status !== 401) setError(failure.message); }).finally(() => setLoading(false));
    return () => { token.current = ''; window.removeEventListener('hashchange', consumeLink); };
  }, []);
  useEffect(() => {
    if (user && consent && navigator.onLine) void api('/usage/visit', 'POST', { week_key: weekKey() }).catch(() => { /* Добровольный счётчик не влияет на кабинет. */ });
  }, [user?.id, consent]);
  useEffect(() => {
    if (user && tab === 'security') void api<Session[]>('/me/sessions').then(setSessions).catch((failure) => setError(failure.message));
  }, [user?.id, tab]);

  /** Переключает next (Page), очищая пароли/сообщения; возвращает void. */
  function navigate(next: Page): void { setPage(next); setPassword(''); setRepeat(''); setCurrentPassword(''); setMessage(''); setError(''); }

  /** Обрабатывает FormEvent регистрации/входа/почты; возвращает Promise<void>, не отправляет данные шифрования. */
  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault(); setError(''); setMessage('');
    if (['register', 'reset-password'].includes(page) && password !== repeat) { setError('Пароли не совпадают.'); return; }
    setBusy(true);
    try {
      if (page === 'login') { const result = await api<{ user: User }>('/auth/login', 'POST', { email, password }); setUser(result.user); setDisplayName(result.user.display_name); }
      else if (page === 'verify-email') { if (!token.current) throw new ApiError(400, 'Откройте одноразовую ссылку из письма.'); const result = await api('/auth/verify-email', 'POST', { token: token.current }); token.current = ''; setMessage(result.message); setPage('login'); }
      else if (page === 'reset-password') { if (!token.current) throw new ApiError(400, 'Откройте действующую ссылку сброса из письма.'); const result = await api('/auth/reset-password', 'POST', { token: token.current, password }); token.current = ''; setMessage(result.message); setPage('login'); }
      else { const result = await api(`/auth/${page}`, 'POST', page === 'register' ? { email, password } : { email }); setMessage(result.message); if (page === 'register') setPage('login'); }
      setPassword(''); setRepeat('');
    } catch (failure) { setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  /** Отзывает текущую серверную сессию; возвращает Promise<void>, очищая состояние кабинета. */
  async function logout(): Promise<void> {
    setBusy(true); setError('');
    try { await api('/auth/logout', 'POST'); setUser(null); setPassword(''); setSessions([]); setPage('login'); }
    catch (failure) { if ((failure as ApiError).status === 401) setUser(null); else setError((failure as Error).message); }
    finally { setBusy(false); }
  }

  if (loading) return <Shell account><div className="auth-wrap" role="status">Загружаем личный кабинет…</div></Shell>;
  return <Shell account>{!user || ['verify-email', 'reset-password'].includes(page) && token.current ? <div className="auth-wrap"><section className="card"><div className="auth-brand"><ShieldCheck size={28} aria-hidden="true" /><span className="logo">gault<span>.</span></span></div><h1>{title[page]}</h1><p className="lead">{page === 'login' ? 'Кабинет для профиля и будущих подключений. Шифрование доступно без входа.' : page === 'register' ? 'Пароль аккаунта не связан с секретной фразой ваших файлов.' : page === 'verify-email' ? 'Подтвердите адрес, на который пришла эта ссылка.' : page === 'reset-password' ? 'Смена пароля завершит все открытые сессии.' : 'Отправим одноразовую ссылку на указанный адрес.'}</p>
      {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice neutral" role="status"><MailCheck size={18} aria-hidden="true" />{message}</div>}
      <form className="auth-form" onSubmit={(event) => void submit(event)}>
        {!['verify-email', 'reset-password'].includes(page) && <div className="field"><label htmlFor="account-email">Email</label><input id="account-email" type="email" autoComplete="email" required maxLength={254} value={email} onChange={(event) => setEmail(event.target.value)} /></div>}
        {['login', 'register', 'reset-password'].includes(page) && <div className="field"><label htmlFor="account-password">{page === 'reset-password' ? 'Новый пароль' : 'Пароль аккаунта'}</label><input id="account-password" type="password" autoComplete={page === 'login' ? 'current-password' : 'new-password'} required minLength={page === 'login' ? 1 : 15} maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} />{page !== 'login' && <small>От 15 до 128 символов. Без требований к цифрам и регистру. Распространённые пароли не допускаются.</small>}</div>}
        {['register', 'reset-password'].includes(page) && <div className="field"><label htmlFor="account-repeat">Повторите пароль</label><input id="account-repeat" type="password" autoComplete="new-password" required maxLength={128} value={repeat} onChange={(event) => setRepeat(event.target.value)} /></div>}
        <Button type="submit" disabled={busy}>{busy ? 'Выполняем…' : ({ login: 'Войти', register: 'Зарегистрироваться', 'forgot-password': 'Отправить ссылку', 'resend-verification': 'Отправить письмо', 'verify-email': 'Подтвердить email', 'reset-password': 'Сохранить новый пароль' })[page]}</Button>
      </form><div className="auth-links">{page !== 'login' && <button onClick={() => navigate('login')}>Войти</button>}{page === 'login' && <><button onClick={() => navigate('register')}>Создать аккаунт</button><button onClick={() => navigate('forgot-password')}>Забыли пароль?</button><button onClick={() => navigate('resend-verification')}>Повторить подтверждение</button></>}</div></section><p className="help mt-4 text-center">Нужен только шифратор? <a href={config.cipherOrigin}>Защитить файл без аккаунта</a></p></div> : <div className="account-page"><span className="eyebrow"><UserRound size={15} aria-hidden="true" /> Личный кабинет</span><h1>Добро пожаловать{user.display_name ? `, ${user.display_name}` : ''}</h1><p>Файлы и фразы остаются на устройстве. Здесь — только настройки аккаунта.</p><div className="account-layout"><nav className="account-nav" aria-label="Разделы кабинета"><button aria-current={tab === 'profile' ? 'page' : undefined} onClick={() => { setTab('profile'); setError(''); setMessage(''); }}><UserRound size={17} aria-hidden="true" /> Профиль</button><button aria-current={tab === 'security' ? 'page' : undefined} onClick={() => { setTab('security'); setError(''); setMessage(''); }}><Shield size={17} aria-hidden="true" /> Безопасность</button><button aria-current={tab === 'storage' ? 'page' : undefined} onClick={() => { setTab('storage'); setError(''); setMessage(''); }}><Database size={17} aria-hidden="true" /> Мои хранилища</button><button disabled={busy} onClick={() => void logout()}><LogOut size={17} aria-hidden="true" /> Выход</button></nav><section className="card account-content">
      {error && <div className="notice error" role="alert">{error}</div>}{message && <div className="notice neutral" role="status"><CheckCircle2 size={18} aria-hidden="true" />{message}</div>}
      {tab === 'profile' && <><h2>Профиль</h2><form onSubmit={async (event) => { event.preventDefault(); setBusy(true); setError(''); try { const next = await api<User>('/me', 'PATCH', { display_name: displayName }); setUser(next); setMessage('Профиль сохранён.'); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }}><div className="field"><label htmlFor="profile-email">Email</label><input id="profile-email" value={user.email} readOnly /><small>Адрес подтверждён</small></div><div className="field"><label htmlFor="display-name">Как к вам обращаться</label><input id="display-name" value={displayName} maxLength={80} onChange={(event) => setDisplayName(event.target.value)} /></div><Button type="submit" disabled={busy}>Сохранить профиль</Button></form><label className="checkbox-row consent"><input type="checkbox" checked={consent} onChange={(event) => { setConsent(event.target.checked); setUsageConsent(event.target.checked); }} /><span><strong>Отправлять анонимную статистику использования</strong><small>Учитывается только согласованное онлайн-посещение кабинета и общие числовые показатели. Отказ не ограничивает функциональность.</small></span></label></>}
      {tab === 'security' && <><h2>Безопасность</h2><form onSubmit={async (event) => { event.preventDefault(); setError(''); if (password !== repeat) { setError('Новые пароли не совпадают.'); return; } setBusy(true); try { const result = await api('/me/password', 'POST', { current_password: currentPassword, password }); setUser(null); setPage('login'); setMessage(result.message); setPassword(''); setRepeat(''); setCurrentPassword(''); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }}><div className="field"><label htmlFor="old-password">Текущий пароль аккаунта</label><input id="old-password" type="password" required autoComplete="current-password" maxLength={128} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></div><div className="field"><label htmlFor="new-password">Новый пароль</label><input id="new-password" type="password" required minLength={15} maxLength={128} autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} /><small>От 15 до 128 символов. После смены все сессии завершатся.</small></div><div className="field"><label htmlFor="new-password-repeat">Повторите новый пароль</label><input id="new-password-repeat" type="password" required autoComplete="new-password" maxLength={128} value={repeat} onChange={(event) => setRepeat(event.target.value)} /></div><Button type="submit" disabled={busy}><KeyRound size={16} aria-hidden="true" /> Изменить пароль</Button></form><h2 className="mt-8">Активные сессии</h2><ul className="sessions">{sessions.map((session) => <li key={session.id}><div><strong>{session.current ? 'Эта сессия' : 'Другая сессия'}</strong>Создана {new Date(`${session.created_at}Z`).toLocaleString('ru-RU')}</div><Button variant="secondary" disabled={busy} onClick={async () => { setBusy(true); try { await api(`/me/sessions/${session.id}`, 'DELETE'); if (session.current) setUser(null); else setSessions(sessions.filter((row) => row.id !== session.id)); } catch (failure) { setError((failure as Error).message); } finally { setBusy(false); } }}>Завершить</Button></li>)}</ul></>}
      {tab === 'storage' && <Storage />}
    </section></div></div>}</Shell>;
}

/** Читает только собственные storage-connections; возвращает честное пустое состояние без фиктивных действий подключения. */
function Storage() {
  const [error, setError] = useState('');
  const [rows, setRows] = useState<{ id: string; display_name: string; status: string }[] | null>(null);
  useEffect(() => { void api<{ id: string; display_name: string; status: string }[]>('/storage-connections').then(setRows).catch((failure) => setError(failure.message)); }, []);
  return <div className="empty-state"><Database size={36} aria-hidden="true" /><h2>Мои хранилища</h2>{error ? <p role="alert">{error}</p> : rows === null ? <p role="status">Проверяем подключения…</p> : rows.length ? <ul>{rows.map((row) => <li key={row.id}>{row.display_name} · {row.status}</li>)}</ul> : <><p>Подключений пока нет.</p><p className="mt-3">Облачные хранилища появятся в следующих версиях. Сейчас Gault шифрует и сохраняет файлы только на вашем устройстве.</p></>}</div>;
}

let theme = 'light';
try { theme = localStorage.getItem('gault-theme') || 'light'; } catch { /* Предпочтение необязательно. */ }
applyTheme(theme);
createRoot(document.getElementById('root')!).render(<Account />);
