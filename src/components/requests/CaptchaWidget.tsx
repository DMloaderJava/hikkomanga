import { useEffect, useRef, useState } from 'react';

/**
 * Обёртка капчи: Turnstile (по умолчанию), hCaptcha или reCAPTCHA v2 — выбор через
 * VITE_CAPTCHA_PROVIDER, замена провайдера не требует правок кода
 * (см. SETUP_SUPABASE.md, «Приём заявок»).
 *
 * Скрипт провайдера грузится лениво из виджета (не из index.html), чтобы
 * анонимная капча не попадала в initial-бюджет каталога.
 */
const PROVIDER = (import.meta.env.VITE_CAPTCHA_PROVIDER as string | undefined) ?? 'turnstile';
const SITE_KEY =
  PROVIDER === 'recaptcha'
    ? (import.meta.env.VITE_RECAPTCHA_SITE_KEY as string | undefined) ?? ''
    : PROVIDER === 'hcaptcha'
      ? (import.meta.env.VITE_HCAPTCHA_SITE_KEY as string | undefined) ?? ''
      : (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined) ?? '';

const SCRIPT_SRC =
  PROVIDER === 'recaptcha'
    ? 'https://www.google.com/recaptcha/api.js?render=explicit&onload=hikkomangaCaptchaReady'
    : PROVIDER === 'hcaptcha'
      ? 'https://js.hcaptcha.com/1/api.js'
      : 'https://challenges.cloudflare.com/turnstile/v0/api.js';

// ── Минимальные типы провайдеров ─────────────────────────────────────────────
interface CaptchaApi {
  render: (
    el: HTMLElement,
    opts: {
      sitekey: string;
      callback: (token: string) => void;
      'expired-callback': () => void;
      'error-callback': () => void;
      theme: 'dark';
    }
  ) => string | number;
  reset: (widgetId: string | number) => void;
  // Google reCAPTCHA has no remove API.
  remove?: (widgetId: string | number) => void;
}

function getApi(): CaptchaApi | null {
  const w = window as unknown as Record<string, unknown>;
  const name = PROVIDER === 'recaptcha' ? 'grecaptcha' : PROVIDER === 'hcaptcha' ? 'hcaptcha' : 'turnstile';
  const api = w[name] as CaptchaApi | undefined;
  return typeof api?.render === 'function' ? api : null;
}

let scriptPromise: Promise<void> | undefined;
function loadScript(): Promise<void> {
  if (getApi()) return Promise.resolve();
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<void>((resolve, reject) => {
    // Google's outer script can load before grecaptcha.render is ready.
    // Its explicit onload callback runs after the full API is available.
    if (PROVIDER === 'recaptcha') {
      (window as unknown as Record<string, unknown>).hikkomangaCaptchaReady = () => resolve();
    }
    const script = document.createElement('script');
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.addEventListener('load', () => {
      if (PROVIDER !== 'recaptcha') resolve();
    }, { once: true });
    script.addEventListener('error', () => {
      script.remove();
      scriptPromise = undefined;
      reject(new Error('Captcha script failed to load'));
    }, { once: true });
    document.head.appendChild(script);
  });
  return scriptPromise;
}

interface CaptchaWidgetProps {
  /** Токен прошёл проверку пользователем. */
  onVerify: (token: string) => void;
  /** Токен истёк — форма не сабмитится, пока не решит заново. */
  onExpire?: () => void;
}

export function CaptchaWidget({ onVerify, onExpire }: CaptchaWidgetProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const widgetIdRef = useRef<string | number | null>(null);
  const [failed, setFailed] = useState(false);
  const callbacks = useRef({ onVerify, onExpire });
  callbacks.current = { onVerify, onExpire };

  useEffect(() => {
    if (!SITE_KEY) {
      // Ключ не настроен: честно показываем, а не тихо блокируем сабмит.
      setFailed(true);
      return;
    }

    let cancelled = false;
    const container = containerRef.current;
    // A fresh child also makes StrictMode remounts safe for Google's API,
    // which cannot remove a widget registration from its original element.
    const mount = document.createElement('div');
    container?.appendChild(mount);

    loadScript().then(() => {
      if (cancelled || !container) return;
      const api = getApi();
      if (!api) throw new Error('Captcha API unavailable');
      widgetIdRef.current = api.render(mount, {
        sitekey: SITE_KEY,
        callback: (token: string) => {
          if (cancelled) return;
          setFailed(false);
          callbacks.current.onVerify(token);
        },
        'expired-callback': () => {
          if (!cancelled) callbacks.current.onExpire?.();
        },
        'error-callback': () => {
          if (cancelled) return;
          setFailed(true);
          callbacks.current.onExpire?.();
        },
        theme: 'dark',
      });
    }).catch(() => {
      if (!cancelled) setFailed(true);
    });

    return () => {
      cancelled = true;
      const api = getApi();
      // Google's first widget ID is 0 (not a missing widget).
      if (api && widgetIdRef.current !== null) {
        try {
          if (api.remove) api.remove(widgetIdRef.current);
          else api.reset(widgetIdRef.current);
        } catch {
          // контейнер уже размонтирован
        }
      }
      widgetIdRef.current = null;
      mount.remove();
    };
  }, []);

  if (!SITE_KEY) {
    return (
      <div className="rounded-lg border border-amber-800/60 bg-amber-950/30 p-3 text-xs text-amber-300">
        Капча не настроена (VITE_TURNSTILE_SITE_KEY / VITE_HCAPTCHA_SITE_KEY / VITE_RECAPTCHA_SITE_KEY).
        Отправка заявок недоступна — обратитесь к администратору сайта.
      </div>
    );
  }

  return (
    <div>
      <div ref={containerRef} />
      {failed && (
        <div className="rounded-lg border border-red-800/60 bg-red-950/30 p-3 text-xs text-red-400">
          Не удалось загрузить капчу. Проверьте сеть (CSP допускает{' '}
          {PROVIDER === 'recaptcha' ? 'www.google.com / www.gstatic.com' : PROVIDER === 'hcaptcha' ? 'js.hcaptcha.com' : 'challenges.cloudflare.com'}) и обновите страницу.
        </div>
      )}
    </div>
  );
}
