import {
  AlertTriangle,
  CircleAlert,
  MailCheck,
  RefreshCw,
  ShieldCheck,
} from 'lucide-react';
import {
  getGetEngagementReputationQueryKey,
  useGetEngagementReputation,
} from '@workspace/api-client-react';

function formatNumber(value: number) {
  return new Intl.NumberFormat('pt-BR').format(value);
}

function formatPercentage(value: number) {
  return `${value.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;
}

function formatDate(value: string) {
  // Use the date portion to avoid timezone shifts for API date-only values.
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (match) {
    const [, year, month, day] = match;
    return `${day}/${month}/${year}`;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

function ReputationSkeleton() {
  return (
    <section
      className="panel overflow-hidden"
      aria-label="Estimativa de reputação carregando"
      aria-busy="true"
      data-testid="status-account-reputation-loading"
    >
      <div className="skeleton h-1.5 w-full rounded-none" />
      <div className="space-y-5 p-5 sm:p-6">
        <div className="skeleton h-3 w-40 rounded-full" />
        <div className="skeleton h-5 w-56 max-w-full rounded-full" />
        <div className="grid gap-3 sm:grid-cols-2">
          {[0, 1].map((item) => (
            <div key={item} className="rounded-xl border border-[#e9e1d6] p-4">
              <div className="skeleton h-3 w-20 rounded-full" />
              <div className="skeleton mt-4 h-7 w-24 rounded-full" />
              <div className="skeleton mt-3 h-2 w-full rounded-full" />
            </div>
          ))}
        </div>
        <div className="skeleton h-10 w-full rounded-lg" />
      </div>
    </section>
  );
}

function MetricPanel({
  title,
  quantity,
  denominator,
  percentage,
  reviewLimit,
  pauseLimit,
  testId,
}: {
  title: string;
  quantity: number;
  denominator: number;
  percentage: number;
  reviewLimit: number;
  pauseLimit: number;
  testId: string;
}) {
  const value = Math.max(0, Math.min(100, (percentage / Math.max(pauseLimit, 1)) * 100));
  const reviewPosition = Math.max(0, Math.min(100, (reviewLimit / Math.max(pauseLimit, 1)) * 100));
  const pausePosition = 100;

  return (
    <div
      className="rounded-xl border border-[#e7dfd3] bg-[#fffdf9] p-4"
      data-testid={`metric-${testId}`}
      aria-label={`${title}: ${formatNumber(quantity)} de ${formatNumber(denominator)}, ${formatPercentage(percentage)}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[#85858b]">{title}</p>
          <p className="mt-2 font-mono text-[1.65rem] font-medium leading-none tracking-[-0.08em] text-[#263044]" data-testid={`value-${testId}`}>
            {formatPercentage(percentage)}
          </p>
        </div>
        <span className="mt-0.5 rounded-full bg-[#f2eee7] px-2 py-1 font-mono text-[9px] text-[#676c78]" data-testid={`count-${testId}`}>
          {formatNumber(quantity)} ocorr.
        </span>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2 text-[10px] text-[#747783]">
        <span>Base: <strong className="font-mono font-medium text-[#42495b]">{formatNumber(denominator)}</strong></span>
        <span className="font-mono text-[9px] text-[#85858b]">ocorrências / base</span>
      </div>

      <div
        className="relative mt-3 h-2 overflow-visible rounded-full bg-[#eee9e1]"
        role="img"
        aria-label={`${title}: ${formatPercentage(percentage)}. Referência recomendada em ${formatPercentage(reviewLimit)}; pausa possível acima de ${formatPercentage(pauseLimit)}.`}
        data-testid={`scale-${testId}`}
      >
        <div
          className={`h-2 rounded-full ${percentage > pauseLimit ? 'bg-[#bd4f26]' : percentage >= reviewLimit ? 'bg-[#d2a333]' : 'bg-[#42836e]'}`}
          style={{ width: `${value}%` }}
        />
        <span
          className="absolute -top-1 h-4 w-px bg-[#9b7426]"
          style={{ left: `${reviewPosition}%` }}
          aria-hidden="true"
        />
        <span
          className="absolute -top-1 h-4 w-px bg-[#bd4f26]"
          style={{ left: `${pausePosition}%` }}
          aria-hidden="true"
        />
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 font-mono text-[9px] leading-4 text-[#777984]">
        <span>Referência recomendada <strong className="font-medium text-[#8b691f]">{formatPercentage(reviewLimit)}</strong></span>
        <span className="text-right">Pausa possível acima de <strong className="font-medium text-[#a64220]">{formatPercentage(pauseLimit)}</strong></span>
      </div>
    </div>
  );
}

export function AccountReputationCard() {
  const reputationQuery = useGetEngagementReputation({
    query: {
      queryKey: getGetEngagementReputationQueryKey(),
      refetchInterval: 60_000,
    },
  });
  const reputation = reputationQuery.data;

  if (reputationQuery.isLoading) return <ReputationSkeleton />;

  if (reputationQuery.isError) {
    return (
      <section className="panel overflow-hidden" data-testid="status-account-reputation-error" role="alert">
        <div className="h-1.5 bg-[#e96527]" />
        <div className="flex flex-col gap-4 p-5 sm:flex-row sm:items-center sm:justify-between sm:p-6">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#fff0e9] text-[#bd4f26]">
              <CircleAlert size={18} aria-hidden="true" />
            </span>
            <div>
              <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-[#bd4f26]">Estimativa indisponível</p>
              <h2 className="mt-1 text-sm font-extrabold tracking-[-0.02em] text-[#263044]">Não foi possível carregar os sinais.</h2>
              <p className="mt-1 text-xs leading-5 text-[#747783]">Tente consultar novamente. Isso não altera os envios em andamento.</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => reputationQuery.refetch()}
            disabled={reputationQuery.isFetching}
            className="action-button action-button-secondary shrink-0"
            data-testid="button-account-reputation-retry"
          >
            <RefreshCw size={14} className={reputationQuery.isFetching ? 'animate-spin' : ''} aria-hidden="true" />
            {reputationQuery.isFetching ? 'Consultando…' : 'Tentar novamente'}
          </button>
        </div>
      </section>
    );
  }

  if (!reputation || reputation.total_enviado <= 0) {
    return (
      <section className="panel overflow-hidden" data-testid="status-account-reputation-empty" aria-label="Sem amostra para estimativa">
        <div className="h-1.5 bg-[#d7ef56]" />
        <div className="flex items-start gap-3 p-5 sm:p-6">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#f0f2db] text-[#657238]">
            <MailCheck size={18} aria-hidden="true" />
          </span>
          <div className="min-w-0">
            <p className="font-mono text-[9px] uppercase tracking-[0.15em] text-[#78833f]">Amostra ainda não formada</p>
            <h2 className="mt-1 text-sm font-extrabold tracking-[-0.02em] text-[#263044]">Sem envios e entregas suficientes no período.</h2>
            <p className="mt-1 text-xs leading-5 text-[#747783]">A estimativa aparece quando houver mensagens de campanha enviadas e entregues nos últimos 14 dias.</p>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="panel overflow-hidden" data-testid="card-account-reputation" aria-labelledby="account-reputation-title">
      <div className="flex h-1.5">
        <span className="w-1/2 bg-[#d7ef56]" />
        <span className="w-1/2 bg-[#e96527]" />
      </div>
      <div className="p-5 sm:p-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex items-start gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-[#edf3ef] text-[#247b79]">
              <ShieldCheck size={18} aria-hidden="true" />
            </span>
            <div>
              <p className="section-kicker">Sinais de entrega · janela móvel de 14 dias</p>
              <h2 id="account-reputation-title" className="mt-1 text-base font-extrabold tracking-[-0.04em] text-[#263044]">
                Estimativa de reputação das campanhas
              </h2>
              <p className="mt-1 font-mono text-[10px] tabular-nums text-[#777984]" data-testid="text-account-reputation-period">
                {formatDate(reputation.periodo_inicio)} <span className="px-1 text-[#c2b8aa]">—</span> {formatDate(reputation.periodo_fim)}
              </p>
            </div>
          </div>
          <span className="inline-flex w-fit items-center gap-1.5 rounded-full border border-[#d8e5dc] bg-[#eff6f0] px-2.5 py-1.5 font-mono text-[9px] uppercase tracking-[0.08em] text-[#477653]" data-testid="status-account-reputation-sample">
            <span className="h-1.5 w-1.5 rounded-full bg-[#63a76f]" />
            Sinal local
          </span>
        </div>

        <div className="mt-5 grid gap-3 sm:grid-cols-2" data-testid="account-reputation-metrics">
          <MetricPanel
            title="Bounces"
            quantity={reputation.bounce.quantidade}
            denominator={reputation.total_enviado}
            percentage={reputation.bounce.percentual}
            reviewLimit={reputation.bounce.limite_revisao_percentual}
            pauseLimit={reputation.bounce.limite_pausa_percentual}
            testId="account-bounce"
          />
          <MetricPanel
            title="Reclamações"
            quantity={reputation.reclamacao.quantidade}
            denominator={reputation.total_entregue}
            percentage={reputation.reclamacao.percentual}
            reviewLimit={reputation.reclamacao.limite_revisao_percentual}
            pauseLimit={reputation.reclamacao.limite_pausa_percentual}
            testId="account-complaints"
          />
        </div>

        <div className="mt-4 rounded-xl border border-[#e8dfd1] bg-[#f7f2eb] px-4 py-3" data-testid="notice-account-reputation-scope">
          <div className="flex items-start gap-2.5">
            <AlertTriangle size={15} className="mt-0.5 shrink-0 text-[#bd672d]" aria-hidden="true" />
            <div className="text-[11px] leading-[1.55] text-[#626978]">
              <p className="font-bold text-[#42495b]">Estimativa interna — não são métricas da conta Amazon SES.</p>
              <p className="mt-1">
                Calculada com mensagens de campanhas registradas localmente (envios principais e lembretes). Testes, mensagens transacionais e exclusões da SES não estão refletidos.
              </p>
              <p className="mt-1">
                A SES usa um volume representativo variável, não esta janela fixa de 14 dias; os percentuais abaixo são referências, não uma previsão de pausa.
              </p>
              <p className="mt-1 flex flex-wrap gap-x-2">
                <span>Fontes oficiais:</span>
                <a className="font-semibold text-[#247b79] underline underline-offset-2" href="https://docs.aws.amazon.com/ses/latest/dg/reputation-dashboard-dg.html" target="_blank" rel="noreferrer">métricas de reputação</a>
                <a className="font-semibold text-[#247b79] underline underline-offset-2" href="https://docs.aws.amazon.com/ses/latest/dg/reputationdashboard-cloudwatch-alarm.html" target="_blank" rel="noreferrer">referências e CloudWatch</a>
                <a className="font-semibold text-[#247b79] underline underline-offset-2" href="https://docs.aws.amazon.com/ses/latest/dg/reputationdashboardmessages.html" target="_blank" rel="noreferrer">volume representativo</a>
              </p>
            </div>
          </div>
          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 border-t border-[#e6ddd0] pt-2.5 font-mono text-[9px] text-[#85858b]" data-testid="text-account-reputation-volume">
            <span>Enviados <strong className="font-medium text-[#42495b]">{formatNumber(reputation.total_enviado)}</strong></span>
            <span>Entregues <strong className="font-medium text-[#42495b]">{formatNumber(reputation.total_entregue)}</strong></span>
            <span className="ml-auto text-[#777984]">SES · recomendado &lt;5% / &lt;0,1% · pausa possível &gt;10% / &gt;0,5%</span>
          </div>
        </div>
      </div>
    </section>
  );
}

export default AccountReputationCard;