-- Fase 4: impede execuções sobrepostas do worker em processos diferentes.
-- Aplicar manualmente no Supabase SQL Editor.
--
-- O advisory lock é tentado no início de cada aquisição. Como o worker
-- chama o Supabase por HTTP, a sessão usada pela aquisição pode não ser a
-- mesma da chamada de liberação. Por isso, a concessão também fica
-- persistida com token e expiração curta. O token impede que uma execução
-- antiga libere a concessão de uma execução nova depois de expirar.

create table if not exists public.worker_lock_state (
  lock_key bigint primary key,
  owner_token text,
  locked_until timestamptz not null default to_timestamp(0),
  updated_at timestamptz not null default now()
);

drop function if exists public.tentar_adquirir_lock_worker(bigint);
drop function if exists public.liberar_lock_worker(bigint);

create or replace function public.tentar_adquirir_lock_worker(
  p_chave bigint,
  p_token text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_advisory_acquired boolean;
  v_locked_until timestamptz;
begin
  if p_token is null or length(trim(p_token)) = 0 then
    return false;
  end if;

  v_advisory_acquired := pg_try_advisory_lock(p_chave);
  if not v_advisory_acquired then
    return false;
  end if;

  insert into public.worker_lock_state (lock_key)
  values (p_chave)
  on conflict (lock_key) do nothing;

  select locked_until
    into v_locked_until
    from public.worker_lock_state
   where lock_key = p_chave
   for update;

  if v_locked_until > now() then
    perform pg_advisory_unlock(p_chave);
    return false;
  end if;

  update public.worker_lock_state
     set owner_token = p_token,
         locked_until = now() + interval '1 hour',
         updated_at = now()
   where lock_key = p_chave;

  return true;
end;
$$;

create or replace function public.liberar_lock_worker(
  p_chave bigint,
  p_token text
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_released boolean;
begin
  update public.worker_lock_state
     set owner_token = null,
         locked_until = to_timestamp(0),
         updated_at = now()
   where lock_key = p_chave
     and owner_token = p_token;
  v_released := found;

  -- This is false when PostgREST used another pooled session; the durable
  -- state above is the source of truth in that case.
  perform pg_advisory_unlock(p_chave);
  return v_released;
end;
$$;

revoke all on table public.worker_lock_state from public;
revoke all on function public.tentar_adquirir_lock_worker(bigint, text) from public;
revoke all on function public.liberar_lock_worker(bigint, text) from public;
grant execute on function public.tentar_adquirir_lock_worker(bigint, text) to service_role;
grant execute on function public.liberar_lock_worker(bigint, text) to service_role;