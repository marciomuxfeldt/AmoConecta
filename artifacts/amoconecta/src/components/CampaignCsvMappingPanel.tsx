import type { ChangeEvent } from "react";
import { AlertTriangle, CalendarDays, Check, Mail, Rows3 } from "lucide-react";
import type {
  CampaignCsvHeaderInspection,
  CampaignCsvImportTarget,
} from "../lib/campaign-csv-header";

export type CampaignCsvMappingPanelProps = {
  inspection: CampaignCsvHeaderInspection;
  mapping: CampaignCsvImportTarget[];
  onMappingChange: (index: number, target: CampaignCsvImportTarget) => void;
  referenceDateType: "" | "compra" | "acesso" | "criacao_conta" | "outro";
  onReferenceDateTypeChange: (
    value: "" | "compra" | "acesso" | "criacao_conta" | "outro",
  ) => void;
  referenceDateLabel: string;
  onReferenceDateLabelChange: (value: string) => void;
  existingReferenceDateType: string | null;
  existingReferenceDateLabel: string | null;
  hasExistingRecipients: boolean;
  disabled: boolean;
};

const targetOptions: Array<{
  value: CampaignCsvImportTarget;
  label: string;
}> = [
  { value: "email", label: "E-mail" },
  { value: "name", label: "Nome" },
  { value: "phone", label: "Telefone" },
  { value: "user_id", label: "ID do usuário" },
  { value: "region", label: "Região" },
  { value: "reference_date", label: "Data de referência" },
  { value: "ignore", label: "Ignorar coluna" },
];

const dateMeanings: Record<string, string> = {
  compra: "Data da última compra",
  acesso: "Data do último acesso",
  criacao_conta: "Data de criação da conta",
  outro: "Outro significado",
};

function displaySample(value: string | undefined): string {
  return value == null || value.trim() === "" ? "(vazio)" : value;
}

