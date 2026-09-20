-- IP-rate-limit для анонимных заявок: фиксированные окна по (ip_hash, окно).
-- Хранится только sha256(ip + RATE_LIMIT_SALT) — сырой IP не пишется нигде.
-- Пишет только service_role (edge-функции); клиенту таблица недоступна.

create table if not exists public.ip_rate_limit (
  ip_hash text not null,
  window_start timestamptz not null,
  count int not null default 0,
  primary key (ip_hash, window_start)
);

alter table public.ip_rate_limit enable row level security;

-- Прямого доступа клиенту нет — только SECURITY DEFINER / service role.
drop policy if exists "no direct client access" on public.ip_rate_limit;
create policy "no direct client access"
  on public.ip_rate_limit for all
  using (false);

-- Атомарный инкремент счётчика окна; false = лимит превышен.
-- Вызывается edge-функцией трижды: (60, 15), (3600, 100), (86400, 300).
create or replace function public.check_ip_rate_limit(
  p_ip_hash text,
  p_limit int,
  p_window_seconds int
) returns boolean
language plpgsql security definer as $$
declare
  v_window timestamptz := to_timestamp(
    floor(extract(epoch from now()) / p_window_seconds) * p_window_seconds
  );
  v_count int;
begin
  insert into public.ip_rate_limit (ip_hash, window_start, count)
  values (p_ip_hash, v_window, 1)
  on conflict (ip_hash, window_start)
    do update set count = ip_rate_limit.count + 1
  returning count into v_count;

  return v_count <= p_limit;
end;
$$;

revoke all on function public.check_ip_rate_limit(text, int, int) from anon, authenticated;

-- Именование: НЕ cleanup_rate_limit (конфликт смысла с cleanup_rate_limit_log
-- из 00000000000005). Чистит только окна ip_rate_limit старше 2 дней.
create or replace function public.cleanup_ip_rate_limit() returns void
language sql as $$
  delete from public.ip_rate_limit where window_start < now() - interval '2 days';
$$;
