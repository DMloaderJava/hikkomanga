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