export function CampaignCsvMappingPanel({
  inspection,
  mapping,
  onMappingChange,
  referenceDateType,
  onReferenceDateTypeChange,
  referenceDateLabel,
  onReferenceDateLabelChange,
  existingReferenceDateType,
  existingReferenceDateLabel,
  hasExistingRecipients,
  disabled,
}: CampaignCsvMappingPanelProps) {
  const ignoredCount = inspection.columns.reduce(
    (count, _, index) => count + ((mapping[index] ?? "ignore") === "ignore" ? 1 : 0),
    0,
  );
  const hasEmail = mapping.includes("email");
  const hasReferenceDate = mapping.includes("reference_date");
  const savedDateMeaning = existingReferenceDateType
    ? dateMeanings[existingReferenceDateType] ?? existingReferenceDateType
    : null;
  const savedDateLabel = existingReferenceDateLabel?.trim();

  const handleDateMeaningChange = (event: ChangeEvent<HTMLSelectElement>) => {
    onReferenceDateTypeChange(
      event.target.value as CampaignCsvMappingPanelProps["referenceDateType"],
    );
  };

  return (
    <section
      className="mt-6 overflow-hidden rounded-2xl border border-[#e3dbcf] bg-[#fffdf9] shadow-[0_8px_24px_rgba(38,48,68,.035)]"
      aria-labelledby="csv-mapping-title"
      data-testid="panel-csv-mapping"
    >
      <header className="border-b border-[#e8e0d5] bg-[#f8f3ec] px-4 py-5 sm:px-6">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
          <div className="min-w-0">
            <p className="section-kicker">Conferência antes da validação</p>
            <h3
              id="csv-mapping-title"
              className="mt-2 text-lg font-extrabold tracking-[-.045em] text-[#263044]"
            >
              Confira o destino de cada coluna
            </h3>
            <p className="mt-1 max-w-2xl text-xs leading-5 text-[#727783]">
              Uma linha por coluna do arquivo. Revise as amostras e ajuste o
              destino quando necessário.
            </p>
          </div>
          <div
            className="flex w-fit shrink-0 items-center gap-2 rounded-lg border border-[#dcd3c5] bg-[#fffdf9] px-3 py-2 font-mono text-[10px] uppercase tracking-[.08em] text-[#626876]"
            data-testid="text-import-ignored-count"
          >
            <Rows3 size={14} className="text-[#8b8790]" />
            <span>
              <strong className="text-[#263044]">{ignoredCount}</strong>{" "}
              {ignoredCount === 1 ? "coluna ignorada" : "colunas ignoradas"}
            </span>
          </div>
        </div>

        <div
          className={`mt-4 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-xs leading-5 ${
            hasEmail
              ? "border-[#cfe4c7] bg-[#f2f8ee] text-[#426c43]"
              : "border-[#e8c56f] bg-[#fff7dc] text-[#74561c]"
          }`}
          role={hasEmail ? "status" : "alert"}
          data-testid="status-import-email-mapping"
        >
          {hasEmail ? (
            <Check size={16} className="mt-0.5 shrink-0" />
          ) : (
            <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          )}
          <span>
            {hasEmail ? (
              <>
                <strong className="font-extrabold">E-mail mapeado.</strong>{" "}
                Este é o único campo obrigatório para importar destinatários.
              </>
            ) : (
              <>
                <strong className="font-extrabold">
                  Selecione manualmente a coluna de e-mail.
                </strong>{" "}
                O e-mail é o único campo obrigatório; escolha “E-mail” na linha
                correspondente para continuar.
              </>
            )}
          </span>
        </div>
      </header>

      <div className="px-3 py-3 sm:px-5 sm:py-4">
        <div
          className="mb-2 hidden grid-cols-[minmax(130px,1fr)_minmax(0,1.8fr)_minmax(178px,.9fr)] gap-4 px-3 font-mono text-[9px] uppercase tracking-[.12em] text-[#92909a] md:grid"
          aria-hidden="true"
        >
          <span>Coluna de origem</span>
          <span>Amostras · até 3 linhas</span>
          <span>Importar como</span>
        </div>
        <div className="space-y-2" data-testid="list-import-column-mappings">
          {inspection.columns.map((column, index) => {
            const target = mapping[index] ?? "ignore";
            const isEmailTarget = target === "email";
            const sampleValues = inspection.samples.slice(0, 3).map((row) =>
              displaySample(row[index]),
            );

            return (
              <article
                key={`${column}-${index}`}
                className={`grid min-w-0 gap-3 rounded-xl border p-3 transition-colors sm:p-3.5 md:grid-cols-[minmax(130px,1fr)_minmax(0,1.8fr)_minmax(178px,.9fr)] md:items-center md:gap-4 ${
                  isEmailTarget
                    ? "border-[#e8b08e] bg-[#fff7f1]"
                    : "border-[#ebe5dc] bg-[#fffdf9] hover:bg-[#fcfaf6]"
                }`}
                data-testid={`row-import-column-${index}`}
              >
                <div className="min-w-0">
                  <div className="mb-1 flex items-center gap-1.5 md:hidden">
                    <span className="font-mono text-[9px] uppercase tracking-[.1em] text-[#96939a]">
                      Coluna {index + 1}
                    </span>
                    {isEmailTarget && (
                      <span className="rounded-full bg-[#f8dfcc] px-1.5 py-0.5 font-mono text-[8px] font-medium uppercase tracking-[.06em] text-[#a14a20]">
                        Obrigatório
                      </span>
                    )}
                  </div>
                  <div className="flex min-w-0 items-center gap-2">
                    {isEmailTarget && (
                      <Mail
                        size={14}
                        className="shrink-0 text-[#c45c2c]"
                        aria-hidden="true"
                      />
                    )}
                    <span
                      className="min-w-0 break-all text-sm font-extrabold text-[#30394d]"
                      title={column || "(sem nome)"}
                      data-testid={`text-import-source-column-${index}`}
                    >
                      {column || "(sem nome)"}
                    </span>
                  </div>
                  {isEmailTarget && (
                    <span className="mt-1 hidden font-mono text-[9px] font-medium uppercase tracking-[.08em] text-[#a14a20] md:block">
                      Campo obrigatório
                    </span>
                  )}
                </div>

                <div
                  className="grid min-w-0 grid-cols-1 gap-1.5 sm:grid-cols-3"
                  aria-label={`Amostras da coluna ${column || index + 1}`}
                  data-testid={`samples-import-column-${index}`}
                >
                  {Array.from({ length: 3 }, (_, sampleIndex) => (
                    <div
                      key={sampleIndex}
                      className="min-w-0 rounded-lg border border-[#eee8df] bg-[#f8f5ef] px-2.5 py-1.5"
                      data-testid={`sample-import-cell-${index}-${sampleIndex}`}
                    >
                      <span className="mb-0.5 block font-mono text-[8px] uppercase tracking-[.1em] text-[#aaa5a0]">
                        Linha {sampleIndex + 1}
                      </span>
                      <span
                        className={`block truncate text-[11px] ${
                          sampleValues[sampleIndex] === "(vazio)"
                            ? "italic text-[#aaa5a0]"
                            : "text-[#555d6c]"
                        }`}
                        title={sampleValues[sampleIndex] ?? "(vazio)"}
                      >
                        {sampleValues[sampleIndex] ?? "(vazio)"}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="min-w-0">
                  <label
                    htmlFor={`csv-target-${index}`}
                    className="mb-1 block font-mono text-[9px] uppercase tracking-[.1em] text-[#85838c] md:sr-only"
                  >
                    Importar “{column || `coluna ${index + 1}`}” como
                  </label>
                  <select
                    id={`csv-target-${index}`}
                    value={target}
                    disabled={disabled}
                    onChange={(event) =>
                      onMappingChange(
                        index,
                        event.target.value as CampaignCsvImportTarget,
                      )
                    }
                    className={`w-full min-w-0 rounded-lg border px-3 py-2.5 text-xs font-bold text-[#30394d] outline-none transition focus-visible:border-[#e96527] focus-visible:ring-2 focus-visible:ring-[#e96527]/20 disabled:cursor-not-allowed disabled:opacity-60 ${
                      isEmailTarget
                        ? "border-[#e4a37d] bg-[#fffaf6]"
                        : "border-[#dcd3c5] bg-[#fffdf9]"
                    }`}
                    data-testid={`select-import-target-${index}`}
                  >
                    {targetOptions.map((option) => (
                      <option key={option.value} value={option.value}>
                        {option.label}
                      </option>
                    ))}
                  </select>
                </div>
              </article>
            );
          })}
        </div>
        {inspection.columns.length === 0 && (
          <div
            className="rounded-xl border border-dashed border-[#d8cdbd] bg-[#f8f3ec] px-4 py-7 text-center"
            role="status"
            data-testid="status-import-no-columns"
          >
            <p className="text-sm font-bold text-[#42495b]">
              Nenhuma coluna encontrada no cabeçalho.
            </p>
            <p className="mt-1 text-xs text-[#777985]">
              Confira o arquivo CSV antes de seguir.
            </p>
          </div>
        )}
      </div>

      <div
        className="border-t border-[#e8e0d5] bg-[#fbf8f2] px-4 py-4 sm:px-6"
        data-testid="section-import-date-meaning"
      >
        <div className="flex items-start gap-3">
          <span className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-[#e4efc7] text-[#506a32]">
            <CalendarDays size={16} />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-extrabold tracking-[-.02em] text-[#30394d]">
                Significado da data de referência
              </h4>
              <span className="rounded-full border border-[#dcd3c5] bg-[#fffdf9] px-2 py-0.5 font-mono text-[8px] uppercase tracking-[.09em] text-[#797984]">
                {hasReferenceDate ? "Coluna mapeada" : "Opcional"}
              </span>
            </div>
            <p className="mt-1 text-xs leading-5 text-[#737783]">
              Identifique o que as datas representam para que a recência da
              lista seja interpretada corretamente.
            </p>

            {savedDateMeaning ? (
              <div
                className="mt-3 rounded-lg border border-[#d9e3e0] bg-[#f1f7f5] px-3.5 py-3"
                data-testid="status-existing-date-meaning"
              >
                <label
                  htmlFor="csv-existing-reference-date-type"
                  className="field-label !text-[#52716c]"
                >
                  Significado já salvo nesta campanha
                </label>
                <select
                  id="csv-existing-reference-date-type"
                  value={existingReferenceDateType ?? ""}
                  disabled
                  aria-describedby="csv-existing-reference-date-help"
                  className="field-control !border-[#d6e2de] !bg-[#f8fbf9] !py-2.5 !text-[#315c58] disabled:cursor-not-allowed disabled:opacity-100"
                  data-testid="select-existing-reference-date-type"
                >
                  <option value={existingReferenceDateType ?? ""}>
                    {savedDateLabel || savedDateMeaning}
                  </option>
                </select>
                <p className="mt-1 text-[11px] leading-4 text-[#667b78]">
                  <span id="csv-existing-reference-date-help">
                    A seleção está bloqueada para evitar misturar significados
                    de data nesta lista.
                  </span>
                </p>
              </div>
            ) : (
              <>
                {hasExistingRecipients && (
                  <div
                    className="mt-3 flex items-start gap-2 rounded-lg border border-[#e8c56f] bg-[#fff7dc] px-3 py-2.5 text-[11px] leading-5 text-[#74561c]"
                    role="alert"
                    data-testid="status-existing-date-meaning-warning"
                  >
                    <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                    <span>
                      Esta campanha já tem destinatários sem um significado de
                      data salvo. O significado escolhido aqui também será
                      aplicado aos valores de data que já existem.
                    </span>
                  </div>
                )}
                <div className="mt-3 grid min-w-0 gap-3 sm:grid-cols-2">
                  <div className="min-w-0">
                    <label
                      htmlFor="csv-reference-date-type"
                      className="field-label"
                    >
                      O que esta data representa?
                    </label>
                    <select
                      id="csv-reference-date-type"
                      value={referenceDateType}
                      disabled={disabled}
                      onChange={handleDateMeaningChange}
                      className="field-control !py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e96527]/25 disabled:cursor-not-allowed disabled:opacity-60"
                      data-testid="select-import-reference-date-type"
                    >
                      <option value="">Escolha o significado</option>
                      <option value="compra">Compra</option>
                      <option value="acesso">Acesso</option>
                      <option value="criacao_conta">Criação da conta</option>
                      <option value="outro">Outro</option>
                    </select>
                  </div>
                  {referenceDateType === "outro" && (
                    <div className="min-w-0">
                      <label
                        htmlFor="csv-reference-date-label"
                        className="field-label"
                      >
                        Nome do significado{" "}
                        <span className="text-[#bd4f26]">· obrigatório</span>
                      </label>
                      <input
                        id="csv-reference-date-label"
                        type="text"
                        value={referenceDateLabel}
                        maxLength={80}
                        required
                        disabled={disabled}
                        onChange={(event) =>
                          onReferenceDateLabelChange(event.target.value)
                        }
                        placeholder="Ex.: data de renovação"
                        className="field-control !py-2.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#e96527]/25 disabled:cursor-not-allowed disabled:opacity-60"
                        data-testid="input-import-reference-date-label"
                      />
                      <p className="field-hint">Até 80 caracteres</p>
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        </div>

        <div
          className="mt-4 flex items-start gap-2.5 rounded-lg border border-[#d9e3e0] bg-[#f1f7f5] px-3.5 py-3 text-[11px] leading-5 text-[#536f6b]"
          data-testid="notice-import-date-storage"
        >
          <CalendarDays size={14} className="mt-0.5 shrink-0 text-[#247b79]" />
          <p>
            Datas sem fuso horário são interpretadas como horário local de{" "}
            <strong className="font-extrabold text-[#315c58]">
              America/Sao_Paulo
            </strong>{" "}
            e armazenadas somente como datas de calendário.
          </p>
        </div>
      </div>
    </section>
  );
}

export default CampaignCsvMappingPanel;
