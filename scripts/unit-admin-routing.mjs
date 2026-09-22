/**
 * Regression: the URL changed, but the chapters list hid its child routes.
 * Render the real generated route tree and loaders with demo data, not just
 * link destinations. No browser, production credentials or writes required.
 */
import assert from 'node:assert/strict';
import React from 'react';
import { renderToString } from 'react-dom/server';
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router';
import { createServer } from 'vite';
import { forceDemoMode, DEMO_SERVER_OPTIONS } from './lib/demo-mode.mjs';

forceDemoMode();
const vite = await createServer({ ...DEMO_SERVER_OPTIONS, mode: 'test' });

try {
  const { routeTree } = await vite.ssrLoadModule('/src/routeTree.gen.ts');
  const { auth } = await vite.ssrLoadModule('/src/data/auth.ts');
  const { mockStore } = await vite.ssrLoadModule('/src/data/mockStore.ts');
  const { chapters } = await vite.ssrLoadModule('/src/data/chapters.ts');

  // Only authentication is stubbed; keep all route components and data loaders.
  const originalGetSession = auth.getSession;
  const originalHasRole = auth.hasRole;
  auth.getSession = async () => ({ user: { id: 'routing-test-owner' } });
  auth.hasRole = async () => true;

  try {
    const title = mockStore.getTitles(false)[0];
    const [chapter] = await chapters.listByTitle(title.id, true);
    assert.ok(chapter, 'Demo title must have a chapter');
    const listUrl = `/admin/titles/${title.id}/chapters`;
    const editorUrl = `${listUrl}/${chapter.id}`;

    async function render(url, followRedirect = true) {
      const router = createRouter({
        routeTree,
        history: createMemoryHistory({ initialEntries: [url] }),
      });
      await router.load();
      if (router._serverResult?.type === 'redirect' && followRedirect) {
        return render(router._serverResult.redirect.options.href, false);
      }
      assert.ok(router.state.matches.length, `No matches for ${url}`);
      for (const match of router.state.matches) {
        assert.equal(match.status, 'success', `${url}: ${match.routeId}`);
      }
      return { router, html: renderToString(React.createElement(RouterProvider, { router })) };
    }

    for (const url of [listUrl, `${listUrl}/`]) {
      const { html } = await render(url);
      assert.ok(html.includes('Главы тайтла'), 'Chapter list is visible');
      assert.ok(html.includes(`href="${editorUrl}"`), 'Pages link retains real IDs');
      assert.ok(html.includes('Страницы и загрузка'));
      assert.ok(!html.includes('Загрузка страниц'), 'Editor is not part of the list');
      console.log(`PASS  chapters list: ${url}`);
    }

    const { html: editor } = await render(editorUrl);
    assert.ok(editor.includes('Редактирование главы'), 'Chapter editor is visible');
    assert.ok(editor.includes('Загрузка страниц'), 'Page uploader is visible');
    assert.ok(editor.includes('type="file"'), 'Upload file input is rendered');
    assert.ok(editor.includes('Список страниц'), 'Page sorting list is visible');
    assert.ok(editor.includes(`href="${listUrl}"`), 'Back link retains title ID');
    assert.ok(!editor.includes('Главы тайтла'), 'Chapter list does not wrap the editor');
    console.log('PASS  chapter editor replaces list and renders uploader');

    const { html: importer } = await render(`${listUrl}/import`);
    assert.ok(importer.includes('Импорт глав'));
    assert.ok(importer.includes('Загрузить .csv'), 'Import form is visible');
    assert.ok(!importer.includes('Главы тайтла'), 'Chapter list does not wrap import');
    console.log('PASS  import replaces list and renders CSV form');

    // On the server TanStack exposes redirects instead of following them.
    const legacyRouter = createRouter({
      routeTree,
      history: createMemoryHistory({ initialEntries: [`${editorUrl}/pages`] }),
    });
    await legacyRouter.load();
    assert.equal(legacyRouter._serverResult?.redirect?.options.href, editorUrl);
    console.log('PASS  legacy /pages URL redirects to the chapter editor');
  } finally {
    auth.getSession = originalGetSession;
    auth.hasRole = originalHasRole;
  }
} finally {
  await vite.close();
}
