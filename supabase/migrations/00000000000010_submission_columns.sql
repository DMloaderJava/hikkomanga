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
