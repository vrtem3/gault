/** Связывает Worker с диском: backpressure, завершение записи и аварийный откат. */
import type { Operation } from './age';

export interface OutputSink {
  /** Поглощает chunk до resolve; sink, сохраняющий ссылку, обязан скопировать байты. */
  write(chunk: Uint8Array<ArrayBuffer>): Promise<unknown>;
  close(): Promise<unknown>;
  abort(reason?: unknown): Promise<unknown>;
}
export interface Progress { stage: 'preparing' | 'deriving' | 'processing' | 'finalizing'; processed: number }

let preparedWorker: Worker | null = null;

/** До выбора файла загружает только локальный код Worker; возвращает void без доступа к данным пользователя. */
export function warmCryptoWorker(): void {
  if (!preparedWorker) preparedWorker = new Worker(new URL('../workers/crypto.worker.ts', import.meta.url), { type: 'module' });
}

/** Обрабатывает file/phrase/mode в Worker, пишет sink с signal и onProgress; возвращает число записанных байтов после close. */
export function processFile(file: File, phrase: string, mode: Operation, sink: OutputSink, signal: AbortSignal, onProgress: (progress: Progress) => void): Promise<number> {
  return new Promise((resolve, reject) => {
    warmCryptoWorker();
    const worker = preparedWorker!;
    preparedWorker = null;
    let settled = false;
    let written = 0;
    const stop = async (error: Error) => {
      if (settled) return;
      settled = true;
      worker.terminate();
      signal.removeEventListener('abort', cancelled);
      try { await sink.abort(); } catch { /* Откат зависит от браузера; успех не сообщается. */ }
      reject(error);
    };
    const cancelled = () => { void stop(new DOMException('cancelled', 'AbortError')); };
    signal.addEventListener('abort', cancelled, { once: true });
    if (signal.aborted) { cancelled(); return; }
    worker.onerror = () => { void stop(new Error('worker')); };
    worker.onmessage = async (event: MessageEvent) => {
      if (settled) return;
      const message = event.data;
      try {
        if (message.type === 'stage') onProgress({ stage: message.stage, processed: message.processed });
        if (message.type === 'chunk') {
          try {
            await sink.write(message.chunk);
            written += message.chunk.byteLength;
          } finally { message.chunk.fill(0); }
          if (!settled) worker.postMessage({ type: 'ack' });
        }
        if (message.type === 'error') await stop(new Error(message.code));
        if (message.type === 'done') {
          onProgress({ stage: 'finalizing', processed: file.size });
          await sink.close();
          if (settled) return;
          settled = true;
          worker.terminate();
          signal.removeEventListener('abort', cancelled);
          resolve(written);
        }
      } catch (error) { await stop(error instanceof Error ? error : new Error('write')); }
    };
    worker.postMessage({ type: 'start', file, phrase, mode });
    phrase = '';
  });
}
