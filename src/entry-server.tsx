/**
 * Точка входа для пререндера (Node, без DOM).
 *
 * Используется только `scripts/prerender.mjs` во время сборки: рендерит
 * маршрут в строку через react-dom/server, чтобы в `dist` лежали статические
 * HTML с контентом и мета-тегами — поисковые боты получают страницы без
 * выполнения JS. В клиентский бандл не попадает.
 */
import { renderToString } from 'react-dom/server';
import {
  RouterProvider,
  createRouter,
  createMemoryHistory,
} from '@tanstack/react-router';
import { routeTree } from './routeTree.gen';
import { renderHeadTags, seoForRoute, type SeoInput } from '@/lib/seo';

export type PrerenderResult = {
  html: string;
  head: string;
  seo: SeoInput;
};

/** Маршрут не найден (несуществующий тайтл/глава) → боту отдаваем 404. */
export class PrerenderNotFoundError extends Error {
  constructor(routeId: string) {
    super(`not found on ${routeId}`);
    this.name = 'PrerenderNotFoundError';
  }
}

/** Loader упал с ошибкой (например, Supabase недоступен) → боту отдаём 503. */
export class PrerenderRenderError extends Error {
  constructor(routeId: string) {
    super(`loader error on ${routeId}`);
    this.name = 'PrerenderRenderError';
  }
}

type MatchLike = {
  routeId: string;
  status?: string;
  loaderData?: unknown;
};

export async function prerender(url: string): Promise<PrerenderResult> {
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: [url] }),
  });

  // Грузим данные всех loader'ов маршрута (Supabase/мок — как в браузере).
  await router.load();

  const matches = router.state.matches as Array<MatchLike>;
  const broken = matches.find((m) => m.status === 'error' || m.status === 'notFound');
  if (broken) {
    if (broken.status === 'notFound') {
      throw new PrerenderNotFoundError(broken.routeId);
    }
    throw new PrerenderRenderError(broken.routeId);
  }

  const last = matches[matches.length - 1];
  const routeId = last?.routeId ?? '';
  const seo: SeoInput = seoForRoute(routeId, last?.loaderData);

  const html = renderToString(<RouterProvider router={router} />);

  return { html, head: renderHeadTags(seo, url), seo };
}
