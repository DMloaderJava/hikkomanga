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
