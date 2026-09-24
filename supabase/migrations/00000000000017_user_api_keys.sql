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
