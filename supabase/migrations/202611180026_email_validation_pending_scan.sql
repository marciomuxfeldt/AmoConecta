-- Run outside an explicit transaction so the active validation queue stays writable.
CREATE INDEX CONCURRENTLY IF NOT EXISTS validacao_email_job_item_pending_id_idx
  ON public.validacao_email_job_item(job_id,id)
  WHERE status='pendente';
