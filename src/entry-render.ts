/**
 * Entry динамического рендеринга (runtime, Node) — собирается отдельным
 * SSR-бандлом (`vite build --config vite.ssr.config.ts` → dist-ssr/render.mjs).
 *
 * Используется Vercel-функцией api/render.mjs (по rewrite из middleware.ts,
 * когда запрос пришёл от поискового бота) и локальным сервером
 * scripts/serve-dynamic.mjs. Отличие от build-time пререндера: рендер
 * происходит в момент запроса, поэтому бот видит и те тайтлы/главы,
 * которые опубликовали уже после сборки. В клиентский бандл не попадает.
 *
 * SPA-шаблон вшивается в бандл на этапе SSR-сборки через `?raw`-импорт
 * готового dist/index.html (поэтому SSR-сборка всегда идёт ПОСЛЕ клиентской).
 */
import rawTemplate from '../dist/ssr-shell.html?raw';
import { prerender, PrerenderNotFoundError } from './entry-server';
import { buildHtml } from '@/lib/render-html';

/** Неотрендеренный SPA-шелл — фолбэк для 404/503 и аварийных ситуаций. */
export const shellHtml: string = rawTemplate;

export type RenderPageResult = {
  html: string;
  status: number;
  reason: 'rendered' | 'not-found' | 'render-error';
};

/** Рендерит публичный маршрут в полный HTML для бота. Никогда не бросает. */
export async function renderPage(pathname: string): Promise<RenderPageResult> {
  try {
    const result = await prerender(pathname);
    return { html: buildHtml(rawTemplate, result), status: 200, reason: 'rendered' };
  } catch (error) {
    if (error instanceof PrerenderNotFoundError) {
      // Несуществующий тайтл/глава: честный 404 вместо soft-404 в индексе.
      return { html: rawTemplate, status: 404, reason: 'not-found' };
    }
    // Временная ошибка (СУБД недоступна и т.п.): 503 просит бота вернуться.
    console.error(
      `[dynamic-render] ошибка рендера ${pathname}:`,
      error instanceof Error ? error.message : error,
    );
    return { html: rawTemplate, status: 503, reason: 'render-error' };
  }
}
