import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  Clock3,
  Download,
  FileDown,
  Filter,
  LoaderCircle,
  RefreshCw,
  Rows3,
  Send,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  BiExportFilter,
  BiExportJobStatus,
  getGetBiExportQueryKey,
  getListBiExportsQueryKey,
  getListCampaignsQueryKey,
  useCreateBiExport,
  useGetBiExport,
  useListBiExports,
  useListCampaigns,
  type BiExportJob,
} from '@workspace/api-client-react';
import { downloadBiExportFile } from '@/lib/bi-export-download';
import { Shell, type SessionUser } from './campaigns';

const filterLabels: Record<string, string> = {
  todos: 'Todos os contatos',
  clicaram: 'Clicaram',
  abriram_sem_clicar: 'Abriram sem clicar',
  nao_abriram: 'Não abriram',
  bounce_ou_reclamacao: 'Bounce ou reclamação',
};

const statusLabels: Record<string, string> = {
  pendente: 'Na fila',
  processando: 'Processando',
  concluida: 'Concluída',
  erro: 'Com erro',
  expirada: 'Expirada',
};

function formatNumber(value: number | null | undefined) {
  return new Intl.NumberFormat('pt-BR').format(value ?? 0);
}

function formatDate(value: string | null | undefined) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date).replace('.', '');
}

function errorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object') {
    const response = error as { error?: unknown; data?: { error?: unknown } };
    if (typeof response.error === 'string') return response.error;
    if (typeof response.data?.error === 'string') return response.data.error;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

function statusTone(status: string) {
  if (status === BiExportJobStatus.concluida) return 'border-[#b9d9bc] bg-[#eef7ee] text-[#3f7b46]';
  if (status === BiExportJobStatus.erro || status === BiExportJobStatus.expirada) return 'border-[#efc9ba] bg-[#fff0e9] text-[#a64220]';
  return 'border-[#e8c56f] bg-[#fff7dc] text-[#8a651c]';
}

function jobProgress(job: BiExportJob) {
  if (job.status === BiExportJobStatus.concluida) return 100;
  if (!job.total_linhas || job.total_linhas <= 0) return job.status === BiExportJobStatus.processando ? 12 : 0;
  return Math.min(99, Math.round((job.linhas_processadas / job.total_linhas) * 100));
}

function ExportSkeleton() {
  return (
    <div className="panel overflow-hidden" data-testid="status-bi-exports-loading">
      <div className="border-b border-[#eee7dc] bg-[#f7f2eb] px-6 py-4"><div className="skeleton h-2 w-44 rounded-full" /></div>
      {Array.from({ length: 3 }).map((_, index) => (
        <div className="grid gap-3 border-b border-[#eee7dc] px-5 py-5 last:border-0 md:grid-cols-[1.4fr_1fr_.8fr_.8fr]" key={index}>
          <div className="skeleton h-4 w-40 rounded-full" /><div className="skeleton h-4 w-28 rounded-full" /><div className="skeleton h-4 w-20 rounded-full" /><div className="skeleton h-8 w-24 rounded-lg" />
        </div>
      ))}
    </div>
  );
}

