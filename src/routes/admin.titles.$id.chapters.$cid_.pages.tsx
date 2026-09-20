import { createFileRoute, redirect } from '@tanstack/react-router';
import { assertEntityId } from '@/lib/routeParams';

/**
 * Совместимость со старыми ссылками/закладками вида
 * `/admin/titles/{id}/chapters/{cid}/pages`.
 *
 * Такого раздела в приложении нет: страницы главы и их загрузка живут на
 * `/admin/titles/$id/chapters/$cid`. Раньше переход по «/pages» заканчивался
 * ошибкой роутера (а при битых params — ещё и 400 от PostgREST), поэтому
 * здесь просто редиректим на канонический адрес с теми же params.
 *
 * Суффикс `_` в имени файла (`$cid_.pages`) отключает вложенность: роут не
 * становится ребёнком `$cid` и не требует `<Outlet />` в нём.
 */
export const Route = createFileRoute('/admin/titles/$id/chapters/$cid_/pages')({
  beforeLoad: ({ params }) => {
    const id = assertEntityId(params.id, 'тайтл');
    const cid = assertEntityId(params.cid, 'глава');
    throw redirect({
      to: '/admin/titles/$id/chapters/$cid',
      params: { id, cid },
      replace: true,
    });
  },
});
