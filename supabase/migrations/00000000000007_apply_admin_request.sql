-- Авто-применение approved-заявок: delete_title / delete_chapter / new_chapter.
-- ad_request не трогаем — owner создаёт баннер вручную в /admin/ads.
-- SECURITY DEFINER: обходит RLS, т.к. owner уже прошёл policy UPDATE.
--
-- chapters(title_id, number) UNIQUE — см. 00000000000000_init.sql.
-- new_chapter: retry-loop на unique_violation (race между SELECT MAX и INSERT).

-- ── Pre-cleanup + идемпотентная страховка UNIQUE ────────────────────────────
-- Если в данных уже есть дубли (title_id, number) — ALTER UNIQUE упадёт и
-- заблокирует весь db push. Сначала soft-merge: оставляем главу с max(id)
-- (обычно самую «свежую»), остальные удаляем (pages каскадятся).
DO $$
DECLARE
  v_dups INT;
BEGIN
  SELECT count(*) INTO v_dups
  FROM (
    SELECT title_id, number
    FROM public.chapters
    GROUP BY title_id, number
    HAVING count(*) > 1
  ) d;

  IF v_dups > 0 THEN
    RAISE NOTICE
      '07_apply: found % duplicate (title_id, number) groups — keeping max(id), deleting rest',
      v_dups;

    DELETE FROM public.chapters c
    USING (
      SELECT title_id, number, max(id::text) AS keep_id
      FROM public.chapters
      GROUP BY title_id, number
      HAVING count(*) > 1
    ) d
    WHERE c.title_id = d.title_id
      AND c.number = d.number
      AND c.id::text <> d.keep_id;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.chapters'::regclass
      AND contype = 'u'
      AND pg_get_constraintdef(oid) ILIKE '%(title_id, number)%'
  ) THEN
    ALTER TABLE public.chapters
      ADD CONSTRAINT chapters_title_id_number_key UNIQUE (title_id, number);
    RAISE NOTICE '07_apply: added UNIQUE (title_id, number)';
  ELSE
    RAISE NOTICE '07_apply: UNIQUE (title_id, number) already present';
  END IF;
END $$;

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
    -- target_id = title_id; payload.suggested_number / name опциональны
    v_title_id := NEW.target_id;

    -- Тайтл мог быть удалён между submit и approve.
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

    -- Если номер занят — берём max+1 (ещё до INSERT)
    IF EXISTS (
      SELECT 1 FROM public.chapters
      WHERE title_id = v_title_id AND number = v_number
    ) THEN
      SELECT COALESCE(MAX(number), 0) + 1 INTO v_number
      FROM public.chapters
      WHERE title_id = v_title_id;
    END IF;

    -- Retry на unique_violation: параллельный INSERT мог занять тот же number
    -- между SELECT MAX и INSERT (UNIQUE (title_id, number) в init).
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

    -- Сохраняем id созданной главы в payload для аудита
    NEW.payload := COALESCE(NEW.payload, '{}'::jsonb)
      || jsonb_build_object(
           'created_chapter_id', v_chapter_id,
           'created_number', v_number
         );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_apply_admin_request ON public.admin_requests;
-- BEFORE UPDATE, чтобы можно было дописать payload / resolved_*
CREATE TRIGGER trg_apply_admin_request
  BEFORE UPDATE ON public.admin_requests
  FOR EACH ROW
  EXECUTE FUNCTION public.apply_admin_request();
