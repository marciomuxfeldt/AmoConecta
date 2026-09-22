-- Fase 4: rastreia a pausa automática por reputação.
-- Aplicar manualmente no Supabase SQL Editor.

alter table public.campanha
  add column if not exists pausa_motivo text,
  add column if not exists pausa_taxa_bounce numeric,
  add column if not exists pausa_taxa_reclamacao numeric,
  add column if not exists pausada_em timestamptz;-- Fase 4: rastreia a pausa automática por reputação.
-- Aplicar manualmente no Supabase SQL Editor.

alter table public.campanha
  add column if not exists pausa_motivo text,
  add column if not exists pausa_taxa_bounce numeric,
  add column if not exists pausa_taxa_reclamacao numeric,
  add column if not exists pausada_em timestamptz;