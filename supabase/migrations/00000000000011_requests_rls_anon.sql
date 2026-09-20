-- Анонимам INSERT в admin_requests запрещён: заявки на тайтл создаёт
-- edge-функция submit-title под service_role (после Turnstile + rate limit).
-- Просмотр статуса заявителем — тоже через edge-функцию get-submission,
-- поэтому анонам SELECT не даём.
--
-- ВАЖНО: политика "anyone can insert ad_request" (00000000000004) остаётся —
-- публичная форма /advertise продолжает работать. RLS-политики OR'ятся,
-- так что эта with check (false) не блокирует ad_request, а явно фиксирует:
-- прямого пути anon → new_title нет.
drop policy if exists "no anon insert" on public.admin_requests;
create policy "no anon insert"
on public.admin_requests for insert
to anon
with check (false);
