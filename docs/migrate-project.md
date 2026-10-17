# Переезд сайта на другой Supabase-проект

Runbook для случая «старый проект больше не наш» (нет доступа, чужой аккаунт,
проект удаляют) или «хотим поднять чистый проект со своим контентом».

Порядок шагов важен: сначала схема и контент, потом секреты и функции, и только
в конце — переключение фронтенда. До шага 6 прод продолжает работать со старым
проектом, так что сломанного промежутка нет.

**Что переносится**

| Данные | Как |
| --- | --- |
| Схема, RLS, RPC, триггеры, бакеты | `supabase/bootstrap.sql` (шаг 2) |
| Тайтлы, главы, страницы, жанры, озвучки, реклама | `scripts/migrate-supabase-project.mjs` (шаг 4) |
| Файлы Storage: `manga`, `title-covers`, `voiceovers` | тем же скриптом (копирование по ссылкам из БД) |
| История заявок `admin_requests` | `--include-requests` (по умолчанию нет) |
| Оригиналы страниц (`hikko-originals`, приватный) | `--include-originals` (нужен service_role старого проекта) |

**Что НЕ переносится — настраивается заново**

| Данные | Почему |
| --- | --- |
| `auth.users` (аккаунт админа) | пользователи живут вне `public`; создайте заново (шаг 3) |
| `user_api_keys` (персональный Gemini key) | зашифрован `USER_KEY_ENC_SECRET`; введите в `/admin/settings` |
| `login_challenges`, `ip_rate_limit`, `rate_limit_log` | эфемерные (сессии, лимиты) |
| Секреты Edge Functions | в дашборде не читаются; задаются заново (шаг 5) |

---

## Шаг 0. Что подготовить

| Что | Где взять |
| --- | --- |
| `ref` нового проекта (20 строчных букв) | адресная строка дэшборда `/project/<ref>/…` |
| `publishable` (anon) key нового проекта | Project Settings → API Keys → publishable |
| `service_role` key нового проекта | Project Settings → API Keys → service_role **(секрет!)** |
| Ключи старого проекта (по возможности `service_role`) | дэшборд старого проекта; без него перенесётся только опубликованное |
| `RESEND_API_KEY`, адрес владельца | resend.com → API Keys |
| `RECAPTCHA_SECRET_KEY` | Google reCAPTCHA admin (пара к `VITE_RECAPTCHA_SITE_KEY` из `.env.production`) |

**Про ключи.** `publishable`/anon — публичный, его можно пересылать в чате.
`service_role` обходит RLS целиком: не публикуйте его, не коммитьте и не
присылайте в переписку. Держите в файле `.env.migrate` в корне репозитория —
он попадает под `.env.*` из `.gitignore` и не уедет в git:

```bash
# .env.migrate   (в репозиторий НЕ коммитится)
OLD_SUPABASE_URL=https://<старый-ref>.supabase.co
OLD_SUPABASE_KEY=<service_role старого, если есть; иначе publishable>
NEW_SUPABASE_URL=https://<новый-ref>.supabase.co
NEW_SUPABASE_KEY=<service_role нового>
```

## Шаг 1. Создать проект

Supabase → New project. Регион выбирайте ближе к аудитории (для РФ/ЕС —
Frankfurt). Пароль БД сохраните в менеджер паролей: он понадобится только для
прямого доступа к Postgres.

## Шаг 2. Накатить схему

```bash
npm run bootstrap:sql        # соберёт supabase/bootstrap.sql из supabase/migrations/*.sql
```

Дальше **SQL Editor нового проекта → New query → вставить `supabase/bootstrap.sql`
целиком → Run**. Ожидаемо: `Success. No rows returned`.

> Альтернатива для тех, кто работает через CLI: `supabase link --project-ref
> <новый-ref>` и `supabase db push` — на пустом проекте история миграций пуста,
> поэтому применятся все файлы по порядку. На уже живущем проекте `db push` не
> используйте (см. предупреждение в DEPLOY.md).

**Проверка «удостоверения» проекта** — выполните в том же SQL Editor; на пустом
проекте столбцы должны стать `true`, а счётчики — 0:

```sql
select
  (select count(*) from public.titles)                                     as titles,
  (select count(*) from public.chapters)                                   as chapters,
  to_regclass('public.user_api_keys') is not null                          as has_user_api_keys,
  to_regprocedure('public.set_title_published(uuid,boolean)') is not null  as has_publish_fn,
  to_regprocedure('public.check_ip_rate_limit(text,int,int)') is not null  as has_rate_limit_fn;
```

## Шаг 3. Админ-пользователь

1. Authentication → Users → **Add user**: email + пароль + галочка
   *Auto Confirm User* (иначе потребуется подтверждение почты).
2. Скопируйте `UID` созданного пользователя и выполните в SQL Editor:

   ```sql
   insert into public.user_roles (user_id, role)
   values ('<uid>', 'owner')
   on conflict do nothing;
   ```

   (`owner` автоматически считается админом — см. `has_role` в
   `00000000000004_roles_and_requests.sql`.)
3. Authentication → Sign In / Providers: **Email** включён, *Allow new users to
   sign up* — выключить.
