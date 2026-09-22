/**
 * Browser regression against the real production bundle (npm run preview).
 * Auth/data API responses are fixtures: no production login or DB writes.
 * Optional setup: npm i --no-save --package-lock=false playwright
 *                npx playwright install chromium
 * Run: node scripts/browser-admin-routing.mjs
 * PREVIEW_URL defaults to http://127.0.0.1:4173.
 * PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH can point to an existing Chromium.
 */
import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const base = process.env.PREVIEW_URL || 'http://127.0.0.1:4173';
const titleId = 'a7ee5463-f88e-4905-9d73-15236cae98df';
const chapterId = '648740d8-4b13-42b5-a2b2-ff91b155f77f';
const listPath = `/admin/titles/${titleId}/chapters`;
const editorPath = `${listPath}/${chapterId}`;
const title = {
  id: titleId, slug: 'routing-test', title: 'Тест маршрутов', author: 'Test',
  description: 'Тестовые данные браузерной проверки', type: 'manga',
  cover_url: '/media/placeholder-cover.svg', status: 'ongoing', published: false,
  created_at: '2026-01-01T00:00:00Z', title_genres: [],
};
const chapter = {
  id: chapterId, title_id: titleId, number: 1, name: 'Тестовая глава',
  description: null, published: false, created_at: '2026-01-01T00:00:00Z',
};
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || undefined,
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const unexpectedRequests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`);
  });
  await context.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin === new URL(base).origin) {
      // Vercel injects analytics at deployment; vite preview has no such endpoint.
      if (url.pathname === '/_vercel/insights/script.js') {
        return route.fulfill({ status: 200, contentType: 'application/javascript', body: '' });
      }
      return route.continue();
    }
    const headers = { 'access-control-allow-origin': '*', 'content-type': 'application/json' };
    if (request.method() === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: {
        ...headers, 'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': request.headers()['access-control-request-headers'] || '*',
      } });
    }
    if (/\.supabase\.(co|in)$/.test(url.hostname)) {
      let data;
      if (url.pathname === '/rest/v1/rpc/latest_login_challenge_status') data = 'approved';
      else if (url.pathname === '/rest/v1/rpc/has_role') data = true;
      else if (url.pathname === '/rest/v1/titles') data = [title];
      else if (url.pathname === '/rest/v1/chapters') data = [chapter];
      else if (['/rest/v1/pages', '/rest/v1/chapter_voiceovers', '/rest/v1/admin_requests'].includes(url.pathname)) data = [];
      else unexpectedRequests.push(`${request.method()} ${url.pathname}`);
      if (Array.isArray(data) && request.headers().accept?.includes('vnd.pgrst.object')) data = data[0] ?? null;
      return route.fulfill({ status: data === undefined ? 500 : 200, headers, body: JSON.stringify(data ?? null) });
    }
    unexpectedRequests.push(`${request.method()} ${url.origin}${url.pathname}`);
    return route.fulfill({ status: 200, headers, body: '{}' });
  });
  await context.addInitScript(() => {
    // Fixture session only in this isolated browser, not in app code.
    localStorage.setItem('manga_admin_session', JSON.stringify({ user: {
      id: 'browser-routing-test', email: 'test@example.invalid', user_metadata: { role: 'owner' },
    } }));
    localStorage.setItem('manga_login_challenge', JSON.stringify({ status: 'approved' }));
  });
  const heading = (text) => page.getByRole('heading', { name: text });
  async function assertEditor() {
    await heading('Редактирование главы 1').waitFor();
    await heading('Загрузка страниц').waitFor();
    assert.equal(await page.locator('input[type="file"]').count(), 1);
    assert.equal(await heading(/Главы тайтла/).count(), 0, 'Editor must replace, not nest under the list');
    assert.equal(new URL(page.url()).pathname, editorPath);
  }

  const response = await page.goto(`${base}${listPath}`);
  assert.equal(response.status(), 200);
  await heading(/Главы тайтла/).waitFor();
  await page.getByRole('link', { name: 'Страницы и загрузка' }).click();
  await assertEditor();
  console.log('PASS  production deep link → click «Страницы и загрузка» → uploader visible');

  await page.reload();
  await assertEditor();
  console.log('PASS  reload chapter editor at its deep URL');

  await page.locator(`a[href="${listPath}"]`).click();
  await heading(/Главы тайтла/).waitFor();
  await page.getByRole('link', { name: 'Импорт глав', exact: true }).click();
  await heading(/Импорт глав/).waitFor();
  assert.equal(await heading(/Главы тайтла/).count(), 0);
  console.log('PASS  back to list → import replaces list');

  await page.goto(`${base}${editorPath}/pages`);
  await assertEditor();
  console.log('PASS  legacy /pages URL redirects to editor');

  // Separate context must remain locked out without a session.
  const guest = await browser.newContext();
  const guestPage = await guest.newPage();
  await guestPage.goto(`${base}${listPath}`);
  await guestPage.waitForURL('**/admin/login');
  await guest.close();
  console.log('PASS  unauthenticated deep link still redirects to login');

  assert.deepEqual(unexpectedRequests, [], 'All external API calls must use known fixtures');
  assert.deepEqual(errors, [], 'Browser console must have no JS/router errors');
  console.log('PASS  no console errors; no real database requests');
  await context.close();
} finally {
  await browser.close();
}
