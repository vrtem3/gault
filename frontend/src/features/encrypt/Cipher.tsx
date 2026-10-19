/** Единая форма локального шифрования и расшифровки с подтверждаемой потоковой записью. */
import { useEffect, useRef, useState } from 'react';
import { ArrowDownToLine, ArrowRight, Check, CheckCircle2, Copy, Eye, EyeOff, FileCheck2, FileLock2, FileUp, Info, KeyRound, LockKeyhole, RefreshCw, ShieldCheck, UnlockKeyhole, Upload, WifiOff, X } from 'lucide-react';
import { config } from '../../app/config';
import { Button } from '../../components/ui/button';
import { LocalNotice } from '../../components/Shell';
import type { Operation } from '../../crypto/age';
import { processFile, warmCryptoWorker, type OutputSink, type Progress } from '../../crypto/process';
import { fileProblem, formatBytes, isMobile } from '../../platform/capabilities';
import { prepareOffline } from '../../platform/offline';
import { assessPhrase, generatePhrase } from '../passphrase/passphrase';

type State = 'idle' | 'running' | 'success' | 'prepared' | 'cancelled' | 'error';
const errorMessages: Record<string, string> = {
  decrypt: 'Не удалось расшифровать файл: неверная фраза, повреждение или обрыв данных. Результат не сохранён как успешный.',
  encrypt: 'Не удалось зашифровать файл. Проверьте доступ к исходнику и повторите.',
  format: 'Нужен бинарный парольный файл age v1. Для файлов с ключами или ASCII armor используйте age/rage.',
  kdf: 'Параметры этого файла требуют слишком много памяти для браузера. Используйте age или rage на компьютере.',
  worker: 'Браузер остановил обработку. Проверьте доступную память или используйте другой браузер.',
};

