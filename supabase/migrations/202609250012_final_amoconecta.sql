-- Final AmoConecta phase.
-- Backend content-lock enforcement must include corpo_lembrete,
-- assunto_lembrete, lembrete_horas, cor_botao_snapshot and
-- incluir_desengajados whenever a campaign is agendada, enviando or pausada.

-- There is exactly one account-wide email button colour configuration.
create table if not exists public.configuracao_email_global (
  id smallint primary key default 1,
  cor_botao text not null default '#e96527',
  atualizado_em timestamptz not null default now(),
  constraint configuracao_email_global_singleton check (id = 1),
  constraint configuracao_email_global_cor_check
    check (cor_botao ~ '^#[0-9A-Fa-f]{6}$')
);

insert into public.configuracao_email_global (id, cor_botao)
values (1, '#e96527')
on conflict (id) do nothing;

create table if not exists public.estado_desengajamento (
  id smallint primary key default 1 check (id = 1),
  calculado_em timestamptz,
  linhas_atualizadas integer not null default 0 check (linhas_atualizadas >= 0)
);

insert into public.estado_desengajamento (id)
values (1)
on conflict (id) do nothing;

alter table public.campanha
  add column if not exists cor_botao_snapshot text not null default '#e96527',
  add column if not exists corpo_lembrete jsonb,
  add column if not exists incluir_desengajados boolean not null default false;

update public.campanha
set cor_botao_snapshot = '#e96527'
where cor_botao_snapshot is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'campanha_cor_botao_snapshot_check'
      and conrelid = 'public.campanha'::regclass
  ) then
    alter table public.campanha
      add constraint campanha_cor_botao_snapshot_check
      check (cor_botao_snapshot ~ '^#[0-9A-Fa-f]{6}$');
  end if;
end
$$;

-- Keep the existing lifecycle range explicit even when this migration is
-- applied to a database that predates the lifecycle-guards migration.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'campanha_lembrete_horas_check'
      and conrelid = 'public.campanha'::regclass
  ) then
    alter table public.campanha
      add constraint campanha_lembrete_horas_check
      check (lembrete_horas between 24 and 168);
  end if;
end
$$;

alter table public.destinatario
  add column if not exists desengajado_cronico boolean not null default false,
  add column if not exists desengajado_cronico_em timestamptz;

alter table public.destinatario
  drop constraint if exists destinatario_status_check;
alter table public.destinatario
  add constraint destinatario_status_check
  check (status in (
    'pendente',
    'processando',
    'enviado',
    'entregue',
    'aberto',
    'clicado',
    'bounce',
    'erro',
    'suprimido',
    'bloqueado_modo_teste',
    'bloqueado_desengajado'
  ));

create index if not exists destinatario_email_original_entrega_idx
  on public.destinatario (lower(email), entregue_em, campanha_id)
  where is_lembrete = false;

create index if not exists destinatario_desengajado_email_idx
  on public.destinatario (lower(btrim(email)))
  where desengajado_cronico = true and is_lembrete = false;

create or replace function public.inherit_chronic_disengagement()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_check_email boolean;
begin
  if tg_op = 'INSERT' then
    v_check_email := true;
  else
    v_check_email :=
      lower(btrim(old.email)) is distinct from lower(btrim(new.email))
      or old.is_lembrete is distinct from new.is_lembrete;
  end if;

  if new.is_lembrete = false and v_check_email then
    new.desengajado_cronico := exists (
      select 1
      from public.destinatario d
      where d.is_lembrete = false
        and d.desengajado_cronico = true
        and lower(btrim(d.email)) = lower(btrim(new.email))
    );
    if new.desengajado_cronico then
      new.desengajado_cronico_em := now();
    else
      new.desengajado_cronico_em := null;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists destinatario_inherit_chronic_disengagement on public.destinatario;
create trigger destinatario_inherit_chronic_disengagement
  before insert or update on public.destinatario
  for each row execute function public.inherit_chronic_disengagement();

-- Records the current (and reversible) chronic-disengagement assessment.
-- A recipient is chronic when the email has at least five distinct original
-- campaigns delivered during the rolling six-month window and has no open or
-- click event on any of those deliveries.
create or replace function public.refresh_chronic_disengagement()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_changed integer;
begin
  with engagement as (
    select
      lower(btrim(d.email)) as email,
      count(distinct d.campanha_id) as campanhas_entregues,
      bool_or(
        d.aberto_em is not null
        or d.clicado_em is not null
        or d.status in ('aberto', 'clicado')
      ) as teve_engajamento
    from public.destinatario d
    where d.is_lembrete = false
      and d.entregue_em >= now() - interval '6 months'
    group by lower(btrim(d.email))
  ),
  eligible as (
    select email
    from engagement
    where campanhas_entregues >= 5
      and not teve_engajamento
  ),
  refreshed as (
    update public.destinatario d
    set desengajado_cronico = (e.email is not null),
        desengajado_cronico_em = case
          when e.email is not null then now()
          else null
        end
    from (select distinct lower(btrim(email)) as email from public.destinatario) all_emails
    left join eligible e on e.email = all_emails.email
    where d.is_lembrete = false
      and lower(btrim(d.email)) = all_emails.email
      and d.desengajado_cronico is distinct from (e.email is not null)
    returning d.id
  )
  select count(*) into v_changed from refreshed;

  insert into public.estado_desengajamento (id, calculado_em, linhas_atualizadas)
  values (1, now(), v_changed)
  on conflict (id) do update
    set calculado_em = excluded.calculado_em,
        linhas_atualizadas = excluded.linhas_atualizadas;

  return v_changed;
