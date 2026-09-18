/**
 * Общий рантайм динамического рендеринга: загрузка SSR-бандла (dist-ssr),
 * in-memory кэш и заголовки кэширования.
 *
 * Потребители:
 *  - api/render.mjs         — Vercel serverless-функция (прод);
 *  - scripts/serve-dynamic.mjs — локальный прод-сервер (npm run preview:dynamic).
 *
 * Путь до SSR-бандла '../../dist-ssr/render.mjs' разрешается относительно
 * этого файла, поэтому работает из любого cwd и трассируется nft на Vercel.
 */
import { isRenderablePath, normalizeRenderPath } from '../../src/lib/bots.mjs';

const DEFAULT_TTL_SEC = 15 * 60; // живой кэш внутри тёплого инстанса функции
const DEFAULT_MAX_ENTRIES = 256; // защита от распухания кэша на длинных каталогах

const numEnv = (raw, fallback) => {
  const value = Number(raw);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const ttlSec = () => numEnv(process.env.DYNAMIC_RENDER_TTL, DEFAULT_TTL_SEC);

/**
 * Фабрика рендерера (инъекция loadModule — для юнит-тестов).
 * @param {{ loadModule?: () => Promise<any>, ttlSec?: number, maxEntries?: number }} [options]
 */
export function createRenderer(options = {}) {
  const ttlMs = (options.ttlSec ?? ttlSec()) * 1000;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const loadModule = options.loadModule ?? (() => import('../../dist-ssr/render.mjs'));

  /** @type {Map<string, { entry: any, expires: number }>} */
  const cache = new Map();
  let modulePromise = null;

  async function getModule() {
    if (!modulePromise) {
      // при провале импорта — сбрасываем, чтобы следующий запрос повторил
      modulePromise = loadModule().catch((error) => {
        modulePromise = null;
        throw error;
      });
    }
    return modulePromise;
  }

  /**
   * Отрендерить путь для бота (из кэша, если свежий).
   * @returns {Promise<{ html: string | null, status: number, reason: string }>}
   */
  async function render(pathname) {
    const path = normalizeRenderPath(pathname);
    if (!isRenderablePath(path)) {
      return { html: null, status: 404, reason: 'not-renderable' };
    }

    const hit = cache.get(path);
    if (hit && hit.expires > Date.now()) {
      return hit.entry;
    }

    let entry;
    try {
      const mod = await getModule();
      entry = await mod.renderPage(path);
    } catch (error) {
      console.error(
        '[dynamic-render] SSR-бандл недоступен:',
        error instanceof Error ? error.message : error,
      );
      return { html: null, status: 503, reason: 'module-error' };
    }

    // 503 кэшируем совсем ненадолго — вдруг это временный сбой СУБД
    const ttl = entry.status >= 500 ? Math.min(ttlMs, 60_000) : ttlMs;
    if (cache.size >= maxEntries && !cache.has(path)) {
      // FIFO: Map хранит порядок вставки
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(path, { entry, expires: Date.now() + ttl });
    return entry;
  }

  return {
    render,
    stats: () => ({ entries: cache.size, maxEntries, ttlSec: ttlMs / 1000 }),
  };
}

/** Единый синглтон для тёплого инстанса Vercel-функции. */
export const renderer = createRenderer();

/**
 * Cache-Control для ответа функции: CDN Vercel кэширует GET-ответы функций
 * по s-maxage, поэтому первый же рендер пути раздаётся всем ботам с края.
 */
export function cacheControlFor(entry, env = process.env) {
  if (!entry || entry.status >= 500) return 'no-store';
  const sMaxAge = numEnv(env.DYNAMIC_RENDER_S_MAXAGE, 3600);
  const swr = numEnv(env.DYNAMIC_RENDER_SWR, 86_400);
  // 404 кэшируем на крае короче: тайтл могут опубликовать прямо сейчас
  const maxAge = entry.status === 404 ? Math.min(sMaxAge, 600) : sMaxAge;
  return `public, max-age=0, s-maxage=${maxAge}, stale-while-revalidate=${swr}`;
}
