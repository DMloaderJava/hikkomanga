-- Публикация тайтла в каталог.
--
-- Симптом: глава уже published=true, страницы залиты, а titles.published
-- остаётся false. Аноним видит главу по id, но не тайтл (RLS), каталог пустой,
-- /title/$slug отвечает «не найден». Переключатель в широкой таблице легко
-- не заметить, а прямой UPDATE может вернуть 0 строк, если у политики записи
-- нет WITH CHECK или у роли authenticated нет GRANT UPDATE.
--
-- set_title_published — запасной путь: SECURITY DEFINER после проверки
-- has_role(..., 'admin') (owner проходит её автоматически) пишет флаг в обход
-- сломанной политики. Клиент зовёт её, только если обычный UPDATE не изменил строку.

CREATE OR REPLACE FUNCTION public.set_title_published(p_id UUID, p_published BOOLEAN)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_updated INT;
BEGIN
  IF auth.uid() IS NULL OR NOT public.has_role(auth.uid(), 'admin') THEN
    RAISE EXCEPTION 'forbidden'
      USING HINT = 'Нет прав администратора';
  END IF;

  UPDATE public.titles
  SET published = COALESCE(p_published, false)
  WHERE id = p_id;

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated = 0 THEN
    RAISE EXCEPTION 'not_found'
      USING HINT = 'Тайтл не найден';
  END IF;

  RETURN COALESCE(p_published, false);
END;
$$;

REVOKE ALL ON FUNCTION public.set_title_published(UUID, BOOLEAN) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_title_published(UUID, BOOLEAN) TO authenticated;

-- Явный WITH CHECK: без него FOR ALL / USING иногда не пропускает UPDATE
-- колонки published (0 строк, клиент показывает «не удалось сохранить»).
DROP POLICY IF EXISTS "Admin write titles" ON public.titles;
CREATE POLICY "Admin write titles"
  ON public.titles
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

DROP POLICY IF EXISTS "Admin write chapters" ON public.chapters;
CREATE POLICY "Admin write chapters"
  ON public.chapters
  FOR ALL
  TO authenticated
  USING (public.has_role(auth.uid(), 'admin'))
  WITH CHECK (public.has_role(auth.uid(), 'admin'));

GRANT SELECT ON public.titles TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.titles TO authenticated;
GRANT SELECT ON public.chapters TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.chapters TO authenticated;
GRANT SELECT ON public.pages TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.pages TO authenticated;
GRANT SELECT ON public.genres TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.genres TO authenticated;
GRANT SELECT ON public.title_genres TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.title_genres TO authenticated;

-- Уже залитые главы с published=true не видны, пока тайтл — черновик.
-- Это и есть «не могу опубликовать»: глава в базе есть, каталог пустой.
-- Публикуем такие тайтлы один раз. Новые черновики без опубликованных глав не трогаем.
UPDATE public.titles AS t
SET published = true
WHERE t.published = false
  AND EXISTS (
    SELECT 1
    FROM public.chapters AS c
    WHERE c.title_id = t.id
      AND c.published = true
  );
