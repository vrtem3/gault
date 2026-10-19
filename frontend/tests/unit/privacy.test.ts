/** Неделя с учётом часовой зоны и отсутствие сетевых попыток без согласия. */
import { afterEach, expect, it, vi } from 'vitest';
import { reportCompletedOperation, weekKey } from '../../src/features/privacy/telemetry';
import { fileProblem, isMobile } from '../../src/platform/capabilities';

afterEach(() => vi.unstubAllGlobals());
it('учитывает локальную границу понедельника и ISO-год', () => {
  expect(weekKey(new Date('2026-10-18T18:59:59Z'))).toBe('2026-W42');
  expect(weekKey(new Date('2026-10-18T19:00:00Z'))).toBe('2026-W43');
  expect(weekKey(new Date('2027-01-01T00:00:00Z'))).toBe('2026-W53');
});
it('без согласия не обращается к сети или DOM', () => {
  vi.stubGlobal('localStorage', { getItem: () => null });
  vi.stubGlobal('navigator', { onLine: true });
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
  reportCompletedOperation('encrypt'); expect(fetch).not.toHaveBeenCalled();
});
it('не отправляет согласованные офлайн-события', () => {
  vi.stubGlobal('localStorage', { getItem: () => 'yes' });
  vi.stubGlobal('navigator', { onLine: false });
  const createElement = vi.fn(); vi.stubGlobal('document', { createElement });
  reportCompletedOperation('decrypt'); expect(createElement).not.toHaveBeenCalled();
});
it('распознаёт смартфоны и планшеты без привязки к размеру окна', () => {
  expect(isMobile({ userAgent: 'iPhone', maxTouchPoints: 5 })).toBe(true);
  expect(isMobile({ userAgent: 'Macintosh', maxTouchPoints: 5 })).toBe(true);
  expect(isMobile({ userAgent: 'Macintosh', maxTouchPoints: 0 })).toBe(false);
});
it('блокирует файл свыше 100 МБ на мобильном до обработки', () => {
  vi.stubGlobal('window', { isSecureContext: true, showSaveFilePicker: vi.fn() });
  vi.stubGlobal('navigator', { userAgent: 'Android', maxTouchPoints: 5 });
  vi.stubGlobal('Worker', class {});
  expect(fileProblem(new File([], 'test') as File & { size: number })).toBe('');
  expect(fileProblem({ size: 100_000_001 } as File)).toContain('100 МБ');
});
