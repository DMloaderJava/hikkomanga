-- Возврат EXECUTE-прав на функции public, от которых зависит вход в админку
-- (Login Guard) и админские письма.
--
-- Симптом (реальный прод): пароль верный, экран «Подтвердите вход» и/или
-- красная плашка «Вход отклонён», а письмо подтверждения НЕ приходит вообще —
-- потому что edge-функция не может выполнить ни один RPC:
--
--   login-notify → rpc('has_role')              → permission denied for function has_role
--   login-notify → rpc('create_login_challenge') → permission denied for function create_login_challenge
--   login-confirm → rpc('resolve_login_challenge') → permission denied (ссылка из письма не работает)
--   браузер       → rpc('latest_login_challenge_status') → permission denied (экран ожидания «висит»)
--
-- Клиент показывает это как `errorKind: 'db-grants'` (см. src/data/notify.ts,
-- OWNER_HINTS в /admin/login), а `npm run check:supabase` — как
-- «permission denied for function …» в разделе 4 «Функции БД (RPC)».
--
-- Причина: на проекте слетели гранты на EXECUTE для ролей anon/authenticated/
-- service_role. Такое случается после ручного REVOKE (например, при «harden
-- functions» по Security Advisor) или когда миграции 03/04/08 накатывали в
-- SQL Editor, а строки GRANT из файла не выполнились. Миграции выдавали права
-- явно, и зависимостей от default-прав PUBLIC у проекта нет: без этих строк
-- функции существуют, но исполнять их нельзя никому, кроме postgres.
--
-- Файл идемпотентен и устойчив к частично накатанной схеме: каждая выдача
-- обёрнута в проверку `to_regprocedure(...) is not null`, поэтому отсутствие
-- какой-то функции (например, ещё не накатана 08) не роняет весь скрипт —
-- в Message видно «пропуск: <функция> не существует на этом проекте».
--
-- Накат (на этом проекте `supabase db push` не работает — пустая локальная
-- история миграций, см. DEPLOY.md):
--   1) Supabase → SQL Editor → вставить файл целиком → Run;
--   2) либо одной командой:
--        supabase db query --linked -f supabase/migrations/00000000000021_restore_function_grants.sql
--
-- Проверка после наката (publishable/anon-ключ публичный):
--   curl -s -X POST -H 'apikey: <publishable-key>' \
--     -H 'Content-Type: application/json' \
--     -d '{"uid":"00000000-0000-0000-0000-000000000000","role_to_check":"admin"}' \
--     https://<ref>.supabase.co/rest/v1/rpc/has_role
--   # было 42501 «permission denied for function has_role»; должно стать 200 false
--   npm run check:supabase   # раздел 4 без ✗

do $grants$
declare
  item record;
begin
  for item in
    select *
    from (
      values
        -- ── Login Guard ─────────────────────────────────────────────────────
        -- has_role зовут: клиент (auth.hasRole), все админские edge-функции
        -- под JWT пользователя (authenticated) и RLS-политики admin_requests/
        -- ads/user_api_keys. Роль anon нужна публичным политикам
        -- (INSERT ad_request на /advertise) — так задумано в
        -- 04_roles_and_requests.sql.
        ('public.has_role(uuid,text)', 'anon, authenticated'),

        -- Ссылку из письма открывают БЕЗ сессии: страница /admin/login/confirm
        -- зовёт RPC под anon-ключом, и edge login-confirm делает то же самое
        -- своим anon-клиентом.
        ('public.resolve_login_challenge(text,text)', 'anon, authenticated'),

        -- Polling статуса challenge и создание challenge — только под сессией
        -- админа (authenticated).
        ('public.latest_login_challenge_status()', 'authenticated'),
        ('public.create_login_challenge(text,text,text,text,int,text)', 'authenticated'),

        -- ── Админка ─────────────────────────────────────────────────────────
        -- Запасной путь публикации тайтла, если обычный UPDATE не изменил
        -- строку (18_publish_title.sql; там же revoke для anon/PUBLIC).
        ('public.set_title_published(uuid,boolean)', 'authenticated'),

        -- ── Анонимные заявки ────────────────────────────────────────────────
        -- Лимиты считают edge-функции submit-title / submit-chapters /
        -- get-submission сервисной ролью; клиенту и анонимам эта функция
        -- закрыта намеренно (12_rate_limit_ip.sql).
        ('public.check_ip_rate_limit(text,int,int)', 'service_role')
    ) as v(signature, roles)
  loop
    if to_regprocedure(item.signature) is null then
      raise notice 'пропуск: % не существует на этом проекте (проверьте, что накатаны нужные миграции)', item.signature;
      continue;
    end if;

    execute format('grant execute on function %s to %s', item.signature, item.roles);
    raise notice 'ок: EXECUTE на % → %', item.signature, item.roles;
  end loop;
end
$grants$;
