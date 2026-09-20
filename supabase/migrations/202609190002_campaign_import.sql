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
  nome text not null,
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

create unique index if not exists destinatario_campanha_email_lembrete_uidx
  on public.destinatario (campanha_id, email, is_lembrete);

create index if not exists destinatario_campanha_idx
  on public.destinatario (campanha_id);

alter table public.supressao enable row level security;
alter table public.destinatario enable row level security;

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