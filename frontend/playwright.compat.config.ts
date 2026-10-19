/** Нативные криптотесты Windows/macOS: один локальный origin, без backend, почты и рабочих аккаунтов. */
import { defineConfig } from '@playwright/test';
import base from './playwright.config';

export default defineConfig({
  ...base,
  testIgnore: ['**/account.spec.ts'],
  outputDir: './test-results/native-compatibility',
  webServer: {
    command: `${process.platform === 'win32' ? 'python' : 'python3'} ../scripts/run-local.py --cipher-only`,
    url: 'http://127.0.0.1:5173', timeout: 120000, reuseExistingServer: !process.env.CI,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
  },
});
