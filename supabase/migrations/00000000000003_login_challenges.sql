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
