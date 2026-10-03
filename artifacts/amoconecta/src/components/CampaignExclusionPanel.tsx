import { useRef, useState, type ReactNode } from 'react';
import {
  CircleAlert,
  FileUp,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  UserMinus,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  type CampaignExclusionOverview,
  type CampaignReputationPeriod,
  type CampaignRecipientSummary,
  type CampaignExclusionResult,
  type ImportValidationSummary,
  getGetCampaignExclusionsQueryKey,
  getGetCampaignQueryKey,
  getGetCampaignAuditQueryKey,
  getGetCampaignRecipientSummaryQueryKey,
  useGetCampaignExclusions,
  useExcludeCampaignRecipients,
  useRestoreCampaignRecipients,
} from '@workspace/api-client-react';
import { ScrollConfirmation } from './ScrollConfirmation';

export const EXCLUSION_PAGE_SIZE = 20;
export const EXCLUSION_CSV_MAX_BYTES = 5_000_000;
export const MISSING_DATE_WARNING_PERCENT = 20;
export const CATASTROPHE_MIN_SENT = 200;
export const NORMAL_MIN_SENT = 1000;

type ProviderKey = 'gmail' | 'microsoft' | 'yahoo' | 'outros';
const providerLabels: Record<ProviderKey, string> = {
  gmail: 'Gmail',
  microsoft: 'Microsoft',
  yahoo: 'Yahoo',
  outros: 'Outros',
};
const motiveSuggestions = [
  'provedor: ',
  'validacao: ',
  'decisao do operador: ',
];

