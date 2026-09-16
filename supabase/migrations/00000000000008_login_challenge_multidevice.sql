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
