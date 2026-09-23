create index if not exists destinatario_campanha_recencia_idx
  on public.destinatario (campanha_id, data_ultima_compra)
  where is_lembrete = false;

create index if not exists destinatario_campanha_main_status_idx
  on public.destinatario (campanha_id, status)
  where is_lembrete = false;