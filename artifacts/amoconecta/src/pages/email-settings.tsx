import { useEffect, useState } from 'react';
import {
  Check,
  CircleAlert,
  Clock3,
  LoaderCircle,
  Palette,
  RefreshCw,
  Save,
  ShieldCheck,
} from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import {
  getGetEmailBrandingQueryKey,
  getGetEngagementSummaryQueryKey,
  useGetEmailBranding,
  useGetEngagementSummary,
  useUpdateEmailBranding,
} from '@workspace/api-client-react';
import { Shell, type SessionUser } from './campaigns';

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

function validHex(value: string) {
  return /^#[0-9a-f]{6}$/iu.test(value);
}

function BrandingSkeleton() {
  return (
    <div className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]" data-testid="status-email-branding-loading">
      <div className="panel p-6 sm:p-8">
        <div className="skeleton h-3 w-28 rounded-full" />
        <div className="skeleton mt-5 h-8 w-64 rounded-lg" />
        <div className="skeleton mt-3 h-4 w-full max-w-lg rounded-full" />
        <div className="skeleton mt-10 h-12 w-full rounded-xl" />
        <div className="skeleton mt-4 h-11 w-36 rounded-xl" />
      </div>
      <div className="panel p-6 sm:p-8">
        <div className="skeleton h-3 w-32 rounded-full" />
        <div className="skeleton mt-5 h-32 w-full rounded-2xl" />
      </div>
    </div>
  );
}

function EmailPreview({ color }: { color: string }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-[#e2d8ca] bg-[#f7f0e7] p-4" data-testid="email-button-preview">
      <div className="absolute -right-10 -top-10 h-28 w-28 rounded-full bg-[#d7ef56]/35" />
      <div className="relative rounded-xl border border-[#e8dfd4] bg-[#fbf9f5] p-5 shadow-[0_10px_24px_rgba(38,48,68,.07)]">
        <div className="flex items-center justify-between border-b border-[#eee5da] pb-4">
          <span className="font-mono text-[9px] uppercase tracking-[.16em] text-[#8d8990]">Prévia do e-mail</span>
          <span className="h-2 w-2 rounded-full bg-[#63a76f]" />
        </div>
        <div className="py-6">
          <div className="h-2.5 w-36 rounded-full bg-[#263044]/15" />
          <div className="mt-3 h-2 w-full rounded-full bg-[#263044]/8" />
          <div className="mt-2 h-2 w-4/5 rounded-full bg-[#263044]/8" />
          <div className="mt-7 flex justify-center">
            <span className="rounded-lg px-5 py-2.5 text-[11px] font-extrabold text-[#fffaf6] shadow-[0_3px_0_rgba(38,48,68,.15)]" style={{ backgroundColor: validHex(color) ? color : '#e96527' }}>
              Ver oferta
            </span>
          </div>
        </div>
        <div className="border-t border-[#eee5da] pt-3 font-mono text-[8px] uppercase tracking-[.12em] text-[#aaa3a0]">Botão global da conta</div>
      </div>
    </div>
  );
}

