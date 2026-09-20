-- Fase 4: fila de envio, rastreabilidade e modo de segurança.
-- Aplicar manualmente no Supabase. Não cria nem altera políticas de RLS.

alter table public.destinatario
  add column if not exists status text not null default 'pendente',
  add column if not exists resend_email_id text,
  add column if not exists tentativas integer not null default 0,
  add column if not exists erro text,
  add column if not exists enviado_em timestamptz,
  add column if not exists entregue_em timestamptz,
  add column if not exists aberto_em timestamptz,
  add column if not exists clicado_em timestamptz;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'destinatario_status_check'
      and conrelid = 'public.destinatario'::regclass
  ) then
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
        'bloqueado_modo_teste'
      ));
  end if;
end
$$;

create index if not exists destinatario_campanha_status_idx
  on public.destinatario (campanha_id, status);

create index if not exists destinatario_resend_email_id_idx
  on public.destinatario (resend_email_id);

create index if not exists destinatario_pendente_idx
  on public.destinatario (status)
  where status = 'pendente';

alter table public.supressao
  add column if not exists origem text;

alter table public.campanha
  add column if not exists reply_to text;