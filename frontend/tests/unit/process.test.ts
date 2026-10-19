/** Проверяет владение буферами, backpressure и поздний write после отмены без дорогого KDF. */
import { afterEach, expect, it, vi } from 'vitest';

class ControlledWorker {
  static instance: ControlledWorker;
  onmessage?: (event: MessageEvent) => Promise<void>;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  /** Сохраняет тестовый Worker; реальные файлы/криптография в mock не передаются. */
  constructor() { ControlledWorker.instance = this; }
}
afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

it.each([false, true])('обнуляет блок только после завершения write; ошибка=%s', async (fail) => {
  vi.stubGlobal('Worker', ControlledWorker);
  const { processFile } = await import('../../src/crypto/process');
  let release!: () => void;
  const write = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }).then(() => { if (fail) throw new Error('disk'); }));
  const sink = { write, close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  const result = processFile(new File(['abc'], 'public.bin'), 'public-test-only', 'encrypt', sink, new AbortController().signal, () => {});
  const completed = result.then((bytes) => bytes, (error: Error) => error.message);
  const worker = ControlledWorker.instance;
  const chunk = new Uint8Array([1, 2, 3]);
  const pending = worker.onmessage!({ data: { type: 'chunk', chunk } } as MessageEvent);
  expect([...chunk]).toEqual([1, 2, 3]); expect(sink.close).not.toHaveBeenCalled();
  release(); await pending;
  expect([...chunk]).toEqual([0, 0, 0]);
  if (fail) {
    expect(await completed).toBe('disk'); expect(sink.abort).toHaveBeenCalledOnce(); expect(sink.close).not.toHaveBeenCalled();
  } else {
    expect(worker.postMessage).toHaveBeenLastCalledWith({ type: 'ack' });
    await worker.onmessage!({ data: { type: 'done' } } as MessageEvent);
    expect(await completed).toBe(3); expect(sink.close).toHaveBeenCalledOnce();
  }
  expect(worker.terminate).toHaveBeenCalledOnce();
});

it('поздний write после отмены очищает блок без ack и без успешного close', async () => {
  vi.stubGlobal('Worker', ControlledWorker);
  const { processFile } = await import('../../src/crypto/process');
  let release!: () => void;
  const sink = { write: vi.fn(() => new Promise<void>((done) => { release = done; })), close: vi.fn(async () => {}), abort: vi.fn(async () => {}) };
  const controller = new AbortController();
  const result = processFile(new File(['abc'], 'public.bin'), 'public-test-only', 'decrypt', sink, controller.signal, () => {}).catch((error: Error) => error.name);
  const worker = ControlledWorker.instance;
  const chunk = new Uint8Array([1, 2, 3]);
  const pending = worker.onmessage!({ data: { type: 'chunk', chunk } } as MessageEvent);
  controller.abort(); expect(await result).toBe('AbortError');
  expect([...chunk]).toEqual([1, 2, 3]);
  release(); await pending;
  expect([...chunk]).toEqual([0, 0, 0]); expect(sink.close).not.toHaveBeenCalled();
  expect(worker.postMessage).not.toHaveBeenCalledWith({ type: 'ack' });
});
