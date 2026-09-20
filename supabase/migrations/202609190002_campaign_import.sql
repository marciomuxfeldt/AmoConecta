create table if not exists public.supressao (
  id uuid primary key default gen_random_uuid(),
  email text,
  telefone text,
  motivo text,
  criado_em timestamptz not null default now(),
  constraint supressao_tem_chave check (email is not null or telefone is not null)
);

create unique index if not exists supressao_email_uidx
  on public.supressao (email)
  where email is not null;

create unique index if not exists supressao_telefone_uidx
  on public.supressao (telefone)
  where telefone is not null;

create table if not exists public.destinatario (
  id uuid primary key default gen_random_uuid(),
  campanha_id uuid not null references public.campanha(id) on delete cascade,
  id_usuario text,
  nome text,
  email text not null,
  telefone text,
  regiao text,
  data_ultima_compra date,
  is_lembrete boolean not null default false,
  criado_em timestamptz not null default now()
);

alter table public.destinatario
  add column if not exists id_usuario text;

alter table public.destinatario
  add column if not exists regiao text;

alter table public.destinatario
  alter column nome drop not null;

create unique index if not exists destinatario_campanha_email_lembrete_uidx
  on public.destinatario (campanha_id, email, is_lembrete);

create index if not exists destinatario_campanha_idx
  on public.destinatario (campanha_id);

create table if not exists public.importacao (
  id uuid primary key default gen_random_uuid(),
  campanha_id uuid not null references public.campanha(id) on delete cascade,
  caminho_arquivo text not null,
  status text not null default 'pendente'
    check (status in ('pendente', 'processando', 'concluida', 'erro')),
  linhas_processadas integer not null default 0,
  total_linhas integer,
  resultado jsonb,
  erro text,
  criado_em timestamptz not null default now(),
  concluido_em timestamptz
);

create index if not exists importacao_campanha_criado_idx
  on public.importacao (campanha_id, criado_em desc);

alter table public.supressao enable row level security;
alter table public.destinatario enable row level security;
alter table public.importacao enable row level security;

drop policy if exists "Usuário autenticado pode consultar destinatários" on public.destinatario;
create policy "Usuário autenticado pode consultar destinatários"
  on public.destinatario
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.campanha
      where public.campanha.id = destinatario.campanha_id
    )
  );

drop policy if exists "Usuário autenticado pode consultar importações" on public.importacao;
create policy "Usuário autenticado pode consultar importações"
  on public.importacao
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.campanha
      where public.campanha.id = importacao.campanha_id
    )
  );create table if not exists public.supressao (
  id uuid primary key default gen_random_uuid(),
  email text,
  telefone text,
  motivo text,
  criado_em timestamptz not null default now(),
  constraint supressao_tem_chave check (email is not null or telefone is not null)
);

create unique index if not exists supressao_email_uidx
  on public.supressao (email)
  where email is not null;

create unique index if not exists supressao_telefone_uidx
  on public.supressao (telefone)
  where telefone is not null;

create table if not exists public.destinatario (
  id uuid primary key default gen_random_uuid(),
  campanha_id uuid not null references public.campanha(id) on delete cascade,
  id_usuario text,
  nome text,
  email text not null,
  telefone text,
  regiao text,
  data_ultima_compra date,
  is_lembrete boolean not null default false,
  criado_em timestamptz not null default now()
);

alter table public.destinatario
  add column if not exists id_usuario text;

alter table public.destinatario
  add column if not exists regiao text;

alter table public.destinatario
  alter column nome drop not null;

create unique index if not exists destinatario_campanha_email_lembrete_uidx
  on public.destinatario (campanha_id, email, is_lembrete);

create index if not exists destinatario_campanha_idx
  on public.destinatario (campanha_id);

create table if not exists public.importacao (
  id uuid primary key default gen_random_uuid(),
  campanha_id uuid not null references public.campanha(id) on delete cascade,
  caminho_arquivo text not null,
  status text not null default 'pendente'
    check (status in ('pendente', 'processando', 'concluida', 'erro')),
  linhas_processadas integer not null default 0,
  total_linhas integer,
  resultado jsonb,
  erro text,
  criado_em timestamptz not null default now(),
  concluido_em timestamptz
);

create index if not exists importacao_campanha_criado_idx
  on public.importacao (campanha_id, criado_em desc);

alter table public.supressao enable row level security;
alter table public.destinatario enable row level security;
alter table public.importacao enable row level security;

drop policy if exists "Usuário autenticado pode consultar destinatários" on public.destinatario;
create policy "Usuário autenticado pode consultar destinatários"
  on public.destinatario
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.campanha
      where public.campanha.id = destinatario.campanha_id
    )
  );

drop policy if exists "Usuário autenticado pode consultar importações" on public.importacao;
create policy "Usuário autenticado pode consultar importações"
  on public.importacao
  for select
  to authenticated
  using (
    exists (
      select 1
      from public.campanha
      where public.campanha.id = importacao.campanha_id
    )
  );