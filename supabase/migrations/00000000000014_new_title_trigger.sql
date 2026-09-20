-- Расширение apply_admin_request: approve заявки new_title создаёт ЧЕРНОВИК
-- тайтла (published=false). Конфликт slug: on conflict do nothing + флаг
-- payload.conflict=true — owner видит предупреждение в /admin/requests.
--
-- slug генерируется SQL-функцией slugify_title с транслитерацией кириллицы
-- (та же карта, что в src/lib/slugify.ts): regexp_replace(lower(...)) из
-- «Магическая битва» дал бы пустой slug из одних дефисов.

-- ── slugify: та же логика, что src/lib/slugify.ts ──────────────────────────
create or replace function public.slugify_title(p_text text)
returns text
language sql
immutable
as $$
  select nullif(
    regexp_replace(
      regexp_replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
        replace(replace(replace(
          lower(trim(coalesce(p_text, ''))),
          'а', 'a'), 'б', 'b'), 'в', 'v'), 'г', 'g'), 'д', 'd'), 'е', 'e'), 'ё', 'yo'), 'ж', 'zh'),
          'з', 'z'), 'и', 'i'), 'й', 'y'), 'к', 'k'), 'л', 'l'), 'м', 'm'), 'н', 'n'), 'о', 'o'),
          'п', 'p'), 'р', 'r'), 'с', 's'), 'т', 't'), 'у', 'u'), 'ф', 'f'), 'х', 'kh'), 'ц', 'ts'),
          'ч', 'ch'), 'ш', 'sh'), 'щ', 'shch'), 'ъ', ''), 'ы', 'y'), 'ь', ''), 'э', 'e'),
          'ю', 'yu'), 'я', 'ya'),
        '[^a-z0-9]+', '-', 'g'
      ),
      '^-+|-+$', ''
    ),
    ''
  );
$$;

-- ── Полная версия триггера: ветки из 07 + new_title ─────────────────────────
CREATE OR REPLACE FUNCTION public.apply_admin_request()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_title_id UUID;
  v_number NUMERIC;
  v_name TEXT;
  v_chapter_id UUID;
  v_attempt INT := 0;
  v_slug TEXT;
  v_new_title_id UUID;
BEGIN
  IF NEW.status IS DISTINCT FROM 'approved' THEN
    RETURN NEW;
  END IF;
  -- Только переход pending → approved (не повторный UPDATE уже approved).
  IF OLD.status IS DISTINCT FROM 'pending' THEN
    RETURN NEW;
  END IF;

  -- Аудит: даже если клиент не прислал resolved_*, заполняем из сессии.
  NEW.resolved_at := COALESCE(NEW.resolved_at, now());
  NEW.resolved_by := COALESCE(NEW.resolved_by, auth.uid());

  IF NEW.type = 'delete_title' AND NEW.target_id IS NOT NULL THEN
    DELETE FROM public.titles WHERE id = NEW.target_id;

  ELSIF NEW.type = 'delete_chapter' AND NEW.target_id IS NOT NULL THEN
    DELETE FROM public.chapters WHERE id = NEW.target_id;

  ELSIF NEW.type = 'new_chapter' AND NEW.target_id IS NOT NULL THEN
    v_title_id := NEW.target_id;

    IF NOT EXISTS (SELECT 1 FROM public.titles WHERE id = v_title_id) THEN
      RAISE EXCEPTION 'new_chapter_missing_title'
        USING HINT = 'Тайтл не найден — возможно, уже удалён';
    END IF;

    BEGIN
      v_number := NULLIF(NEW.payload->>'suggested_number', '')::NUMERIC;
    EXCEPTION WHEN others THEN
      v_number := NULL;
    END;
    IF v_number IS NULL THEN
      SELECT COALESCE(MAX(number), 0) + 1 INTO v_number
      FROM public.chapters
      WHERE title_id = v_title_id;
    END IF;
    v_name := NULLIF(NEW.payload->>'name', '');

    IF EXISTS (
      SELECT 1 FROM public.chapters
      WHERE title_id = v_title_id AND number = v_number
    ) THEN
      SELECT COALESCE(MAX(number), 0) + 1 INTO v_number
      FROM public.chapters
      WHERE title_id = v_title_id;
    END IF;

    LOOP
      BEGIN
        INSERT INTO public.chapters (title_id, number, name, published)
        VALUES (v_title_id, v_number, v_name, false)
        RETURNING id INTO v_chapter_id;
        EXIT;
      EXCEPTION WHEN unique_violation THEN
        v_attempt := v_attempt + 1;
        IF v_attempt >= 8 THEN
          RAISE EXCEPTION 'new_chapter_conflict'
            USING HINT = 'Не удалось подобрать свободный номер главы после нескольких попыток';
        END IF;
        SELECT COALESCE(MAX(number), 0) + 1 INTO v_number
        FROM public.chapters
        WHERE title_id = v_title_id;
      END;
    END LOOP;

    NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
      || jsonb_build_object(
           'created_chapter_id', v_chapter_id,
           'created_number', v_number
         );

  ELSIF NEW.type = 'new_title' THEN
    -- Анонимная заявка: создаём ЧЕРНОВИК (published=false). Slug из
    -- original_title; занятый slug → conflict=true, owner видит предупреждение.
    v_slug := public.slugify_title(NEW.payload->>'original_title');
    IF v_slug IS NULL THEN
      v_slug := 'title-' || substr(md5(COALESCE(NEW.payload->>'original_title', NEW.id::text)), 1, 8);
    END IF;

    INSERT INTO public.titles (slug, title, author, description, cover_url, status, published)
    VALUES (
      v_slug,
      COALESCE(NULLIF(NEW.payload->>'original_title', ''), 'Без названия'),
      NULLIF(NEW.payload->>'author', ''),
      NULLIF(NEW.payload->>'description', ''),
      NULLIF(NEW.payload->>'cover_url', ''),
      COALESCE(NULLIF(NEW.payload->>'status', ''), 'ongoing'),
      false
    )
    ON CONFLICT (slug) DO NOTHING
    RETURNING id INTO v_new_title_id;

    IF v_new_title_id IS NULL THEN
      -- 0 строк: slug уже занят существующим тайтлом.
      NEW.conflict := true;
      NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
        || jsonb_build_object('conflict', true, 'conflict_slug', v_slug);
    ELSE
      NEW.conflict := false;
      NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
        || jsonb_build_object(
             'conflict', false,
             'created_title_id', v_new_title_id,
             'created_slug', v_slug
           );
    END IF;
  END IF;
  -- ad_request — без авто-применения (баннер owner создаёт в /admin/ads).

  RETURN NEW;
END;
$$;