4. Authentication → URL Configuration: **Site URL** = `https://hikkomanga.vercel.app`,
   в *Redirect URLs* добавьте домен прода и `http://localhost:5173` для dev.

## Шаг 4. Перенести контент и файлы

Сначала примерка (ничего не пишет):

```bash
node --env-file=.env.migrate scripts/migrate-supabase-project.mjs --dry-run
```

Затем перенос:

```bash
node --env-file=.env.migrate scripts/migrate-supabase-project.mjs
```

Скрипт читает строки из старого проекта, **переписывает ссылки на медиа со
старого ref на новый**, вставляет строки (id сохраняются) и копирует файлы
Storage, пропуская уже существующие. Повторный запуск безопасен.

Полезные флаги:

| Флаг | Зачем |
| --- | --- |
| `--dry-run` | прочитать и посчитать, ничего не записывать |
| `--limit=50` | пробный прогон: по 50 строк на таблицу |
| `--skip-storage` | только БД, файлы копировать не надо |
| `--include-requests` | перенести историю заявок `admin_requests` |
| `--include-originals` | перенести оригиналы страниц (нужен service_role старого проекта) |

В конце скрипт печатает сводку; `exit code 1` и список ошибок означает, что
часть файлов скопировать не удалось — обычно потому, что старый ключ не
service_role (приватные бакеты). Строки в БД при этом уже перенесены, повторный
запуск доберёт остаток.

## Шаг 5. Секреты и функции

```bash
supabase link --project-ref <новый-ref>

supabase secrets set \
  RATE_LIMIT_SALT="$(openssl rand -hex 32)" \
  USER_KEY_ENC_SECRET="$(openssl rand -base64 32)" \
  CAPTCHA_PROVIDER=recaptcha \
  RECAPTCHA_SECRET_KEY="<secret от того же виджета, что VITE_RECAPTCHA_SITE_KEY>" \
  RESEND_API_KEY="re_xxx" \
  OWNER_NOTIFY_EMAIL="you@domain.tld"
# опционально, если домен подтверждён в Resend:
# OWNER_NOTIFY_FROM="Hikkomanga <login@yourdomain>"
```

> `USER_KEY_ENC_SECRET` — новый: старые персональные Gemini-ключи всё равно
> нечитаемы, их вводят заново в `/admin/settings`.

Деплой функций (список актуален на 2026-10; `verify_jwt` берётся из
`supabase/config.toml`):

```bash
supabase functions deploy login-notify
supabase functions deploy login-confirm
supabase functions deploy submit-title
supabase functions deploy submit-chapters
supabase functions deploy get-submission
supabase functions deploy notify-submitter
supabase functions deploy finalize-chapter-submission
supabase functions deploy gemini-proxy
supabase functions deploy dialog-tts
supabase functions deploy chat
supabase functions deploy admin-api-keys
```

## Шаг 6. Переключить фронтенд

```bash
npm run switch:supabase -- --ref <новый-ref> --key sb_publishable_…
```

Скрипт поправит `.env.production` и `supabase/config.toml`, проверит новый
проект по REST и напомнит про документацию со старым ref. Затем — **Vercel**:

Production **и** Preview → Environment Variables:

- `VITE_SUPABASE_URL=https://<новый-ref>.supabase.co`
- `VITE_SUPABASE_PUBLISHABLE_KEY=sb_publishable_…`

> Если эти переменные на Vercel остались от старого проекта, они **перекрывают**
> `.env.production` (Vite отдаёт приоритет `process.env`), и сайт продолжит
> ходить в старый проект. После правки — обязательный **Redeploy**.

## Шаг 7. Проверка

```bash
npm run check:supabase     # разделы 3–6 без ✗ (таблицы, RPC, бакеты, функции)
```

Затем руками:

1. `/` — каталог показывает тайтлы, обложки грузятся с **нового** ref
   (правый клик → «Копировать адрес картинки»).
2. `/title/<slug>/chapter/1` — страницы главы открываются.
3. `/admin/login` — пароль → **письмо** Login Guard приходит → ссылка
   «Подтвердить» → вход в `/admin`.
4. Консоль браузера: нет предупреждений `[storageUrl] URL медиа указывает на
   другой Supabase-проект`.
5. (по желанию) форма заявки: капча проходит, заявка уходит в `/admin/requests`.

## Откат

Пока старый проект жив, откат — это обратное переключение:

```bash
npm run switch:supabase -- --ref <старый-ref> --key <старый publishable>
```

плюс вернуть `VITE_SUPABASE_*` на Vercel и сделать Redeploy. Данные, записанные
в новом проекте после переезда (заявки, правки контента), в старый не попадут.

## Чек-лист (короткий)

- [ ] новый проект создан, `bootstrap.sql` накатан, «удостоверение» показывает `true/false` как ожидается
- [ ] админ создан, `user_roles` = `owner`, signup выключен, Site URL задан
- [ ] `migrate-supabase-project.mjs` прогнан без ошибок (сводка: строки + файлы)
- [ ] секреты заданы, 11 функций задеплоены
- [ ] `.env.production` и Vercel env переключены, сайт пересобран
- [ ] `npm run check:supabase` чист, письмо Login Guard приходит, главы читаются
- [ ] старый проект: решено, что с ним делать (оставить как бэкап / удалить после проверки)
