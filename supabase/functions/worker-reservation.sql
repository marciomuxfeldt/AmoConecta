-- Aplicar manualmente no Supabase SQL Editor.
-- Não executar pelo worker: a reserva precisa acontecer dentro de uma transação
-- PostgreSQL com FOR UPDATE SKIP LOCKED.
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
    order by d.id
    limit greatest(1, least(p_limite, 100))
    for update skip locked
  ),
  claimed as (
    update public.destinatario d
    set status = 'processando',
        tentativas = d.tentativas + 1,
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