/**
 * Smoke-тест слоя данных в демо-режиме (без Supabase, без браузера).
 * Модули загружаются через Vite SSR API, mockStore работает in-memory
 * (window/localStorage отсутствуют — save() просто no-op).
 *
 * ВАЖНО: тест проверяет именно демо-режим — Supabase-переменные обнуляются
 * через scripts/lib/demo-mode.mjs, иначе настроенный `.env` разработчика
 * уводит `src/data/*` в реальную базу (анонимный INSERT падает на RLS).
 *
 * Запуск: node scripts/smoke-data-layer.mjs
 */
import { createServer } from 'vite';
import { forceDemoMode, DEMO_SERVER_OPTIONS } from './lib/demo-mode.mjs';

forceDemoMode();

const server = await createServer(DEMO_SERVER_OPTIONS);

let failures = 0;
const check = (name, cond) => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
  if (!cond) failures++;
};

try {
  const { titles } = await server.ssrLoadModule('/src/data/titles.ts');
  const { chapters } = await server.ssrLoadModule('/src/data/chapters.ts');
  const { pages } = await server.ssrLoadModule('/src/data/pages.ts');
  const { mockStore } = await server.ssrLoadModule('/src/data/mockStore.ts');
  const { SlugConflictError, DuplicateChapterError } = await server.ssrLoadModule('/src/data/types.ts');

  // Сиды на месте
  check('сиды: три тайтла', (await titles.listAll()).length === 3);

  // Обложки сидов — файлы репозитория: /media/covers/{slug}.webp
  // (генерируются scripts/generate-seed-covers.mjs, лежат в public/media/covers/).
  const seeded = await titles.listAll();
  check(
    'обложки сидов — пути /media/covers/*.webp',
    seeded.every((t) => t.cover_url?.startsWith('/media/covers/') && t.cover_url?.endsWith('.webp'))
  );

  // Создание тайтла + конфликт slug
  const created = await titles.create({ title: 'Тест', slug: 'test-slug', genre_ids: [] });
  check('create вернул тайтл с id', Boolean(created.id));
  let caught = null;
  try {
    await titles.create({ title: 'Тест 2', slug: 'test-slug', genre_ids: [] });
  } catch (e) {
    caught = e;
  }
  check('дубликат slug бросает SlugConflictError', caught instanceof SlugConflictError);

  // Главы: дубликат номера
  const ch1 = await chapters.create({ title_id: created.id, number: 1, name: 'Первая' });
  caught = null;
  try {
    await chapters.create({ title_id: created.id, number: 1 });
  } catch (e) {
    caught = e;
  }
  check('дубликат номера главы бросает DuplicateChapterError', caught instanceof DuplicateChapterError);

  // Страницы + каскадное удаление тайтла
  await pages.create({ chapter_id: ch1.id, image_url: '/media/x.jpg', original_url: null, page_order: 1 });
  check('страница добавилась', (await pages.listByChapter(ch1.id)).length === 1);

  await titles.delete(created.id);
  check('тайтл удалён', (await titles.getById(created.id)) === null);
  check('главы удалились каскадом', (await chapters.listByTitle(created.id, true)).length === 0);
  check('страницы удалились каскадом', mockStore.getPagesByChapter(ch1.id).length === 0);

  // Удаление несуществующего — явная ошибка, а не тихий успех
  caught = null;
  try {
    await titles.delete('missing-id');
  } catch (e) {
    caught = e;
  }
  check('удаление несуществующего тайтла бросает ошибку', Boolean(caught));

  // Сиды не пострадали
  check('сиды не пострадали', (await titles.listAll()).length === 3);

  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`);
  process.exitCode = failures ? 1 : 0;
} finally {
  await server.close();
}
