/**
 * Общий помощник для build-скриптов (sitemap + пререндер):
 * env, адрес сайта и список публичных URL из Supabase.
 */
import { loadEnv } from 'vite';
import { createClient } from '@supabase/supabase-js';

/** VITE_* из .env + реальные переменные окружения (Vercel/CI). */
export function buildEnv() {
  const fileEnv = loadEnv('production', process.cwd(), '');
  return { ...fileEnv, ...process.env };
}

/**
 * Канонический домен сайта. Приоритет:
 *   VITE_SITE_URL / SITE_URL → VERCEL_PROJECT_PRODUCTION_URL → VERCEL_URL
 */
export function getSiteUrl(env) {
  const raw = (env.VITE_SITE_URL || env.SITE_URL || '').trim();
  if (raw) return raw.replace(/\/+$/, '');

  const vercel = (
    env.VERCEL_PROJECT_PRODUCTION_URL ||
    env.VERCEL_URL ||
    ''
  ).trim();
  if (vercel) return `https://${vercel.replace(/^https?:\/\//, '')}`;

  return '';
}

/**
 * Клиент Supabase для чтения опубликованных данных.
 * SERVICE_ROLE_KEY нужен только если RLS/anons-доступ почему-то закрыт.
 */
export function getSupabaseClient(env) {
  const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL;
  const key =
    env.SUPABASE_SERVICE_ROLE_KEY ||
    env.VITE_SUPABASE_ANON_KEY ||
    env.VITE_SUPABASE_PUBLISHABLE_KEY ||
    env.VITE_SUPABASE_PUBLIC_KEY;

  if (!url || !key) return null;

  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Номер главы в том виде, в котором он живёт в URL ( NUMERIC → '1' / '1.5' ). */
function chapterNumber(value) {
  if (value === null || value === undefined) return null;
  const str = String(value).trim();
  return str === '' ? null : str;
}

/**
 * Список страниц для sitemap и пререндера.
 *
 * @returns {Promise<{ urls: Array<{path: string, priority: string, changefreq: string, lastmod?: string}>, env: object }>}
 */
export async function getPublicUrls() {
  const env = buildEnv();

  const urls = [
    { path: '/', priority: '1.0', changefreq: 'daily' },
    { path: '/advertise', priority: '0.4', changefreq: 'monthly' },
  ];

  const supabase = getSupabaseClient(env);
  if (!supabase) {
    console.warn(
      '[seo] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY не заданы — ' +
        'sitemap и пререндер соберут только статические страницы (/, /advertise).',
    );
    return { urls, env };
  }

  const { data: titles, error: titlesError } = await supabase
    .from('titles')
    .select('slug, created_at')
    .eq('published', true)
    .order('created_at', { ascending: false });

  if (titlesError) {
    console.warn('[seo] не удалось получить тайтлы:', titlesError.message);
    return { urls, env };
  }

  for (const title of titles ?? []) {
    if (!title?.slug) continue;
    urls.push({
      path: `/title/${title.slug}`,
      priority: '0.9',
      changefreq: 'weekly',
      lastmod: title.created_at,
    });
  }

  // Главы — «тонкие» страницы (картинки без текста); по умолчанию включаем,
  // но даём выключатель, чтобы не размывать crawl-бюджет на больших каталогах.
  const withChapters = String(env.PRERENDER_CHAPTERS ?? '1') !== '0';

  if (withChapters) {
    const { data: chapters, error: chaptersError } = await supabase
      .from('chapters')
      .select('number, created_at, titles!inner(slug)')
      .eq('published', true)
      .eq('titles.published', true)
      .order('number', { ascending: true });

    if (chaptersError) {
      console.warn('[seo] не удалось получить главы:', chaptersError.message);
    } else {
      for (const chapter of chapters ?? []) {
        const slug = chapter.titles?.slug;
        const number = chapterNumber(chapter.number);
        if (!slug || number === null) continue;
        urls.push({
          path: `/title/${slug}/chapter/${number}`,
          priority: '0.7',
          changefreq: 'weekly',
          lastmod: chapter.created_at,
        });
      }
    }
  }

  return { urls, env };
}

/** Ограничение на число пререндеренных страниц. */
export function maxUrls(env = buildEnv()) {
  const raw = Number(env.PRERENDER_MAX_URLS ?? 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 1000;
}
