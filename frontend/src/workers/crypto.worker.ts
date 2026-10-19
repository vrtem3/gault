/** Криптография в изолированном Worker, максимум один неподтверждённый выходной блок. */
import { InputError, transformAge, type Operation } from '../crypto/age';

let acknowledge: (() => void) | undefined;

/** Принимает start/ack через MessageEvent; возвращает Promise<void>, результат передаёт только сообщениями. */
self.onmessage = async (event: MessageEvent) => {
  if (event.data?.type === 'ack') { acknowledge?.(); acknowledge = undefined; return; }
  if (event.data?.type !== 'start') return;
  const { file, mode } = event.data as { file: File; mode: Operation };
  let phrase: string = event.data.phrase;
  event.data.phrase = '';
  try {
    self.postMessage({ type: 'stage', stage: 'preparing', processed: 0 });
    let processed = 0;
    let lastUpdate = 0;
    let derived = false;
    const input = file.stream().pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        processed += chunk.byteLength;
        if (derived && (performance.now() - lastUpdate > 100 || processed === file.size)) {
          self.postMessage({ type: 'stage', stage: 'processing', processed });
          lastUpdate = performance.now();
        }
        controller.enqueue(chunk);
      },
    }));
    const output = await transformAge(input, phrase, mode, () => self.postMessage({ type: 'stage', stage: 'deriving', processed: 0 }));
    phrase = '';
    derived = true;
    self.postMessage({ type: 'stage', stage: 'processing', processed });
    const reader = output.getReader();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const chunk = value.slice();
      // В Typage 0.3.1 выходные блоки не используются повторно. Не передаём соседние байты backing buffer.
      value.fill(0);
      await new Promise<void>((resolve) => {
        acknowledge = resolve;
        self.postMessage({ type: 'chunk', chunk }, { transfer: [chunk.buffer] });
      });
    }
    reader.releaseLock();
    self.postMessage({ type: 'done' });
  } catch (error) {
    phrase = '';
    self.postMessage({ type: 'error', code: error instanceof InputError ? error.code : mode === 'decrypt' ? 'decrypt' : 'encrypt' });
  }
};