const nf = (value: number | null | undefined) => new Intl.NumberFormat('pt-BR').format(value ?? 0);
/** Converts a fractional rate (0..1) into a pt-BR percentage string. */
export function rateToPercent(rate: number | null | undefined) {
  return `${((rate ?? 0) * 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}
const fmtDate = (value: string | null | undefined) => {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return new Intl.DateTimeFormat('pt-BR', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(d).replace('.', '');
};
function errText(error: unknown, fallback: string) {
  if (error && typeof error === 'object') {
    const r = error as { data?: unknown; error?: unknown };
    if (typeof r.error === 'string') return r.error;
    if (r.data && typeof r.data === 'object' && typeof (r.data as { error?: unknown }).error === 'string') {
      return (r.data as { error: string }).error;
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export function isExclusionLocked(status?: string) {
  return status === 'concluida' || status === 'cancelada';
}

/** Share (0..100) of recipients whose recency bucket is "sem data". */
export function missingDateShare(summary?: Pick<CampaignRecipientSummary, 'recencia' | 'total' | 'total_na_lista'>) {
  if (!summary?.recencia) return null;
  const total = summary.total_na_lista ?? summary.total ?? 0;
  if (total <= 0) return null;
  const bucket = summary.recencia.find((item) => /sem\s+data/i.test(item.faixa));
  const count = bucket?.quantidade ?? 0;
  return { count, total, percent: (count / total) * 100 };
}

export function MissingDateWarning({ percent, count, testId }: { percent: number; count: number; testId: string }) {
  if (!(percent > MISSING_DATE_WARNING_PERCENT)) return null;
  return (
    <div className="mt-5 flex items-start gap-3 rounded-xl border border-[#e8c56f] bg-[#fff7dc] px-4 py-3 text-xs leading-5 text-[#74561c]" role="status" data-testid={testId}>
      <CircleAlert size={16} className="mt-0.5 shrink-0 text-[#b47b1c]" />
      <p>
        <strong>{nf(count)} destinatários ({percent.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%) estão sem data da última compra.</strong>{' '}
        Sem a data, a ordenação por recência não distingue quem comprou há pouco e a deduplicação por telefone pode manter o registro errado. O envio não é bloqueado; revise a base se puder.
      </p>
    </div>
  );
}

export function CampaignMissingDateNotice({ summary }: { summary?: CampaignRecipientSummary }) {
  const share = missingDateShare(summary);
  if (!share) return null;
  return <MissingDateWarning percent={share.percent} count={share.count} testId="status-campaign-missing-date-warning" />;
}

export function ImportDataQualityNotices({ summary }: { summary: ImportValidationSummary }) {
  const missing = summary.datas_ausentes ?? 0;
  const pct = summary.datas_ausentes_percentual ?? 0;
  const typos = summary.dominios_suspeitos ?? [];
  const typoTotal = summary.dominios_suspeitos_total ?? typos.length;
  if (!(pct > MISSING_DATE_WARNING_PERCENT) && typoTotal === 0) return null;
  return (
    <div className="mt-6 space-y-3" data-testid="import-data-quality-notices">
      <MissingDateWarning percent={pct} count={missing} testId="status-import-missing-dates-warning" />
      {typoTotal > 0 && (
        <div className="rounded-xl border border-[#e8c56f] bg-[#fff9e9] p-4 text-xs leading-5 text-[#74561c]" data-testid="status-import-suspicious-domains">
          <strong>{nf(typoTotal)} endereços com domínio possivelmente digitado errado.</strong>{' '}
          Nada foi corrigido nem recusado: eles continuam na lista exatamente como vieram. Confira as sugestões e corrija na origem se fizer sentido.
          <ul className="mt-3 divide-y divide-[#f1dfb8] rounded-lg border border-[#f1dfb8] bg-white/60">
            {typos.map((item) => (
              <li key={`${item.linha}-${item.email}`} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2" data-testid={`row-suspicious-domain-${item.linha}`}>
                <span className="font-mono text-[10px] text-[#8a6b2c]">linha {item.linha}</span>
                <span className="min-w-0 flex-1 truncate font-semibold">{item.email}</span>
                <span className="text-[#417846]">sugestão: {item.sugestao}</span>
              </li>
            ))}
          </ul>
          {typoTotal > typos.length && <p className="mt-2">Mostrando {nf(typos.length)} de {nf(typoTotal)}.</p>}
        </div>
      )}
    </div>
  );
}

export function useCampaignExclusionOverview(campaignId: string, offset: number, status?: string) {
  const params = { offset, limit: EXCLUSION_PAGE_SIZE };
  return useGetCampaignExclusions(campaignId, params, {
    query: {
      enabled: Boolean(campaignId),
      queryKey: getGetCampaignExclusionsQueryKey(campaignId, params),
      refetchInterval: status === 'enviando' ? 15000 : false,
    },
  });
}

function PeriodCard({ title, hint, period, testId }: { title: string; hint: string; period: CampaignReputationPeriod; testId: string }) {
  return (
    <div className="rounded-xl border border-[#e5ddd0] bg-[#fffdf9] p-4" data-testid={testId}>
      <h4 className="text-sm font-extrabold text-[#263044]">{title}</h4>
      <p className="mt-1 text-[11px] leading-4 text-[#7d7e87]">{hint}</p>
      <dl className="mt-3 grid grid-cols-2 gap-3 text-xs">
        <div><dt className="text-[#7d7e87]">Bounce permanente</dt><dd className="text-xl font-extrabold tabular-nums text-[#263044]" data-testid={`${testId}-bounce`}>{rateToPercent(period.taxa_bounce)}</dd><dd className="text-[10px] text-[#9a9492]">{nf(period.bounces_permanentes)} de {nf(period.enviados)} enviados</dd></div>
        <div><dt className="text-[#7d7e87]">Reclamações</dt><dd className="text-xl font-extrabold tabular-nums text-[#263044]" data-testid={`${testId}-complaint`}>{rateToPercent(period.taxa_reclamacao)}</dd><dd className="text-[10px] text-[#9a9492]">{nf(period.reclamacoes)} de {nf(period.entregues)} entregues</dd></div>
      </dl>
    </div>
  );
}

export function ReputationComparison({ overview }: { overview: CampaignExclusionOverview }) {
  return (
    <div className="mt-5" data-testid="panel-reputation-comparison">
      <div className="grid gap-3 md:grid-cols-2">
        <PeriodCard title="Acumulada da campanha" hint="Todos os envios desde o início." period={overview.acumulada} testId="reputation-cumulative" />
        <PeriodCard
          title="Período atual (após a retomada)"
          hint={overview.retomada_em ? `Desde ${fmtDate(overview.retomada_em)}; base de ${nf(overview.retomada_enviados_base)} envios anteriores.` : 'Sem retomada: coincide com a acumulada.'}
          period={overview.periodo_atual}
          testId="reputation-current"
        />
      </div>
      <p className="mt-3 text-xs leading-5 text-[#6d7180]" data-testid="text-reputation-triggers">
        Dois gatilhos pausam o envio: <strong>catastrófico</strong>, a partir de {nf(CATASTROPHE_MIN_SENT)} envios, com mais de 4% de bounce permanente ou mais de 0,5% de reclamações sobre entregues; e <strong>normal</strong>, a partir de {nf(NORMAL_MIN_SENT)} envios, com mais de 2% de bounce permanente ou mais de 0,2% de reclamações. Abaixo de {nf(CATASTROPHE_MIN_SENT)} envios nenhuma avaliação é feita. Após uma retomada, a avaliação considera o período atual.
      </p>
    </div>
  );
}

function sampleNote(sent: number) {
  if (sent === 0) return 'sem envios';
  if (sent < CATASTROPHE_MIN_SENT) return `amostra pequena (${nf(sent)} enviados)`;
  return null;
}

export function ProviderTable({ overview }: { overview: CampaignExclusionOverview }) {
  return (
    <div className="mt-5 overflow-x-auto rounded-xl border border-[#e5ddd0]" data-testid="table-provider-diagnostics">
      <table className="w-full min-w-[720px] text-left text-xs">
        <thead className="bg-[#f7f2eb] font-mono text-[9px] uppercase tracking-[.1em] text-[#8b8d96]">
          <tr>
            {['Provedor', 'Total', 'Pendentes', 'Excluídos', 'Enviados', 'Recebidos', 'Bounce total', 'Bounce permanente'].map((h) => <th key={h} className="px-3 py-2.5 font-medium">{h}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-[#eee7dc] bg-[#fffdf9]">
          {overview.provedores.map((p) => {
            const note = sampleNote(p.enviados);
            return (
              <tr key={p.provedor} data-testid={`row-provider-${p.provedor}`}>
                <td className="px-3 py-2.5 font-extrabold text-[#263044]">{providerLabels[p.provedor] ?? p.provedor}</td>
                <td className="px-3 py-2.5 tabular-nums">{nf(p.total)}</td>
                <td className="px-3 py-2.5 tabular-nums">{nf(p.pendentes)}</td>
                <td className="px-3 py-2.5 tabular-nums">{nf(p.excluidos)}</td>
                <td className="px-3 py-2.5 tabular-nums">{nf(p.enviados)}</td>
                <td className="px-3 py-2.5 tabular-nums">{nf(p.entregues)}</td>
                <td className="px-3 py-2.5 tabular-nums" data-testid={`text-provider-bounce-${p.provedor}`}>{rateToPercent(p.taxa_bounce)}<span className="block text-[10px] text-[#9a9492]">{nf(p.bounces)} de {nf(p.enviados)} enviados</span></td>
                <td className="px-3 py-2.5 tabular-nums" data-testid={`text-provider-permanent-${p.provedor}`}>{rateToPercent(p.taxa_bounce_permanente)}<span className="block text-[10px] text-[#9a9492]">{nf(p.bounces_permanentes)} de {nf(p.enviados)} enviados</span>{note && <span className="mt-1 block text-[10px] font-bold text-[#9b6b17]" data-testid={`text-provider-sample-${p.provedor}`}>{note}</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="border-t border-[#eee7dc] bg-[#f8f3ec] px-3 py-2 text-[11px] leading-4 text-[#7d7e87]" data-testid="text-provider-sample-caveat">
        As taxas usam enviados como denominador. Com poucos envios por provedor (menos de {nf(CATASTROPHE_MIN_SENT)}) uma única ocorrência muda muito o percentual: trate como indício, não como conclusão.
      </p>
    </div>
  );
}

/** Diagnostics block shown inside the resume confirmation. */
export function ResumeDiagnostics({
  rates,
  reason,
  overview,
  loading,
  error,
  onRetry,
}: {
  rates: { bounce?: number | null; complaint?: number | null };
  reason?: string | null;
  overview?: CampaignExclusionOverview;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="mt-4 space-y-3" data-testid="resume-diagnostics">
      <div className="rounded-xl border border-[#efc9ba] bg-[#fffaf6] p-3 text-xs leading-5 text-[#6d7180]" data-testid="text-resume-recorded-trigger">
        <strong className="text-[#a64220]">Registrado na pausa:</strong> bounce permanente {rateToPercent(rates.bounce)} · reclamações {rateToPercent(rates.complaint)}.
        {reason ? <> Motivo: {reason}</> : null}
      </div>
      {loading && <div className="skeleton h-16 rounded-xl" data-testid="status-resume-diagnostics-loading" />}
      {error && !loading && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-xs text-[#a64220]" role="alert" data-testid="status-resume-diagnostics-error">
          <span>Não foi possível carregar o diagnóstico da fila. A confirmação fica bloqueada até carregar.</span>
          <button type="button" onClick={onRetry} className="action-button action-button-secondary !px-3" data-testid="button-resume-diagnostics-retry"><RefreshCw size={13} /> Tentar novamente</button>
        </div>
      )}
      {overview && (
        <>
          <div className="rounded-xl border border-[#e5ddd0] bg-[#fffdf9] p-3 text-xs leading-5 text-[#42495b]" data-testid="text-resume-remaining-queue">
            Restam <strong className="tabular-nums">{nf(overview.pendentes_na_fila)}</strong> destinatários pendentes na fila após as exclusões ({nf(overview.total_excluidos)} excluídos no total).
          </div>
          {overview.exclusoes_desde_pausa === 0 && (
            <div className="rounded-xl border-2 border-[#d35f2a] bg-[#fff3ee] px-4 py-3 text-xs font-bold leading-5 text-[#8e3a20]" role="alert" data-testid="status-resume-no-exclusions-warning">
              Nenhum destinatário foi excluído desde a pausa. Se a causa estava na lista (por exemplo, um provedor), retomar repetirá o problema.
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Notice({ tone, children, testId }: { tone: 'ok' | 'error'; children: ReactNode; testId: string }) {
  const cls = tone === 'ok' ? 'border-[#cfe4c7] bg-[#f2f8ee] text-[#417846]' : 'border-[#efc9ba] bg-[#fff0e9] text-[#a64220]';
  return <div className={`mt-4 rounded-xl border px-4 py-3 text-xs leading-5 ${cls}`} role={tone === 'error' ? 'alert' : 'status'} data-testid={testId}>{children}</div>;
}

export function CampaignExclusionPanel({
  campaignId,
  campaignStatus,
  offset,
  onOffsetChange,
  query,
}: {
  campaignId: string;
  campaignStatus?: string;
  offset: number;
  onOffsetChange: (offset: number) => void;
  query: { data?: CampaignExclusionOverview; isLoading: boolean; isError: boolean; error: unknown; refetch: () => unknown };
}) {
  const queryClient = useQueryClient();
  const exclude = useExcludeCampaignRecipients();
  const restore = useRestoreCampaignRecipients();
  const locked = isExclusionLocked(campaignStatus);
  const overview = query.data;
  const fileRef = useRef<HTMLInputElement>(null);
  const [providers, setProviders] = useState<ProviderKey[]>([]);
  const [motivo, setMotivo] = useState('');
  const [emailsText, setEmailsText] = useState('');
  const [csvText, setCsvText] = useState<string | null>(null);
  const [csvName, setCsvName] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [result, setResult] = useState<CampaignExclusionResult | null>(null);
  const [restoreTarget, setRestoreTarget] = useState<string | 'all' | null>(null);
  const [restoreMessage, setRestoreMessage] = useState<string | null>(null);

  const emails = emailsText.split(/[\s,;]+/).map((e) => e.trim()).filter(Boolean);
  const hasSelection = providers.length > 0 || csvText !== null || emails.length > 0;

  const invalidateAll = () => {
    void queryClient.invalidateQueries({ queryKey: getGetCampaignRecipientSummaryQueryKey(campaignId) });
    void queryClient.invalidateQueries({ queryKey: getGetCampaignQueryKey(campaignId) });
    void queryClient.invalidateQueries({ queryKey: getGetCampaignAuditQueryKey(campaignId) });
    void queryClient.invalidateQueries({ queryKey: getGetCampaignExclusionsQueryKey(campaignId) });
  };

  const onFile = async (file: File | undefined) => {
    setFormError(null);
    if (!file) return;
    if (file.size > EXCLUSION_CSV_MAX_BYTES) {
      setFormError('O CSV excede o limite de 5 MB.');
      if (fileRef.current) fileRef.current.value = '';
      return;
    }
    try {
      const text = await file.text();
      if (!text.trim()) throw new Error('vazio');
      setCsvText(text);
      setCsvName(file.name);
    } catch {
      setCsvText(null);
      setCsvName('');
      setFormError('Não foi possível ler o CSV. Use um arquivo com uma coluna email.');
    }
  };

  const clearCsv = () => {
    setCsvText(null);
    setCsvName('');
    if (fileRef.current) fileRef.current.value = '';
  };

  const requestConfirm = () => {
    setResult(null);
    if (!motivo.trim()) return setFormError('Descreva o motivo da exclusão.');
    if (!hasSelection) return setFormError('Escolha provedores, envie um CSV com coluna email ou informe endereços.');
    setFormError(null);
    setConfirming(true);
  };

  const submitExclusion = () => {
    exclude.mutate(
      {
        campaignId,
        data: {
          motivo: motivo.trim(),
          ...(providers.length > 0 ? { provedores: providers } : {}),
          ...(csvText !== null ? { csv: csvText } : {}),
          ...(emails.length > 0 ? { emails } : {}),
        },
      },
      {
        onSuccess: (res) => {
          setResult(res);
          setConfirming(false);
          setProviders([]);
          setMotivo('');
          setEmailsText('');
          clearCsv();
          onOffsetChange(0);
          invalidateAll();
        },
        onError: (error) => {
          setConfirming(false);
          setFormError(errText(error, 'Não foi possível excluir os destinatários.'));
          invalidateAll();
        },
      },
    );
  };

  const submitRestore = () => {
    if (!restoreTarget) return;
    const data = restoreTarget === 'all' ? { todos: true } : { ids: [restoreTarget] };
    restore.mutate(
      { campaignId, data },
      {
        onSuccess: () => {
          setRestoreMessage(restoreTarget === 'all' ? 'Todos os destinatários excluídos foram restaurados.' : 'Destinatário restaurado.');
          setRestoreTarget(null);
          onOffsetChange(0);
          invalidateAll();
        },
        onError: () => {
          invalidateAll();
        },
      },
    );
  };

  const total = overview?.total_excluidos ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + EXCLUSION_PAGE_SIZE, total);

  return (
    <section className="panel p-5 sm:p-7" data-testid="panel-campaign-exclusions">
      <div className="flex flex-col justify-between gap-3 border-b border-[#eee7dc] pb-5 sm:flex-row sm:items-start">
        <div>
          <p className="section-kicker">Segurança de entrega</p>
          <h2 className="mt-2 text-xl font-extrabold tracking-[-.05em] text-[#263044]">Provedores, reputação e exclusões</h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#747783]">Retire grupos de risco da fila antes de retomar. Excluir é reversível enquanto a campanha não for concluída ou cancelada.</p>
        </div>
        <ShieldCheck size={20} className="text-[#247b79]" />
      </div>

      {query.isLoading ? (
        <div className="mt-5 space-y-3" data-testid="status-exclusions-loading"><div className="skeleton h-40 rounded-xl" /><div className="skeleton h-24 rounded-xl" /></div>
      ) : query.isError || !overview ? (
        <div className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-5 py-4 text-sm text-[#a64220]" role="alert" data-testid="status-exclusions-error">
          <span>{errText(query.error, 'Não foi possível carregar o diagnóstico por provedor.')}</span>
          <button type="button" onClick={() => { void query.refetch(); }} className="action-button action-button-secondary" data-testid="button-exclusions-retry"><RefreshCw size={14} /> Tentar novamente</button>
        </div>
      ) : (
        <>
          <ProviderTable overview={overview} />
          <ReputationComparison overview={overview} />
        </>
      )}

      <div className="mt-6 rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-4 sm:p-5" data-testid="form-exclude-recipients">
        <h3 className="flex items-center gap-2 text-sm font-extrabold text-[#263044]"><UserMinus size={15} className="text-[#d35f2a]" /> Excluir da fila</h3>
        {locked && <p className="mt-3 rounded-lg bg-[#fff7dc] px-3 py-2 text-xs text-[#74561c]" data-testid="status-exclusions-locked">Campanha {campaignStatus === 'concluida' ? 'concluída' : 'cancelada'}: exclusões e restaurações estão desativadas.</p>}
        <fieldset disabled={locked || exclude.isPending} className="mt-4 space-y-4 disabled:opacity-60">
          <div>
            <span className="text-[11px] font-bold text-[#6d7180]">Provedores (em massa)</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {(Object.keys(providerLabels) as ProviderKey[]).map((key) => {
                const on = providers.includes(key);
                return (
                  <label key={key} className={`focus-within:ring-2 flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-bold ${on ? 'border-[#263044] bg-[#263044] text-[#fffaf6]' : 'border-[#ded5c8] bg-[#fffdf9] text-[#42495b]'}`}>
                    <input type="checkbox" className="sr-only" checked={on} onChange={() => setProviders((cur) => on ? cur.filter((p) => p !== key) : [...cur, key])} data-testid={`checkbox-exclude-provider-${key}`} />
                    {providerLabels[key]}
                  </label>
                );
              })}
            </div>
          </div>
          <div>
            <label htmlFor="exclude-motivo" className="text-[11px] font-bold text-[#6d7180]">Motivo (texto livre)</label>
            <textarea id="exclude-motivo" value={motivo} maxLength={500} onChange={(e) => setMotivo(e.target.value)} rows={2} className="mt-1.5 w-full rounded-xl border border-[#ded5c8] bg-[#fffdf9] px-3 py-2 text-sm" data-testid="input-exclude-motivo" />
            <div className="mt-2 flex flex-wrap gap-2">
              {motiveSuggestions.map((s) => <button key={s} type="button" onClick={() => setMotivo(s)} className="rounded-full border border-[#ded5c8] px-2.5 py-1 text-[11px] font-semibold text-[#6d7180] hover:bg-[#fffdf9]" data-testid={`button-motive-suggestion-${s.split(' ')[0].toLowerCase()}`}>{s}</button>)}
            </div>
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            <div>
              <span className="text-[11px] font-bold text-[#6d7180]">CSV com coluna email (até 5 MB)</span>
              <div className="mt-1.5 flex flex-wrap items-center gap-2">
                <label className="action-button action-button-secondary cursor-pointer !px-3"><FileUp size={14} /> Escolher arquivo<input ref={fileRef} type="file" accept=".csv,text/csv" className="sr-only" onChange={(e) => { void onFile(e.target.files?.[0]); }} data-testid="input-exclude-csv" /></label>
                {csvName && <span className="text-xs font-semibold text-[#42495b]" data-testid="text-exclude-csv-name">{csvName} <button type="button" onClick={clearCsv} className="ml-1 underline" data-testid="button-exclude-csv-clear">remover</button></span>}
              </div>
            </div>
            <div>
              <label htmlFor="exclude-emails" className="text-[11px] font-bold text-[#6d7180]">Ou endereços (separados por espaço, vírgula ou linha)</label>
              <textarea id="exclude-emails" value={emailsText} onChange={(e) => setEmailsText(e.target.value)} rows={2} className="mt-1.5 w-full rounded-xl border border-[#ded5c8] bg-[#fffdf9] px-3 py-2 font-mono text-xs" data-testid="input-exclude-emails" />
            </div>
          </div>
          <button type="button" onClick={requestConfirm} className="action-button action-button-danger" data-testid="button-exclude-review">Revisar exclusão</button>
        </fieldset>
        {formError && <Notice tone="error" testId="status-exclude-error">{formError}</Notice>}
        {confirming && (
          <ScrollConfirmation className="mt-4">
            <div className="rounded-xl border-2 border-[#d35f2a] bg-[#fff8ef] p-4 text-xs leading-5 text-[#6d4a2a]" role="alertdialog" data-testid="dialog-exclude-confirmation">
              <strong className="text-sm text-[#263044]">Confirmar exclusão da fila?</strong>
              <p className="mt-1">
                {providers.length > 0 && <>Provedores: {providers.map((p) => providerLabels[p]).join(', ')}. </>}
                {csvName && <>CSV: {csvName}. </>}
                {emails.length > 0 && <>{nf(emails.length)} endereços informados. </>}
                Motivo: {motivo.trim()}
              </p>
              <p className="mt-2 font-bold text-[#a64220]" data-testid="text-exclude-processing-warning">Envios que já estão em processamento não são cancelados e podem ser entregues mesmo após a exclusão.</p>
              <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button type="button" onClick={() => setConfirming(false)} className="action-button action-button-secondary" data-testid="button-exclude-cancel">Voltar</button>
                <button type="button" onClick={submitExclusion} disabled={exclude.isPending} className="action-button action-button-danger" data-testid="button-exclude-confirm">{exclude.isPending ? <><LoaderCircle size={14} className="animate-spin" /> Excluindo...</> : 'Confirmar exclusão'}</button>
              </div>
            </div>
          </ScrollConfirmation>
        )}
        {result && (
          <Notice tone="ok" testId="status-exclude-result">
            {nf(result.alterados)} excluídos ({nf(result.lembretes_alterados)} lembretes). {nf(result.em_processamento)} já em processamento (não cancelados), {nf(result.ja_processados)} já processados, {nf(result.nao_encontrados)} não encontrados.
          </Notice>
        )}
      </div>

      <div className="mt-6" data-testid="list-excluded-recipients">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-sm font-extrabold text-[#263044]">Excluídos <span className="font-mono text-[10px] text-[#9a9492]" data-testid="text-excluded-total">{nf(total)}</span></h3>
          <button type="button" disabled={locked || total === 0 || restore.isPending} onClick={() => { setRestoreMessage(null); setRestoreTarget('all'); }} className="action-button action-button-secondary !px-3 disabled:opacity-50" data-testid="button-restore-all"><RotateCcw size={13} /> Restaurar todos</button>
        </div>
        {restoreMessage && <Notice tone="ok" testId="status-restore-success">{restoreMessage}</Notice>}
        {restore.isError && <Notice tone="error" testId="status-restore-error">{errText(restore.error, 'Não foi possível restaurar.')}</Notice>}
        {restoreTarget === 'all' && (
          <ScrollConfirmation className="mt-3">
            <div className="flex flex-col gap-3 rounded-xl border-2 border-[#e8c56f] bg-[#fff9e9] px-4 py-3 text-xs text-[#74561c] sm:flex-row sm:items-center sm:justify-between" role="alertdialog" data-testid="dialog-restore-confirmation">
              <p><strong>Restaurar os {nf(total)} excluídos?</strong> Eles voltam à fila de envio.</p>
              <div className="flex gap-2">
                <button type="button" onClick={() => setRestoreTarget(null)} className="action-button action-button-secondary !px-3" data-testid="button-restore-cancel">Cancelar</button>
                <button type="button" onClick={submitRestore} disabled={restore.isPending} className="action-button action-button-primary !px-3" data-testid="button-restore-confirm">{restore.isPending ? 'Restaurando...' : 'Confirmar restauração'}</button>
              </div>
            </div>
          </ScrollConfirmation>
        )}
        {overview && overview.excluidos.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-[#cdbfae] bg-[#f8f3ec] px-5 py-8 text-center text-sm text-[#7d7e87]" data-testid="empty-excluded-recipients">Nenhum destinatário excluído desta campanha.</div>
        ) : overview ? (
          <ul className="mt-3 divide-y divide-[#eee7dc] rounded-xl border border-[#e5ddd0] bg-[#fffdf9]">
            {overview.excluidos.map((r) => (
              <li key={r.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between" data-testid={`row-excluded-${r.id}`}>
                <div className="min-w-0 text-xs">
                  <p className="truncate font-extrabold text-[#263044]">{r.email}{r.nome ? <span className="font-medium text-[#7d7e87]"> · {r.nome}</span> : null}</p>
                  <p className="mt-0.5 text-[#6d7180]">{r.exclusao_motivo} · {fmtDate(r.excluido_em)} · por {r.excluido_por_nome ?? r.excluido_por_email ?? 'Equipe Amo'} · status {r.status}</p>
                </div>
                <button type="button" disabled={locked || restore.isPending} onClick={() => { setRestoreMessage(null); setRestoreTarget(r.id); }} className="action-button action-button-secondary !px-3 shrink-0 disabled:opacity-50" data-testid={`button-restore-${r.id}`}><RotateCcw size={13} /> Restaurar</button>
                {restoreTarget === r.id && (
                  <ScrollConfirmation className="basis-full">
                    <div className="rounded-xl border-2 border-[#e8c56f] bg-[#fff9e9] px-4 py-3 text-xs text-[#74561c]" role="alertdialog" data-testid="dialog-restore-confirmation">
                      <p><strong>Restaurar {r.email}?</strong> O destinatário volta à fila de envio.</p>
                      <div className="mt-3 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                        <button type="button" onClick={() => setRestoreTarget(null)} className="action-button action-button-secondary !px-3" data-testid="button-restore-cancel">Cancelar</button>
                        <button type="button" onClick={submitRestore} disabled={restore.isPending} className="action-button action-button-primary !px-3" data-testid="button-restore-confirm">{restore.isPending ? 'Restaurando...' : 'Confirmar restauração'}</button>
                      </div>
                    </div>
                  </ScrollConfirmation>
                )}
              </li>
            ))}
          </ul>
        ) : null}
        {overview && total > EXCLUSION_PAGE_SIZE && (
          <div className="mt-3 flex items-center justify-between text-xs text-[#6d7180]">
            <span data-testid="text-excluded-range">{from}–{to} de {nf(total)}</span>
            <div className="flex gap-2">
              <button type="button" disabled={offset === 0} onClick={() => onOffsetChange(Math.max(0, offset - EXCLUSION_PAGE_SIZE))} className="action-button action-button-secondary !px-3 disabled:opacity-50" data-testid="button-excluded-prev">Anterior</button>
              <button type="button" disabled={offset + EXCLUSION_PAGE_SIZE >= total} onClick={() => onOffsetChange(offset + EXCLUSION_PAGE_SIZE)} className="action-button action-button-secondary !px-3 disabled:opacity-50" data-testid="button-excluded-next">Próxima</button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

/** Describes pause/resume metadata (rates, trigger, base) and exclusion/restore audit events. */
export function auditExtraDescription(action: string, metadata: Record<string, unknown> = {}): string | null {
  const num = (...keys: string[]) => {
    for (const k of keys) if (typeof metadata[k] === 'number') return metadata[k] as number;
    return null;
  };
  const str = (...keys: string[]) => {
    for (const k of keys) if (typeof metadata[k] === 'string' && metadata[k]) return metadata[k] as string;
    return null;
  };
  if (action === 'campaign_recipients_excluded') {
    const parts: string[] = [];
    const n = num('alterados', 'changed', 'excluded');
    if (n !== null) parts.push(`${nf(n)} destinatários excluídos`);
    const motivo = str('motivo', 'reason');
    if (motivo) parts.push(`motivo: ${motivo}`);
    const prov = Array.isArray(metadata.provedores) ? (metadata.provedores as unknown[]).filter((p): p is string => typeof p === 'string') : [];
    if (prov.length) parts.push(`provedores: ${prov.join(', ')}`);
    const inflight = num('em_processamento', 'in_flight');
    if (inflight) parts.push(`${nf(inflight)} já em processamento (não cancelados)`);
    return parts.length ? `${parts.join(' · ')}.` : 'Exclusão de destinatários registrada.';
  }
  if (action === 'campaign_recipients_restored') {
    const n = num('alterados', 'changed', 'restored');
    return n !== null ? `${nf(n)} destinatários restaurados.` : 'Restauração de destinatários registrada.';
  }
  if (action === 'campaign_paused' || action === 'campaign_resumed' || action === 'campaign_auto_paused') {
    const parts: string[] = [];
    const bounce = num('bounce_rate', 'taxa_bounce', 'pausa_taxa_bounce');
    const complaint = num('complaint_rate', 'taxa_reclamacao', 'pausa_taxa_reclamacao');
    if (bounce !== null) parts.push(`bounce permanente ${rateToPercent(bounce)}`);
    if (complaint !== null) parts.push(`reclamações ${rateToPercent(complaint)}`);
    const trigger = str('trigger', 'gatilho');
    if (trigger) parts.push(`gatilho ${trigger}`);
    const base = num('base_enviados', 'retomada_enviados_base', 'sent_base', 'base');
    if (base !== null) parts.push(`base de ${nf(base)} envios`);
    return parts.length ? parts.join(' · ') : null;
  }
  return null;
}
