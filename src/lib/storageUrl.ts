import { SUPABASE_URL } from '@/integrations/supabase/config';

/**
 * Refs удалённых Supabase-проектов. Их домены уже не резолвятся (NXDOMAIN),
 * но в строках БД после переноса данных на новый проект могут остаться
 * storage-URL, указывающие на них (например, `titles.cover_url`) — такие
 * изображения браузер никогда не загрузит.
 *
 * Если добавите новый мёртвый ref, допишите его сюда.
 */
const LEGACY_SUPABASE_REFS = new Set(['vokzyxwkhappwnggjxf']);

/** Дедупликация: один и тот же битый URL выводим в консоль один раз. */
const warnedUrls = new Set<string>();

function currentHostname(): string {
  try {
    return new URL(SUPABASE_URL).hostname;
  } catch {
    return '';
  }
}

/**
 * Починить URL Supabase Storage, указывающий на удалённый проект:
 * `<legacy-ref>.supabase.co` → хост проекта, текущего по VITE_SUPABASE_URL.
 *
 * Всё остальное (data:, внешние ссылки, ссылки на текущий проект)
 * возвращается без изменений. Безопасно вызывать на любом string-поле с URL.
 */
export function repairSupabaseUrl(url: string | null | undefined): string | null | undefined {
  if (!url || typeof url !== 'string' || !url.includes('.supabase.co')) return url;
  const current = currentHostname();
  if (!current) return url;

  const match = url.match(/\/\/([a-z0-9-]+)\.supabase\.co\//);
  const legacyRef = match?.[1];
  if (!legacyRef || !LEGACY_SUPABASE_REFS.has(legacyRef)) return url;

  if (!warnedUrls.has(url)) {
    warnedUrls.add(url);
    console.warn(
      `[storageUrl] URL указывает на удалённый Supabase-проект ${legacyRef} — переадресован на ${current}. ` +
        'Если файл не был перенесён в новый проект, придёт 404 и приложение покажет плейсхолдер.',
      url
    );
  }
  return url.replace(`${legacyRef}.supabase.co`, current);
}
