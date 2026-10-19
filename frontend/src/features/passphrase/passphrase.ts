/** Локальный генератор EFF: 8 независимых слов, равномерный выбор, 103,4 бита энтропии. */
import rawWords from './eff-words.txt?raw';
import { ZxcvbnFactory } from '@zxcvbn-ts/core';
import * as common from '@zxcvbn-ts/language-common';
import * as english from '@zxcvbn-ts/language-en';
import * as russian from '@zxcvbn-ts/language-ru';

export const words = rawWords.trim().split('\n');
export const WORD_COUNT = 8;
export const ENTROPY_BITS = WORD_COUNT * Math.log2(words.length);
const estimator = new ZxcvbnFactory({ translations: russian.translations, graphs: common.adjacencyGraphs, dictionary: { ...common.dictionary, ...english.dictionary, ...russian.dictionary }, maxLength: 256 });

/** Генерирует фразу без аргументов через crypto.getRandomValues; возвращает str из восьми слов EFF. */
export function generatePhrase(): string {
  const selected: string[] = [];
  const limit = Math.floor(2 ** 32 / words.length) * words.length;
  const random = new Uint32Array(1);
  while (selected.length < WORD_COUNT) {
    crypto.getRandomValues(random);
    if (random[0] < limit) selected.push(words[random[0] % words.length]);
  }
  random.fill(0);
  return selected.join(' ');
}

/** Оценивает phrase (str) локально; возвращает оценку 0–4 и одну русскую рекомендацию. */
export function assessPhrase(phrase: string): { score: number; label: string; advice: string } {
  const result = estimator.check(phrase.slice(0, 256));
  return { score: result.score, label: ['Очень слабая', 'Слабая', 'Средняя', 'Хорошая', 'Очень высокая'][result.score], advice: result.feedback.suggestions[0] || result.feedback.warning || 'Храните фразу в надёжном месте отдельно от файла.' };
}
