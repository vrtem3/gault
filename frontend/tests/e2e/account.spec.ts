/** Полный пользовательский цикл кабинета с реальным SMTP в локальном Mailpit. */
import { expect, test, type APIRequestContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Ищет тестовое письмо email/action (str) через request; возвращает Promise<str> одноразовой ссылки без вывода секрета. */
async function emailLink(request: APIRequestContext, email: string, action: string): Promise<string> {
  let found = '';
  await expect.poll(async () => {
    const response = await request.get('http://127.0.0.1:8025/api/v1/messages');
    const inbox = await response.json();
    for (const summary of inbox.messages) {
      if (!summary.To.some((to: { Address: string }) => to.Address === email)) continue;
      const message = await (await request.get(`http://127.0.0.1:8025/api/v1/message/${summary.ID}`)).json();
      const match = (message.Text as string).match(new RegExp(`http://localhost:5174/#${action}=[A-Za-z0-9_-]+`));
      if (match) { found = match[0]; return true; }
    }
    return false;
  }).toBe(true);
  return found;
}

test('регистрация → email → вход → профиль → хранилища → сброс → выход', async ({ page, request }, testInfo) => {
  const email = `e2e-${Date.now()}@example.com`;
  const password = 'independent-orbit-cobalt-sunset-lantern';
  const nextPassword = 'another-river-maple-rainbow-coffee';
  await page.goto('http://localhost:5174');
  await page.getByRole('button', { name: 'Создать аккаунт', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль аккаунта', { exact: true }).fill(password);
  await page.getByLabel('Повторите пароль', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Зарегистрироваться', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('придёт письмо');
  await page.goto(await emailLink(request, email, 'verify-email'));
  await expect(page).not.toHaveURL(/verify-email=/);
  await page.getByRole('button', { name: 'Подтвердить email', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Email подтверждён');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль аккаунта', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Добро пожаловать', exact: true })).toBeVisible();
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toMatch(/session|csrf|password/i);
  await page.getByLabel('Как к вам обращаться').fill('Тест Gault');
  await page.getByRole('button', { name: 'Сохранить профиль', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Добро пожаловать, Тест Gault' })).toBeVisible();
  await page.getByRole('button', { name: 'Мои хранилища', exact: true }).click();
  await expect(page.getByText('Подключений пока нет.', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /подключить/i })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('account-storage.png'), fullPage: true });
  await page.getByRole('button', { name: 'Безопасность', exact: true }).click();
  await expect(page.getByText('Эта сессия', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Выход', exact: true }).click();
  await page.getByRole('button', { name: 'Забыли пароль?', exact: true }).click();
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByRole('button', { name: 'Отправить ссылку', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('придёт письмо');
  await page.goto(await emailLink(request, email, 'reset-password'));
  await expect(page).not.toHaveURL(/reset-password=/);
  await page.getByLabel('Новый пароль', { exact: true }).fill(nextPassword);
  await page.getByLabel('Повторите пароль', { exact: true }).fill(nextPassword);
  await page.getByRole('button', { name: 'Сохранить новый пароль', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Пароль обновлён');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Пароль аккаунта', { exact: true }).fill(nextPassword);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Добро пожаловать, Тест Gault' })).toBeVisible();
  expect((await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa']).analyze()).violations).toEqual([]);
  await page.getByRole('button', { name: 'Выход', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'С возвращением' })).toBeVisible();
});

test('инструкция и настройки статистики доступны без аккаунта', async ({ page }) => {
  await page.goto('/#instructions');
  await expect(page.getByRole('link', { name: 'Скачать age', exact: false })).toHaveAttribute('href', 'https://github.com/FiloSottile/age/releases');
  await expect(page.getByRole('link', { name: 'Скачать rage', exact: false })).toHaveAttribute('href', 'https://github.com/str4d/rage/releases');
  await expect(page.getByText('age -d -o restored.zip archive.zip.age', { exact: true })).toBeVisible();
  await page.goto('/#privacy');
  await expect(page.getByRole('checkbox', { name: 'Отправлять анонимную статистику использования', exact: false })).not.toBeChecked();
  await page.getByRole('checkbox', { name: 'Отправлять анонимную статистику использования', exact: false }).check();
  await page.reload();
  await expect(page.getByRole('checkbox', { name: 'Отправлять анонимную статистику использования', exact: false })).toBeChecked();
});

test('добровольное событие отправляется только после close и без файловых данных', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('gault-usage-consent', 'yes');
    window.showSaveFilePicker = async (options) => (await navigator.storage.getDirectory()).getFileHandle(options!.suggestedName!, { create: true });
  });
  const during: string[] = [];
  let success = false;
  page.on('request', (request) => { if (!success && request.url().includes('/api/')) during.push(request.url()); });
  await page.goto('/');
  await expect(page.getByText('Готово к работе без интернета', { exact: true })).toBeVisible();
  await page.waitForLoadState('networkidle');
  await page.getByRole('button', { name: 'Ввести свою', exact: true }).click();
  await page.getByTestId('file-input').setInputFiles({ name: 'never-send-this-name.txt', mimeType: 'text/plain', buffer: Buffer.from('never-send-this-content') });
  await page.getByLabel('Секретная фраза', { exact: true }).fill('never-send-this-phrase');
  await page.getByLabel('Повторите фразу', { exact: true }).fill('never-send-this-phrase');
  // Отметка реального закрытия writer ставится до любых post-operation запросов.
  await page.exposeFunction('testClosed', () => { success = true; });
  await page.evaluate(() => {
    const picker = window.showSaveFilePicker!;
    window.showSaveFilePicker = async (options) => {
      const handle = await picker(options); const create = handle.createWritable.bind(handle);
      return { name: handle.name, createWritable: async () => { const stream = await create(); const close = stream.close.bind(stream); stream.close = async () => { await close(); await (window as unknown as { testClosed(): Promise<void> }).testClosed(); }; return stream; } } as FileSystemFileHandle;
    };
  });
  const event = page.waitForResponse((response) => response.url().endsWith('/api/v1/usage/events'));
  await page.getByRole('button', { name: 'Зашифровать файл', exact: true }).click();
  const response = await event;
  expect(response.status()).toBe(202); expect(during).toEqual([]);
  const body = response.request().postDataJSON();
  expect(Object.keys(body).sort()).toEqual(['event_id', 'guest_or_auth', 'operation_type', 'week_key']);
  expect(JSON.stringify(body)).not.toContain('never-send'); expect(body.operation_type).toBe('encrypt');
});
