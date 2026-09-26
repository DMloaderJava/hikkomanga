-- Обложки тайтлов, загруженные из админки (TitleForm → «Загрузить файл»).
--
-- Штатная обложка по-прежнему файл репозитория: public/media/covers/{имя}.webp,
-- в titles.cover_url относительный путь /media/covers/{имя}.webp (кэш 'self',
-- вес каталога ограничен бюджетом — scripts/check-budgets.mjs). Этот бакет —
-- второй способ: админ выбирает файл, клиент жмёт его в WebP ≤800 px
-- (src/lib/coverUpload.ts) и кладёт сюда, а в titles.cover_url записывается
-- публичный URL …/storage/v1/object/public/covers/{slug}-{time}-{rand}.webp.
--
-- Бакет ПУБЛИЧНЫЙ: обложку читает анонимный посетитель каталога, подписанных
-- URL нет. Пишет только роль admin — та же схема, что у бакета `manga`
-- (00000000000002_storage_buckets.sql).

insert into storage.buckets (id, name, public)
values ('covers', 'covers', true)
on conflict (id) do update set public = true;

drop policy if exists "public read covers" on storage.objects;
create policy "public read covers"
  on storage.objects for select
  using (bucket_id = 'covers');

drop policy if exists "admin write covers" on storage.objects;
create policy "admin write covers"
  on storage.objects for all
  to authenticated
  using (bucket_id = 'covers' and public.has_role(auth.uid(), 'admin'))
  with check (bucket_id = 'covers' and public.has_role(auth.uid(), 'admin'));

-- Проверка: npm run check:supabase (раздел «5. Бакеты Storage») и
-- npm run check:covers — он проверяет и файлы в public/, и URL из этого бакета.
