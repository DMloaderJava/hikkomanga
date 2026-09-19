-- Supabase Storage Buckets & Policies for Manga and Originals

insert into storage.buckets (id, name, public)
values
  ('manga', 'manga', true),
  ('hikko-originals', 'hikko-originals', false)
on conflict (id) do nothing;

create policy "Public read manga"
on storage.objects for select
using (bucket_id = 'manga');

create policy "Admin write manga"
on storage.objects for all
to authenticated
using (bucket_id = 'manga' and public.has_role(auth.uid(), 'admin'))
with check (bucket_id = 'manga' and public.has_role(auth.uid(), 'admin'));

create policy "Admin read originals"
on storage.objects for select
to authenticated
using (bucket_id = 'hikko-originals' and public.has_role(auth.uid(), 'admin'));

create policy "Admin write originals"
on storage.objects for all
to authenticated
using (bucket_id = 'hikko-originals' and public.has_role(auth.uid(), 'admin'))
with check (bucket_id = 'hikko-originals' and public.has_role(auth.uid(), 'admin'));
