/**
 * Генерирует dist/sitemap.xml и dist/robots.txt.
 * Запускается после `vite build` (см. npm run build).
 *
 * Домен берётся из VITE_SITE_URL (или VERCEL_PROJECT_PRODUCTION_URL).
 * Список страниц — scripts/lib/urls.mjs (опубликованные тайтлы и главы).
 */
import fs from 'node:fs';
import path from 'node:path';
import { getPublicUrls, getSiteUrl } from './lib/urls.mjs';

const DIST = path.resolve(process.cwd(), 'dist');
const FALLBACK_SITE = 'https://hikkomanga.vercel.app';

const escapeXml = (value) =>
  String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

function buildSitemap(siteUrl, urls) {
  const now = new Date().toISOString();

  const entries = urls
    .map((item) => {
      const loc = `${siteUrl}${item.path === '/' ? '/' : item.path}`;
      const lastmod = item.lastmod ? new Date(item.lastmod).toISOString() : now;
      return [
        '  <url>',
        `    <loc>${escapeXml(loc)}</loc>`,
        `    <lastmod>${escapeXml(lastmod)}</lastmod>`,
        `    <changefreq>${escapeXml(item.changefreq)}</changefreq>`,
        `    <priority>${escapeXml(item.priority)}</priority>`,
        '  </url>',
      ].join('\n');
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

function buildRobots(siteUrl) {
  return `# https://${siteUrl.replace(/^https?:\/\//, '')}
User-agent: *
Allow: /
Disallow: /admin
Disallow: /admin/
Disallow: /api/

# Яндекс дополнительно учитывает директиву Host и Sitemap
User-agent: Yandex
Allow: /
Disallow: /admin
Disallow: /admin/
Disallow: /api/

Sitemap: ${siteUrl}/sitemap.xml
`;
}

async function main() {
  if (!fs.existsSync(DIST)) {
    console.error('[seo] папка dist/ не найдена — сначала выполните `vite build`.');
    process.exit(1);
  }

  const { urls, env } = await getPublicUrls();
  let siteUrl = getSiteUrl(env);

  if (!siteUrl) {
    siteUrl = FALLBACK_SITE;
    console.warn(
      `[seo] VITE_SITE_URL не задан — sitemap собран на ${siteUrl}. ` +
        'Задайте реальный домен в переменных окружения (Vercel → Settings → Environment Variables).',
    );
  }

  fs.writeFileSync(
    path.join(DIST, 'sitemap.xml'),
    buildSitemap(siteUrl, urls),
    'utf8',
  );
  fs.writeFileSync(
    path.join(DIST, 'robots.txt'),
    buildRobots(siteUrl),
    'utf8',
  );

  console.log(
    `[seo] sitemap.xml: ${urls.length} URL, robots.txt → ${siteUrl}/sitemap.xml`,
  );
}

main().catch((error) => {
  console.error('[seo] генерация sitemap не удалась:', error?.message ?? error);
  process.exit(1);
});
