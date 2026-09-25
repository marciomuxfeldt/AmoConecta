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
  ciclo_iniciado_em timestamptz,
  cursor_email text,
  linhas_processadas integer not null default 0 check (linhas_processadas >= 0),
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
  on public.destinatario (lower(btrim(email)), entregue_em, campanha_id)
  where is_lembrete = false;

-- Normalize all future e-mail writes at the database boundary. The NOT VALID
-- checks still protect new writes without making this migration fail because
-- of historical rows; every query over historical delivery data uses the same
-- lower(btrim(email)) expression.
create or replace function public.normalize_email_before_write()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.email := nullif(lower(btrim(new.email)), '');
  return new;
end;
$$;

drop trigger if exists destinatario_normalize_email on public.destinatario;
create trigger destinatario_normalize_email
  before insert or update of email on public.destinatario
  for each row execute function public.normalize_email_before_write();

drop trigger if exists evento_email_normalize_email on public.evento_email;
create trigger evento_email_normalize_email
  before insert or update of email on public.evento_email
  for each row execute function public.normalize_email_before_write();

-- Suppression lookups deliberately compare the normalized recipient expression
-- to the raw suppression column so this existing unique index is usable.
-- Collapse historical case/whitespace duplicates before normalizing that column.
create index if not exists supressao_email_normalizado_migration_idx
  on public.supressao (lower(btrim(email)))
  where email is not null;

delete from public.supressao s
using public.supressao keeper
where s.email is not null
  and keeper.email is not null
  and lower(btrim(s.email)) = lower(btrim(keeper.email))
  and (s.criado_em, s.id) > (keeper.criado_em, keeper.id);

update public.supressao
set email = nullif(lower(btrim(email)), '')
where email is not null
  and email is distinct from nullif(lower(btrim(email)), '');

drop index if exists public.supressao_email_normalizado_migration_idx;

drop trigger if exists supressao_normalize_email on public.supressao;
create trigger supressao_normalize_email
  before insert or update of email on public.supressao
  for each row execute function public.normalize_email_before_write();

alter table public.supressao
  drop constraint if exists supressao_email_normalizado_check;
alter table public.supressao
  add constraint supressao_email_normalizado_check
  check (email is null or email = lower(btrim(email)));

alter table public.destinatario
  drop constraint if exists destinatario_email_normalizado_check;
alter table public.destinatario
  add constraint destinatario_email_normalizado_check
  check (email = lower(btrim(email))) not valid;

alter table public.evento_email
  drop constraint if exists evento_email_email_normalizado_check;
alter table public.evento_email
  add constraint evento_email_email_normalizado_check
  check (email is null or email = lower(btrim(email))) not valid;

update public.evento_email
set email = nullif(lower(btrim(email)), '')
where email is not null
  and email is distinct from nullif(lower(btrim(email)), '');

alter table public.evento_email
  validate constraint evento_email_email_normalizado_check;

create index if not exists evento_email_campanha_email_tipo_idx
  on public.evento_email (campanha_id, email, tipo);

-- Chronic disengagement is contact state, not delivery state: one row per
-- normalized e-mail regardless of how many campaigns contain that contact.
create table if not exists public.contato_desengajamento (
  email text primary key,
  desengajado_cronico boolean not null default false,
  desengajado_desde timestamptz,
  apurado_em timestamptz not null default now(),
  constraint contato_desengajamento_email_normalizado_check
    check (email = lower(btrim(email)) and email <> ''),
  constraint contato_desengajamento_desde_check
    check (desengajado_cronico or desengajado_desde is null)
);

create index if not exists contato_desengajamento_cronico_idx
  on public.contato_desengajamento (email)
  where desengajado_cronico = true;

