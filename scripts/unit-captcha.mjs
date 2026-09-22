/** Real CAPTCHA verifier, mocked provider HTTP (no secrets or network). */
import assert from 'node:assert/strict';

const originalDeno = globalThis.Deno;
const originalFetch = globalThis.fetch;
let env = {};
let calls = [];
let response = { success: true };
let status = 200;
globalThis.Deno = { env: { get: (key) => env[key] } };
globalThis.fetch = async (url, options) => {
  calls.push({ url, options });
  return new Response(JSON.stringify(response), { status });
};

try {
  for (const [provider, secretName, endpoint] of [
    ['recaptcha', 'RECAPTCHA_SECRET_KEY', 'https://www.google.com/recaptcha/api/siteverify'],
    ['turnstile', 'TURNSTILE_SECRET_KEY', 'https://challenges.cloudflare.com/turnstile/v0/siteverify'],
    ['hcaptcha', 'HCAPTCHA_SECRET_KEY', 'https://hcaptcha.com/siteverify'],
  ]) {
    env = { CAPTCHA_PROVIDER: provider };
    calls = [];
    response = { success: true };
    status = 200;
    const { verifyCaptcha } = await import(`../supabase/functions/_shared/captcha.ts?provider=${provider}`);
    assert.deepEqual(await verifyCaptcha('token', '192.0.2.1'), {
      ok: false, error: `${provider}_secret_missing`,
    });
    assert.equal(calls.length, 0, 'Missing secret must not send requests');
    env[secretName] = 'test-secret';
    assert.equal((await verifyCaptcha('token', '192.0.2.1')).ok, true);
    const { url, options } = calls.at(-1);
    assert.equal(url, endpoint);
    assert.equal(options.method, 'POST');
    assert.equal(options.headers['content-type'], 'application/x-www-form-urlencoded');
    assert.deepEqual(Object.fromEntries(options.body), {
      secret: 'test-secret', response: 'token', remoteip: '192.0.2.1',
    });
    response = { success: false, 'error-codes': ['invalid-input-response'] };
    assert.equal((await verifyCaptcha('bad-token', '192.0.2.1')).ok, false);
    if (provider === 'recaptcha') {
      response = { success: 'false' };
      assert.equal((await verifyCaptcha('token', '')).ok, false);
      response = { success: true };
      status = 503;
      assert.equal((await verifyCaptcha('token', '')).ok, false);
    }
    console.log(`PASS  ${provider}: secret, endpoint, request body, accepted/rejected tokens`);
  }
  env = { CAPTCHA_PROVIDER: 'unknown' };
  const { verifyCaptcha } = await import('../supabase/functions/_shared/captcha.ts?provider=unknown');
  assert.deepEqual(await verifyCaptcha('token', ''), { ok: false, error: 'captcha_provider_invalid' });
  console.log('PASS  unknown provider fails closed');
} finally {
  globalThis.fetch = originalFetch;
  if (originalDeno === undefined) delete globalThis.Deno;
  else globalThis.Deno = originalDeno;
}
