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
