-- Resumable BI exports checkpoint CSV parts and bounded App Storage cleanup.
-- Apply manually in the Supabase SQL Editor before running the updated worker.
alter table public.exportacao_csv
  add column if not exists cursor_destinatario_id uuid,
  add column if not exists partes_processadas integer not null default 0
    check (partes_processadas >= 0),
  add column if not exists fonte_concluida boolean not null default false,
  add column if not exists partes_removidas integer not null default 0
    check (partes_removidas >= 0),
  add column if not exists limpeza_concluida boolean not null default false;