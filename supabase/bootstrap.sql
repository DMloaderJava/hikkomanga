-- ============================================================================
-- supabase/bootstrap.sql — СГЕНЕРИРОВАННЫЙ файл, не правьте его вручную.
-- Регенерация: npm run bootstrap:sql   (собирает supabase/migrations/*.sql)
--
-- ЧТО ЭТО: все миграции репозитория по порядку (20 файлов, ~65 КБ) —
-- схема, RLS, RPC, триггеры, бакеты Storage. Один заход для ЧИСТОГО проекта,
-- например при переезде на новый Supabase (docs/migrate-project.md).
--
-- КАК НАКАТИТЬ (SQL Editor):
--   1. Откройте проект → SQL Editor → New query;
--   2. вставьте этот файл ЦЕЛИКОМ (Ctrl+A на странице файла в GitHub → Copy);
--   3. Run. Ожидаемый результат — "Success. No rows returned";
--   4. проверьте: npm run check:supabase (разделы 3–5 без ✗).
--
-- ВАЖНО:
--   • Только для ПУСТОГО/НОВОГО проекта. На живом проекте повторный прогон
--     упадёт на CREATE POLICY — это защита, а не поломка: накатывайте
--     точечные миграции (DEPLOY.md → «Порядок первого деплоя»).
--   • Пользователи (auth.users) и секреты Edge Functions этим файлом НЕ
--     создаются — см. docs/migrate-project.md, шаги 3–4.
--   • Файл детерминирован: те же миграции → тот же bootstrap.sql.
-- ============================================================================


-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000000_init.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Supabase Schema & RLS for Hikkomanga

-- 1. Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Genres Table
CREATE TABLE IF NOT EXISTS public.genres (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 3. Titles Table
CREATE TABLE IF NOT EXISTS public.titles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  author TEXT,
  description TEXT,
  cover_url TEXT,
  status TEXT NOT NULL DEFAULT 'ongoing' CHECK (status IN ('ongoing', 'completed')),
  published BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 4. Title Genres Junction Table
CREATE TABLE IF NOT EXISTS public.title_genres (
  title_id UUID NOT NULL REFERENCES public.titles(id) ON DELETE CASCADE,
  genre_id UUID NOT NULL REFERENCES public.genres(id) ON DELETE CASCADE,
  PRIMARY KEY (title_id, genre_id)
);

-- 5. Chapters Table
CREATE TABLE IF NOT EXISTS public.chapters (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title_id UUID NOT NULL REFERENCES public.titles(id) ON DELETE CASCADE,
  number NUMERIC NOT NULL,
  name TEXT,
  published BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (title_id, number)
);

-- 6. Pages Table
CREATE TABLE IF NOT EXISTS public.pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id UUID NOT NULL REFERENCES public.chapters(id) ON DELETE CASCADE,
  image_url TEXT NOT NULL,
  original_url TEXT,
  page_order INT NOT NULL
);

-- 7. User Roles Table
CREATE TABLE IF NOT EXISTS public.user_roles (
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY (user_id, role)
);

-- 8. Security Definer Role Checker (Without Recursion)
CREATE OR REPLACE FUNCTION public.has_role(uid UUID, role_to_check TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = uid AND role = role_to_check
  );
$$;

-- 9. Enable Row Level Security (RLS)
ALTER TABLE public.genres ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.titles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.title_genres ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.chapters ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;

-- 10. RLS Policies

-- Genres
CREATE POLICY "Public read genres" ON public.genres FOR SELECT USING (true);
CREATE POLICY "Admin write genres" ON public.genres FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Titles
CREATE POLICY "Public read published titles" ON public.titles FOR SELECT USING (published = true OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin write titles" ON public.titles FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Title Genres
CREATE POLICY "Public read title_genres" ON public.title_genres FOR SELECT USING (true);
CREATE POLICY "Admin write title_genres" ON public.title_genres FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Chapters
CREATE POLICY "Public read published chapters" ON public.chapters FOR SELECT USING (published = true OR public.has_role(auth.uid(), 'admin'));
CREATE POLICY "Admin write chapters" ON public.chapters FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- Pages
CREATE POLICY "Public read pages" ON public.pages FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM public.chapters
    WHERE chapters.id = pages.chapter_id AND (chapters.published = true OR public.has_role(auth.uid(), 'admin'))
  )
);
CREATE POLICY "Admin write pages" ON public.pages FOR ALL USING (public.has_role(auth.uid(), 'admin'));

-- User Roles
CREATE POLICY "User read own roles" ON public.user_roles FOR SELECT USING (user_id = auth.uid() OR public.has_role(auth.uid(), 'admin'));

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000001_voiceovers.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Migration for Chapter Voiceovers & Voiceovers Storage Bucket

CREATE TABLE IF NOT EXISTS public.chapter_voiceovers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  chapter_id UUID UNIQUE NOT NULL REFERENCES public.chapters(id) ON DELETE CASCADE,
  audio_url TEXT NOT NULL,
  lines JSONB NOT NULL DEFAULT '[]',
  duration_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.chapter_voiceovers ENABLE ROW LEVEL SECURITY;

-- Admin only RLS Policies for Table
CREATE POLICY "Admin read voiceovers"
ON public.chapter_voiceovers FOR SELECT
USING (public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admin write voiceovers"
ON public.chapter_voiceovers FOR ALL
USING (public.has_role(auth.uid(), 'admin'));

-- Storage Bucket Policies for 'voiceovers' bucket
INSERT INTO storage.buckets (id, name, public)
VALUES ('voiceovers', 'voiceovers', true)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Admin write voiceovers bucket"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'voiceovers' AND public.has_role(auth.uid(), 'admin'));

CREATE POLICY "Admin read voiceovers bucket"
ON storage.objects FOR SELECT
TO authenticated
USING (bucket_id = 'voiceovers' AND public.has_role(auth.uid(), 'admin'));

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000002_storage_buckets.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Supabase Storage Buckets & Policies for Manga and Originals

insert into storage.buckets (id, name, public)
values
  ('manga', 'manga', true),
  ('hikko-originals', 'hikko-originals', false)
on conflict (id) do nothing;

create policy "Public read manga"
on storage.objects for select
using (bucket_id = 'manga');

create policy "Admin write manga"
on storage.objects for all
to authenticated
using (bucket_id = 'manga' and public.has_role(auth.uid(), 'admin'))
with check (bucket_id = 'manga' and public.has_role(auth.uid(), 'admin'));

create policy "Admin read originals"
on storage.objects for select
to authenticated
using (bucket_id = 'hikko-originals' and public.has_role(auth.uid(), 'admin'));

create policy "Admin write originals"
on storage.objects for all
to authenticated
using (bucket_id = 'hikko-originals' and public.has_role(auth.uid(), 'admin'))
with check (bucket_id = 'hikko-originals' and public.has_role(auth.uid(), 'admin'));

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000003_login_challenges.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Login Guard: обязательное подтверждение входа по письму.
-- Без approve-статуса challenge админ-панель не пускает, даже при валидной сессии.

CREATE TABLE IF NOT EXISTS public.login_challenges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  admin_email TEXT,
  user_agent TEXT,
  ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '15 minutes'),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS login_challenges_user_pending_idx
  ON public.login_challenges (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS login_challenges_token_idx
  ON public.login_challenges (token);

ALTER TABLE public.login_challenges ENABLE ROW LEVEL SECURITY;

-- Читать можно только свои challenge (для polling статуса на странице ожидания).
CREATE POLICY "User read own login challenges"
  ON public.login_challenges
  FOR SELECT
  USING (user_id = auth.uid());

-- Запись/апдейт — только через SECURITY DEFINER функции ниже (не напрямую).

-- Создать challenge для текущего пользователя. Старые pending гасятся.
CREATE OR REPLACE FUNCTION public.create_login_challenge(
  p_token TEXT,
  p_admin_email TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_ip TEXT DEFAULT NULL,
  p_ttl_minutes INT DEFAULT 15
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
  cid UUID;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_token IS NULL OR length(p_token) < 16 THEN
    RAISE EXCEPTION 'invalid token';
  END IF;

  UPDATE public.login_challenges
  SET status = 'expired', resolved_at = now()
  WHERE user_id = uid AND status = 'pending';

  INSERT INTO public.login_challenges (
    user_id, token, admin_email, user_agent, ip, expires_at
  ) VALUES (
    uid,
    p_token,
    p_admin_email,
    p_user_agent,
    p_ip,
    now() + make_interval(mins => GREATEST(1, LEAST(p_ttl_minutes, 60)))
  )
  RETURNING id INTO cid;

  RETURN cid;
END;
$$;

-- Подтвердить / отклонить по секретному токену из письма (без сессии).
CREATE OR REPLACE FUNCTION public.resolve_login_challenge(
  p_token TEXT,
  p_action TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  row public.login_challenges%ROWTYPE;
  act TEXT := lower(coalesce(p_action, ''));
BEGIN
  IF act NOT IN ('approve', 'deny') THEN
    RETURN 'invalid_action';
  END IF;

  SELECT * INTO row
  FROM public.login_challenges
  WHERE token = p_token
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN 'not_found';
  END IF;

  IF row.status = 'approved' THEN
    RETURN 'already_approved';
  END IF;
  IF row.status = 'denied' THEN
    RETURN 'already_denied';
  END IF;
  IF row.status = 'expired' OR row.expires_at < now() THEN
    IF row.status = 'pending' THEN
      UPDATE public.login_challenges
      SET status = 'expired', resolved_at = now()
      WHERE id = row.id;
    END IF;
    RETURN 'expired';
  END IF;

  IF act = 'approve' THEN
    UPDATE public.login_challenges
    SET status = 'approved', resolved_at = now()
    WHERE id = row.id;
    RETURN 'approved';
  ELSE
    UPDATE public.login_challenges
    SET status = 'denied', resolved_at = now()
    WHERE id = row.id;
    RETURN 'denied';
  END IF;
END;
$$;

-- Статус актуального challenge текущего пользователя (для polling).
-- Multi-device (session_id) — в 08_login_challenge_multidevice.sql.
CREATE OR REPLACE FUNCTION public.latest_login_challenge_status()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
  row public.login_challenges%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RETURN 'unauthenticated';
  END IF;

  SELECT * INTO row
  FROM public.login_challenges
  WHERE user_id = uid
  ORDER BY created_at DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RETURN 'none';
  END IF;

  IF row.status = 'pending' AND row.expires_at < now() THEN
    UPDATE public.login_challenges
    SET status = 'expired', resolved_at = now()
    WHERE id = row.id AND status = 'pending';
    RETURN 'expired';
  END IF;

  RETURN row.status;
END;
$$;

GRANT EXECUTE ON FUNCTION public.create_login_challenge(TEXT, TEXT, TEXT, TEXT, INT)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_login_challenge(TEXT, TEXT)
  TO anon, authenticated;
GRANT EXECUTE ON FUNCTION public.latest_login_challenge_status()
  TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000004_roles_and_requests.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Роли owner/admin + заявки администраторов (delete/new chapter/ads).
-- owner автоматически проходит has_role(..., 'admin').

-- Обновляем has_role: owner имеет права admin
CREATE OR REPLACE FUNCTION public.has_role(uid UUID, role_to_check TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = uid
      AND (
        role = role_to_check
        OR (role_to_check = 'admin' AND role = 'owner')
      )
  );
$$;

-- Типы заявок
DO $$ BEGIN
  CREATE TYPE public.request_type AS ENUM (
    'delete_title', 'delete_chapter', 'new_chapter', 'ad_request'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE public.request_status AS ENUM (
    'pending', 'approved', 'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Таблица заявок
CREATE TABLE IF NOT EXISTS public.admin_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type          public.request_type NOT NULL,
  -- nullable: публичная заявка на рекламу может прийти без аккаунта
  requester_id  UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  target_id     UUID,
  target_name   TEXT,
  payload       JSONB DEFAULT '{}',
  status        public.request_status NOT NULL DEFAULT 'pending',
  resolved_by   UUID REFERENCES auth.users(id),
  resolved_at   TIMESTAMPTZ,
  reject_reason TEXT,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.admin_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin sees own requests" ON public.admin_requests;
CREATE POLICY "admin sees own requests"
  ON public.admin_requests FOR SELECT
  USING (requester_id = auth.uid());

DROP POLICY IF EXISTS "owner sees all requests" ON public.admin_requests;
CREATE POLICY "owner sees all requests"
  ON public.admin_requests FOR SELECT
  USING (public.has_role(auth.uid(), 'owner'));

DROP POLICY IF EXISTS "admin can insert" ON public.admin_requests;
CREATE POLICY "admin can insert"
  ON public.admin_requests FOR INSERT
  WITH CHECK (
    public.has_role(auth.uid(), 'admin')
    AND requester_id = auth.uid()
    AND type <> 'ad_request'
  );

-- Публичные (и залогиненные) заявки на рекламу
DROP POLICY IF EXISTS "anyone can insert ad_request" ON public.admin_requests;
CREATE POLICY "anyone can insert ad_request"
  ON public.admin_requests FOR INSERT
  WITH CHECK (
    type = 'ad_request'
    AND (requester_id IS NULL OR requester_id = auth.uid())
  );

DROP POLICY IF EXISTS "owner can update status" ON public.admin_requests;
CREATE POLICY "owner can update status"
  ON public.admin_requests FOR UPDATE
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

CREATE INDEX IF NOT EXISTS admin_requests_status_created_idx
  ON public.admin_requests (status, created_at DESC);

-- Спам-защита: не более 10 заявок в час с одного requester (или IP-less public key)
CREATE OR REPLACE FUNCTION public.check_request_rate_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  recent_count INT;
BEGIN
  IF NEW.requester_id IS NULL THEN
    -- публичные ad_request без uid: лимит по note+payload хешу не делаем жёстко,
    -- считаем все анонимные ad_request за час
    SELECT count(*) INTO recent_count
    FROM public.admin_requests
    WHERE requester_id IS NULL
      AND type = 'ad_request'
      AND created_at > now() - interval '1 hour';
    IF recent_count >= 30 THEN
      RAISE EXCEPTION 'rate_limit_exceeded'
        USING HINT = 'Не более 30 анонимных заявок в час';
    END IF;
    RETURN NEW;
  END IF;

  SELECT count(*) INTO recent_count
  FROM public.admin_requests
  WHERE requester_id = NEW.requester_id
    AND created_at > now() - interval '1 hour';
  IF recent_count >= 10 THEN
    RAISE EXCEPTION 'rate_limit_exceeded'
      USING HINT = 'Не более 10 заявок в час';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS enforce_request_rate_limit ON public.admin_requests;
CREATE TRIGGER enforce_request_rate_limit
  BEFORE INSERT ON public.admin_requests
  FOR EACH ROW EXECUTE FUNCTION public.check_request_rate_limit();

GRANT EXECUTE ON FUNCTION public.has_role(UUID, TEXT) TO anon, authenticated;

-- Явные grants: anon может вставлять ad_request (публичная форма /advertise),
-- authenticated — свои заявки; SELECT/UPDATE закрыты RLS.
GRANT SELECT, INSERT, UPDATE ON public.admin_requests TO authenticated;
GRANT INSERT ON public.admin_requests TO anon;
GRANT USAGE ON TYPE public.request_type TO anon, authenticated;
GRANT USAGE ON TYPE public.request_status TO anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000005_rate_limit_log.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Общий лог rate-limit (на будущее: edge-функции, публичные формы).

CREATE TABLE IF NOT EXISTS public.rate_limit_log (
  id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  key        TEXT NOT NULL,
  action     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS rate_limit_log_lookup_idx
  ON public.rate_limit_log (key, action, created_at);

CREATE OR REPLACE FUNCTION public.cleanup_rate_limit_log()
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  DELETE FROM public.rate_limit_log
  WHERE created_at < now() - interval '24 hours';
$$;

ALTER TABLE public.rate_limit_log ENABLE ROW LEVEL SECURITY;

-- Прямого доступа клиенту нет — только SECURITY DEFINER / service role.
DROP POLICY IF EXISTS "no direct client access" ON public.rate_limit_log;
CREATE POLICY "no direct client access"
  ON public.rate_limit_log FOR ALL
  USING (false);

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000006_ads.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Рекламные баннеры между главами.

CREATE TABLE IF NOT EXISTS public.ads (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title           TEXT NOT NULL,
  description     TEXT,
  image_url       TEXT,
  link_url        TEXT NOT NULL,
  link_label      TEXT NOT NULL DEFAULT 'Перейти',
  placement       TEXT NOT NULL DEFAULT 'between_chapters',
  active          BOOLEAN NOT NULL DEFAULT true,
  advertiser_name TEXT,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.ads ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "public reads active ads" ON public.ads;
CREATE POLICY "public reads active ads"
  ON public.ads FOR SELECT
  USING (
    active = true
    AND (expires_at IS NULL OR expires_at > now())
  );

DROP POLICY IF EXISTS "owner manages ads" ON public.ads;
CREATE POLICY "owner manages ads"
  ON public.ads FOR ALL
  USING (public.has_role(auth.uid(), 'owner'))
  WITH CHECK (public.has_role(auth.uid(), 'owner'));

CREATE INDEX IF NOT EXISTS ads_placement_active_idx
  ON public.ads (placement, active, created_at DESC);

GRANT SELECT ON public.ads TO anon, authenticated;
-- Явные grants (не ALL): RLS всё равно режет, но принцип least-privilege.
GRANT SELECT, INSERT, UPDATE, DELETE ON public.ads TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000007_apply_admin_request.sql
-- ────────────────────────────────────────────────────────────────────────────

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

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000008_login_challenge_multidevice.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Multi-device Login Guard через session_id (JWT session_id / GoTrue).
--
-- Проблема «latest by created_at»:
--   - login на телефоне гасил approved-ноут (старый баг);
--   - «любой approved» открывал Guard навсегда (регрессия) — НЕ используем.
--
-- Решение: challenge привязан к session_id.
--   - ноут (S1) видит только свой challenge;
--   - телефон (S2) — только свой; pending S2 не трогает approved S1;
--   - новый login = новый session_id = новый challenge обязателен.
--
-- session_id берётся из JWT claim `session_id` (Supabase Auth / GoTrue).
-- Edge login-notify передаёт p_session_id явно (fallback — auth.jwt()).

ALTER TABLE public.login_challenges
  ADD COLUMN IF NOT EXISTS session_id TEXT;

CREATE INDEX IF NOT EXISTS login_challenges_user_session_idx
  ON public.login_challenges (user_id, session_id, created_at DESC);

-- Postgres различает функции по числу/типам args (DEFAULT не меняет сигнатуру).
-- Старая 5-arg из 03 гасит ВСЕ pending и пишет session_id=NULL — DROP, иначе
-- 5-arg вызов (или PostgREST ambiguity) обходит multi-device.
DROP FUNCTION IF EXISTS public.create_login_challenge(TEXT, TEXT, TEXT, TEXT, INT);

-- Создать challenge для ТЕКУЩЕЙ сессии. Гасим только pending этой же session_id.
CREATE OR REPLACE FUNCTION public.create_login_challenge(
  p_token TEXT,
  p_admin_email TEXT DEFAULT NULL,
  p_user_agent TEXT DEFAULT NULL,
  p_ip TEXT DEFAULT NULL,
  p_ttl_minutes INT DEFAULT 15,
  p_session_id TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
  sid TEXT;
  cid UUID;
BEGIN
  IF uid IS NULL THEN
    RAISE EXCEPTION 'not authenticated';
  END IF;
  IF p_token IS NULL OR length(p_token) < 16 THEN
    RAISE EXCEPTION 'invalid token';
  END IF;

  -- session_id: явный аргумент → JWT claim → null (legacy single-device).
  sid := NULLIF(trim(COALESCE(
    p_session_id,
    auth.jwt() ->> 'session_id',
    ''
  )), '');

  -- Гасим только pending ЭТОЙ сессии (другие устройства не трогаем).
  IF sid IS NOT NULL THEN
    UPDATE public.login_challenges
    SET status = 'expired', resolved_at = now()
    WHERE user_id = uid
      AND status = 'pending'
      AND session_id IS NOT DISTINCT FROM sid;
  ELSE
    -- Legacy: без session_id — гасим все pending пользователя (старое поведение).
    UPDATE public.login_challenges
    SET status = 'expired', resolved_at = now()
    WHERE user_id = uid AND status = 'pending';
  END IF;

  INSERT INTO public.login_challenges (
    user_id, token, admin_email, user_agent, ip, expires_at, session_id
  ) VALUES (
    uid,
    p_token,
    p_admin_email,
    p_user_agent,
    p_ip,
    now() + make_interval(mins => GREATEST(1, LEAST(p_ttl_minutes, 60))),
    sid
  )
  RETURNING id INTO cid;

  RETURN cid;
END;
$$;

-- Статус challenge ТЕКУЩЕЙ сессии (не «любой approved»).
CREATE OR REPLACE FUNCTION public.latest_login_challenge_status()
RETURNS TEXT
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid UUID := auth.uid();
  sid TEXT;
  row public.login_challenges%ROWTYPE;
BEGIN
  IF uid IS NULL THEN
    RETURN 'unauthenticated';
  END IF;

  sid := NULLIF(trim(COALESCE(auth.jwt() ->> 'session_id', '')), '');

  IF sid IS NOT NULL THEN
    SELECT * INTO row
    FROM public.login_challenges
    WHERE user_id = uid
      AND session_id IS NOT DISTINCT FROM sid
    ORDER BY created_at DESC
    LIMIT 1;
  ELSE
    -- Legacy fallback (нет claim): последний challenge пользователя.
    SELECT * INTO row
    FROM public.login_challenges
    WHERE user_id = uid
    ORDER BY created_at DESC
    LIMIT 1;
  END IF;

  IF NOT FOUND THEN
    RETURN 'none';
  END IF;

  IF row.status = 'pending' AND row.expires_at < now() THEN
    UPDATE public.login_challenges
    SET status = 'expired', resolved_at = now()
    WHERE id = row.id AND status = 'pending';
    RETURN 'expired';
  END IF;

  -- approved для ЭТОЙ session_id — доступ открыт (не истекает по expires_at).
  -- Новый login = новый session_id = снова pending.
  RETURN row.status;
END;
$$;

-- Только 6-arg сигнатура (5-arg удалена выше).
GRANT EXECUTE ON FUNCTION public.create_login_challenge(TEXT, TEXT, TEXT, TEXT, INT, TEXT)
  TO authenticated;
GRANT EXECUTE ON FUNCTION public.latest_login_challenge_status()
  TO authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000010_submission_columns.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Анонимные заявки на новый тайтл (new_title): колонки аудита, типы, бакет.
-- Подробности флоу — SETUP_SUPABASE.md, раздел «Приём заявок».

-- ── 1. Новые колонки admin_requests ─────────────────────────────────────────
alter table public.admin_requests
  add column if not exists ip_hash text,
  add column if not exists user_agent text,
  add column if not exists turnstile_ok boolean default false,
  add column if not exists public_token text unique,
  add column if not exists submitter_email text,
  add column if not exists conflict boolean default false;

create index if not exists admin_requests_ip_hash_idx
  on public.admin_requests (ip_hash, created_at desc);
create index if not exists admin_requests_public_token_idx
  on public.admin_requests (public_token);

-- ── 2. Типы заявок: модель готова к будущим итерациям, UI v1 использует
--      только new_title. Enum-значения добавить в отдельном DO-блоке
--      (идемпотентно), CHECK делаем по ::text — сравнение текстом не зависит
--      от транзакционных ограничений ALTER TYPE ADD VALUE.
DO $$ BEGIN
  ALTER TYPE public.request_type ADD VALUE IF NOT EXISTS 'new_title';
  ALTER TYPE public.request_type ADD VALUE IF NOT EXISTS 'new_team';
  ALTER TYPE public.request_type ADD VALUE IF NOT EXISTS 'new_person';
  ALTER TYPE public.request_type ADD VALUE IF NOT EXISTS 'new_character';
  ALTER TYPE public.request_type ADD VALUE IF NOT EXISTS 'new_publisher';
  ALTER TYPE public.request_type ADD VALUE IF NOT EXISTS 'new_card';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  ALTER TYPE public.request_status ADD VALUE IF NOT EXISTS 'spam';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 3. Бакет submissions (обложки анонимных заявок) ────────────────────────
-- Публичный: обложка становится cover_url черновика тайтла после approve и
-- должна рендериться без подписанных URL. Пишет только service_role
-- (edge-функция submit-title), клиентских INSERT-политик нет.
insert into storage.buckets (id, name, public)
values ('submissions', 'submissions', true)
on conflict (id) do nothing;

drop policy if exists "public read submissions" on storage.objects;
create policy "public read submissions"
  on storage.objects for select
  using (bucket_id = 'submissions');

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000011_requests_rls_anon.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Анонимам INSERT в admin_requests запрещён: заявки на тайтл создаёт
-- edge-функция submit-title под service_role (после Turnstile + rate limit).
-- Просмотр статуса заявителем — тоже через edge-функцию get-submission,
-- поэтому анонам SELECT не даём.
--
-- ВАЖНО: политика "anyone can insert ad_request" (00000000000004) остаётся —
-- публичная форма /advertise продолжает работать. RLS-политики OR'ятся,
-- так что эта with check (false) не блокирует ad_request, а явно фиксирует:
-- прямого пути anon → new_title нет.
drop policy if exists "no anon insert" on public.admin_requests;
create policy "no anon insert"
on public.admin_requests for insert
to anon
with check (false);

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000012_rate_limit_ip.sql
-- ────────────────────────────────────────────────────────────────────────────

-- IP-rate-limit для анонимных заявок: фиксированные окна по (ip_hash, окно).
-- Хранится только sha256(ip + RATE_LIMIT_SALT) — сырой IP не пишется нигде.
-- Пишет только service_role (edge-функции); клиенту таблица недоступна.

create table if not exists public.ip_rate_limit (
  ip_hash text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (ip_hash, window_start)
);

alter table public.ip_rate_limit enable row level security;

-- Прямого доступа клиенту нет — только SECURITY DEFINER / service role.
drop policy if exists "no direct client access" on public.ip_rate_limit;
create policy "no direct client access"
  on public.ip_rate_limit for all
  using (false);

-- Атомарный инкремент счётчика окна; false = лимит превышен.
-- Вызывается edge-функцией трижды: (60, 15), (3600, 100), (86400, 300).
create or replace function public.check_ip_rate_limit(
  p_ip_hash text,
  p_limit int,
  p_window_seconds int
) returns boolean
language plpgsql security definer as $$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  v_count int;
begin
  insert into public.ip_rate_limit (ip_hash, window_start, count)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
    do update set count = ip_rate_limit.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke all on function public.check_ip_rate_limit(text, int, int) from anon, authenticated;

-- Именование: НЕ cleanup_rate_limit (конфликт смысла с cleanup_rate_limit_log
-- из 00000000000005). Чистит только окна ip_rate_limit старше 2 дней.
create or replace function public.cleanup_ip_rate_limit() returns void
language sql as $$
  delete from public.ip_rate_limit where window_start < now() - interval '2 days';
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000013_submissions_cleanup.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Автоочистка отклонённых/спам-заявок старше 90 дней.
-- Файлы обложек в бакете submissions не удаляем здесь (нужен service_role):
-- строка помечается payload.purged=true, а разовую зачистку бакета удобнее
-- делать через Dashboard → Storage (см. SETUP_SUPABASE.md, «Приём заявок»).
create or replace function public.cleanup_rejected_submissions() returns void
language plpgsql security definer as $$
declare
  r record;
begin
  for r in
    select id, public_token
    from public.admin_requests
    where status in ('rejected','spam')
      and resolved_at < now() - interval '90 days'
      and coalesce((payload->>'purged')::boolean, false) = false
  loop
    update public.admin_requests
      set payload = jsonb_build_object('purged', true),
          -- обложка и персональные данные больше не нужны
          submitter_email = null,
          ip_hash = null,
          user_agent = null
      where id = r.id;
  end loop;
end;
$$;

revoke all on function public.cleanup_rejected_submissions() from anon, authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000014_new_title_trigger.sql
-- ────────────────────────────────────────────────────────────────────────────

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

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000015_chapter_submissions.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Заявки на главы (new_chapters) + перенос файлов при approve.
--
-- Флоу: аноним шлёт главы через edge submit-chapters → файлы ложатся в
-- submissions/{token}/ch-{n}/page-{m}.{ext} → owner в /admin/requests жмёт
-- «Одобрить» → клиент вызывает edge finalize-chapter-submission, которая
-- создаёт главы (published=false), переносит страницы в manga/{chapterId}/…
-- и удаляет исходники из submissions.
--
-- Триггер apply_admin_request для new_chapters НЕ нужен: перенос файлов
-- из storage внутри триггера невозможен, поэтому шаг 2 делает edge-функция,
-- а её результат пишется в finalized_at / finalized_error.
-- Подробности — SETUP_SUPABASE.md, раздел «Заявки на главы».

-- ── 1. Тип заявки ───────────────────────────────────────────────────────────
-- DO-блок с EXCEPTION: ALTER TYPE ... ADD VALUE нельзя повторять, а
-- IF NOT EXISTS появился только в PG 12 — повторяем паттерн миграции 10.
DO $$ BEGIN
  ALTER TYPE public.request_type ADD VALUE IF NOT EXISTS 'new_chapters';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Колонки завершения импорта ───────────────────────────────────────────
-- finalized_at != null — импорт глав выполнен (edge идемпотентна: повторный
-- вызов для такой заявки = no-op). finalized_error — текст последней ошибки,
-- по нему в /admin/requests показывается кнопка «Завершить импорт».
alter table public.admin_requests
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_error text;

-- ── 3. Описание главы ───────────────────────────────────────────────────────
-- Заявка на главы и CSV-импорт приносят необязательное описание главы, а в
-- chapters были только number/name. Колонка nullable — старые главы не трогаем.
alter table public.chapters
  add column if not exists description text;

-- ── 4. Индекс инбокса ───────────────────────────────────────────────────────
-- Owner-инбокс фильтрует по типу и статусу с сортировкой по created_at;
-- admin_requests_status_created_idx из 04 не покрывает фильтр по типу.
create index if not exists admin_requests_type_status_idx
  on public.admin_requests (type, status, created_at desc);

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000017_user_api_keys.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Персональные Gemini API key для админов (замена общего секрета GEMINI_API_KEY).
--
-- Хранится ТОЛЬКО шифротекст (AES-256-GCM, см. supabase/functions/_shared/crypto.ts):
-- ключ шифрования живёт в Edge Secret USER_KEY_ENC_SECRET и в базу не попадает.
-- Плейнтекст и расшифрованный ключ никогда не уходят в REST API: колонки
-- ciphertext/iv читает только edge-функция gemini-proxy под service-ролью,
-- а браузер получает исключительно last4 (см. политику SELECT).
--
-- Номер 017: в репозитории последняя занятая версия — 015, 016 пропущен
-- намеренно (задел под параллельные ветки). Пропуск безвреден — Supabase
-- применяет миграции по возрастанию версии.

create table if not exists public.user_api_keys (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  provider   text not null default 'gemini',
  -- base64(AES-256-GCM ciphertext) и base64(12-байтный IV)
  ciphertext text not null,
  iv         text not null,
  -- последние 4 символа ключа — единственное, что показывается в UI
  last4      text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.user_api_keys is
  'Персональные Gemini API key админов. Только шифротекст; ключ расшифровки — Edge Secret USER_KEY_ENC_SECRET.';

alter table public.user_api_keys enable row level security;

-- Каждый админ видит/меняет ТОЛЬКО свою строку. Дополнительно требуется роль
-- admin (владелец проходит has_role(..., 'admin') автоматически).
--
-- ВАЖНО: политика разрешает SELECT всей строки, включая ciphertext/iv — это
-- осознанно: расшифровать без USER_KEY_ENC_SECRET всё равно нельзя, а
-- browser-клиент (src/data/apiKeys.ts) читает статус напрямую через PostgREST.
-- Не превращайте ciphertext в «секрет от самого пользователя»: ключ и так его.
drop policy if exists "user_api_keys_select_own_admin" on public.user_api_keys;
create policy "user_api_keys_select_own_admin"
  on public.user_api_keys for select
  using (user_id = auth.uid() and public.has_role(auth.uid(), 'admin'));

drop policy if exists "user_api_keys_insert_own_admin" on public.user_api_keys;
create policy "user_api_keys_insert_own_admin"
  on public.user_api_keys for insert
  with check (user_id = auth.uid() and public.has_role(auth.uid(), 'admin'));

drop policy if exists "user_api_keys_update_own_admin" on public.user_api_keys;
create policy "user_api_keys_update_own_admin"
  on public.user_api_keys for update
  using (user_id = auth.uid() and public.has_role(auth.uid(), 'admin'))
  with check (user_id = auth.uid() and public.has_role(auth.uid(), 'admin'));

drop policy if exists "user_api_keys_delete_own_admin" on public.user_api_keys;
create policy "user_api_keys_delete_own_admin"
  on public.user_api_keys for delete
  using (user_id = auth.uid() and public.has_role(auth.uid(), 'admin'));

create or replace function public.tg_user_api_keys_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists user_api_keys_updated_at on public.user_api_keys;
create trigger user_api_keys_updated_at
  before update on public.user_api_keys
  for each row execute function public.tg_user_api_keys_updated_at();

-- Явные grants (не ALL): RLS всё равно режет, но принцип least-privilege.
-- anon не получает ничего: строки привязаны к auth.users.
revoke all on public.user_api_keys from anon;
grant select, insert, update, delete on public.user_api_keys to authenticated;

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000018_publish_title.sql
-- ────────────────────────────────────────────────────────────────────────────

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

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000019_title_covers.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Обложки тайтлов, загруженные из админки (TitleForm → «Загрузить файл»).
--
-- ВНИМАНИЕ: бакет переименован — см. 00000000000020_title_covers_bucket.sql.
-- Актуальное имя бакета `title-covers` (то же, что COVER_BUCKET в
-- src/data/storage.ts), форматы — JPEG/PNG/WebP/GIF. Эта миграция оставлена
-- как есть ради уже накатанных проектов; 20-я создаёт `title-covers` и
-- убирает пустой `covers`.
--
-- Штатная обложка по-прежнему файл репозитория: public/media/covers/{имя}.webp,
-- в titles.cover_url относительный путь /media/covers/{имя}.webp (кэш 'self',
-- вес каталога ограничен бюджетом — scripts/check-budgets.mjs). Этот бакет —
-- второй способ: админ выбирает файл, клиент жмёт его в WebP ≤800 px
-- (src/lib/coverUpload.ts) и кладёт сюда, а в titles.cover_url записывается
-- публичный URL …/storage/v1/object/public/covers/{slug}-{time}-{rand}.webp.
--
-- Бакет ПУБЛИЧНЫЙ: обложку читает анонимный посетитель каталога, подписанных
-- URL нет. Пишет только роль admin — та же схема, что у бакета `manga`
-- (00000000000002_storage_buckets.sql).

insert into storage.buckets (id, name, public)
values ('covers', 'covers', true)
on conflict (id) do update set public = true;

drop policy if exists "public read covers" on storage.objects;
create policy "public read covers"
  on storage.objects for select
  using (bucket_id = 'covers');

drop policy if exists "admin write covers" on storage.objects;
create policy "admin write covers"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'covers' and public.has_role(auth.uid(), 'admin'))
  with check (bucket_id = 'covers' and public.has_role(auth.uid(), 'admin'));

-- Проверка: npm run check:supabase (раздел «5. Бакеты Storage») и
-- npm run check:covers — он проверяет и файлы в public/, и URL из этого бакета.
--
-- Файл переименован с 00000000000018_title_covers.sql: версию 18 делили два
-- файла (ещё и 00000000000018_publish_title.sql), а дубль версии ломает
-- supabase db push и проверку «версии миграций уникальны» в npm test.

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000020_title_covers_bucket.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Обложки тайтлов, загруженные из админки: бакет `title-covers` + любые
-- распространённые форматы изображений.
--
-- Зачем эта миграция (вместо правки 00000000000019_title_covers.sql):
--  1. ИМЯ БАКЕТА. 19-я миграция создавала бакет `covers`. В живом проекте
--     бакет называется `title-covers`, а `covers` нет вовсе — клиент
--     (src/data/storage.ts → COVER_BUCKET) стучался в `/object/covers/…` и
--     получал 400 «Bucket not found». Теперь клиент и бакет называются
--     одинаково: `title-covers`.
--  2. ФОРМАТЫ. Форма TitleForm принимает JPEG, PNG, WebP и GIF (GIF уходит в
--     бакет как есть — с анимацией, src/lib/coverUpload.ts). Ограничение
--     осталось прежним: 5 MB на исходник (COVER_MAX_BYTES) — здесь это
--     file_size_limit, дублирующий клиентскую проверку.
--
-- Бакет ПУБЛИЧНЫЙ: обложку читает анонимный посетитель каталога, подписанных
-- URL нет. Пишет только роль admin — та же схема, что у бакета `manga`
-- (00000000000002_storage_buckets.sql).
--
-- Штатная обложка по-прежнему может быть файлом репозитория:
-- public/media/covers/{имя}.webp и относительный путь /media/covers/{имя}.webp
-- в titles.cover_url (кэш 'self', вес каталога ограничен бюджетом —
-- scripts/check-budgets.mjs).

insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values (
  'title-covers',
  'title-covers',
  true,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  5 * 1024 * 1024
)
on conflict (id) do update set
  public = true,
  allowed_mime_types = excluded.allowed_mime_types,
  file_size_limit = excluded.file_size_limit;

drop policy if exists "public read title-covers" on storage.objects;
create policy "public read title-covers"
  on storage.objects for select
  using (bucket_id = 'title-covers');

drop policy if exists "admin write title-covers" on storage.objects;
create policy "admin write title-covers"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'title-covers' and public.has_role(auth.uid(), 'admin'))
  with check (bucket_id = 'title-covers' and public.has_role(auth.uid(), 'admin'));

-- Прежний бакет `covers` (миграция 19) убираем, но только пустой: объекты
-- Storage физически лежат в префиксе своего бакета, поэтому «перенести» их
-- SQL-ом нельзя. Если в нём что-то есть — оставьте как есть: клиент всё ещё
-- умеет удалять такие обложки при замене (LEGACY_COVER_BUCKETS в
-- src/data/storage.ts), а переложить файлы можно в Storage → covers.
do $$
begin
  if not exists (select 1 from storage.objects where bucket_id = 'covers') then
    drop policy if exists "public read covers" on storage.objects;
    drop policy if exists "admin write covers" on storage.objects;
    delete from storage.buckets where id = 'covers';
  else
    raise notice 'Бакет `covers` не пуст — объекты оставлены; перенесите их в `title-covers` вручную.';
  end if;
end $$;

-- Проверка: npm run check:supabase (раздел «5. Бакеты Storage») и
-- npm run check:covers — он проверяет и файлы в public/, и URL из этого бакета.

-- ────────────────────────────────────────────────────────────────────────────
-- 00000000000021_restore_function_grants.sql
-- ────────────────────────────────────────────────────────────────────────────

-- Возврат EXECUTE-прав на функции public, от которых зависит вход в админку
-- (Login Guard) и админские письма.
--
-- Симптом (реальный прод): пароль верный, экран «Подтвердите вход» и/или
-- красная плашка «Вход отклонён», а письмо подтверждения НЕ приходит вообще —
-- потому что edge-функция не может выполнить ни один RPC:
--
--   login-notify → rpc('has_role')              → permission denied for function has_role
--   login-notify → rpc('create_login_challenge') → permission denied for function create_login_challenge
--   login-confirm → rpc('resolve_login_challenge') → permission denied (ссылка из письма не работает)
--   браузер       → rpc('latest_login_challenge_status') → permission denied (экран ожидания «висит»)
--
-- Клиент показывает это как `errorKind: 'db-grants'` (см. src/data/notify.ts,
-- OWNER_HINTS в /admin/login), а `npm run check:supabase` — как
-- «permission denied for function …» в разделе 4 «Функции БД (RPC)».
--
-- Причина: на проекте слетели гранты на EXECUTE для ролей anon/authenticated/
-- service_role. Такое случается после ручного REVOKE (например, при «harden
-- functions» по Security Advisor) или когда миграции 03/04/08 накатывали в
-- SQL Editor, а строки GRANT из файла не выполнились. Миграции выдавали права
-- явно, и зависимостей от default-прав PUBLIC у проекта нет: без этих строк
-- функции существуют, но исполнять их нельзя никому, кроме postgres.
--
-- Файл идемпотентен и устойчив к частично накатанной схеме: каждая выдача
-- обёрнута в проверку `to_regprocedure(...) is not null`, поэтому отсутствие
-- какой-то функции (например, ещё не накатана 08) не роняет весь скрипт —
-- в Message видно «пропуск: <функция> не существует на этом проекте».
--
-- Накат (на этом проекте `supabase db push` не работает — пустая локальная
-- история миграций, см. DEPLOY.md):
--   1) Supabase → SQL Editor → вставить файл целиком → Run;
--   2) либо одной командой:
--        supabase db query --linked -f supabase/migrations/00000000000021_restore_function_grants.sql
--
-- Проверка после наката (publishable/anon-ключ публичный):
--   curl -s -X POST -H 'apikey: <publishable-key>' \
--     -H 'Content-Type: application/json' \
--     -d '{"uid":"00000000-0000-0000-0000-000000000000","role_to_check":"admin"}' \
--     https://<ref>.supabase.co/rest/v1/rpc/has_role
--   # было 42501 «permission denied for function has_role»; должно стать 200 false
--   npm run check:supabase   # раздел 4 без ✗

do $grants$
declare
  item record;
begin
  for item in
    select *
    from (
      values
        -- ── Login Guard ─────────────────────────────────────────────────────
        -- has_role зовут: клиент (auth.hasRole), все админские edge-функции
        -- под JWT пользователя (authenticated) и RLS-политики admin_requests/
        -- ads/user_api_keys. Роль anon нужна публичным политикам
        -- (INSERT ad_request на /advertise) — так задумано в
        -- 04_roles_and_requests.sql.
        ('public.has_role(uuid,text)', 'anon, authenticated'),

        -- Ссылку из письма открывают БЕЗ сессии: страница /admin/login/confirm
        -- зовёт RPC под anon-ключом, и edge login-confirm делает то же самое
        -- своим anon-клиентом.
        ('public.resolve_login_challenge(text,text)', 'anon, authenticated'),

        -- Polling статуса challenge и создание challenge — только под сессией
        -- админа (authenticated).
        ('public.latest_login_challenge_status()', 'authenticated'),
        ('public.create_login_challenge(text,text,text,text,int,text)', 'authenticated'),

        -- ── Админка ─────────────────────────────────────────────────────────
        -- Запасной путь публикации тайтла, если обычный UPDATE не изменил
        -- строку (18_publish_title.sql; там же revoke для anon/PUBLIC).
        ('public.set_title_published(uuid,boolean)', 'authenticated'),

        -- ── Анонимные заявки ────────────────────────────────────────────────
        -- Лимиты считают edge-функции submit-title / submit-chapters /
        -- get-submission сервисной ролью; клиенту и анонимам эта функция
        -- закрыта намеренно (12_rate_limit_ip.sql).
        ('public.check_ip_rate_limit(text,int,int)', 'service_role')
    ) as v(signature, roles)
  loop
    if to_regprocedure(item.signature) is null then
      raise notice 'пропуск: % не существует на этом проекте (проверьте, что накатаны нужные миграции)', item.signature;
      continue;
    end if;

    execute format('grant execute on function %s to %s', item.signature, item.roles);
    raise notice 'ок: EXECUTE на % → %', item.signature, item.roles;
  end loop;
end
$grants$;
