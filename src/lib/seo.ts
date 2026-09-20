import { SITE_NAME, SITE_URL, DEFAULT_DESCRIPTION, absoluteUrl } from './site';

export type SeoInput = {
  title?: string;
  description?: string;
  image?: string | null;
  /** Закрыть страницу от индексации (админка, ошибочные маршруты). */
  noindex?: boolean;
  /** Путь для canonical/og:url; по умолчанию — текущий location.pathname. */
  path?: string;
};

const esc = (value: string) =>
  value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export function fullTitle(title?: string): string {
  return title ? `${title} — ${SITE_NAME}` : `${SITE_NAME} — Читалка манги онлайн`;
}

/** Кэшируемый плейсхолдер — og:image обязателен на каждой публичной странице. */
const PLACEHOLDER_COVER_PATH = '/media/placeholder-cover.svg';

/**
 * Картинка для og:image — только абсолютный http(s).
 * data:-URL в соцсетях/мессенджерах не работает, поэтому для тайтла с
 * демо-обложкой (и для страниц вовсе без обложки) отдаём статический
 * плейсхолдер с абсолютным SITE_URL — превью ссылки остаётся презентабельным.
 */
function shareImage(image?: string | null): string | undefined {
  if (image && !image.startsWith('data:')) {
    if (/^https?:\/\//i.test(image)) return image;
    if (image.startsWith('/') && SITE_URL) return `${SITE_URL}${image}`;
  }
  return SITE_URL ? `${SITE_URL}${PLACEHOLDER_COVER_PATH}` : undefined;
}

/**
 * Метаданные маршрута в одном месте: используются и клиентом (updateMetaTags),
 * и пререндером при сборке (renderHeadTags) — чтобы HTML и рантайм не расходились.
 */
export function seoForRoute(routeId: string, data?: any): SeoInput {
  switch (routeId) {
    case '/':
      return {
        title: 'Каталог манги',
        description:
          'Онлайн читалка манги. Читайте популярные произведения онлайн бесплатно.',
      };

    case '/advertise':
      return {
        title: 'Реклама на Hikkomanga',
        description:
          'Разместите баннер между главами манги для активной аудитории читателей.',
      };

    case '/title/$slug':
    case '/title/$slug/': {
      const title = data?.title;
      if (!title) return { noindex: true };
      return {
        title: title.title,
        description:
          title.description || `Читать мангу ${title.title} онлайн`,
        image: title.cover_url,
      };
    }

    case '/title/$slug/chapter/$number': {
      const title = data?.title;
      const chapter = data?.chapter;
      if (!title || !chapter) return { noindex: true };
      return {
        title: `${title.title} — Глава ${chapter.number}`,
        description: `Читать главу ${chapter.number} манги ${title.title} онлайн`,
        image: title.cover_url,
      };
    }

    default:
      // Всё, что внутри /admin, в поиске не нужно.
      if (routeId.startsWith('/admin')) return { noindex: true };
      return {};
  }
}

/** Готовый набор тегов для <head> — используется пререндером (Node, без DOM). */
export function renderHeadTags(seo: SeoInput, pathname = '/'): string {
  const url = absoluteUrl(seo.path ?? pathname);
  const titleText = fullTitle(seo.title);
  const description = (seo.description || DEFAULT_DESCRIPTION).slice(0, 300);
  const image = shareImage(seo.image);

  const tags: string[] = [
    `<title>${esc(titleText)}</title>`,
    `<meta name="description" content="${esc(description)}" />`,
    `<meta name="robots" content="${seo.noindex ? 'noindex, nofollow' : 'index, follow'}" />`,
  ];

  if (url) tags.push(`<link rel="canonical" href="${esc(url)}" />`);

  tags.push(
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="${esc(SITE_NAME)}" />`,
    `<meta property="og:title" content="${esc(titleText)}" />`,
    `<meta property="og:description" content="${esc(description)}" />`,
    `<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}" />`,
    `<meta name="twitter:title" content="${esc(titleText)}" />`,
    `<meta name="twitter:description" content="${esc(description)}" />`,
  );

  if (url) tags.push(`<meta property="og:url" content="${esc(url)}" />`);
  if (image) {
    tags.push(
      `<meta property="og:image" content="${esc(image)}" />`,
      `<meta name="twitter:image" content="${esc(image)}" />`,
    );
  }

  return tags.join('\n    ');
}

function upsertMeta(
  attr: 'name' | 'property',
  key: string,
  content: string,
): void {
  let element = document.head.querySelector<HTMLMetaElement>(
    `meta[${attr}="${key}"]`,
  );
  if (!element) {
    element = document.createElement('meta');
    element.setAttribute(attr, key);
    document.head.appendChild(element);
  }
  element.setAttribute('content', content);
}

function upsertLink(rel: string, href: string | undefined): void {
  const existing = document.head.querySelector<HTMLLinkElement>(
    `link[rel="${rel}"]`,
  );
  if (!href) {
    existing?.remove();
    return;
  }
  const link = existing ?? document.createElement('link');
  link.setAttribute('rel', rel);
  link.setAttribute('href', href);
  if (!existing) document.head.appendChild(link);
}

/** Клиентское применение SEO-данных (title, description, og:*, canonical, robots). */
export function updateMetaTags({
  title,
  description,
  image,
  noindex,
  path,
}: SeoInput): void {
  const pathname =
    path ?? (typeof window !== 'undefined' ? window.location.pathname : '/');
  const titleText = fullTitle(title);
  const descriptionText = (description || DEFAULT_DESCRIPTION).slice(0, 300);
  const share = shareImage(image);

  document.title = titleText;

  upsertMeta('name', 'description', descriptionText);
  upsertMeta(
    'name',
    'robots',
    noindex ? 'noindex, nofollow' : 'index, follow',
  );

  upsertMeta('property', 'og:type', 'website');
  upsertMeta('property', 'og:site_name', SITE_NAME);
  upsertMeta('property', 'og:title', titleText);
  upsertMeta('property', 'og:description', descriptionText);
  upsertMeta('name', 'twitter:card', share ? 'summary_large_image' : 'summary');
  upsertMeta('name', 'twitter:title', titleText);
  upsertMeta('name', 'twitter:description', descriptionText);

  const url = absoluteUrl(pathname);
  if (url) {
    upsertMeta('property', 'og:url', url);
    upsertLink('canonical', url);
  }
  if (share) {
    upsertMeta('property', 'og:image', share);
    upsertMeta('name', 'twitter:image', share);
  }
}

/** Быстрый переключатель noindex (страницы ошибок, админка). */
export function setNoindex(noindex: boolean): void {
  upsertMeta('name', 'robots', noindex ? 'noindex, nofollow' : 'index, follow');
}
