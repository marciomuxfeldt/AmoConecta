alter table public.campanha
  add column if not exists data_referencia_tipo text,
  add column if not exists data_referencia_rotulo text;

alter table public.campanha
  drop constraint if exists campanha_data_referencia_check;

alter table public.campanha
  add constraint campanha_data_referencia_check
  check (
    (data_referencia_tipo is null and data_referencia_rotulo is null)
    or (
      data_referencia_tipo in ('compra', 'acesso', 'criacao_conta')
      and data_referencia_rotulo is null
    )
    or (
      data_referencia_tipo = 'outro'
      and nullif(btrim(data_referencia_rotulo), '') is not null
      and char_length(data_referencia_rotulo) <= 80
    )
  );

alter table public.importacao
  add column if not exists cabecalhos jsonb not null default '[]'::jsonb,
  add column if not exists mapeamento jsonb not null default '[]'::jsonb,
  add column if not exists deduplicar_por_telefone boolean not null default false,
  add column if not exists data_referencia_tipo text,
  add column if not exists data_referencia_rotulo text,
  add column if not exists confirmar_datas_invalidas boolean not null default false;

alter table public.importacao
  drop constraint if exists importacao_status_check;

alter table public.importacao
  add constraint importacao_status_check
  check (
    status in (
      'pendente',
      'processando',
      'aguardando_confirmacao',
      'concluida',
      'erro',
      'cancelada'
    )
  );

create table if not exists public.importacao_mapeamento_cabecalho (
  assinatura text primary key
    check (assinatura ~ '^[0-9a-f]{64}$'),
  mapeamento jsonb not null
    check (jsonb_typeof(mapeamento) = 'array'),
  atualizado_em timestamptz not null default now()
);

alter table public.importacao_mapeamento_cabecalho enable row level security;
revoke all on public.importacao_mapeamento_cabecalho from public, anon, authenticated;
grant select, insert, update, delete
  on public.importacao_mapeamento_cabecalho to service_role;
