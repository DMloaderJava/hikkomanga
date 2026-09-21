-- Заявки на главы (new_chapters) + перенос файлов при approve.
--
-- Флоу: аноним шлёт главы через edge submit-chapters → файлы ложатся в
-- submissions/{token}/ch-{n}/page-{m}.{ext} → owner в /admin/requests жмёт
-- «Одобрить» → клиент вызывает edge finalize-chapter-submission, которая
-- создаёт главы (published=false), переносит страницы в manga/{chapterId}/…
-- и удаляет исходники из submissions.
--
-- Триггер apply_admin_request для new_chapters НЕ нужен: перенос файлов
-- из storage внутри триггера невозможен, поэтому шаг 2 делает edge-функция,
-- а её результат пишется в finalized_at / finalized_error.
-- Подробности — SETUP_SUPABASE.md, раздел «Заявки на главы».

-- ── 1. Тип заявки ───────────────────────────────────────────────────────────
-- DO-блок с EXCEPTION: ALTER TYPE ... ADD VALUE нельзя повторять, а
-- IF NOT EXISTS появился только в PG 12 — повторяем паттерн миграции 10.
DO $$ BEGIN
  ALTER TYPE public.request_type ADD VALUE IF NOT EXISTS 'new_chapters';
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ── 2. Колонки завершения импорта ───────────────────────────────────────────
-- finalized_at != null — импорт глав выполнен (edge идемпотентна: повторный
-- вызов для такой заявки = no-op). finalized_error — текст последней ошибки,
-- по нему в /admin/requests показывается кнопка «Завершить импорт».
alter table public.admin_requests
  add column if not exists finalized_at timestamptz,
  add column if not exists finalized_error text;

-- ── 3. Описание главы ───────────────────────────────────────────────────────
-- Заявка на главы и CSV-импорт приносят необязательное описание главы, а в
-- chapters были только number/name. Колонка nullable — старые главы не трогаем.
alter table public.chapters
  add column if not exists description text;

-- ── 4. Индекс инбокса ───────────────────────────────────────────────────────
-- Owner-инбокс фильтрует по типу и статусу с сортировкой по created_at;
-- admin_requests_status_created_idx из 04 не покрывает фильтр по типу.
create index if not exists admin_requests_type_status_idx
  on public.admin_requests (type, status, created_at desc);
