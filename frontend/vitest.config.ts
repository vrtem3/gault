/** Последовательные криптотесты: ограничивает конкурентный расход памяти scrypt. */
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { include: ['tests/unit/**/*.test.ts'], fileParallelism: false, maxWorkers: 1, testTimeout: 30000, hookTimeout: 30000 }, define: { __PUBLIC_CONFIG__: JSON.stringify({ cipherOrigin: 'http://localhost:5173', accountOrigin: 'http://localhost:5174', githubUrl: '', mobileLimitMB: 100, fallbackLimitMB: 100, reportTimezone: 'Asia/Yekaterinburg' }) } });
