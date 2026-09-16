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