function DownloadButton({ job }: { job: BiExportJob }) {
  const [error, setError] = useState('');
  const [isDownloading, setIsDownloading] = useState(false);

  const download = async () => {
    setError('');
    setIsDownloading(true);
    let objectUrl: string | null = null;
    try {
      const { blob, filename } = await downloadBiExportFile(job.id);
      objectUrl = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = objectUrl;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (downloadError) {
      if (
        downloadError instanceof TypeError &&
        downloadError.message.includes('createObjectURL')
      ) {
        setError(
          'O navegador não conseguiu preparar o arquivo CSV recebido. Tente novamente; se persistir, atualize a página e solicite uma nova exportação.',
        );
      } else {
        setError(
          downloadError instanceof Error
            ? downloadError.message
            : 'Não foi possível baixar o CSV. Tente novamente.',
        );
      }
    } finally {
      if (objectUrl) {
        window.setTimeout(() => URL.revokeObjectURL(objectUrl as string), 1000);
      }
      setIsDownloading(false);
    }
  };

  return (
    <div className="flex flex-col items-end gap-2">
      <button type="button" onClick={() => void download()} disabled={isDownloading} className="action-button action-button-secondary !px-3 !py-2" data-testid={`button-download-export-${job.id}`}>
        {isDownloading ? <LoaderCircle className="animate-spin" size={14} /> : <Download size={14} />}
        {isDownloading ? 'Preparando' : 'Baixar CSV'}
      </button>
      {error && (
        <div
          role="alert"
          aria-live="assertive"
          className="max-w-xs rounded-lg border border-[#efc9ba] bg-[#fff0e9] p-3 text-right text-xs leading-5 text-[#8e3a20]"
          data-testid={`status-download-error-${job.id}`}
        >
          <p>{error}</p>
          <button
            type="button"
            onClick={() => void download()}
            disabled={isDownloading}
            className="mt-2 font-bold underline underline-offset-2"
          >
            Tentar novamente
          </button>
        </div>
      )}
    </div>
  );
}

export function BiExportsPage({ user }: { user: SessionUser }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [campaignId, setCampaignId] = useState('');
  const [periodStart, setPeriodStart] = useState('');
  const [periodEnd, setPeriodEnd] = useState('');
  const [filter, setFilter] = useState<string>(BiExportFilter.todos);
  const [selectedId, setSelectedId] = useState('');
  const [formError, setFormError] = useState('');
  const [successNotice, setSuccessNotice] = useState('');
  const queryClient = useQueryClient();
  const campaignsQuery = useListCampaigns({ query: { queryKey: getListCampaignsQueryKey() } });
  const exportsQuery = useListBiExports({ query: { queryKey: getListBiExportsQueryKey(), refetchInterval: 5000 } });
  const createExport = useCreateBiExport();
  const jobs = exportsQuery.data?.jobs ?? [];
  const activeId = selectedId || jobs[0]?.id || '';
  const activeJob = useMemo(() => jobs.find((job) => job.id === activeId), [jobs, activeId]);
  const detailQuery = useGetBiExport(activeId, {
    query: {
      queryKey: getGetBiExportQueryKey(activeId),
      enabled: Boolean(activeId),
      refetchInterval: activeJob && (activeJob.status === BiExportJobStatus.pendente || activeJob.status === BiExportJobStatus.processando) ? 2500 : false,
    },
  });
  const detail = detailQuery.data ?? activeJob;

  useEffect(() => {
    if (detailQuery.data && detailQuery.data.status !== BiExportJobStatus.pendente && detailQuery.data.status !== BiExportJobStatus.processando) {
      void queryClient.invalidateQueries({ queryKey: getListBiExportsQueryKey() });
    }
  }, [detailQuery.data, queryClient]);

  const submitExport = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError('');
    setSuccessNotice('');
    if (periodStart && periodEnd && periodStart > periodEnd) {
      setFormError('O início do período precisa ser anterior ao fim.');
      return;
    }
    createExport.mutate(
      {
        data: {
          campanha_id: campaignId || null,
          periodo_inicio: periodStart || null,
          periodo_fim: periodEnd || null,
          filtro: filter as typeof BiExportFilter[keyof typeof BiExportFilter],
        },
      },
      {
        onSuccess: (job) => {
          setSelectedId(job.id);
          setSuccessNotice('Exportação adicionada à fila. Acompanhe o processamento ao lado.');
          void queryClient.invalidateQueries({ queryKey: getListBiExportsQueryKey() });
          void queryClient.invalidateQueries({ queryKey: getGetBiExportQueryKey(job.id) });
        },
        onError: (error) => setFormError(errorMessage(error, 'Não foi possível solicitar a exportação.')),
      },
    );
  };

  const isLoading = campaignsQuery.isLoading || exportsQuery.isLoading;
  const hasError = campaignsQuery.isError || exportsQuery.isError;

  return (
    <Shell
      user={user}
      title="Exportações BI"
      eyebrow="Relatórios operacionais"
      mobileNavOpen={mobileNavOpen}
      setMobileNavOpen={setMobileNavOpen}
    >
      {isLoading ? <ExportSkeleton /> : hasError ? (
        <div className="rounded-2xl border border-[#efc9ba] bg-[#fff0e9] px-6 py-14 text-center" data-testid="status-bi-exports-error">
          <CircleAlert className="mx-auto text-[#bd4f26]" size={24} />
          <h2 className="mt-4 font-extrabold text-[#8e3a20]">Os dados não carregaram.</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#a65d46]">Não conseguimos consultar campanhas e exportações agora.</p>
          <button type="button" onClick={() => { void campaignsQuery.refetch(); void exportsQuery.refetch(); }} className="action-button action-button-primary mt-5" data-testid="button-bi-exports-retry"><RefreshCw size={14} /> Tentar novamente</button>
        </div>
      ) : (
        <div className="animate-rise-in-delay">
          <div className="grid gap-5 lg:grid-cols-[minmax(0,430px)_1fr]">
            <section className="panel h-fit p-6 sm:p-8" data-testid="panel-create-bi-export">
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#263044] text-[#d7ef56]"><FileDown size={20} /></div>
                <div>
                  <p className="section-kicker">Nova extração</p>
                  <h2 className="mt-2 text-2xl font-extrabold tracking-[-.06em] text-[#263044]">Criar exportação</h2>
                  <p className="mt-2 text-sm leading-6 text-[#747783]">Escolha o recorte. O arquivo será preparado em segundo plano para não interromper a operação.</p>
                </div>
              </div>

              <form onSubmit={submitExport} className="mt-8 space-y-5">
                <div>
                  <label htmlFor="export-campaign" className="field-label">Campanha</label>
                  <select id="export-campaign" value={campaignId} onChange={(event) => setCampaignId(event.target.value)} className="field-control" data-testid="select-export-campaign">
                    <option value="">Todas as campanhas</option>
                    {campaignsQuery.data?.map((campaign) => <option value={campaign.id} key={campaign.id}>{campaign.nome}</option>)}
                  </select>
                  <p className="field-hint">Deixe em todas para uma visão consolidada.</p>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div><label htmlFor="export-period-start" className="field-label">Período inicial</label><input id="export-period-start" type="date" value={periodStart} onChange={(event) => setPeriodStart(event.target.value)} className="field-control" data-testid="input-export-period-start" /></div>
                  <div><label htmlFor="export-period-end" className="field-label">Período final</label><input id="export-period-end" type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} className="field-control" data-testid="input-export-period-end" /></div>
                </div>
                <div>
                  <label htmlFor="export-filter" className="field-label">Filtro de engajamento</label>
                  <div className="relative">
                    <Filter size={14} className="pointer-events-none absolute left-3 top-3.5 text-[#9b9897]" />
                    <select id="export-filter" value={filter} onChange={(event) => setFilter(event.target.value)} className="field-control pl-9" data-testid="select-export-filter">
                      {Object.entries(filterLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}
                    </select>
                  </div>
                </div>
                {formError && <p className="rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-xs font-semibold leading-5 text-[#a64220]" role="alert" data-testid="status-create-export-error">{formError}</p>}
                {successNotice && <p className="flex items-start gap-2 rounded-xl border border-[#b9d9bc] bg-[#eef7ee] px-4 py-3 text-xs font-semibold leading-5 text-[#3f7b46]" role="status" data-testid="status-create-export-success"><CheckCircle2 size={15} className="mt-0.5 shrink-0" /> {successNotice}</p>}
                <button type="submit" disabled={createExport.isPending} className="action-button action-button-primary w-full" data-testid="button-create-bi-export">
                  {createExport.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <Send size={15} />}
                  {createExport.isPending ? 'Solicitando' : 'Solicitar CSV'}
                </button>
              </form>
            </section>

            <section className="min-w-0" data-testid="panel-bi-export-status">
              <div className="mb-4 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
                <div><p className="section-kicker">Fila e histórico</p><h2 className="mt-2 text-xl font-extrabold tracking-[-.05em] text-[#263044]">Exportações recentes</h2><p className="mt-1 text-xs text-[#85858b]">A lista atualiza automaticamente enquanto um arquivo é processado.</p></div>
                <div className="flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.12em] text-[#969298]"><span className="h-1.5 w-1.5 rounded-full bg-[#63a76f]" /> atualização contínua</div>
              </div>

              {jobs.length === 0 ? (
                <div className="panel relative overflow-hidden px-6 py-16 text-center sm:px-10" data-testid="empty-bi-exports">
                  <div className="absolute left-1/2 top-0 h-1 w-24 -translate-x-1/2 bg-[#d7ef56]" />
                  <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl border border-[#e4daca] bg-[#f5efe7] text-[#d35f2a]"><Rows3 size={28} strokeWidth={1.5} /></div>
                  <p className="mt-7 section-kicker">Nenhum arquivo ainda</p>
                  <h3 className="mt-3 text-xl font-extrabold tracking-[-.05em] text-[#263044]">O primeiro recorte começa aqui.</h3>
                  <p className="mx-auto mt-2 max-w-sm text-sm leading-6 text-[#747783]">Solicite uma exportação ao lado. O histórico ficará disponível para download quando o processamento terminar.</p>
                </div>
              ) : (
                <div className="space-y-4">
                  {detail && (
                    <div className="panel border-[#d7ef56] bg-[#fbf9f5] p-5 sm:p-6" data-testid={`card-export-detail-${detail.id}`}>
                      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
                        <div>
                          <div className="flex flex-wrap items-center gap-2"><span className={`rounded-full border px-2.5 py-1 font-mono text-[9px] uppercase tracking-[.12em] ${statusTone(detail.status)}`} data-testid={`status-export-${detail.id}`}>{statusLabels[detail.status] ?? detail.status}</span><span className="font-mono text-[9px] uppercase tracking-[.1em] text-[#a19c99]">ID {detail.id.slice(0, 8)}</span></div>
                          <h3 className="mt-3 text-lg font-extrabold tracking-[-.04em] text-[#263044]">{filterLabels[detail.filtro] ?? detail.filtro}</h3>
                          <p className="mt-1 text-xs text-[#85858b]">{detail.campanha_id ? `Campanha selecionada · ${detail.campanha_id.slice(0, 8)}` : 'Todas as campanhas'} · criado em {formatDate(detail.criado_em)}</p>
                        </div>
                        {detail.status === BiExportJobStatus.concluida && detail.disponivel_para_download && <DownloadButton job={detail} />}
                      </div>
                      <div className="mt-6">
                        <div className="mb-2 flex justify-between font-mono text-[9px] uppercase tracking-[.1em] text-[#8b8d96]"><span>Progresso</span><span data-testid={`text-export-progress-${detail.id}`}>{jobProgress(detail)}%</span></div>
                        <div className="h-2 overflow-hidden rounded-full bg-[#eee7dc]"><div className="h-full rounded-full bg-[#247b79] transition-[width] duration-500" style={{ width: `${jobProgress(detail)}%` }} /></div>
                        <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[#747783]"><span className="flex items-center gap-1.5"><Rows3 size={13} className="text-[#d35f2a]" /> {formatNumber(detail.linhas_processadas)}{detail.total_linhas != null ? ` de ${formatNumber(detail.total_linhas)}` : ''} linhas</span>{detail.expira_em && <span className="flex items-center gap-1.5"><Clock3 size={13} className="text-[#d35f2a]" /> expira em {formatDate(detail.expira_em)}</span>}</div>
                      </div>
                      {detail.erro && <p role={detail.status === BiExportJobStatus.erro ? 'alert' : undefined} className="mt-4 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-xs font-semibold leading-5 text-[#a64220]" data-testid={`status-export-job-error-${detail.id}`}>{detail.erro}</p>}
                    </div>
                  )}
                  <div className="panel overflow-hidden" data-testid="bi-export-list">
                    <div className="hidden grid-cols-[1.3fr_1fr_.8fr_.9fr] gap-4 border-b border-[#eee7dc] bg-[#f7f2eb] px-6 py-3 font-mono text-[9px] uppercase tracking-[.14em] text-[#8b8d96] md:grid"><span>Recorte</span><span>Status</span><span>Linhas</span><span className="text-right">Ação</span></div>
                    {jobs.map((job) => (
                      <button type="button" key={job.id} onClick={() => setSelectedId(job.id)} className={`grid w-full grid-cols-2 gap-x-4 gap-y-3 border-b border-[#eee7dc] px-5 py-5 text-left last:border-0 hover:bg-[#f8f3ec] md:grid-cols-[1.3fr_1fr_.8fr_.9fr] md:items-center md:px-6 ${job.id === activeId ? 'bg-[#f8f3ec]' : ''}`} data-testid={`row-bi-export-${job.id}`}>
                        <span><strong className="block truncate text-sm font-extrabold text-[#263044]">{filterLabels[job.filtro] ?? job.filtro}</strong><span className="mt-1 block font-mono text-[9px] uppercase tracking-[.08em] text-[#99959a]">{formatDate(job.criado_em)}</span>{job.status === BiExportJobStatus.erro && job.erro && <span className="mt-2 block text-[10px] font-semibold leading-4 text-[#a64220]" data-testid={`status-export-list-error-${job.id}`}>{job.erro}</span>}</span>
                        <span className={`w-fit rounded-full border px-2.5 py-1 font-mono text-[9px] uppercase tracking-[.1em] ${statusTone(job.status)}`}>{statusLabels[job.status] ?? job.status}</span>
                        <span className="text-sm font-bold tabular-nums text-[#42495b]">{formatNumber(job.linhas_processadas)}{job.total_linhas != null ? ` / ${formatNumber(job.total_linhas)}` : ''}<span className="mt-1 block font-mono text-[9px] uppercase text-[#aaa3a1] md:hidden">linhas</span></span>
                        <span className="col-span-2 flex justify-end md:col-span-1">{job.status === BiExportJobStatus.concluida && job.disponivel_para_download ? <span className="flex items-center gap-1.5 text-xs font-bold text-[#247b79]"><Download size={13} /> Baixar</span> : job.status === BiExportJobStatus.erro ? <span className="flex items-center gap-1.5 text-xs font-semibold text-[#a64220]"><CircleAlert size={13} /> Ver falha</span> : <span className="flex items-center gap-1.5 text-xs font-semibold text-[#8b8d96]"><Clock3 size={13} /> Ver andamento</span>}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>
          </div>
        </div>
      )}
    </Shell>
  );
}

export default BiExportsPage;