end;
$$;

create or replace function public.count_chronic_disengagement()
returns bigint
language sql
security definer
set search_path = public
as $$
  select count(*)::bigint
  from (
    select distinct lower(btrim(email))
    from public.destinatario
    where desengajado_cronico = true
      and is_lembrete = false
  ) contacts;
$$;

-- Select and enqueue a bounded batch atomically. "entregue" is the existing
-- recipient status used by this schema for a delivered message.
create or replace function public.enqueue_campaign_reminders(
  p_campaign_id uuid,
  p_limit integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_inserted integer;
begin
  if p_limit is null or p_limit <= 0 then
    return 0;
  end if;

  -- Prevent two reminder workers for the same campaign from selecting the
  -- same original recipient concurrently.
  perform pg_advisory_xact_lock(hashtextextended(p_campaign_id::text, 0));

  with candidates as (
    select d.*
    from public.destinatario d
    join public.campanha c on c.id = d.campanha_id
    where d.campanha_id = p_campaign_id
      and nullif(btrim(c.assunto_lembrete), '') is not null
      and btrim(c.assunto_lembrete) <> btrim(c.assunto)
      and case
        when jsonb_typeof(c.corpo_lembrete) = 'array'
          then jsonb_array_length(c.corpo_lembrete) > 0
        else false
      end
      and d.is_lembrete = false
      and d.status = 'entregue'
      and d.entregue_em is not null
      and d.entregue_em <= now() - make_interval(hours => c.lembrete_horas)
      and d.aberto_em is null
      and d.clicado_em is null
      and not exists (
        select 1
        from public.destinatario r
        where r.campanha_id = d.campanha_id
          and r.is_lembrete = true
          and lower(btrim(r.email)) = lower(btrim(d.email))
      )
      and not exists (
        select 1
        from public.supressao s
        where s.email is not null
          and lower(btrim(s.email)) = lower(btrim(d.email))
      )
    order by d.data_ultima_compra desc nulls last, d.id
    limit p_limit
  ),
  inserted as (
    insert into public.destinatario (
      campanha_id, id_usuario, nome, email, telefone, regiao,
      data_ultima_compra, is_lembrete, status
    )
    select campanha_id, id_usuario, nome, email, telefone, regiao,
           data_ultima_compra, true, 'pendente'
    from candidates
    returning id
  )
  select count(*) into v_inserted from inserted;

  return v_inserted;
end;
$$;

create table if not exists public.exportacao_csv (
  id uuid primary key default gen_random_uuid(),
  campanha_id uuid references public.campanha(id) on delete set null,
  status text not null default 'pendente'
    check (status in ('pendente', 'processando', 'concluida', 'erro', 'expirada')),
  filtro text not null default 'todos'
    check (filtro in ('todos', 'clicaram', 'abriram_sem_clicar', 'nao_abriram', 'bounce_ou_reclamacao')),
  periodo_inicio date,
  periodo_fim date,
  linhas_processadas integer not null default 0
    check (linhas_processadas >= 0),
  total_linhas integer
    check (total_linhas is null or total_linhas >= 0),
  caminho_objeto text,
  erro text,
  criado_em timestamptz not null default now(),
  iniciado_em timestamptz,
  concluido_em timestamptz,
  expira_em timestamptz not null default (now() + interval '24 hours'),
  constraint exportacao_csv_periodo_check
    check (periodo_fim is null or periodo_inicio is null or periodo_fim >= periodo_inicio)
);

create index if not exists exportacao_csv_status_idx
  on public.exportacao_csv (status, criado_em desc);

create index if not exists exportacao_csv_expira_idx
  on public.exportacao_csv (expira_em)
  where status not in ('concluida', 'erro', 'expirada');

alter table public.configuracao_email_global enable row level security;
alter table public.estado_desengajamento enable row level security;
alter table public.exportacao_csv enable row level security;
revoke all on table public.configuracao_email_global, public.estado_desengajamento, public.exportacao_csv
  from anon, authenticated;
grant all on table public.configuracao_email_global, public.estado_desengajamento, public.exportacao_csv
  to service_role;

revoke all on function public.refresh_chronic_disengagement() from public, anon, authenticated;
revoke all on function public.count_chronic_disengagement() from public, anon, authenticated;
revoke all on function public.enqueue_campaign_reminders(uuid, integer) from public, anon, authenticated;
grant execute on function public.refresh_chronic_disengagement() to service_role;
grant execute on function public.count_chronic_disengagement() to service_role;
grant execute on function public.enqueue_campaign_reminders(uuid, integer) to service_role;