-- Records the current (and reversible) chronic-disengagement assessment.
-- A recipient is chronic when the email has at least five distinct original
-- campaigns delivered during the rolling six-month window and has no open or
-- click event on any of those deliveries. Each call handles at most 1,000
-- contacts and persists its cursor; calculado_em advances only after a complete
-- pass over the contact set.
create or replace function public.refresh_chronic_disengagement(
  p_limit integer default 1000
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_cursor text;
  v_batch_count integer;
  v_changed integer;
  v_last_email text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'p_limit must be between 1 and 1000';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('refresh_chronic_disengagement', 0));

  insert into public.estado_desengajamento (id, ciclo_iniciado_em)
  values (1, now())
  on conflict (id) do nothing;

  select cursor_email
    into v_cursor
  from public.estado_desengajamento
  where id = 1
  for update;

  update public.estado_desengajamento
  set ciclo_iniciado_em = coalesce(ciclo_iniciado_em, now()),
      linhas_processadas = case
        when ciclo_iniciado_em is null then 0
        else linhas_processadas
      end,
      linhas_atualizadas = case
        when ciclo_iniciado_em is null then 0
        else linhas_atualizadas
      end
  where id = 1;

  with batch as materialized (
    select distinct lower(btrim(d.email)) as email
    from public.destinatario d
    where d.is_lembrete = false
      and lower(btrim(d.email)) > coalesce(v_cursor, '')
    order by email
    limit p_limit
  ),
  engagement as (
    select
      lower(btrim(d.email)) as email,
      count(distinct d.campanha_id) as campanhas_entregues,
      bool_or(
        d.aberto_em is not null
        or d.clicado_em is not null
        or d.status in ('aberto', 'clicado')
      ) as teve_engajamento
    from public.destinatario d
    join batch b on b.email = lower(btrim(d.email))
    where d.is_lembrete = false
      and d.entregue_em >= now() - interval '6 months'
    group by lower(btrim(d.email))
  ),
  assessed as (
    select
      b.email,
      coalesce(
        e.campanhas_entregues >= 5 and not e.teve_engajamento,
        false
      ) as is_chronic
    from batch b
    left join engagement e on e.email = b.email
  ),
  changed_assessments as (
    select a.email
    from assessed a
    left join public.contato_desengajamento cd on cd.email = a.email
    where cd.email is null
       or cd.desengajado_cronico is distinct from a.is_chronic
  ),
  upserted as (
    insert into public.contato_desengajamento (
      email, desengajado_cronico, desengajado_desde, apurado_em
    )
    select
      a.email,
      a.is_chronic,
      case when a.is_chronic then now() else null end,
      now()
    from assessed a
    on conflict (email) do update
      set desengajado_cronico = excluded.desengajado_cronico,
          desengajado_desde = case
            when excluded.desengajado_cronico
              then coalesce(
                contato_desengajamento.desengajado_desde,
                excluded.desengajado_desde
              )
            else null
          end,
          apurado_em = excluded.apurado_em
      where contato_desengajamento.desengajado_cronico
              is distinct from excluded.desengajado_cronico
         or contato_desengajamento.apurado_em
              is distinct from excluded.apurado_em
    returning email
  )
  select
    (select count(*) from batch),
    coalesce((select count(*) from changed_assessments), 0),
    (select max(email) from batch)
  into v_batch_count, v_changed, v_last_email;

  if v_batch_count < p_limit then
    update public.estado_desengajamento
    set calculado_em = now(),
        ciclo_iniciado_em = null,
        cursor_email = null,
        linhas_processadas = linhas_processadas + v_batch_count,
        linhas_atualizadas = linhas_atualizadas + v_changed
    where id = 1;
  else
    update public.estado_desengajamento
    set cursor_email = v_last_email,
        linhas_processadas = linhas_processadas + v_batch_count,
        linhas_atualizadas = linhas_atualizadas + v_changed
    where id = 1;
  end if;

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
  from public.contato_desengajamento
  where desengajado_cronico = true;
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
          and s.email = lower(btrim(d.email))
      )
      and (
        c.incluir_desengajados
        or not exists (
          select 1
          from public.contato_desengajamento cd
          where cd.email = lower(btrim(d.email))
            and cd.desengajado_cronico = true
        )
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
alter table public.contato_desengajamento enable row level security;
alter table public.exportacao_csv enable row level security;
revoke all on table public.configuracao_email_global, public.estado_desengajamento,
  public.contato_desengajamento, public.exportacao_csv
  from anon, authenticated;
grant all on table public.configuracao_email_global, public.estado_desengajamento,
  public.contato_desengajamento, public.exportacao_csv
  to service_role;

revoke all on function public.refresh_chronic_disengagement(integer) from public, anon, authenticated;
revoke all on function public.count_chronic_disengagement() from public, anon, authenticated;
revoke all on function public.enqueue_campaign_reminders(uuid, integer) from public, anon, authenticated;
grant execute on function public.refresh_chronic_disengagement(integer) to service_role;
grant execute on function public.count_chronic_disengagement() to service_role;
grant execute on function public.enqueue_campaign_reminders(uuid, integer) to service_role;