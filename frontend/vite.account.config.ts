/** Отдельная сборка кабинета и узкого приёмника добровольной телеметрии. */
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

/** Читает mode Vite; возвращает настройки account-origin с локальным API-прокси. */
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve('..'), 'PUBLIC_');
  return {
    root: 'account', publicDir: '../public', plugins: [react(), tailwindcss()],
    define: { __PUBLIC_CONFIG__: JSON.stringify({ cipherOrigin: env.PUBLIC_CIPHER_ORIGIN || 'http://localhost:5173', accountOrigin: env.PUBLIC_ACCOUNT_ORIGIN || 'http://localhost:5174', githubUrl: env.PUBLIC_GITHUB_URL || '', mobileLimitMB: 100, fallbackLimitMB: 100, reportTimezone: env.PUBLIC_REPORT_TIMEZONE || 'Asia/Yekaterinburg' }) },
    build: { target: 'es2023', outDir: '../dist-account', emptyOutDir: true, rollupOptions: { input: { index: resolve('account/index.html'), telemetry: resolve('account/_telemetry.html') } } },
    server: { port: 5174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8000' }, fs: { allow: [resolve('.')] }, headers: { 'Referrer-Policy': 'no-referrer' } },
    preview: { port: 4174, strictPort: true, proxy: { '/api': 'http://127.0.0.1:8000' }, headers: { 'Referrer-Policy': 'no-referrer' } },
  };
});
