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
