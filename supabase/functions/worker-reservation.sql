-- Aplicar manualmente no Supabase SQL Editor.
-- Não executar pelo worker: a reserva precisa acontecer dentro de uma transação
-- PostgreSQL com FOR UPDATE SKIP LOCKED.
alter table public.destinatario
  add column if not exists processando_em timestamptz;

create index if not exists destinatario_processando_idx
  on public.destinatario (processando_em, id)
  where status = 'processando';

create or replace function public.reservar_destinatarios(
  p_campanha_id uuid,
  p_limite integer default 100,
  p_is_lembrete boolean default false
)
returns setof public.destinatario
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with locked as (
    select d.id
    from public.destinatario d
    where d.campanha_id = p_campanha_id
      and d.is_lembrete = p_is_lembrete
      and d.status = 'pendente'
    order by d.data_ultima_compra desc nulls last, d.id
    limit greatest(1, least(p_limite, 100))
    for update skip locked
  ),
  claimed as (
    update public.destinatario d
    set status = 'processando',
        tentativas = d.tentativas + 1,
        processando_em = now(),
        erro = null
    from locked
    where d.id = locked.id
    returning d.*
  )
  select claimed.*
  from claimed;
end;
$$;

revoke all on function public.reservar_destinatarios(uuid, integer, boolean) from public;
grant execute on function public.reservar_destinatarios(uuid, integer, boolean) to service_role;

create or replace function public.recuperar_destinatarios_travados(
  p_limite integer default 1000
)
returns setof public.destinatario
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with locked as (
    select d.id
    from public.destinatario d
    where d.status = 'processando'
      and coalesce(d.processando_em, d.criado_em) < now() - interval '15 minutes'
    order by coalesce(d.processando_em, d.criado_em), d.id
    limit greatest(1, least(p_limite, 1000))
    for update skip locked
  ),
  recovered as (
    update public.destinatario d
    set status = case
          when d.tentativas < 3 then 'pendente'
          else 'erro'
        end,
        processando_em = null,
        erro = case
          when d.tentativas < 3 then null
          else 'Reserva expirada após 15 minutos sem conclusão; limite de 3 tentativas atingido.'
        end
    from locked
    where d.id = locked.id
    returning d.*
  )
  select recovered.*
  from recovered;
end;
$$;

revoke all on function public.recuperar_destinatarios_travados(integer) from public;
grant execute on function public.recuperar_destinatarios_travados(integer) to service_role;