-- Adiciona o timestamp usado para detectar reservas abandonadas pelo worker.
alter table public.destinatario
  add column if not exists processando_em timestamptz;

create index if not exists destinatario_processando_idx
  on public.destinatario (processando_em, id)
  where status = 'processando';-- Adiciona o timestamp usado para detectar reservas abandonadas pelo worker.
alter table public.destinatario
  add column if not exists processando_em timestamptz;

create index if not exists destinatario_processando_idx
  on public.destinatario (processando_em, id)
  where status = 'processando';