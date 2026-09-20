/**
 * Валидация id из URL перед походом в базу.
 *
 * Зачем: если ссылка в админке собрана без `params` (TanStack Router
 * подставит в путь литералы вида `$id` / `<title-id>`, а не UUID), то
 * `titles.getById('<title-id>')` уходит в PostgREST как
 * `?id=eq.%3Ctitle-id%3E` и получает 400 Bad Request — ошибка в UI
 * выглядит как «Тайтл не найден», хотя тайтл на месте.
 *
 * Поэтому все админ-лоадеры сначала проверяют параметр здесь и бросают
 * понятное сообщение про битую ссылку, не делая бессмысленный запрос.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Похоже на незаменённый плейсхолдер маршрута: `$id`, `:cid`, `<title-id>`, `%3Ctitle-id%3E`. */
export function looksLikeRoutePlaceholder(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const raw = value.trim();
  if (!raw) return true;
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    // оставляем как есть
  }
  return (
    decoded.startsWith('$') ||
    decoded.startsWith(':') ||
    (decoded.startsWith('<') && decoded.endsWith('>')) ||
    decoded.includes('{') ||
    decoded.includes('}')
  );
}

/**
 * Валидный идентификатор сущности: UUID (Supabase) либо демо-id mockStore
 * (`t-1`, `c-2`, `p-1-1`). Всё остальное — битая ссылка.
 */
export function isValidEntityId(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw || looksLikeRoutePlaceholder(raw)) return false;
  if (UUID_RE.test(raw)) return true;
  return /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(raw);
}

/**
 * Бросает понятную ошибку вместо 400 от PostgREST.
 * `what` — что именно в ссылке битое, для текста ошибки.
 */
export function assertEntityId(value: unknown, what: string): string {
  if (!isValidEntityId(value)) {
    throw new Error(
      `Ссылка повреждена: в адресе вместо идентификатора (${what}) стоит «${String(value)}». ` +
        'Откройте раздел заново из списка — если повторяется, значит на странице есть ссылка без params.'
    );
  }
  return (value as string).trim();
}
