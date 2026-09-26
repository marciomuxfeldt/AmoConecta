-- Move new BI export parts to a private Supabase Storage bucket.
-- Apply manually in the Supabase SQL Editor before deploying the updated worker.

-- Preserve the provider for existing App Storage exports. New rows use Supabase.
alter table public.exportacao_csva
  add column if not exists provedor_armazenamento text;

update public.exportacao_csv
set provedor_armazenamento = 'app_storage'
where provedor_armazenamento is null;

alter table public.exportacao_csv
  alter column provedor_armazenamento set default 'supabase',
  alter column provedor_armazenamento set not null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'exportacao_csv_provedor_armazenamento_check'
      and conrelid = 'public.exportacao_csv'::regclass
  ) then
    alter table public.exportacao_csv
      add constraint exportacao_csv_provedor_armazenamento_check
      check (provedor_armazenamento in ('supabase', 'app_storage'));
  end if;
end;
$$;

insert into storage.buckets (id, name, public)
values ('amoconecta-bi-exports', 'amoconecta-bi-exports', false)
on conflict (id) do update
set name = excluded.name,
    public = false;

-- Restrict client roles even if another broad storage.objects policy exists.
drop policy if exists bi_exports_restrict_client_access on storage.objects;
create policy bi_exports_restrict_client_access
on storage.objects
as restrictive
for all
to anon, authenticated
using (bucket_id <> 'amoconecta-bi-exports')
with check (bucket_id <> 'amoconecta-bi-exports');