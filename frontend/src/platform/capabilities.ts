/** Проверенные возможности устройства и явные ограничения ограниченного RAM-fallback. */
import { config } from '../app/config';

/** Анализирует environment Navigator (по умолчанию navigator); возвращает bool признака смартфона/планшета. */
export function isMobile(environment: Pick<Navigator, 'userAgent' | 'maxTouchPoints'> = navigator): boolean {
  return /Android|iPhone|iPad|iPod/i.test(environment.userAgent) || (/Macintosh/i.test(environment.userAgent) && environment.maxTouchPoints > 1);
}

/** Проверяет file File перед обработкой; возвращает русскую причину блокировки или пустую строку. */
export function fileProblem(file: File): string {
  if (!window.isSecureContext || !globalThis.crypto?.getRandomValues || typeof Worker === 'undefined' || typeof ReadableStream === 'undefined' || !File.prototype.stream) return 'Для обработки нужен современный браузер и защищённое соединение HTTPS (или localhost).';
  if (isMobile() && file.size > config.mobileLimitMB * 1_000_000) return `На смартфонах можно обработать файл до ${config.mobileLimitMB} МБ. Для больших файлов используйте компьютер.`;
  if (!window.showSaveFilePicker && file.size > config.fallbackLimitMB * 1_000_000) return `Этот браузер сохраняет небольшие файлы через память (до ${config.fallbackLimitMB} МБ). Для больших файлов откройте Gault в Chrome или Edge на компьютере.`;
  return '';
}

/** Форматирует bytes (number); возвращает короткую русскую строку размера. */
export function formatBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} Б`;
  const exponent = Math.min(4, Math.floor(Math.log(bytes) / Math.log(1000)));
  return `${(bytes / 1000 ** exponent).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'][exponent]}`;
}
