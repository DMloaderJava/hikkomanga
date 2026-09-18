/**
 * Определение поисковых ботов/краулеров и рендеримых публичных маршрутов.
 *
 * Файл намеренно без TS-синтаксиса (.mjs): его импортируют и Edge Middleware
 * (middleware.ts — собирается Vercel отдельно), и Node-функция api/render.mjs,
 * и локальные скрипты scripts/*.mjs. Один источник правды для всех рантаймов.
 *
 * Правило против cloaking: бот получает ровно тот же контент, что и
 * пользователь после загрузки JS (рендерим то же приложение), меняется только
 * способ доставки — готовый HTML вместо SPA-шелла.
 */

/**
 * UA-фрагменты ботов: поисковики, соцсети/мессенджеры (link-preview),
 * SEO-краулеры и AI-агенты. Совпадение регистронезависимое, по подстроке.
 */
export const BOT_TOKENS = [
  // Поисковые системы
  'googlebot',
  'google-inspectiontool',
  'googleother',
  'google-extended',
  'apis-google',
  'adsbot-google',
  'mediapartners-google',
  'bingbot',
  'adidxbot',
  'msnbot',
  'slurp',
  'yandexbot',
  'yandeximages',
  'yandexvideo',
  'yandexmedia',
  'yandexmetrika',
  'yandexnews',
  'yandexblogs',
  'duckduckbot',
  'duckduckgo-favicon',
  'baiduspider',
  'sogou',
  'exabot',
  'petalbot',
  'applebot',
  'amazonbot',
  'yeti',
  'naverbot',
  // Соцсети и мессенджеры (превью ссылок)
  'facebookexternalhit',
  'facebot',
  'meta-externalagent',
  'twitterbot',
  'telegrambot',
  'whatsapp',
  'slackbot',
  'slack-imgproxy',
  'linkedinbot',
  'pinterestbot',
  'discordbot',
  'skypeuripreview',
  'vkshare',
  'viber',
  // SEO-краулеры
  'semrushbot',
  'ahrefsbot',
  'mj12bot',
  'dotbot',
  'screamingfrog',
  // AI-краулеры (рендерим для них тот же контент; доступ регулирует robots.txt)
  'gptbot',
  'chatgpt-user',
  'oai-searchbot',
  'claudebot',
  'claude-web',
  'perplexitybot',
  'bytespider',
  'ccbot',
  // Инструменты аудита (получают отрендеренный HTML — честные метрики Lighthouse)
  'chrome-lighthouse',
  'headlesschrome',
];

const BOT_RE = new RegExp(BOT_TOKENS.join('|'), 'i');

/** true, если User-Agent похож на известного бота/краулера. */
export function isBotUserAgent(userAgent) {
  if (!userAgent) return false;
  return BOT_RE.test(userAgent);
}

/** Нормализация пути: decode, схлопывание //, срез хвостового слэша. */
export function normalizeRenderPath(pathname) {
  let p = pathname || '/';
  try {
    p = decodeURIComponent(p);
  } catch {
    // некорректная %-последовательность — работаем с исходной строкой
  }
  p = p.replace(/\/{2,}/g, '/');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

/**
 * Публичные маршруты, которые можно рендерить для бота:
 * `/`, `/advertise`, `/title/$slug`, `/title/$slug/chapter/$number`.
 * Всё остальное (админка, api, ассеты, robots/sitemap) — обычная раздача.
 */
const RENDERABLE_RE = /^\/(?:advertise|title\/[^/]+(?:\/chapter\/[^/]+)?)?$/;

/** true, если путь — публичный маршрут, который стоит рендерить. */
export function isRenderablePath(pathname) {
  if (!pathname || !pathname.startsWith('/')) return false;
  const p = normalizeRenderPath(pathname);
  if (!RENDERABLE_RE.test(p)) return false;
  // защита от /title/../admin и подобных сегментов
  return !p.split('/').slice(1).some((segment) => segment === '.' || segment === '..');
}
