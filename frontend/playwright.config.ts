/** Проверки реального Chromium на самостоятельном шифраторе без API и почты. */
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e', timeout: 90000, fullyParallel: false, workers: 1,
  testIgnore: ['**/account.spec.ts'],
  expect: { timeout: 15000 }, use: { baseURL: 'http://localhost:5173', trace: 'retain-on-failure', screenshot: 'only-on-failure', browserName: 'chromium' },
  reporter: [['list'], ['html', { open: 'never' }]],
  webServer: { command: `${process.platform === 'win32' ? 'python' : 'python3'} ../scripts/run-local.py --cipher-only`, url: 'http://127.0.0.1:5173', timeout: 120000, reuseExistingServer: !process.env.CI, gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 } },
});
