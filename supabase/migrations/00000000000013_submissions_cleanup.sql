-- Автоочистка отклонённых/спам-заявок старше 90 дней.
-- Файлы обложек в бакете submissions не удаляем здесь (нужен service_role):
-- строка помечается payload.purged=true, а разовую зачистку бакета удобнее
-- делать через Dashboard → Storage (см. SETUP_SUPABASE.md, «Приём заявок»).
create or replace function public.cleanup_rejected_submissions() returns void
language plpgsql security definer as $$
declare
  r record;
begin
  for r in
    select id, public_token
    from public.admin_requests
    where status in ('rejected','spam')
      and resolved_at < now() - interval '90 days'
      and coalesce((payload->>'purged')::boolean, false) = false
  loop
    update public.admin_requests
      set payload = jsonb_build_object('purged', true),
          -- обложка и персональные данные больше не нужны
          submitter_email = null,
          ip_hash = null,
          user_agent = null
      where id = r.id;
  end loop;
end;
$$;

revoke all on function public.cleanup_rejected_submissions() from anon, authenticated;
