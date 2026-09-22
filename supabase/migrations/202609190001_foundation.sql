create extension if not exists pgcrypto;

create table if not exists public.campanha (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  assunto text not null,
  assunto_lembrete text,
  remetente_nome text not null,
  remetente_email text not null,
  valor_credito numeric,
  validade_credito date,
  corpo jsonb not null default '[]'::jsonb,
  url_deeplink text,
  url_landing text,
  teto_hora integer,
  teto_dia integer,
  status text not null default 'rascunho'
    check (status in ('rascunho', 'agendada', 'enviando', 'pausada', 'concluida')),
  agendada_para timestamptz,
  lembrete_ativo boolean not null default false,
  lembrete_horas integer not null default 48,
  teste_enviado boolean not null default false,
  criado_em timestamptz not null default now()
);

alter table public.campanha enable row level security;

drop policy if exists "Usuário autenticado pode consultar campanhas" on public.campanha;
create policy "Usuário autenticado pode consultar campanhas"
  on public.campanha
  for select
  to authenticated
  using (true);create extension if not exists pgcrypto;

create table if not exists public.campanha (
  id uuid primary key default gen_random_uuid(),
  nome text not null,
  assunto text not null,
  assunto_lembrete text,
  remetente_nome text not null,
  remetente_email text not null,
  valor_credito numeric,
  validade_credito date,
  corpo jsonb not null default '[]'::jsonb,
  url_deeplink text,
  url_landing text,
  teto_hora integer,
  teto_dia integer,
  status text not null default 'rascunho'
    check (status in ('rascunho', 'agendada', 'enviando', 'pausada', 'concluida')),
  agendada_para timestamptz,
  lembrete_ativo boolean not null default false,
  lembrete_horas integer not null default 48,
  teste_enviado boolean not null default false,
  criado_em timestamptz not null default now()
);

alter table public.campanha enable row level security;

drop policy if exists "Usuário autenticado pode consultar campanhas" on public.campanha;
create policy "Usuário autenticado pode consultar campanhas"
  on public.campanha
  for select
  to authenticated
  using (true);