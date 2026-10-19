/** Изолированная сборка шифратора: строгая CSP, локальные ресурсы и проверяемый PWA-кэш. */
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join, relative, sep } from 'node:path';
import packageInfo from './package.json' with { type: 'json' };

const { version } = packageInfo;

/** Хэширует только build-входы и публичные параметры; возвращает SHA-256 без путей ПК, env-секретов и времени. */
function buildIdentity(publicConfig: object): string {
  const hash = createHash('sha256').update(JSON.stringify({ publicConfig, node: process.versions.node }));
  const paths = ['index.html', 'package.json', 'package-lock.json', 'tsconfig.json', 'vite.config.ts', 'release-profile.json', 'scripts/licenses.mjs'];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile()) paths.push(path);
      else throw new Error('Недопустимый build-вход: символическая ссылка');
    }
  };
  visit('src'); visit('public'); visit('account/src'); // Общая таблица стилей использует классы обеих сохранённых форм.
  const normalized = paths.map((path) => relative('.', path).split(sep).join('/')).sort();
  for (const path of normalized) hash.update(path).update('\0').update(readFileSync(path)).update('\0');
  return hash.digest('hex');
}

/** Возвращает Plugin для кэша всех ресурсов cipher-сборки; секретов и API в нём нет. */
function offlinePlugin(buildId: string): Plugin {
  return {
    name: 'gault-offline',
    generateBundle(_options, bundle) {
      const paths = ['/', '/index.html', '/build-info.json', '/favicon.svg', '/manifest.webmanifest', '/third-party-licenses.txt', ...Object.keys(bundle).filter((name) => !name.endsWith('.map')).map((name) => `/${name}`)];
      // Учитываем также public-файлы, чьи имена не содержат content hash.
      const id = buildId.slice(0, 24);
      this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ version, buildId, node: process.versions.node, kind: 'source-config-runtime-sha256' }) + '\n' });
      this.emitFile({ type: 'asset', fileName: 'sw.js', source: `
const CACHE = 'gault-${id}';
const BUILD_ID = ${JSON.stringify(buildId)};
const PATHS = ${JSON.stringify([...new Set(paths)])};
self.addEventListener('install', event => event.waitUntil((async () => {
  const existed = await caches.has(CACHE);
  try { await (await caches.open(CACHE)).addAll(PATHS); }
  catch (error) { if (!existed) await caches.delete(CACHE); throw error; }
})()));
self.addEventListener('activate', event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith('gault-') && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener('message', event => {
  if (event.data?.type !== 'CHECK_CACHE' || !event.ports[0]) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const present = await Promise.all(PATHS.map(path => cache.match(path)));
    event.ports[0].postMessage({ready: present.every(Boolean), buildId: BUILD_ID});
  })());
});
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    // Только публичные статические ресурсы: Vary: Origin dev-сервера не должен ломать precache.
    const hit = await cache.match(event.request, {ignoreSearch: false, ignoreVary: true});
    if (hit) return hit;
    if (event.request.mode === 'navigate') return (await cache.match('/index.html')) || Response.error();
    return fetch(event.request);
  })());
});` });
    },
  };
}

/** Получает mode и command Vite; возвращает конфигурацию публичного автономного приложения. */
export default defineConfig(({ mode, command }) => {
  const env = loadEnv(mode, resolve('..'), 'PUBLIC_');
  const accountOrigin = env.PUBLIC_ACCOUNT_ORIGIN || 'http://localhost:5174';
  const mobileLimitMB = Number(env.PUBLIC_MOBILE_LIMIT_MB || 100);
  const fallbackLimitMB = Number(env.PUBLIC_FALLBACK_LIMIT_MB || 100);
  for (const limit of [mobileLimitMB, fallbackLimitMB]) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('В MVP лимиты RAM/mobile должны быть целыми от 1 до 100 МБ; повышение требует испытаний.');
  }
  const production = command === 'build' || process.argv.includes('preview');
  const publicConfig = {
    cipherOrigin: env.PUBLIC_CIPHER_ORIGIN || 'http://localhost:5173', accountOrigin,
    githubUrl: env.PUBLIC_GITHUB_URL || '', mobileLimitMB,
    fallbackLimitMB, reportTimezone: env.PUBLIC_REPORT_TIMEZONE || 'Asia/Yekaterinburg',
  };
  const buildId = buildIdentity(publicConfig);
  const policy = `default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; font-src 'self'; connect-src ${production ? "'none'" : "'self' ws://localhost:5173 ws://127.0.0.1:5173"}; worker-src 'self'; manifest-src 'self'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  return {
    plugins: [react(), tailwindcss(), offlinePlugin(buildId), {
      name: 'gault-preview-security',
      configurePreviewServer(server) {
        server.middlewares.use((request, response, next) => {
          // Кэш заполняет только service worker; документ по-прежнему не имеет connect-src.
          response.setHeader('Content-Security-Policy', request.url?.split('?')[0] === '/sw.js' ? "default-src 'none'; script-src 'self'; connect-src 'self'; object-src 'none'" : policy);
          next();
        });
      },
    }],
    define: { __PUBLIC_CONFIG__: JSON.stringify({ ...publicConfig, buildId }) },
    build: { target: 'es2023', outDir: 'dist', sourcemap: false, rollupOptions: { input: resolve('index.html') } },
    server: { port: 5173, strictPort: true, headers: { 'Referrer-Policy': 'no-referrer' } },
    preview: { port: 4173, strictPort: true, headers: { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } },
  };
});
