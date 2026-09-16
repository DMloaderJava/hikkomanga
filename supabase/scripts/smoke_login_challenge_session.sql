-- Multi-device Login Guard smoke (session_id).
-- Запуск в SQL Editor ПОСЛЕ миграции 08.
--
-- Проверяет:
--   1) 5-arg create_login_challenge УДАЛЕНА
--   2) latest_login_challenge_status() фильтрует по JWT session_id
--      (sess-A approved ≠ sess-B pending; A не гасится)
--   3) нет shortcut «любой approved»
--
-- Весь блок в транзакции с ROLLBACK — данные не остаются.
-- Требует superuser (SQL Editor Supabase) для session_replication_role.

BEGIN;

-- FK login_challenges.user_id → auth.users: без replica INSERT фейкового uid упадёт.
-- SECURITY DEFINER не обходит FK. SET LOCAL + ROLLBACK безопасны.
SET LOCAL session_replication_role = replica;

-- 0) 5-arg должна быть удалена
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'create_login_challenge'
      AND pg_get_function_identity_arguments(p.oid) = 'text, text, text, text, integer'
  ) THEN
    RAISE EXCEPTION 'FAIL: 5-arg create_login_challenge still exists';
  END IF;
  RAISE NOTICE 'PASS: 5-arg create_login_challenge dropped';
END $$;

-- 1) Симулируем две сессии одного user через request.jwt.claims + вызов
--    latest_login_challenge_status() (не зеркало SELECT — саму функцию 08).
DO $$
DECLARE
  uid UUID := 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  tok_a TEXT := 'smoke_token_session_A_' || replace(gen_random_uuid()::text, '-', '');
  tok_b TEXT := 'smoke_token_session_B_' || replace(gen_random_uuid()::text, '-', '');
  st TEXT;
  n_approved INT;
BEGIN
  DELETE FROM public.login_challenges
  WHERE user_id = uid OR token LIKE 'smoke_token_session_%';

  INSERT INTO public.login_challenges (user_id, token, status, session_id, expires_at)
  VALUES
    (uid, tok_a, 'approved', 'sess-A-smoke', now() + interval '15 minutes'),
    (uid, tok_b, 'pending',  'sess-B-smoke', now() + interval '15 minutes');

  -- ── sess-A: JWT claims → latest_login_challenge_status() ──
  -- Supabase auth.uid() читает request.jwt.claim.sub / request.jwt.claims->>'sub'.
  -- auth.jwt() читает request.jwt.claims.
  PERFORM set_config('request.jwt.claim.sub', uid::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', uid::text,
      'session_id', 'sess-A-smoke',
      'role', 'authenticated'
    )::text,
    true
  );

  st := public.latest_login_challenge_status();
  IF st IS DISTINCT FROM 'approved' THEN
    RAISE EXCEPTION 'FAIL: sess-A via function expected approved, got %', st;
  END IF;
  RAISE NOTICE 'PASS: latest_login_challenge_status(sess-A) → approved';

  -- ── sess-B: тот же user, другой session_id ──
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', uid::text,
      'session_id', 'sess-B-smoke',
      'role', 'authenticated'
    )::text,
    true
  );

  st := public.latest_login_challenge_status();
  IF st IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'FAIL: sess-B via function expected pending, got %', st;
  END IF;
  RAISE NOTICE 'PASS: latest_login_challenge_status(sess-B) → pending';

  -- A approved не погашен B pending
  SELECT count(*) INTO n_approved
  FROM public.login_challenges
  WHERE user_id = uid AND session_id = 'sess-A-smoke' AND status = 'approved';
  IF n_approved <> 1 THEN
    RAISE EXCEPTION 'FAIL: sess-A approved lost (count=%)', n_approved;
  END IF;
  RAISE NOTICE 'PASS: sess-A approved intact after B pending';

  -- Нет shortcut «любой approved»: повторный вызов с sess-B всё ещё pending
  st := public.latest_login_challenge_status();
  IF st IS DISTINCT FROM 'pending' THEN
    RAISE EXCEPTION 'FAIL: global-approved shortcut leaked (sess-B got %)', st;
  END IF;
  RAISE NOTICE 'PASS: no global-approved shortcut';

  -- unauthenticated без claims
  PERFORM set_config('request.jwt.claims', '', true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  st := public.latest_login_challenge_status();
  IF st IS DISTINCT FROM 'unauthenticated' AND st IS DISTINCT FROM 'none' THEN
    -- В зависимости от реализации auth.uid() может вернуть null → unauthenticated
    -- или (редко) none. Оба приемлемы; approved — нет.
    IF st = 'approved' OR st = 'pending' THEN
      RAISE EXCEPTION 'FAIL: empty claims must not return session status, got %', st;
    END IF;
  END IF;
  RAISE NOTICE 'PASS: empty claims → % (not a foreign session status)', st;

  DELETE FROM public.login_challenges WHERE user_id = uid;
END $$;

ROLLBACK;

-- Live-check после реального multi-device login (вне транзакции):
--   SELECT session_id, status, created_at
--   FROM public.login_challenges
--   WHERE user_id = '<your-uuid>'
--   ORDER BY created_at DESC LIMIT 5;
-- Ожидание: разные session_id; approved на старом девайсе + pending на новом.
