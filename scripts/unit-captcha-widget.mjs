/** Optional DOM regression: npm i --no-save --package-lock=false jsdom
 * Run: node scripts/unit-captcha-widget.mjs
 * Uses a fake Google API; does not solve or contact reCAPTCHA.
 */
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { createServer } from 'vite';
import { forceDemoMode, DEMO_SERVER_OPTIONS } from './lib/demo-mode.mjs';

const dom = new JSDOM('<div id="root"></div>', { url: 'https://preview.example/' });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
forceDemoMode();
process.env.VITE_CAPTCHA_PROVIDER = 'recaptcha';
process.env.VITE_RECAPTCHA_SITE_KEY = 'test-site-key';
const { default: React, act } = await import('react');
const { createRoot } = await import('react-dom/client');
const vite = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test' });
const root = createRoot(document.getElementById('root'));
try {
  const { CaptchaWidget } = await vite.ssrLoadModule('/src/components/requests/CaptchaWidget.tsx');
  let token = '';
  let expired = 0;
  let currentOptions;
  let renders = 0;
  const resets = [];
  const widget = (onVerify = (value) => { token = value; }) => React.createElement(
    React.StrictMode, null,
    React.createElement(CaptchaWidget, { onVerify, onExpire: () => { expired++; } }),
  );
  await act(async () => root.render(widget()));
  assert.equal(document.querySelectorAll('script').length, 1, 'StrictMode only loads one script');
  const script = document.querySelector('script');
  assert.ok(script.src.includes('google.com/recaptcha/api.js?render=explicit'));
  await act(async () => script.dispatchEvent(new window.Event('load')));
  assert.equal(renders, 0, 'Wait for Google API callback, not just script load');
  window.grecaptcha = {
    render: (el, options) => {
      assert.ok(el.isConnected);
      currentOptions = options;
      return renders++;
    },
    reset: (id) => resets.push(id),
  };
  await act(async () => window.hikkomangaCaptchaReady());
  assert.equal(renders, 1);
  assert.equal(currentOptions.sitekey, 'test-site-key');
  await act(async () => currentOptions.callback('token-one'));
  assert.equal(token, 'token-one');
  await act(async () => root.render(widget((value) => { token = `updated:${value}`; })));
  await act(async () => currentOptions.callback('token-two'));
  assert.equal(token, 'updated:token-two', 'Latest callbacks are used without remount');
  assert.equal(renders, 1);
  await act(async () => currentOptions['expired-callback']());
  assert.equal(expired, 1);
  await act(async () => currentOptions['error-callback']());
  assert.equal(expired, 2, 'Errors invalidate old tokens');
  assert.ok(document.body.textContent.includes('Не удалось загрузить капчу'));
  await act(async () => currentOptions.callback('retry-token'));
  assert.ok(!document.body.textContent.includes('Не удалось загрузить капчу'));
  await act(async () => root.render(null));
  assert.deepEqual(resets, [0], 'Google widget ID 0 is reset on unmount');
  const previousOptions = currentOptions;
  await act(async () => root.render(widget()));
  assert.equal(renders, 2, 'Reopening renders a fresh widget');
  assert.equal(document.querySelectorAll('script').length, 1, 'API script is reused');
  await act(async () => previousOptions.callback('stale'));
  assert.equal(token, 'updated:retry-token', 'Unmounted widget callbacks are ignored');
  console.log('PASS  reCAPTCHA v2: async API, StrictMode, callbacks, expiry, errors, ID 0 and reopen');
} finally {
  await act(async () => root.unmount());
  await vite.close();
  dom.window.close();
}