export function EmailSettingsPage({ user }: { user: SessionUser }) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [color, setColor] = useState('#e96527');
  const [savedColor, setSavedColor] = useState('#e96527');
  const [formError, setFormError] = useState('');
  const [savedNotice, setSavedNotice] = useState('');
  const queryClient = useQueryClient();
  const brandingQuery = useGetEmailBranding({
    query: { queryKey: getGetEmailBrandingQueryKey() },
  });
  const engagementQuery = useGetEngagementSummary({
    query: { queryKey: getGetEngagementSummaryQueryKey() },
  });
  const updateBranding = useUpdateEmailBranding();

  useEffect(() => {
    if (brandingQuery.data?.cor_botao_email) {
      setColor(brandingQuery.data.cor_botao_email);
      setSavedColor(brandingQuery.data.cor_botao_email);
    }
  }, [brandingQuery.data]);

  const saveColor = () => {
    const normalized = color.trim().toUpperCase();
    if (!validHex(normalized)) {
      setFormError('Use uma cor hexadecimal no formato #RRGGBB.');
      setSavedNotice('');
      return;
    }
    setFormError('');
    setSavedNotice('');
    updateBranding.mutate(
      { data: { cor_botao_email: normalized } },
      {
        onSuccess: (branding) => {
          setColor(branding.cor_botao_email);
          setSavedColor(branding.cor_botao_email);
          setSavedNotice('Cor global atualizada e pronta para novas campanhas.');
          queryClient.invalidateQueries({ queryKey: getGetEmailBrandingQueryKey() });
        },
        onError: (error) => setFormError(errorMessage(error, 'Não foi possível salvar a identidade do e-mail.')),
      },
    );
  };

  const isLoading = brandingQuery.isLoading || engagementQuery.isLoading;
  const hasError = brandingQuery.isError || engagementQuery.isError;

  return (
    <Shell
      user={user}
      title="Identidade do e-mail"
      eyebrow="Configuração da conta"
      mobileNavOpen={mobileNavOpen}
      setMobileNavOpen={setMobileNavOpen}
    >
      {isLoading ? <BrandingSkeleton /> : hasError ? (
        <div className="rounded-2xl border border-[#efc9ba] bg-[#fff0e9] px-6 py-14 text-center" data-testid="status-email-settings-error">
          <CircleAlert className="mx-auto text-[#bd4f26]" size={24} />
          <h2 className="mt-4 font-extrabold text-[#8e3a20]">A identidade não carregou.</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-[#a65d46]">Não conseguimos consultar as configurações da conta agora.</p>
          <button
            type="button"
            onClick={() => {
              void brandingQuery.refetch();
              void engagementQuery.refetch();
            }}
            className="action-button action-button-primary mt-5"
            data-testid="button-email-settings-retry"
          >
            <RefreshCw size={14} /> Tentar novamente
          </button>
        </div>
      ) : (
        <div className="animate-rise-in-delay">
          <div className="mb-5 grid gap-3 sm:grid-cols-2">
            <div className="panel flex items-start gap-4 p-5" data-testid="card-disengaged-summary">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#fff0e9] text-[#d35f2a]"><ShieldCheck size={18} /></div>
              <div>
                <span className="section-kicker">Base protegida</span>
                <strong className="mt-2 block text-2xl font-extrabold tracking-[-.06em] text-[#263044]" data-testid="text-disengaged-total">
                  {formatNumber(engagementQuery.data?.desengajados_total)}
                </strong>
                <span className="mt-1 block text-xs text-[#7d7e87]">contatos desengajados acompanhados</span>
              </div>
            </div>
            <div className="panel flex items-start gap-4 p-5" data-testid="card-branding-updated">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-[#eef7ee] text-[#3f7b46]"><Clock3 size={18} /></div>
              <div>
                <span className="section-kicker">Última alteração</span>
                <strong className="mt-2 block text-sm font-extrabold text-[#263044]" data-testid="text-branding-updated">
                  {formatDate(brandingQuery.data?.atualizado_em)}
                </strong>
                <span className="mt-1 block text-xs text-[#7d7e87]">valor usado como padrão global</span>
              </div>
            </div>
          </div>

          <div className="grid gap-5 lg:grid-cols-[1.2fr_.8fr]">
            <section className="panel p-6 sm:p-8" data-testid="panel-email-branding">
              <div className="flex items-start gap-4">
                <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-[#263044] text-[#d7ef56]"><Palette size={20} /></div>
                <div>
                  <p className="section-kicker">Controle de entrega visual</p>
                  <h2 className="mt-2 text-2xl font-extrabold tracking-[-.06em] text-[#263044]">Cor dos botões de e-mail</h2>
                  <p className="mt-2 max-w-xl text-sm leading-6 text-[#747783]">Este valor será aplicado aos botões das próximas campanhas. Campanhas já criadas preservam a identidade visual registrada no momento da criação.</p>
                </div>
              </div>

              <div className="mt-9 grid gap-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
                <div>
                  <label htmlFor="email-button-color" className="field-label">Valor hexadecimal</label>
                  <div className="flex gap-3">
                    <input
                      id="email-button-color"
                      value={color}
                      onChange={(event) => {
                        setColor(event.target.value);
                        setFormError('');
                        setSavedNotice('');
                      }}
                      className="field-control font-mono uppercase"
                      placeholder="#E96527"
                      maxLength={7}
                      spellCheck={false}
                      data-testid="input-email-button-color"
                    />
                    <input
                      type="color"
                      value={validHex(color) ? color : '#e96527'}
                      onChange={(event) => {
                        setColor(event.target.value.toUpperCase());
                        setFormError('');
                        setSavedNotice('');
                      }}
                      className="h-[46px] w-[54px] cursor-pointer rounded-xl border border-[#dcd3c5] bg-[#fbf9f5] p-1"
                      aria-label="Selecionar cor dos botões"
                      data-testid="input-email-button-color-picker"
                    />
                  </div>
                  <p className="field-hint">Formato aceito: #RRGGBB · Exemplo atual: {savedColor}</p>
                </div>
                <button type="button" onClick={saveColor} disabled={updateBranding.isPending || color === savedColor} className="action-button action-button-primary" data-testid="button-save-email-branding">
                  {updateBranding.isPending ? <LoaderCircle className="animate-spin" size={15} /> : <Save size={15} />}
                  {updateBranding.isPending ? 'Salvando' : 'Salvar cor'}
                </button>
              </div>
              {formError && <p className="mt-4 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-xs font-semibold leading-5 text-[#a64220]" role="alert" data-testid="status-email-branding-error">{formError}</p>}
              {savedNotice && <p className="mt-4 flex items-center gap-2 rounded-xl border border-[#b9d9bc] bg-[#eef7ee] px-4 py-3 text-xs font-semibold leading-5 text-[#3f7b46]" role="status" data-testid="status-email-branding-saved"><Check size={15} /> {savedNotice}</p>}
            </section>

            <section className="panel p-6 sm:p-8" data-testid="panel-email-preview">
              <p className="section-kicker">Leitura rápida</p>
              <h2 className="mt-2 text-lg font-extrabold tracking-[-.04em] text-[#263044]">Assim o destinatário verá</h2>
              <p className="mt-2 text-xs leading-5 text-[#85858b]">Uma amostra do botão global, sem disparar nenhum e-mail.</p>
              <div className="mt-6"><EmailPreview color={color} /></div>
              <div className="mt-5 flex items-center gap-2 border-t border-[#eee6db] pt-4 font-mono text-[9px] uppercase tracking-[.12em] text-[#969298]"><ShieldCheck size={13} className="text-[#d35f2a]" /> Aplicado só em novas campanhas</div>
            </section>
          </div>
        </div>
      )}
    </Shell>
  );
}

export default EmailSettingsPage;