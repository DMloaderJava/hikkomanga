// Абстракция капчи: Turnstile / hCaptcha / reCAPTCHA v2 переключаются секретом
// CAPTCHA_PROVIDER без изменения кода (см. SETUP_SUPABASE.md, «Приём заявок»).
export type CaptchaProvider = 'turnstile' | 'hcaptcha' | 'recaptcha';

const PROVIDER: CaptchaProvider =
  (Deno.env.get('CAPTCHA_PROVIDER') as CaptchaProvider) ?? 'turnstile';

export async function verifyCaptcha(
  token: string,
  remoteip: string
): Promise<{ ok: boolean; error?: string }> {
  if (PROVIDER === 'turnstile') {
    return verifyTurnstile(token, remoteip);
  }
  if (PROVIDER === 'hcaptcha') return verifyHCaptcha(token, remoteip);
  if (PROVIDER === 'recaptcha') return verifyRecaptcha(token, remoteip);
  return { ok: false, error: 'captcha_provider_invalid' };
}

async function verifyTurnstile(token: string, remoteip: string) {
  const secret = Deno.env.get('TURNSTILE_SECRET_KEY');
  if (!secret) return { ok: false, error: 'turnstile_secret_missing' };
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token, remoteip }),
  });
  const data = await res.json();
  return { ok: !!data.success, error: data.success ? undefined : 'turnstile_failed' };
}

async function verifyHCaptcha(token: string, remoteip: string) {
  const secret = Deno.env.get('HCAPTCHA_SECRET_KEY');
  if (!secret) return { ok: false, error: 'hcaptcha_secret_missing' };
  const res = await fetch('https://hcaptcha.com/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token, remoteip }),
  });
  const data = await res.json();
  return { ok: !!data.success, error: data.success ? undefined : 'hcaptcha_failed' };
}

async function verifyRecaptcha(token: string, remoteip: string) {
  const secret = Deno.env.get('RECAPTCHA_SECRET_KEY');
  if (!secret) return { ok: false, error: 'recaptcha_secret_missing' };
  const res = await fetch('https://www.google.com/recaptcha/api/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret, response: token, remoteip }),
  });
  if (!res.ok) return { ok: false, error: 'recaptcha_failed' };
  const data = await res.json();
  return { ok: data.success === true, error: data.success === true ? undefined : 'recaptcha_failed' };
}
