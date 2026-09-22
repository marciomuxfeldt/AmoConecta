-- Fase 4: impede execuções sobrepostas do worker em processos diferentes.
-- Aplicar manualmente no Supabase SQL Editor.
--
-- A concessão persistida é o mecanismo de coordenação. O token impede que
-- uma execução antiga libere a concessão de uma execução nova depois de
-- expirar.

create table if not exists public.worker_lock_state (
  lock_key bigint primary key,
  owner_token text,
  locked_until timestamptz not null default to_timestamp(0),
  updated_at timestamptz not null default now()
);

insert into public.worker_lock_state (lock_key)
values (4782913421)
on conflict (lock_key) do nothing;

drop function if exists public.tentar_adquirir_lock_worker(bigint);
drop function if exists public.liberar_lock_worker(bigint);

create or replace function public.tentar_adquirir_lock_worker(
  p_chave bigint,
  p_token text
)
returns boolean
language sql
security definer
set search_path = public
as $$
  with acquired as (
    update public.worker_lock_state
       set owner_token = p_token,
           locked_until = now() + interval '10 minutes',
           updated_at = now()
     where lock_key = p_chave
       and p_token is not null
       and length(trim(p_token)) > 0
       and (owner_token is null or locked_until < now())
    returning lock_key
  )
  select exists(select 1 from acquired);
$$;

create or replace function public.liberar_lock_worker(
  p_chave bigint,
  p_token text
)
returns boolean
language sql
security definer
set search_path = public
as $$
  with released as (
    update public.worker_lock_state
       set owner_token = null,
           locked_until = to_timestamp(0),
           updated_at = now()
     where lock_key = p_chave
       and owner_token = p_token
    returning lock_key
  )
  select exists(select 1 from released);
$$;

revoke all on table public.worker_lock_state from public;
revoke all on function public.tentar_adquirir_lock_worker(bigint, text) from public;
revoke all on function public.liberar_lock_worker(bigint, text) from public;
grant execute on function public.tentar_adquirir_lock_worker(bigint, text) to service_role;
grant execute on function public.liberar_lock_worker(bigint, text) to service_role;