/** Возвращает UI Cipher; onBusyChange (callback bool) блокирует навигацию до окончания записи. */
export function Cipher({ onBusyChange }: { onBusyChange: (busy: boolean) => void }) {
  const [mode, setMode] = useState<Operation>('encrypt');
  const [source, setSource] = useState<'generated' | 'custom'>('generated');
  const [phrase, setPhrase] = useState(generatePhrase);
  const [confirmation, setConfirmation] = useState('');
  const [visible, setVisible] = useState(false);
  const [saved, setSaved] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [outputName, setOutputName] = useState('');
  const [state, setState] = useState<State>('idle');
  const [message, setMessage] = useState('');
  const [copyMessage, setCopyMessage] = useState('');
  const [progress, setProgress] = useState<Progress>({ stage: 'preparing', processed: 0 });
  const [result, setResult] = useState<{ name: string; bytes: number; url?: string } | null>(null);
  const [offlineReady, setOfflineReady] = useState<boolean | null>(null);
  const [online, setOnline] = useState(navigator.onLine);
  const [dragging, setDragging] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const abort = useRef<AbortController | null>(null);
  const resultUrl = useRef<string | null>(null);
  const busy = state === 'running';
  const completed = state === 'success' || state === 'prepared';
  const mobile = isMobile();
  const strength = phrase ? assessPhrase(phrase) : null;

  useEffect(() => {
    void prepareOffline().then(setOfflineReady);
    const updateNetwork = () => setOnline(navigator.onLine);
    window.addEventListener('online', updateNetwork);
    window.addEventListener('offline', updateNetwork);
    return () => {
      abort.current?.abort();
      if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
      window.removeEventListener('online', updateNetwork);
      window.removeEventListener('offline', updateNetwork);
    };
  }, []);
  useEffect(() => { if (state === 'idle' || state === 'cancelled' || state === 'error') warmCryptoWorker(); }, [state]);
  useEffect(() => {
    onBusyChange(busy);
    if (!busy) return;
    const beforeUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [busy, onBusyChange]);

  /** Переключает next (Operation), очищая ссылки на секреты и файл; возвращает void. */
  function changeMode(next: Operation): void {
    if (busy) return;
    setMode(next); setState('idle'); setMessage(''); setFile(null); setOutputName('');
    setPhrase(next === 'encrypt' ? generatePhrase() : ''); setConfirmation(''); setSaved(false); setVisible(false); setResult(null);
    if (input.current) input.current.value = '';
    if (resultUrl.current) URL.revokeObjectURL(resultUrl.current);
  }

  /** Выбирает selected (File|undefined), валидирует возможности; возвращает void и отражает ошибку в UI. */
  function chooseFile(selected: File | undefined): void {
    if (!selected || busy) return;
    const problem = fileProblem(selected);
    setMessage(problem); setState(problem ? 'error' : 'idle');
    setFile(problem ? null : selected);
    setOutputName(mode === 'encrypt' ? `${selected.name}.age` : selected.name.replace(/\.age$/i, '') || 'restored-file');
    setResult(null);
  }

  /** Экспортирует фразу после явного подтверждения; возвращает void, загружая только локальный .txt. */
  function downloadPhrase(): void {
    if (!phrase || !window.confirm('Текстовый файл содержит секретную фразу В ОТКРЫТОМ ВИДЕ. Лучше сохранить её в менеджере паролей. Храните .txt отдельно от .age и передавайте другим каналом: совместная утечка раскроет файл. Скачать фразу?')) return;
    const blob = new Blob([`Gault ${config.version}\n\nСекретная фраза:\n${phrase}\n\nХраните отдельно от зашифрованного файла. Любой, кто получит фразу и .age, сможет открыть данные.\n`], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a'); anchor.href = url; anchor.download = 'secret-phrase.txt'; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /** Выполняет проверенную локальную операцию; возвращает Promise<void>, подтверждая успех только после close. */
  async function run(): Promise<void> {
    setMessage(''); setCopyMessage('');
    if (!file) { setMessage('Сначала выберите файл.'); return; }
    const problem = fileProblem(file);
    if (problem) { setMessage(problem); return; }
    if (!phrase) { setMessage('Введите непустую секретную фразу.'); return; }
    if (mode === 'encrypt' && source === 'custom' && phrase !== confirmation) { setMessage('Фразы не совпадают. Проверьте подтверждение.'); return; }
    if (mode === 'encrypt' && source === 'generated' && !saved) { setMessage('Сохраните секретную фразу и подтвердите это перед шифрованием.'); return; }
    if (!outputName.trim() || /[\/\\\x00-\x1f]/.test(outputName)) { setMessage('Укажите имя результата без пути и управляющих символов.'); return; }
    const controller = new AbortController(); abort.current = controller;
    let sink: OutputSink | undefined;
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const streaming = !!window.showSaveFilePicker;
    let chosenName = outputName;
    try {
      if (window.showSaveFilePicker) {
        const handle = await window.showSaveFilePicker({ suggestedName: outputName, ...(mode === 'encrypt' ? { types: [{ description: 'Зашифрованный файл age', accept: { 'application/octet-stream': ['.age'] } }] } : {}) });
        // Input File не содержит handle для сравнения isSameEntry: запрещаем одинаковое имя консервативно.
        if (handle.name.normalize('NFC').toLowerCase() === file.name.normalize('NFC').toLowerCase()) { setMessage('Выберите новое имя результата, отличное от исходного файла, чтобы избежать перезаписи.'); return; }
        const writable = await handle.createWritable();
        sink = writable;
        chosenName = handle.name; setOutputName(chosenName);
      } else {
        let buffered = 0;
        sink = {
          async write(chunk) { buffered += chunk.byteLength; if (buffered > config.fallbackLimitMB * 1_000_000 + 65_536) throw new Error('memory-limit'); chunks.push(chunk.slice()); },
          async close() { /* Лишь готовность результата в RAM: окончательная запись браузером не подтверждается. */ },
          async abort() { for (const chunk of chunks) chunk.fill(0); chunks.length = 0; },
        };
      }
      setState('running'); setProgress({ stage: 'preparing', processed: 0 });
      const operation = processFile(file, phrase, mode, sink, controller.signal, setProgress);
      setPhrase(''); setConfirmation(''); setVisible(false); setSaved(false);
      const bytes = await operation;
      if (streaming) {
        setResult({ name: chosenName, bytes }); setState('success');
      } else {
        const url = URL.createObjectURL(new Blob(chunks, { type: 'application/octet-stream' }));
        for (const chunk of chunks) chunk.fill(0);
        chunks.length = 0; resultUrl.current = url;
        setResult({ name: outputName, bytes, url }); setState('prepared');
      }
    } catch (error) {
      for (const chunk of chunks) chunk.fill(0);
      chunks.length = 0;
      if (sink) { try { await sink.abort(); } catch { /* Уже закрытый/отменённый stream не требует второго abort. */ } }
      if (error instanceof Error && error.name === 'AbortError') { setState('cancelled'); setMessage('Операция отменена. Незавершённая запись отменена там, где это поддерживает браузер.'); }
      else {
        setState('error');
        setMessage(error instanceof Error && error.name === 'QuotaExceededError' ? 'Недостаточно места на диске. Освободите место и повторите с исходным файлом.' : error instanceof Error && error.name === 'NotAllowedError' ? 'Нет разрешения на сохранение. Выберите доступную папку и повторите.' : error instanceof Error && errorMessages[error.message] || 'Не удалось завершить запись. Проверьте место на диске и разрешения браузера. Успешный результат не подтверждён.');
      }
    } finally { abort.current = null; }
  }

  const percent = state === 'success' ? 100 : file?.size ? Math.min(99, Math.round(progress.processed / file.size * 100)) : 0;
  return <div className="cipher-page">
    <div className="hero"><span className="eyebrow"><ShieldCheck size={15} aria-hidden="true" /> Локальное шифрование</span><h1>Защитите свои файлы</h1><p>Шифрование на вашем устройстве.<br className="mobile-break" /> Без загрузки на сервер.</p></div>
    <section className="card cipher-card" aria-label="Шифрование файлов">
      <div className="mode-tabs" role="tablist" aria-label="Действие с файлом" onKeyDown={(event) => { if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); const next = event.key === 'Home' ? 'encrypt' : event.key === 'End' ? 'decrypt' : mode === 'encrypt' ? 'decrypt' : 'encrypt'; changeMode(next); document.getElementById(`${next}-tab`)?.focus(); }}>
        <button role="tab" id="encrypt-tab" tabIndex={mode === 'encrypt' ? 0 : -1} aria-selected={mode === 'encrypt'} aria-controls="cipher-panel" disabled={busy} onClick={() => changeMode('encrypt')}><LockKeyhole size={17} aria-hidden="true" /> Зашифровать</button>
        <button role="tab" id="decrypt-tab" tabIndex={mode === 'decrypt' ? 0 : -1} aria-selected={mode === 'decrypt'} aria-controls="cipher-panel" disabled={busy} onClick={() => changeMode('decrypt')}><UnlockKeyhole size={17} aria-hidden="true" /> Расшифровать</button>
      </div>
      <div role="tabpanel" id="cipher-panel" aria-labelledby={mode === 'encrypt' ? 'encrypt-tab' : 'decrypt-tab'} className="cipher-panel">
        {mobile && <div className="notice warning"><Info size={18} aria-hidden="true" /><span>На смартфонах действует ограничение {config.mobileLimitMB} МБ на файл. Для больших архивов используйте компьютер.</span></div>}
        {!window.showSaveFilePicker && <div className="notice neutral"><Info size={18} aria-hidden="true" /><span>Ограниченный режим сохранения: до {config.fallbackLimitMB} МБ через память браузера. Для больших файлов — Chrome или Edge на компьютере.</span></div>}
        <fieldset disabled={busy || completed} className="borderless">
          <legend className="sr-only">Параметры файла и фразы</legend>
          <label className="field-label" htmlFor="file-input">01 <span>{mode === 'encrypt' ? 'Выберите файл' : 'Выберите зашифрованный файл'}</span></label>
          <input id="file-input" data-testid="file-input" className="sr-only" type="file" tabIndex={-1} ref={input} accept={mode === 'decrypt' ? '.age' : undefined} onChange={(event) => chooseFile(event.target.files?.[0])} />
          <button type="button" className={`dropzone ${dragging ? 'is-dragging' : ''} ${file ? 'has-file' : ''}`} onClick={() => input.current?.click()} onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={(event) => { event.preventDefault(); setDragging(false); if (event.dataTransfer.files.length !== 1) { setMessage('Выберите один файл за операцию.'); return; } chooseFile(event.dataTransfer.files[0]); }}>
            <span className="upload-icon">{file ? <FileCheck2 size={25} aria-hidden="true" /> : <Upload size={25} aria-hidden="true" />}</span>
            {file ? <><strong className="filename">{file.name}</strong><span>{formatBytes(file.size)} · Нажмите, чтобы заменить</span></> : <><strong>Перетащите файл сюда</strong><span>или <span className="link-text">выберите на устройстве</span></span><small>{mode === 'encrypt' ? 'Документы, фото, архивы — любой тип файла' : 'Стандартный парольный файл .age'}</small></>}
          </button>
          <div className="phrase-heading"><label className="field-label" htmlFor="passphrase">02 <span>Секретная фраза</span></label><KeyRound size={16} aria-hidden="true" /></div>
          {mode === 'encrypt' && <div className="source-switch" role="group" aria-label="Источник фразы"><button type="button" aria-pressed={source === 'generated'} onClick={() => { setSource('generated'); setPhrase(generatePhrase()); setConfirmation(''); setSaved(false); setVisible(false); }}>Сгенерировать фразу</button><button type="button" aria-pressed={source === 'custom'} onClick={() => { setSource('custom'); setPhrase(''); setConfirmation(''); setSaved(false); }}>Ввести свою</button></div>}
          <div className="password-field"><input id="passphrase" name="local-encryption-phrase" aria-label="Секретная фраза" autoComplete="off" autoCapitalize="off" spellCheck={false} maxLength={4096} type={visible ? 'text' : 'password'} value={phrase} onChange={(event) => { setPhrase(event.target.value); setSaved(false); }} readOnly={mode === 'encrypt' && source === 'generated'} placeholder="Введите секретную фразу" /><Button type="button" variant="ghost" size="icon" aria-label={visible ? 'Скрыть фразу' : 'Показать фразу'} onClick={() => setVisible(!visible)}>{visible ? <EyeOff size={17} /> : <Eye size={17} />}</Button></div>
          {mode === 'encrypt' && source === 'custom' && <div className="field"><label htmlFor="confirmation">Повторите фразу</label><input id="confirmation" name="local-encryption-confirmation" type={visible ? 'text' : 'password'} autoComplete="off" spellCheck={false} maxLength={4096} value={confirmation} onChange={(event) => setConfirmation(event.target.value)} /></div>}
          {mode === 'encrypt' && strength && <div className="strength" data-score={strength.score}><div className="strength-bars" aria-hidden="true">{[0, 1, 2, 3, 4].map((score) => <span key={score} data-active={score <= strength.score} />)}</div><p><strong>{strength.label}</strong><span>{strength.score} / 4</span></p><small>{source === 'generated' ? '8 случайных слов · 103,4 бита энтропии' : strength.advice} {source === 'custom' && strength.score < 3 ? 'Можно продолжить с этой фразой.' : ''}</small></div>}
          <div className="phrase-actions"><Button type="button" variant="ghost" disabled={!phrase} onClick={async () => { try { await navigator.clipboard.writeText(phrase); setCopyMessage('Скопировано. История буфера обмена может синхронизироваться с другими устройствами.'); } catch { setCopyMessage('Не удалось скопировать. Покажите фразу и сохраните вручную.'); } }}><Copy size={15} aria-hidden="true" /> Копировать</Button><Button type="button" variant="ghost" disabled={!phrase} onClick={downloadPhrase}><ArrowDownToLine size={15} aria-hidden="true" /> Скачать фразу (.txt)</Button>{mode === 'encrypt' && source === 'generated' && <Button type="button" variant="ghost" aria-label="Сгенерировать новую фразу" onClick={() => { setPhrase(generatePhrase()); setSaved(false); }}><RefreshCw size={15} aria-hidden="true" /></Button>}</div>
          {copyMessage && <p className="help" role="status">{copyMessage}</p>}
          {mode === 'encrypt' && <><p className="help phrase-warning">Сохраните фразу в менеджере паролей или другом надёжном месте отдельно от файла. При передаче используйте другой канал. Без фразы восстановить данные не получится.</p>{source === 'generated' && <label className="checkbox-row"><input type="checkbox" checked={saved} onChange={(event) => setSaved(event.target.checked)} /><span>Я сохранил фразу в надёжном месте</span></label>}</>}
          {file && <div className="field output-field"><label htmlFor="output-name">Имя результата</label><input id="output-name" value={outputName} maxLength={240} onChange={(event) => setOutputName(event.target.value)} /><small>{mode === 'decrypt' ? 'Предложенное имя можно изменить: формат age не хранит исходное имя.' : 'Будет создан новый зашифрованный файл.'}</small></div>}
        </fieldset>
        <LocalNotice />
        {message && <div className={`notice ${state === 'cancelled' ? 'neutral' : 'error'}`} role="alert"><Info size={18} aria-hidden="true" /><span>{message}</span></div>}
        {busy ? <div className="operation-progress" role="status" aria-live="polite"><div><strong>{progress.stage === 'preparing' ? mode === 'encrypt' ? 'Готовим файл…' : 'Проверяем заголовок файла…' : progress.stage === 'deriving' ? mode === 'encrypt' ? 'Выводим ключ шифрования…' : 'Выводим ключ и проверяем заголовок…' : progress.stage === 'finalizing' ? 'Завершаем запись на диск…' : mode === 'encrypt' ? 'Шифруем и записываем…' : 'Расшифровываем и записываем…'}</strong><span>{percent}%</span></div><progress max={100} value={percent} aria-label="Прогресс обработки" /><p>{formatBytes(progress.processed)} из {formatBytes(file?.size || 0)} · вкладку можно оставить открытой</p><Button variant="secondary" className="full-width" onClick={() => abort.current?.abort()}><X size={17} aria-hidden="true" /> Отменить</Button></div> : completed && result ? <div className="result" role="status"><CheckCircle2 size={28} aria-hidden="true" /><h2>{state === 'success' ? 'Файл записан' : 'Файл подготовлен к скачиванию'}</h2><p>{result.name} · {formatBytes(result.bytes)}</p><p>{state === 'success' ? 'Выходной поток успешно закрыт. Фраза удалена из формы. Проверьте пробную расшифровку, прежде чем удалять оригинал.' : 'Нажмите «Сохранить результат». Браузер не сообщает приложению, завершена ли запись скачивания на диск.'}</p>{result.url && <Button asChild className="full-width"><a download={result.name} href={result.url}><ArrowDownToLine size={17} aria-hidden="true" /> Сохранить результат</a></Button>}<Button variant="secondary" className="full-width" onClick={() => changeMode(mode)}>Обработать другой файл <ArrowRight size={16} aria-hidden="true" /></Button></div> : <Button className="full-width main-action" onClick={() => void run()} disabled={!file}><FileLock2 size={18} aria-hidden="true" />{mode === 'encrypt' ? 'Зашифровать файл' : 'Расшифровать файл'}<ArrowRight size={17} aria-hidden="true" /></Button>}
        <div className="card-footnote"><Check size={13} aria-hidden="true" /> Без регистрации <span>·</span> Открытый формат .age</div>
      </div>
    </section>
    <div className="offline-state" role="status">{!online ? <WifiOff size={15} aria-hidden="true" /> : offlineReady ? <CheckCircle2 size={15} aria-hidden="true" /> : <FileUp size={15} aria-hidden="true" />}<span>{!online ? offlineReady ? 'Вы офлайн. Локальное шифрование доступно' : 'Вы офлайн. Для повторного запуска кэш ещё не подтверждён' : offlineReady ? 'Готово к работе без интернета' : import.meta.env.DEV ? 'Локальная разработка · офлайн проверяется в production preview' : offlineReady === false ? 'Ресурсы для повторного офлайн-запуска загружены не полностью' : 'Подготавливаем ресурсы для работы без интернета…'}</span></div>
    <div className="assurance-grid"><div><ShieldCheck size={19} aria-hidden="true" /><h2>Ваши данные — у вас</h2><p>Ни файл, ни фраза не покидают устройство.</p></div><div><LockKeyhole size={19} aria-hidden="true" /><h2>Без привязки к сервису</h2><p>Файлы открываются в age и rage даже без сайта.</p></div><div><KeyRound size={19} aria-hidden="true" /><h2>Доступ только у вас</h2><p>Сохраните фразу. Мы не сможем её восстановить.</p></div></div>
  </div>;
}
