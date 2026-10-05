import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  CircleAlert,
  Clock3,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
} from "lucide-react";
import {
  type CampaignEmailValidationJob,
  getGetCampaignEmailValidationJobQueryKey,
  getGetCampaignEmailValidationQuoteQueryKey,
  useGetCampaignEmailValidationJob,
  useGetCampaignEmailValidationQuote,
  useCancelCampaignEmailValidationJob,
  useResumeCampaignEmailValidationJob,
  useStartCampaignEmailValidation,
} from "@workspace/api-client-react";

const nf = (value: number | null | undefined) =>
  new Intl.NumberFormat("pt-BR").format(value ?? 0);

function formatDate(value: string | null | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date).replace(".", "");
}

function formatAge(value: string): string {
  const elapsed = Date.now() - new Date(value).getTime();
  if (!Number.isFinite(elapsed) || elapsed < 60_000) return "agora";
  const relative = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  return relative.format(-Math.floor(hours / 24), "day");
}

function errorMessage(error: unknown, fallback: string): string {
  if (error && typeof error === "object") {
    const value = error as { error?: unknown; data?: unknown };
    if (typeof value.error === "string") return value.error;
    if (value.data && typeof value.data === "object") {
      const nested = (value.data as { error?: unknown }).error;
      if (typeof nested === "string") return nested;
    }
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

function jobStatusLabel(status: CampaignEmailValidationJob["status"]): string {
  switch (status) {
    case "pendente": return "Aguardando o worker";
    case "processando": return "Em validação";
    case "sem_creditos": return "Pausada por saldo";
    case "erro": return "Precisa de atenção";
    case "concluida": return "Concluída";
    case "cancelada": return "Cancelada";
  }
}

export function CampaignEmailValidationPanel({
  campaignId,
  campaignStatus,
}: {
  campaignId: string;
  campaignStatus: string;
}) {
  const client = useQueryClient();
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmingCancel, setConfirmingCancel] = useState(false);
  const quoteQuery = useGetCampaignEmailValidationQuote(campaignId);
  const quote = quoteQuery.data;
  const start = useStartCampaignEmailValidation();
  const jobId = quote?.job_ativo?.id ?? selectedJobId ?? "";
  const jobQuery = useGetCampaignEmailValidationJob(campaignId, jobId, {
    query: {
      queryKey: getGetCampaignEmailValidationJobQueryKey(campaignId, jobId),
      enabled: Boolean(jobId),
      refetchInterval: (query) => {
        const status = query.state.data?.status;
        return status === "processando" || status === "pendente" ? 5_000 : false;
      },
    },
  });
  const job = jobQuery.data ?? quote?.job_ativo ?? null;
  const resume = useResumeCampaignEmailValidationJob({
    mutation: {
      onSuccess: (result) => {
        setSelectedJobId(result.id);
        setConfirming(false);
        void client.invalidateQueries({
          queryKey: getGetCampaignEmailValidationQuoteQueryKey(campaignId),
        });
        void client.invalidateQueries({
          queryKey: getGetCampaignEmailValidationJobQueryKey(campaignId, result.id),
        });
      },
      onError: () => {
        void client.invalidateQueries({
          queryKey: getGetCampaignEmailValidationQuoteQueryKey(campaignId),
        });
      },
    },
  });
  const cancelValidation = useCancelCampaignEmailValidationJob({
    mutation: {
      onSuccess: (result) => {
        setSelectedJobId(result.id);
        setConfirmingCancel(false);
        void client.invalidateQueries({
          queryKey: getGetCampaignEmailValidationQuoteQueryKey(campaignId),
        });
        void client.invalidateQueries({
          queryKey: getGetCampaignEmailValidationJobQueryKey(campaignId, result.id),
        });
      },
      onError: () => {
        void client.invalidateQueries({
          queryKey: getGetCampaignEmailValidationQuoteQueryKey(campaignId),
        });
      },
    },
  });

  const refresh = () => {
    void quoteQuery.refetch();
    if (jobId) void jobQuery.refetch();
  };
  const invalidateAfterStart = (result: CampaignEmailValidationJob) => {
    setSelectedJobId(result.id);
    setConfirming(false);
    void client.invalidateQueries({
      queryKey: getGetCampaignEmailValidationQuoteQueryKey(campaignId),
    });
    void client.invalidateQueries({
      queryKey: getGetCampaignEmailValidationJobQueryKey(campaignId, result.id),
    });
  };
  const startValidation = useStartCampaignEmailValidation({
    mutation: {
      onSuccess: invalidateAfterStart,
      onError: () => {
        setConfirming(false);
        void client.invalidateQueries({
          queryKey: getGetCampaignEmailValidationQuoteQueryKey(campaignId),
        });
      },
    },
  });

  const terminal = job?.status === "concluida";
  const validationIsActive =
    Boolean(quote?.job_ativo) &&
    quote?.job_ativo?.status !== "erro" &&
    quote?.job_ativo?.status !== "sem_creditos";
  const canStart =
    Boolean(quote) &&
    !quote?.job_ativo &&
    (quote?.pendentes ?? 0) > 0 &&
    quote?.creditos_faltantes === 0 &&
    campaignStatus !== "concluida" &&
    campaignStatus !== "cancelada";
  const progress = job?.total_pendentes
    ? Math.min(100, Math.round((job.processados / job.total_pendentes) * 100))
    : 0;

  return (
    <section
      className="panel p-5 sm:p-7"
      data-testid="panel-campaign-email-validation"
    >
      <div className="flex flex-col justify-between gap-3 border-b border-[#eee7dc] pb-5 sm:flex-row sm:items-start">
        <div>
          <p className="section-kicker">Qualidade da lista</p>
          <h2 className="mt-2 text-xl font-extrabold tracking-[-.05em] text-[#263044]">
            Validar e-mails da fila
          </h2>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-[#747783]">
            A verificação é assíncrona. Endereços já verificados são reutilizados sem nova cobrança.
            Resultados catch-all e desconhecidos ficam excluídos apenas desta campanha e podem ser restaurados.
          </p>
        </div>
        <ShieldCheck size={20} className="text-[#247b79]" />
      </div>

      {quoteQuery.isLoading ? (
        <div
          className="mt-5 h-28 animate-pulse rounded-xl bg-[#f5f0e8]"
          data-testid="status-email-validation-loading"
        />
      ) : quoteQuery.isError || !quote ? (
        <div
          className="mt-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-5 py-4 text-sm text-[#a64220]"
          role="alert"
          data-testid="status-email-validation-error"
        >
          <span>
            {errorMessage(
              quoteQuery.error,
              "Não foi possível consultar o saldo e a fila. Configure ZEROBOUNCE_API_KEY no Repl da API e tente novamente.",
            )}
          </span>
          <button
            type="button"
            onClick={refresh}
            className="action-button action-button-secondary"
            data-testid="button-email-validation-refresh"
          >
            <RefreshCw size={14} /> Atualizar
          </button>
        </div>
      ) : (
        <>
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Pendentes na fila" value={nf(quote.pendentes)} />
            <Metric label="Já estão no cache" value={nf(quote.cacheados)} />
            <Metric label="Verificações cobradas" value={nf(quote.a_verificar)} />
            <Metric label="Créditos disponíveis" value={nf(quote.creditos)} />
          </div>

          <div className="mt-4 flex flex-col gap-3 rounded-xl border border-[#e5ddd0] bg-[#fbf9f5] p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-xs leading-5 text-[#6d7180]">
              <p>
                {nf(quote.formato_invalido)} endereços com formato inválido serão rejeitados antes de consultar a ZeroBounce.
              </p>
              <p>
                {quote.cache_mais_antigo_em
                  ? `Resultado em cache mais antigo: ${formatAge(quote.cache_mais_antigo_em)} (${formatDate(quote.cache_mais_antigo_em)}).`
                  : "Ainda não há resultados em cache para esta fila."}
              </p>
            </div>
            <button
              type="button"
              onClick={refresh}
              disabled={quoteQuery.isFetching}
              className="action-button action-button-secondary shrink-0"
              data-testid="button-email-validation-refresh"
            >
              {quoteQuery.isFetching
                ? <LoaderCircle size={14} className="animate-spin" />
                : <RefreshCw size={14} />}
              Atualizar cotação
            </button>
          </div>

          {quote.creditos_faltantes > 0 && !quote.job_ativo && (
            <p
              className="mt-4 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm text-[#a64220]"
              role="alert"
              data-testid="status-email-validation-insufficient-credits"
            >
              Faltam {nf(quote.creditos_faltantes)} créditos para a cotação atual. Nenhum crédito será consumido até você iniciar a validação.
            </p>
          )}

          {job && (
            <div
              className="mt-5 rounded-xl border border-[#cfe1dc] bg-[#f4faf7] p-4 sm:p-5"
              data-testid="panel-email-validation-progress"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="flex items-center gap-2 text-sm font-extrabold text-[#263044]">
                    {job.status === "processando"
                      ? <Activity size={15} className="text-[#247b79]" />
                      : job.status === "concluida"
                        ? <ShieldCheck size={15} className="text-[#247b79]" />
                        : <Clock3 size={15} className="text-[#bd6b32]" />}
                    {jobStatusLabel(job.status)}
                  </p>
                  <p className="mt-1 text-xs text-[#6d7180]">
                    {nf(job.processados)} de {nf(job.total_pendentes)} processados · estimativa inicial de {nf(job.custo_estimado)} créditos
                  </p>
                </div>
                <span className="rounded-full border border-[#d8e5df] bg-white px-3 py-1 text-xs font-bold text-[#247b79]">
                  {terminal ? "100%" : `${progress}%`}
                </span>
              </div>
              {job.status !== "concluida" && job.status !== "cancelada" && (
                <div
                  className="mt-4 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm text-[#8e3a20]"
                  role="alert"
                  data-testid="status-campaign-validation-blocked"
                >
                  <strong>Envio bloqueado por validação pendente.</strong>
                  <p className="mt-1 text-xs leading-5">
                    Estado: {jobStatusLabel(job.status)} · início: {formatDate(job.iniciado_em ?? job.criado_em)} · iniciado por: {job.criado_por_nome || job.criado_por_email || "Equipe"}.
                  </p>
                </div>
              )}
              <div
                className="mt-3 h-2 overflow-hidden rounded-full bg-[#e4ece7]"
                role="progressbar"
                aria-label="Progresso da validação"
                aria-valuenow={terminal ? 100 : progress}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <div
                  className="h-full rounded-full bg-[#247b79] transition-[width]"
                  style={{ width: `${terminal ? 100 : progress}%` }}
                />
              </div>
              {job.status === "processando" || job.status === "pendente" ? (
                <p className="mt-3 text-xs text-[#6d7180]" data-testid="text-email-validation-live">
                  O progresso é atualizado automaticamente. A fila da campanha permanece bloqueada até a validação terminar.
                </p>
              ) : null}
              {job.erro && (
                <p
                  className="mt-3 flex items-start gap-2 rounded-lg border border-[#efc9ba] bg-[#fff0e9] px-3 py-2 text-xs leading-5 text-[#a64220]"
                  role="alert"
                  data-testid="status-email-validation-job-error"
                >
                  <CircleAlert size={14} className="mt-0.5 shrink-0" /> {job.erro}
                </p>
              )}
              {(job.status === "sem_creditos" || job.status === "erro") && (
                <button
                  type="button"
                  disabled={resume.isPending || quote.creditos_faltantes > 0}
                  onClick={() => resume.mutate({ campaignId, jobId: job.id })}
                  className="action-button action-button-primary mt-3"
                  data-testid="button-email-validation-resume"
                >
                  {resume.isPending
                    ? <LoaderCircle size={14} className="animate-spin" />
                    : <RefreshCw size={14} />}
                  Conferir saldo e retomar
                </button>
              )}
              {job.status !== "concluida" && job.status !== "cancelada" && (
                <div className="mt-3">
                  {!confirmingCancel ? (
                    <button
                      type="button"
                      disabled={cancelValidation.isPending}
                      onClick={() => setConfirmingCancel(true)}
                      className="action-button action-button-secondary"
                      data-testid="button-email-validation-cancel-job"
                    >
                      Cancelar validação
                    </button>
                  ) : (
                    <div
                      className="rounded-xl border border-[#efc9ba] bg-white p-4"
                      role="alertdialog"
                      aria-labelledby="email-validation-cancel-title"
                      data-testid="dialog-email-validation-cancel-job"
                    >
                      <h3
                        id="email-validation-cancel-title"
                        className="text-sm font-extrabold text-[#263044]"
                      >
                        Cancelar esta validação?
                      </h3>
                      <p className="mt-2 text-xs leading-5 text-[#6d7180]">
                        Isso libera a fila da campanha. Uma chamada ZeroBounce que já está em andamento ainda pode terminar e consumir créditos.
                      </p>
                      <div className="mt-3 flex flex-wrap justify-end gap-2">
                        <button
                          type="button"
                          disabled={cancelValidation.isPending}
                          onClick={() => setConfirmingCancel(false)}
                          className="action-button action-button-secondary"
                          data-testid="button-email-validation-keep-job"
                        >
                          Manter validação
                        </button>
                        <button
                          type="button"
                          disabled={cancelValidation.isPending}
                          onClick={() => cancelValidation.mutate({ campaignId, jobId: job.id })}
                          className="action-button action-button-primary"
                          data-testid="button-email-validation-confirm-cancel-job"
                        >
                          {cancelValidation.isPending
                            ? <LoaderCircle size={14} className="animate-spin" />
                            : <CircleAlert size={14} />}
                          Confirmar cancelamento
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              {cancelValidation.isError && (
                <p
                  className="mt-2 text-xs text-[#a64220]"
                  role="alert"
                  data-testid="status-email-validation-cancel-error"
                >
                  {errorMessage(cancelValidation.error, "Não foi possível cancelar a validação.")}
                </p>
              )}
              {resume.isError && (
                <p className="mt-2 text-xs text-[#a64220]" role="alert" data-testid="status-email-validation-resume-error">
                  {errorMessage(resume.error, "Não foi possível retomar a validação.")}
                </p>
              )}

              <div className="mt-4 grid gap-x-4 gap-y-2 border-t border-[#dce8e2] pt-3 text-xs sm:grid-cols-2 lg:grid-cols-4">
                <Count label="Válidos" value={job.por_status.valid} />
                <Count label="Inválidos" value={job.por_status.invalid} />
                <Count label="Spamtrap" value={job.por_status.spamtrap} />
                <Count label="Abuse / não enviar" value={job.por_status.abuse + job.por_status.do_not_mail} />
                <Count label="Catch-all" value={job.por_status.catch_all} />
                <Count label="Desconhecidos" value={job.por_status.unknown} />
                <Count label="Formato inválido" value={job.por_status.formato_invalido} />
                <Count label="Erros temporários" value={job.por_status.erro} />
                <Count label="Ignorados após três tentativas" value={job.por_status.ignorado} />
                {job.status === "concluida" && (
                  <p className="text-[#247b79] sm:col-span-2 lg:col-span-4" data-testid="text-email-validation-complete">
                    Concluída em {formatDate(job.concluido_em)}. Exclusões aplicadas nesta campanha: {nf(job.exclusoes_automaticas.catch_all)} catch-all e {nf(job.exclusoes_automaticas.unknown)} desconhecidos.
                  </p>
                )}
              </div>
            </div>
          )}

          {!job && (
            <div className="mt-5">
              {validationIsActive && (
                <p className="mb-3 text-xs text-[#6d7180]">Já existe uma validação ativa nesta campanha.</p>
              )}
              <button
                type="button"
                onClick={() => setConfirming(true)}
                disabled={!canStart || startValidation.isPending}
                className="action-button action-button-primary"
                data-testid="button-email-validation-review"
              >
                <ShieldCheck size={15} /> Revisar validação da fila
              </button>
              {!canStart && quote.pendentes === 0 && (
                <p className="mt-2 text-xs text-[#6d7180]">Não há destinatários pendentes para validar.</p>
              )}
            </div>
          )}

          {confirming && quote && (
            <div
              className="mt-4 rounded-xl border-2 border-[#247b79] bg-[#f4faf7] p-4"
              role="alertdialog"
              aria-labelledby="email-validation-confirm-title"
              data-testid="dialog-email-validation-confirm"
            >
              <h3 id="email-validation-confirm-title" className="text-sm font-extrabold text-[#263044]">
                Confirmar validação da fila?
              </h3>
              <p className="mt-2 text-xs leading-5 text-[#6d7180]">
                Serão verificados até {nf(quote.a_verificar)} endereços únicos ainda sem resultado em cache. A estimativa é de até {nf(quote.a_verificar)} créditos; o saldo atual é {nf(quote.creditos)}. A fila ficará bloqueada até o job terminar.
              </p>
              <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="action-button action-button-secondary"
                  data-testid="button-email-validation-cancel"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  disabled={!canStart || startValidation.isPending}
                  onClick={() => startValidation.mutate({
                    campaignId,
                    data: {
                      custo_confirmado: quote.a_verificar,
                      pendentes_confirmados: quote.pendentes,
                    },
                  })}
                  className="action-button action-button-primary"
                  data-testid="button-email-validation-confirm"
                >
                  {startValidation.isPending
                    ? <LoaderCircle size={14} className="animate-spin" />
                    : <ShieldCheck size={14} />}
                  Iniciar validação
                </button>
              </div>
              {startValidation.isError && (
                <p className="mt-3 text-xs text-[#a64220]" role="alert" data-testid="status-email-validation-start-error">
                  {errorMessage(startValidation.error, "Não foi possível iniciar a validação. Atualize a cotação.")}
                </p>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-[#e5ddd0] bg-[#fbf9f5] px-4 py-3">
      <p className="text-[10px] font-bold uppercase tracking-[.08em] text-[#92939a]">{label}</p>
      <p className="mt-1 text-xl font-extrabold tracking-[-.04em] text-[#263044]">{value}</p>
    </div>
  );
}

function Count({ label, value }: { label: string; value: number }) {
  return (
    <p className="flex justify-between gap-3 text-[#6d7180]">
      <span>{label}</span>
      <strong className="text-[#263044]">{nf(value)}</strong>
    </p>
  );
}
