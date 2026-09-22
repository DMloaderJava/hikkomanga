/**
 * Click the actual dev-login controls through React + the real auth/notify
 * modules. Only HTTP is mocked; the live preview's challenge file is untouched.
 * npm i --no-save --package-lock=false jsdom
 * node --conditions=development scripts/unit-login-dev.mjs
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { forceDemoMode, DEMO_SERVER_OPTIONS } from './lib/demo-mode.mjs';

const dom = new JSDOM('<div id="root"></div>', {
  url: 'https://preview.example/admin/login', pretendToBeVisual: true,
});
for (const key of ['window', 'self', 'document', 'localStorage', 'sessionStorage', 'navigator',
  'HTMLElement', 'Element', 'Node', 'Event', 'CustomEvent', 'MouseEvent',
  'requestAnimationFrame', 'cancelAnimationFrame']) {
  Object.defineProperty(globalThis, key, { value: dom.window[key], configurable: true, writable: true });
}
globalThis.scrollTo = window.scrollTo = () => {};
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
forceDemoMode();
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { createRootRoute, createRoute, createRouter, createMemoryHistory, RouterProvider, Outlet } =
  await import('@tanstack/react-router');
const vite = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test' });
const originalFetch = globalThis.fetch;
const container = document.getElementById('root');
let reactRoot;
let challenge;
let responseStatus;
let confirmations = [];
let releaseConfirm;
let holdConfirm = false;

const json = (data, status = 200) => new Response(JSON.stringify(data), { status });
globalThis.fetch = async (url, options = {}) => {
  if (url === '/api/login-notify') {
    challenge = { id: 'dev-ui-test', token: 'dev-token', status: 'pending' };
    return json({ ok: true, emulated: true, challengeId: challenge.id, preview: {
      approveUrl: 'https://preview.example/admin/login/confirm?token=dev-token&action=approve',
      denyUrl: 'https://preview.example/admin/login/confirm?token=dev-token&action=deny',
    } });
  }
  if (String(url).startsWith('/api/login-challenge-status')) {
    return json(challenge ? { id: challenge.id, status: challenge.status } : { status: 'none' });
  }
  if (url === '/api/login-confirm') {
    const body = JSON.parse(options.body);
    confirmations.push(body);
    assert.equal(body.token, 'dev-token');
    if (holdConfirm) await new Promise((resolve) => { releaseConfirm = resolve; });
    const status = responseStatus || (body.action === 'approve' ? 'approved' : 'denied');
    if (['approved', 'denied', 'expired'].includes(status)) challenge.status = status;
    return json({ ok: ['approved', 'denied'].includes(status), status,
      ...(status === 'error' ? { error: 'Тестовая ошибка сервера' } : {}),
    }, ['approved', 'denied'].includes(status) ? 200 : 400);
  }
  throw new Error(`Unexpected HTTP request: ${url}`);
};
const click = (element) => act(async () => {
  assert.ok(element, 'Button must exist');
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
});
const button = (text) => [...container.querySelectorAll('button')].find((b) => b.textContent.includes(text));
const value = async (id, text) => act(async () => {
  const input = container.querySelector(id);
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(input, text);
  input.dispatchEvent(new Event('input', { bubbles: true }));
});

try {
  const { Route } = await vite.ssrLoadModule('/src/routes/admin.login.tsx');
  const { auth } = await vite.ssrLoadModule('/src/data/auth.ts');
  for (const scenario of ['approve', 'deny', 'expired', 'not_found', 'error']) {
    if (reactRoot) await act(async () => reactRoot.unmount());
    await auth.signOut();
    localStorage.clear();
    challenge = null;
    confirmations = [];
    responseStatus = ['approve', 'deny'].includes(scenario) ? null : scenario;
    holdConfirm = scenario === 'approve';
    const rootRoute = createRootRoute({ component: Outlet });
    const loginRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin/login', component: Route.options.component });
    const adminRoute = createRoute({
      getParentRoute: () => rootRoute, path: '/admin',
      beforeLoad: async () => {
        const session = await auth.getSession();
        assert.ok(session);
        assert.equal(await auth.hasRole(session.user.id, 'admin'), true, 'Login Guard still checks approval');
      },
      component: () => React.createElement('h1', null, 'TEST ADMIN'),
    });
    const router = createRouter({ routeTree: rootRoute.addChildren([loginRoute, adminRoute]),
      history: createMemoryHistory({ initialEntries: ['/admin/login'] }), defaultPendingMinMs: 0,
    });
    await router.load();
    reactRoot = createRoot(container);
    await act(async () => reactRoot.render(React.createElement(RouterProvider, { router })));
    await value('#email', 'admin@example.test');
    await value('#password', 'demo-password');
    await act(async () => container.querySelector('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
    assert.ok(button('Подтвердить (dev)'));
    assert.equal(container.querySelector('a[target="_blank"]'), null, 'No new tab needed');
    const approve = button('Подтвердить (dev)');
    const deny = button('Отклонить (dev)');
    await click(scenario === 'deny' ? deny : approve);
    if (holdConfirm) {
      assert.equal(approve.disabled, true);
      assert.equal(deny.disabled, true);
      assert.equal(button('Отменить вход').disabled, true);
      await click(approve);
      assert.equal(confirmations.length, 1, 'Double clicks do not submit twice');
      await act(async () => releaseConfirm());
    }
    assert.equal(confirmations.length, 1);
    assert.equal(confirmations[0].action, scenario === 'deny' ? 'deny' : 'approve');
    if (scenario === 'approve') {
      assert.equal(router.state.location.pathname, '/admin');
      assert.ok(container.textContent.includes('TEST ADMIN'));
    } else if (scenario === 'deny' || scenario === 'expired') {
      assert.ok(container.textContent.includes(scenario === 'deny' ? 'Вход отклонён' : 'Срок истёк'));
      assert.equal(await auth.getSession(), null);
    } else {
      assert.ok(container.textContent.includes(scenario === 'not_found' ? 'Подтверждение не найдено' : 'Тестовая ошибка сервера'));
      assert.equal(router.state.location.pathname, '/admin/login');
      assert.equal(button('Подтвердить (dev)').disabled, false);
    }
    console.log(`PASS  dev confirmation click: ${scenario}`);
  }
} finally {
  if (reactRoot) await act(async () => reactRoot.unmount());
  globalThis.fetch = originalFetch;
  await vite.close();
  dom.window.close();
}
