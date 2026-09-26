-- Обложки тайтлов, загруженные из админки: бакет `title-covers` + любые
-- распространённые форматы изображений.
--
-- Зачем эта миграция (вместо правки 00000000000019_title_covers.sql):
--  1. ИМЯ БАКЕТА. 19-я миграция создавала бакет `covers`. В живом проекте
--     бакет называется `title-covers`, а `covers` нет вовсе — клиент
--     (src/data/storage.ts → COVER_BUCKET) стучался в `/object/covers/…` и
--     получал 400 «Bucket not found». Теперь клиент и бакет называются
--     одинаково: `title-covers`.
--  2. ФОРМАТЫ. Форма TitleForm принимает JPEG, PNG, WebP и GIF (GIF уходит в
--     бакет как есть — с анимацией, src/lib/coverUpload.ts). Ограничение
--     осталось прежним: 5 MB на исходник (COVER_MAX_BYTES) — здесь это
--     file_size_limit, дублирующий клиентскую проверку.
--
-- Бакет ПУБЛИЧНЫЙ: обложку читает анонимный посетитель каталога, подписанных
-- URL нет. Пишет только роль admin — та же схема, что у бакета `manga`
-- (00000000000002_storage_buckets.sql).
--
-- Штатная обложка по-прежнему может быть файлом репозитория:
-- public/media/covers/{имя}.webp и относительный путь /media/covers/{имя}.webp
-- в titles.cover_url (кэш 'self', вес каталога ограничен бюджетом —
-- scripts/check-budgets.mjs).

insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
values (
  'title-covers',
  'title-covers',
  true,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif'],
  5 * 1024 * 1024
)
on conflict (id) do update set
  public = true,
  allowed_mime_types = excluded.allowed_mime_types,
  file_size_limit = excluded.file_size_limit;

drop policy if exists "public read title-covers" on storage.objects;
create policy "public read title-covers"
  on storage.objects for select
  using (bucket_id = 'title-covers');

drop policy if exists "admin write title-covers" on storage.objects;
create policy "admin write title-covers"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'title-covers' and public.has_role(auth.uid(), 'admin'))
  with check (bucket_id = 'title-covers' and public.has_role(auth.uid(), 'admin'));

-- Прежний бакет `covers` (миграция 19) убираем, но только пустой: объекты
-- Storage физически лежат в префиксе своего бакета, поэтому «перенести» их
-- SQL-ом нельзя. Если в нём что-то есть — оставьте как есть: клиент всё ещё
-- умеет удалять такие обложки при замене (LEGACY_COVER_BUCKETS в
-- src/data/storage.ts), а переложить файлы можно в Storage → covers.
do $$
begin
  if not exists (select 1 from storage.objects where bucket_id = 'covers') then
    drop policy if exists "public read covers" on storage.objects;
    drop policy if exists "admin write covers" on storage.objects;
    delete from storage.buckets where id = 'covers';
  else
    raise notice 'Бакет `covers` не пуст — объекты оставлены; перенесите их в `title-covers` вручную.';
  end if;
end $$;

-- Проверка: npm run check:supabase (раздел «5. Бакеты Storage») и
-- npm run check:covers — он проверяет и файлы в public/, и URL из этого бакета.
