/** Энтропия, словарь и рекомендательный индикатор стойкости. */
import { describe, expect, it, vi } from 'vitest';
import { assessPhrase, ENTROPY_BITS, generatePhrase, words } from '../../src/features/passphrase/passphrase';

describe('парольная фраза', () => {
  it('использует 7776 уникальных слов и не менее 100 бит', () => { expect(words).toHaveLength(7776); expect(new Set(words).size).toBe(7776); expect(ENTROPY_BITS).toBeGreaterThanOrEqual(100); });
  it('обходится без Math.random и возвращает 8 слов', () => {
    const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('forbidden'); });
    try { const phrase = generatePhrase().split(' '); expect(phrase).toHaveLength(8); expect(phrase.every((word) => words.includes(word))).toBe(true); } finally { random.mockRestore(); }
  });
  it.each(['password123', 'Qwerty123!', 'aaaaaaaaaaa'])('отмечает %s как слабую, не блокируя', (phrase) => { expect(assessPhrase(phrase).score).toBeLessThan(3); });
  it.each(['русские слова и пробелы', '🔐 Unicode фраза', '  мой пароль  '])('принимает Unicode и пробелы: %s', (phrase) => { expect(assessPhrase(phrase).score).toBeGreaterThanOrEqual(0); });
});
