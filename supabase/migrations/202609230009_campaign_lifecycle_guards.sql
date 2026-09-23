-- Campaign lifecycle guards and server-owned test metadata.
-- This project uses Supabase externally, so apply this migration in Supabase
-- before deploying the API changes that depend on it.

alter table public.campanha
  add column if not exists teste_enviado_em timestamptz;

update public.campanha
set
  teto_hora = coalesce(teto_hora, 100),
  teto_dia = coalesce(teto_dia, 1000)
where teto_hora is null
   or teto_dia is null;

alter table public.campanha
  alter column teto_hora set default 100,
  alter column teto_hora set not null,
  alter column teto_dia set default 1000,
  alter column teto_dia set not null;

alter table public.campanha
  drop constraint if exists campanha_status_check;

alter table public.campanha
  add constraint campanha_status_check
  check (status in ('rascunho', 'agendada', 'enviando', 'pausada', 'concluida', 'cancelada'));

alter table public.campanha
  drop constraint if exists campanha_lembrete_horas_check;

alter table public.campanha
  add constraint campanha_lembrete_horas_check
  check (lembrete_horas between 24 and 168);