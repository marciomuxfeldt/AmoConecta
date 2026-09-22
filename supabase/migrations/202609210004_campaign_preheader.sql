-- Preheader opcional exibido como resumo na caixa de entrada.
alter table public.campanha
  add column if not exists preheader text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'campanha_preheader_length_check'
      and conrelid = 'public.campanha'::regclass
  ) then
    alter table public.campanha
      add constraint campanha_preheader_length_check
      check (preheader is null or char_length(preheader) <= 100);
  end if;
end
$$;-- Preheader opcional exibido como resumo na caixa de entrada.
alter table public.campanha
  add column if not exists preheader text;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'campanha_preheader_length_check'
      and conrelid = 'public.campanha'::regclass
  ) then
    alter table public.campanha
      add constraint campanha_preheader_length_check
      check (preheader is null or char_length(preheader) <= 100);
  end if;
end
$$;