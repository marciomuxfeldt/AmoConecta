import { useEffect, useMemo, useRef, useState, type DragEvent, type ReactNode } from 'react';
import { useForm } from 'react-hook-form';
import {
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  CircleAlert,
  Clock3,
  FileCheck2,
  Inbox,
  Link2,
  LoaderCircle,
  LogOut,
  Mail,
  Menu,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  UploadCloud,
  UserRound,
  X,
} from 'lucide-react';
import { Link, useLocation } from 'wouter';
import {
  CampaignStatus,
  type Campaign,
  type CampaignListItem,
  type CreateCampaignInput,
  type ImportValidationJob,
  type ImportValidationSummary,
  type UpdateCampaignInput,
  getGetCampaignQueryKey,
  getGetCampaignImportQueryKey,
  getGetAuthSessionQueryKey,
  getListCampaignsQueryKey,
  useCreateCampaign,
  useDeleteCampaign,
  useGetCampaign,
  useGetCampaignImport,
  useListCampaigns,
  useLogout,
  useRequestCampaignImportUploadUrl,
  useUpdateCampaign,
  useValidateCampaignImport,
} from '@workspace/api-client-react';
import { useQueryClient } from '@tanstack/react-query';
import { type EmailBlock, normalizeEmailBlocks } from '@workspace/email-template';
import { EmailEditor } from '../components/EmailEditor';

type SessionUser = { email: string } | null;

const statusLabels: Record<string, string> = {
  rascunho: 'Rascunho',
  agendada: 'Agendada',
  enviando: 'Enviando',
  pausada: 'Pausada',
  concluida: 'Concluída',
};

const statusDescriptions: Record<string, string> = {
  rascunho: 'Metadados em preparação',
  agendada: 'Pronta para a janela definida',
  enviando: 'Operação em andamento',
  pausada: 'Aguardando uma decisão',
  concluida: 'Operação finalizada',
};

function getErrorMessage(error: unknown, fallback: string) {
  if (error && typeof error === 'object' && 'error' in error) {
    const value = (error as { error?: unknown }).error;
    if (typeof value === 'string') return value;
  }
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}

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

function toDateTimeLocal(value: string | null | undefined) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value.slice(0, 16);
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function nullableNumber(value: string) {
  if (value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function toServerDate(value: string) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

function isHttpUrl(value: string) {
  return /^https?:\/\/[^\s]+$/iu.test(value.trim());
}

function validateEmailBlocks(blocks: EmailBlock[]) {
  for (const block of blocks) {
    if (block.type === 'image') {
      if (!block.src || !isHttpUrl(block.src)) return 'Envie uma imagem antes de salvar o bloco de imagem.';
      if (block.href?.trim() && !isHttpUrl(block.href)) return 'O link opcional da imagem precisa começar com https:// ou http://.';
    }
    if (block.type === 'button') {
      if (!block.label.trim()) return 'Informe o rótulo de todos os botões.';
      if (!isHttpUrl(block.href)) return 'Informe um destino válido para todos os botões.';
    }
  }
  return null;
}

function StatusPill({ status }: { status: string }) {
  return (
    <span className={`status-pill status-${status}`} data-testid={`status-campaign-${status}`}>
      <span className="status-dot" />
      {statusLabels[status] ?? status}
    </span>
  );
}

function AmoMark({ compact = false }: { compact?: boolean }) {
  return (
    <div className={`flex items-center ${compact ? 'gap-2' : 'gap-3'}`} data-testid="brand-amoconecta">
      <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-[11px] bg-[#d7ef56] text-[#263044] shadow-[3px_3px_0_hsl(24_86%_50%)]">
        <span className="absolute h-3 w-3 rounded-full border-[3px] border-[#263044]" />
        <span className="absolute -right-0.5 -top-0.5 h-2 w-2 rounded-full bg-[#e96527]" />
      </span>
      <span className="leading-none">
        <span className="block text-[17px] font-extrabold tracking-[-0.05em]">amo</span>
        <span className="block font-mono text-[9px] font-medium uppercase tracking-[0.17em] opacity-70">conecta</span>
      </span>
    </div>
  );
}

function Shell({
  user,
  children,
  title,
  eyebrow,
  mobileNavOpen,
  setMobileNavOpen,
}: {
  user: SessionUser;
  children: ReactNode;
  title: string;
  eyebrow: string;
  mobileNavOpen: boolean;
  setMobileNavOpen: (open: boolean) => void;
}) {
  const logout = useLogout();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();

  const doLogout = () => {
    logout.mutate(undefined, {
      onSuccess: () => {
        queryClient.setQueryData(getGetAuthSessionQueryKey(), { authenticated: false, user: null });
        setLocation('/login');
      },
    });
  };

  return (
    <div className="amo-noise min-h-[100dvh] bg-[#f5f0e8] text-[#263044]" data-testid="app-shell">
      <aside className={`fixed inset-y-0 left-0 z-30 flex w-[252px] flex-col bg-[#263044] px-5 py-6 text-[#fbf9f5] shadow-[12px_0_38px_rgba(38,48,68,.08)] transition-transform duration-300 md:translate-x-0 ${mobileNavOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex items-center justify-between px-2">
          <AmoMark />
          <button onClick={() => setMobileNavOpen(false)} className="focus-ring rounded-lg p-1 text-[#cbd0d4] md:hidden" data-testid="button-close-navigation" aria-label="Fechar menu">
            <X size={18} />
          </button>
        </div>
        <div className="mt-14 px-2">
          <p className="font-mono text-[9px] uppercase tracking-[0.2em] text-[#aab2bd]">Espaço de trabalho</p>
          <nav className="mt-3">
            <Link href="/" onClick={() => setMobileNavOpen(false)} className="focus-ring flex items-center gap-3 rounded-xl bg-[#354157] px-3 py-3 text-sm font-bold text-[#fbf9f5]" data-testid="link-campaigns">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-[#d7ef56] text-[#263044]"><Mail size={15} /></span>
              Campanhas
            </Link>
          </nav>
        </div>
        <div className="mt-auto rounded-2xl border border-[#3b475c] bg-[#2d3950] p-4">
          <div className="flex items-center gap-2 text-[#d7ef56]">
            <span className="h-2 w-2 rounded-full bg-[#d7ef56]" />
            <span className="font-mono text-[9px] uppercase tracking-[0.16em]">Sistema operacional</span>
          </div>
          <p className="mt-3 text-xs leading-5 text-[#c4cad2]">Metadados claros. Importações validadas. Decisões sem ruído.</p>
        </div>
        {logout.isError && <p className="mb-3 px-2 text-[10px] leading-4 text-[#f0a387]" data-testid="status-logout-error">Não foi possível sair. Tente novamente.</p>}
        <div className="mt-5 flex items-center justify-between border-t border-[#3b475c] px-2 pt-5">
          <div className="min-w-0">
            <p className="truncate text-xs font-bold text-[#fbf9f5]" data-testid="text-sidebar-email">{user?.email ?? 'Operação Amo'}</p>
            <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.1em] text-[#9ca7b5]">Marketing</p>
          </div>
          <button onClick={doLogout} disabled={logout.isPending} className="focus-ring rounded-lg p-2 text-[#aab2bd] transition hover:bg-[#3b475c] hover:text-[#d7ef56] disabled:opacity-50" aria-label="Sair do AmoConecta" data-testid="button-logout">
            <LogOut size={16} />
          </button>
        </div>
      </aside>
      {mobileNavOpen && <button aria-label="Fechar menu" onClick={() => setMobileNavOpen(false)} className="fixed inset-0 z-20 bg-[#263044]/35 backdrop-blur-sm md:hidden" data-testid="button-dismiss-navigation" />}
      <div className="min-h-[100dvh] md:pl-[252px]">
        <header className="flex h-[76px] items-center justify-between border-b border-[#e6ded3] bg-[#f8f3ec]/90 px-5 backdrop-blur sm:px-8 md:px-10">
          <button onClick={() => setMobileNavOpen(true)} className="focus-ring rounded-lg p-2 text-[#263044] md:hidden" aria-label="Abrir menu" data-testid="button-open-navigation"><Menu size={20} /></button>
          <div className="hidden items-center gap-2 md:flex">
            <span className="h-2 w-2 rounded-full bg-[#d7ef56]" />
            <span className="font-mono text-[10px] uppercase tracking-[0.17em] text-[#777984]">Amo Ofertas <span className="px-1 text-[#d1c7b9]">/</span> Operação</span>
          </div>
          <div className="ml-auto flex items-center gap-3">
            <span className="hidden font-mono text-[10px] text-[#8c8b91] sm:block" data-testid="text-header-email">{user?.email}</span>
            <div className="flex h-8 w-8 items-center justify-center rounded-full bg-[#e96527] text-xs font-extrabold text-[#fbf9f5]" data-testid="avatar-operator">{user?.email?.slice(0, 1).toUpperCase() ?? 'A'}</div>
          </div>
        </header>
        <main className="mx-auto max-w-[1420px] px-5 pb-16 pt-10 sm:px-8 sm:pt-14 md:px-10">
          <div className="animate-rise-in mb-9 flex flex-col justify-between gap-6 border-b border-[#e1d8cc] pb-8 lg:flex-row lg:items-end">
            <div>
              <p className="section-kicker">{eyebrow}</p>
              <h1 className="mt-3 text-[2.7rem] font-extrabold leading-none tracking-[-0.075em] text-[#263044] sm:text-5xl" data-testid="text-page-title">{title}</h1>
            </div>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-2 rounded-full border border-[#ded5c8] bg-[#fbf9f5] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.12em] text-[#7d7e87]" data-testid="status-workspace">
                <span className="h-1.5 w-1.5 rounded-full bg-[#63a76f]" /> ambiente ativo
              </div>
              <span className="hidden h-8 w-px bg-[#ddd3c6] sm:block" />
              <span className="hidden font-mono text-[10px] uppercase tracking-[0.12em] text-[#9b9897] sm:block">Fase 02</span>
            </div>
          </div>
          {children}
          <footer className="mt-10 flex flex-col justify-between gap-3 border-t border-[#e1d8cc] pt-5 text-[10px] text-[#a19c99] sm:flex-row">
            <span className="font-mono uppercase tracking-[0.1em]">AmoConecta · Fundação operacional</span>
            <span className="flex items-center gap-1.5"><ShieldCheck size={12} className="text-[#d35f2a]" /> Ambiente privado da operação</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

function CampaignSkeleton() {
  return (
    <div className="panel overflow-hidden" data-testid="status-campaign-loading">
      <div className="hidden grid-cols-[2fr_1fr_1fr_1fr_1fr] gap-4 border-b border-[#eee7dc] bg-[#f7f2eb] px-6 py-4 md:grid">
        {Array.from({ length: 5 }).map((_, index) => <div key={index} className="skeleton h-2 rounded-full" />)}
      </div>
      {Array.from({ length: 4 }).map((_, index) => (
        <div key={index} className="grid grid-cols-2 gap-4 border-b border-[#eee7dc] px-5 py-5 last:border-0 md:grid-cols-[2fr_1fr_1fr_1fr_1fr] md:px-6">
          <div className="skeleton h-4 w-40 rounded-full" /><div className="skeleton h-5 w-20 rounded-full" /><div className="skeleton h-3 w-16 rounded-full" /><div className="skeleton h-3 w-16 rounded-full" /><div className="skeleton h-3 w-24 rounded-full" />
        </div>
      ))}
    </div>
  );
}

function CampaignTable({ campaigns }: { campaigns: CampaignListItem[] }) {
  return (
    <div className="panel overflow-hidden" data-testid="campaign-list">
      <div className="hidden grid-cols-[2fr_1fr_.8fr_.8fr_1.2fr] gap-4 border-b border-[#eee7dc] bg-[#f7f2eb] px-6 py-3 font-mono text-[9px] uppercase tracking-[0.14em] text-[#8b8d96] md:grid">
        <span>Campanha</span><span>Status</span><span>Enviados</span><span>Entregues</span><span>Próximo passo</span>
      </div>
      {campaigns.map((campaign) => (
        <Link href={`/campaigns/${campaign.id}`} key={campaign.id} className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-[#eee7dc] px-5 py-5 transition-colors last:border-0 hover:bg-[#f8f3ec] md:grid-cols-[2fr_1fr_.8fr_.8fr_1.2fr] md:items-center md:px-6" data-testid={`row-campaign-${campaign.id}`}>
          <div className="min-w-0">
            <p className="truncate text-sm font-extrabold text-[#263044]" data-testid={`text-campaign-name-${campaign.id}`}>{campaign.nome}</p>
            <p className="mt-1 font-mono text-[9px] uppercase tracking-[0.08em] text-[#99959a]">Criada em {formatDate(campaign.criado_em)}</p>
          </div>
          <div><StatusPill status={campaign.status} /></div>
          <div><span className="text-sm font-bold tabular-nums text-[#42495b]">{formatNumber(campaign.enviados)}</span><span className="mt-1 block font-mono text-[9px] uppercase text-[#aaa3a1] md:hidden">enviados</span></div>
          <div><span className="text-sm font-bold tabular-nums text-[#42495b]">{formatNumber(campaign.entregues)}</span><span className="mt-1 block font-mono text-[9px] uppercase text-[#aaa3a1] md:hidden">entregues</span></div>
          <div className="col-span-2 border-t border-[#f0e9e0] pt-3 md:col-span-1 md:border-0 md:pt-0">
            <span className="flex items-center gap-2 text-xs font-semibold text-[#6d7180]"><Clock3 size={13} className="text-[#d35f2a]" /> {campaign.agendada_para ? formatDate(campaign.agendada_para) : 'Sem agendamento'}</span>
          </div>
        </Link>
      ))}
    </div>
  );
}

function EmptyCampaigns() {
  return (
    <div className="panel relative overflow-hidden px-6 py-16 text-center sm:px-10 sm:py-24" data-testid="empty-campaigns">
      <div className="absolute left-1/2 top-0 h-1 w-24 -translate-x-1/2 bg-[#d7ef56]" />
      <div className="relative mx-auto flex h-20 w-20 items-center justify-center rounded-[26px] border border-[#e4daca] bg-[#f5efe7] text-[#d35f2a] shadow-[8px_8px_0_#f0e3d2]">
        <Inbox size={33} strokeWidth={1.5} /><span className="absolute -right-1 -top-1 h-3 w-3 rounded-full border-2 border-[#fbf9f5] bg-[#d7ef56]" />
      </div>
      <p className="mt-9 section-kicker">Primeira operação</p>
      <h2 className="mt-3 text-2xl font-extrabold tracking-[-0.05em] text-[#263044] sm:text-[2rem]">Comece pela mensagem certa.</h2>
      <p className="mx-auto mt-3 max-w-md text-sm leading-6 text-[#747783]">Crie a campanha, confirme seus metadados e depois valide a base de destinatários antes de qualquer decisão de envio.</p>
      <div className="mx-auto mt-10 flex max-w-md items-center justify-center gap-3 border-t border-[#eee6db] pt-6 text-[10px] uppercase tracking-[0.13em] text-[#99959a]">
        <span className="h-1.5 w-1.5 rounded-full bg-[#d7ef56]" /> Clareza primeiro <span className="h-1.5 w-1.5 rounded-full bg-[#e96527]" /> Envio depois
      </div>
    </div>
  );
}

export function CampaignsPage({ user }: { user: SessionUser }) {
  const campaignsQuery = useListCampaigns({ query: { queryKey: getListCampaignsQueryKey() } });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const campaigns = campaignsQuery.data ?? [];
  const counts = useMemo(() => ({
    total: campaigns.length,
    scheduled: campaigns.filter((campaign) => campaign.status === CampaignStatus.agendada).length,
    drafts: campaigns.filter((campaign) => campaign.status === CampaignStatus.rascunho).length,
  }), [campaigns]);

  return (
    <Shell user={user} title="Campanhas" eyebrow="Visão geral" mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}>
      <div className="animate-rise-in-delay">
        <div className="mb-8 grid gap-3 sm:grid-cols-3">
          <div className="panel p-4"><span className="section-kicker">No espaço</span><strong className="mt-3 block text-3xl font-extrabold tracking-[-.07em] text-[#263044]" data-testid="text-campaign-count">{formatNumber(counts.total)}</strong><span className="mt-1 block text-xs text-[#7d7e87]">campanhas registradas</span></div>
          <div className="panel p-4"><span className="section-kicker">Em preparação</span><strong className="mt-3 block text-3xl font-extrabold tracking-[-.07em] text-[#263044]" data-testid="text-draft-count">{formatNumber(counts.drafts)}</strong><span className="mt-1 block text-xs text-[#7d7e87]">rascunhos em aberto</span></div>
          <div className="panel p-4"><span className="section-kicker">Próxima janela</span><strong className="mt-3 block text-3xl font-extrabold tracking-[-.07em] text-[#263044]" data-testid="text-scheduled-count">{formatNumber(counts.scheduled)}</strong><span className="mt-1 block text-xs text-[#7d7e87]">campanhas agendadas</span></div>
        </div>
        <div className="mb-5 flex flex-col justify-between gap-3 sm:flex-row sm:items-end">
          <div><h2 className="text-lg font-extrabold tracking-[-0.03em] text-[#263044]">Todas as campanhas</h2><p className="mt-1 text-xs text-[#85858b]">O ponto de partida para cada importação validada.</p></div>
          <Link href="/campaigns/new" className="action-button action-button-primary" data-testid="link-new-campaign"><span className="text-lg leading-none">+</span> Nova campanha <ArrowRight size={15} /></Link>
        </div>
        {campaignsQuery.isLoading ? <CampaignSkeleton /> : campaignsQuery.isError ? (
          <div className="rounded-2xl border border-[#efc9ba] bg-[#fff0e9] px-6 py-14 text-center" data-testid="status-campaign-error">
            <CircleAlert className="mx-auto text-[#bd4f26]" size={24} /><h3 className="mt-4 font-bold text-[#8e3a20]">A lista não carregou.</h3><p className="mt-2 text-sm text-[#a65d46]">Não conseguimos consultar suas campanhas agora.</p>
            <button onClick={() => campaignsQuery.refetch()} className="action-button action-button-primary mt-5" data-testid="button-campaigns-retry"><RefreshCw size={14} /> Tentar novamente</button>
          </div>
        ) : campaigns.length === 0 ? <EmptyCampaigns /> : <CampaignTable campaigns={campaigns} />}
        <div className="mt-5 flex items-center gap-2 font-mono text-[9px] uppercase tracking-[.12em] text-[#969298]"><ShieldCheck size={13} className="text-[#d35f2a]" /> A lista é atualizada ao entrar e após cada alteração.</div>
      </div>
    </Shell>
  );
}

type CampaignFormValues = {
  nome: string;
  assunto: string;
  assunto_lembrete: string;
  remetente_nome: string;
  remetente_email: string;
  valor_credito: string;
  validade_credito: string;
  url_deeplink: string;
  url_landing: string;
  teto_hora: string;
  teto_dia: string;
  status: string;
  agendada_para: string;
  lembrete_ativo: boolean;
  lembrete_horas: string;
  teste_enviado: boolean;
  corpo: EmailBlock[];
};

const blankCampaign: CampaignFormValues = {
  nome: '',
  assunto: '',
  assunto_lembrete: '',
  remetente_nome: '',
  remetente_email: '',
  valor_credito: '',
  validade_credito: '',
  url_deeplink: '',
  url_landing: '',
  teto_hora: '',
  teto_dia: '',
  status: CampaignStatus.rascunho,
  agendada_para: '',
  lembrete_ativo: false,
  lembrete_horas: '24',
  teste_enviado: false,
  corpo: [],
};

function campaignToForm(campaign?: Campaign): CampaignFormValues {
  if (!campaign) return blankCampaign;
  return {
    nome: campaign.nome,
    assunto: campaign.assunto,
    assunto_lembrete: campaign.assunto_lembrete ?? '',
    remetente_nome: campaign.remetente_nome,
    remetente_email: campaign.remetente_email,
    valor_credito: campaign.valor_credito == null ? '' : String(campaign.valor_credito),
    validade_credito: campaign.validade_credito ?? '',
    url_deeplink: campaign.url_deeplink ?? '',
    url_landing: campaign.url_landing ?? '',
    teto_hora: campaign.teto_hora == null ? '' : String(campaign.teto_hora),
    teto_dia: campaign.teto_dia == null ? '' : String(campaign.teto_dia),
    status: campaign.status,
    agendada_para: toDateTimeLocal(campaign.agendada_para),
    lembrete_ativo: campaign.lembrete_ativo,
    lembrete_horas: String(campaign.lembrete_horas ?? 24),
    teste_enviado: campaign.teste_enviado,
    corpo: normalizeEmailBlocks(campaign.corpo),
  };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return <div><label className="field-label">{label}</label>{children}{hint && <p className="field-hint">{hint}</p>}</div>;
}

function CampaignForm({ campaign, onSaved }: { campaign?: Campaign; onSaved: (campaign: Campaign) => void }) {
  const create = useCreateCampaign();
  const update = useUpdateCampaign();
  const form = useForm<CampaignFormValues>({ defaultValues: campaignToForm(campaign) });
  const isEditing = Boolean(campaign);
  const emailBlocks = form.watch('corpo');
  const emailSubject = form.watch('assunto');
  const [uploadingBlockIds, setUploadingBlockIds] = useState<Set<string>>(() => new Set());
  const isUploadPending = uploadingBlockIds.size > 0;

  const handleUploadingChange = (blockId: string, uploading: boolean) => {
    setUploadingBlockIds((current) => {
      const next = new Set(current);
      if (uploading) {
        next.add(blockId);
      } else {
        next.delete(blockId);
      }
      return next;
    });
  };

  useEffect(() => {
    form.reset(campaignToForm(campaign));
  }, [campaign, form]);

  const submit = (values: CampaignFormValues) => {
    if (isUploadPending) {
      form.setError('corpo', { type: 'upload', message: 'Aguarde o término do upload das imagens antes de salvar.' });
      return;
    }
    if (!values.nome.trim() || !values.assunto.trim() || !values.remetente_nome.trim() || !values.remetente_email.trim()) {
      form.setError('nome', { message: 'Preencha os campos obrigatórios antes de salvar.' });
      return;
    }
    const contentError = validateEmailBlocks(values.corpo);
    if (contentError) {
      form.setError('corpo', { type: 'validate', message: contentError });
      return;
    }
    const corpo = values.corpo.map((block) => (
      block.type === 'image' && !block.href?.trim()
        ? { ...block, href: undefined }
        : block
    ));
    const payload = {
      nome: values.nome.trim(),
      assunto: values.assunto.trim(),
      assunto_lembrete: values.assunto_lembrete.trim() || null,
      remetente_nome: values.remetente_nome.trim(),
      remetente_email: values.remetente_email.trim(),
      valor_credito: nullableNumber(values.valor_credito),
      validade_credito: values.validade_credito.trim() || null,
      url_deeplink: values.url_deeplink.trim() || null,
      url_landing: values.url_landing.trim() || null,
      teto_hora: nullableNumber(values.teto_hora),
      teto_dia: nullableNumber(values.teto_dia),
      status: values.status as CreateCampaignInput['status'],
      agendada_para: toServerDate(values.agendada_para),
      lembrete_ativo: values.lembrete_ativo,
      lembrete_horas: Math.max(1, Number(values.lembrete_horas) || 24),
      teste_enviado: values.teste_enviado,
      corpo,
    };
    if (campaign) {
      update.mutate({ campaignId: campaign.id, data: payload as UpdateCampaignInput }, { onSuccess: onSaved });
    } else {
      create.mutate({ data: payload as CreateCampaignInput }, { onSuccess: onSaved });
    }
  };

  const isPending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  return (
    <form onSubmit={form.handleSubmit(submit)} className="space-y-5" noValidate data-testid="form-campaign">
       <section className="panel p-5 sm:p-7">
        <div className="mb-6 flex items-start justify-between gap-4"><div><p className="section-kicker">01 · Identidade</p><h2 className="mt-2 text-lg font-extrabold tracking-[-.04em] text-[#263044]">Como esta campanha será reconhecida?</h2></div><span className="font-mono text-[9px] uppercase tracking-[.12em] text-[#aaa3a1]">Obrigatório</span></div>
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Nome interno"><input {...form.register('nome')} className="field-control" placeholder="Ex.: Ofertas de sexta — eletrônicos" data-testid="input-campaign-name" /></Field>
          <Field label="Assunto principal"><input {...form.register('assunto')} className="field-control" placeholder="Ex.: As melhores ofertas chegaram" data-testid="input-campaign-subject" /></Field>
          <div className="md:col-span-2"><Field label="Assunto do lembrete" hint="Opcional. Usado para identificar uma eventual mensagem de lembrete."><input {...form.register('assunto_lembrete')} className="field-control" placeholder="Ex.: Você ainda pode aproveitar estas ofertas" data-testid="input-campaign-reminder-subject" /></Field></div>
        </div>
        {form.formState.errors.nome && <p className="mt-4 flex items-center gap-2 text-xs font-bold text-[#bd4f26]" data-testid="error-campaign-form"><CircleAlert size={14} /> {form.formState.errors.nome.message}</p>}
      </section>

      <section className="panel p-5 sm:p-7">
        <div className="mb-6"><p className="section-kicker">02 · Remetente</p><h2 className="mt-2 text-lg font-extrabold tracking-[-.04em] text-[#263044]">De quem a mensagem chega?</h2></div>
        <div className="grid gap-5 md:grid-cols-2">
          <Field label="Nome do remetente"><div className="relative"><UserRound size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#92939a]" /><input {...form.register('remetente_nome')} className="field-control pl-10" placeholder="Amo Ofertas" data-testid="input-sender-name" /></div></Field>
          <Field label="E-mail do remetente"><div className="relative"><Mail size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#92939a]" /><input {...form.register('remetente_email')} type="email" className="field-control pl-10" placeholder="ofertas@amoofertas.com.br" data-testid="input-sender-email" /></div></Field>
        </div>
      </section>

      <section className="panel p-5 sm:p-7">
        <div className="mb-6"><p className="section-kicker">03 · Incentivo e destino</p><h2 className="mt-2 text-lg font-extrabold tracking-[-.04em] text-[#263044]">Quais regras acompanham a oferta?</h2></div>
        <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Valor do crédito" hint="Use o valor numérico em reais."><input {...form.register('valor_credito')} inputMode="decimal" className="field-control" placeholder="0,00" data-testid="input-credit-value" /></Field>
          <Field label="Validade do crédito" hint="Data limite do crédito."><input {...form.register('validade_credito')} type="date" className="field-control" data-testid="input-credit-expiry" /></Field>
          <Field label="Teto por hora"><input {...form.register('teto_hora')} inputMode="numeric" className="field-control" placeholder="Sem limite" data-testid="input-hour-cap" /></Field>
          <Field label="Teto por dia"><input {...form.register('teto_dia')} inputMode="numeric" className="field-control" placeholder="Sem limite" data-testid="input-day-cap" /></Field>
          <div className="sm:col-span-2 lg:col-span-2"><Field label="Deep link"><div className="relative"><Link2 size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#92939a]" /><input {...form.register('url_deeplink')} type="url" className="field-control pl-10" placeholder="https://..." data-testid="input-deeplink" /></div></Field></div>
          <div className="sm:col-span-2 lg:col-span-2"><Field label="Landing page"><div className="relative"><Link2 size={15} className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-[#92939a]" /><input {...form.register('url_landing')} type="url" className="field-control pl-10" placeholder="https://..." data-testid="input-landing-page" /></div></Field></div>
        </div>
      </section>

      <EmailEditor
        blocks={emailBlocks}
        onChange={(blocks) => form.setValue('corpo', blocks, { shouldDirty: true })}
        campaignId={campaign?.id}
        subject={emailSubject}
        onUploadingChange={handleUploadingChange}
      />
      {form.formState.errors.corpo?.message && <p className="rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-xs leading-5 text-[#a64220]" data-testid="error-email-content">{form.formState.errors.corpo.message}</p>}
      {isUploadPending && <p className="flex items-center gap-2 rounded-xl border border-[#d4e5df] bg-[#f1f7f5] px-4 py-3 text-xs text-[#247b79]" role="status" data-testid="status-image-upload-blocking"><LoaderCircle size={14} className="animate-spin" /> Aguarde o upload das imagens terminar para salvar a campanha.</p>}

      <section className="panel p-5 sm:p-7">
        <div className="mb-6"><p className="section-kicker">05 · Operação</p><h2 className="mt-2 text-lg font-extrabold tracking-[-.04em] text-[#263044]">Quando e em que estado ela está?</h2></div>
        <div className="grid gap-5 md:grid-cols-3">
          <Field label="Status"><select {...form.register('status')} className="field-control" data-testid="select-campaign-status">{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></Field>
          <Field label="Agendamento"><input {...form.register('agendada_para')} type="datetime-local" className="field-control" data-testid="input-scheduled-at" /></Field>
          <Field label="Horas até o lembrete"><input {...form.register('lembrete_horas')} type="number" min="1" className="field-control" data-testid="input-reminder-hours" /></Field>
        </div>
        <div className="mt-6 grid gap-3 border-t border-[#eee7dc] pt-5 sm:grid-cols-2">
          <label className="flex items-start gap-3 rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-3 text-xs text-[#565c6a]"><input {...form.register('lembrete_ativo')} type="checkbox" className="mt-0.5 accent-[#e96527]" data-testid="checkbox-reminder-active" /><span><strong className="block text-[#263044]">Lembrete ativo</strong><span className="mt-1 block leading-5">Deixa o lembrete habilitado para a operação.</span></span></label>
          <label className="flex items-start gap-3 rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-3 text-xs text-[#565c6a]"><input {...form.register('teste_enviado')} type="checkbox" className="mt-0.5 accent-[#e96527]" data-testid="checkbox-test-sent" /><span><strong className="block text-[#263044]">Teste já enviado</strong><span className="mt-1 block leading-5">Registra que uma mensagem de teste foi disparada fora deste fluxo.</span></span></label>
        </div>
      </section>

      {error && <div className="rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm leading-5 text-[#a64220]" data-testid="status-save-error"><div className="flex items-start gap-3"><CircleAlert size={17} className="mt-0.5 shrink-0" /><span>{getErrorMessage(error, 'Não foi possível salvar a campanha.')}</span></div></div>}
       <div className="flex flex-col-reverse justify-end gap-3 sm:flex-row"><Link href={campaign ? `/campaigns/${campaign.id}` : '/'} className="action-button action-button-secondary" data-testid="link-cancel-campaign">Cancelar</Link><button type="submit" disabled={isPending || isUploadPending} className="action-button action-button-primary" data-testid="button-save-campaign">{isPending ? <><LoaderCircle size={16} className="animate-spin" /> Salvando...</> : isUploadPending ? <><LoaderCircle size={16} className="animate-spin" /> Aguardando upload...</> : <><Save size={16} /> {isEditing ? 'Salvar alterações' : 'Criar campanha'}</>}</button></div>
    </form>
  );
}

function ImportSummary({ summary }: { summary: ImportValidationSummary }) {
  const maxRecency = Math.max(...(summary.recencia?.map((item) => item.quantidade) ?? [1]), 1);
  const issueRows = [
    ['E-mails inválidos', summary.emails_invalidos],
    ['Datas inválidas', summary.datas_invalidas],
    ['Nomes ausentes', summary.nomes_ausentes],
    ['Telefones inválidos', summary.telefones_invalidos],
    ['Duplicados no arquivo', summary.duplicados_no_arquivo],
    ['Duplicados por telefone', summary.duplicados_telefone],
    ['Suprimidos', summary.suprimidos],
  ];
  return (
    <div className="mt-6 border-t border-[#eee7dc] pt-6" data-testid="import-validation-summary">
      <div className="mb-5 flex flex-col justify-between gap-2 sm:flex-row sm:items-end"><div><p className="section-kicker">Resultado da validação</p><h3 className="mt-2 text-xl font-extrabold tracking-[-.05em] text-[#263044]">Base pronta para uma decisão.</h3></div><span className="font-mono text-[9px] text-[#989498]" data-testid="text-import-storage-path">{summary.storage_path}</span></div>
       <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-7">
        <div className="metric-tile"><strong>{formatNumber(summary.total_linhas)}</strong><span>Linhas lidas</span></div>
        <div className="metric-tile border-[#cfe4c7] bg-[#f2f8ee]"><strong className="text-[#417846]">{formatNumber(summary.validos)}</strong><span>Válidos</span></div>
        <div className="metric-tile border-[#efc9ba] bg-[#fff3ee]"><strong className="text-[#a64220]">{formatNumber(summary.invalidos)}</strong><span>Inválidos</span></div>
         <div className="metric-tile border-[#cfe4c7] bg-[#f2f8ee]"><strong className="text-[#417846]">{formatNumber(summary.novos)}</strong><span>Salvos</span></div>
         <div className="metric-tile"><strong>{formatNumber(summary.atualizados)}</strong><span>Atualizados</span></div>
         <div className="metric-tile border-[#f1dfb8] bg-[#fff9e9]"><strong className="text-[#9b6b17]">{formatNumber(summary.duplicados_no_arquivo)}</strong><span>Duplicados</span></div>
        <div className="metric-tile"><strong>{formatNumber(summary.suprimidos)}</strong><span>Suprimidos</span></div>
      </div>
      <div className="mt-6 grid gap-6 lg:grid-cols-[1fr_1.2fr]">
        <div className="rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-4">
          <div className="flex items-center justify-between"><h4 className="text-sm font-extrabold text-[#263044]">Pontos de atenção</h4><CircleAlert size={15} className="text-[#d35f2a]" /></div>
          <div className="mt-4 space-y-3">{issueRows.map(([label, value]) => <div key={label as string} className="flex items-center justify-between gap-3 text-xs"><span className="text-[#6d7180]">{label}</span><span className={`font-mono font-medium ${Number(value) > 0 ? 'text-[#a64220]' : 'text-[#8a8790]'}`}>{formatNumber(Number(value))}</span></div>)}</div>
        </div>
        <div className="rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-4">
          <div className="flex items-center justify-between"><h4 className="text-sm font-extrabold text-[#263044]">Recência da base</h4><Clock3 size={15} className="text-[#247b79]" /></div>
          <div className="mt-5 space-y-4">{(summary.recencia ?? []).length === 0 ? <p className="text-xs text-[#7d7e87]">A API não retornou distribuição de recência.</p> : summary.recencia.map((bucket) => <div key={bucket.faixa}><div className="mb-1.5 flex justify-between gap-3 font-mono text-[9px] uppercase tracking-[.08em] text-[#7d7e87]"><span>{bucket.faixa}</span><span>{formatNumber(bucket.quantidade)}</span></div><div className="h-2 overflow-hidden rounded-full bg-[#e6ded3]"><div className="h-full rounded-full bg-[#247b79] transition-[width] duration-500" style={{ width: `${Math.max(4, (bucket.quantidade / maxRecency) * 100)}%` }} /></div></div>)}</div>
        </div>
      </div>
      <div className="mt-6 rounded-xl border border-[#e5ddd0] bg-[#fffdf9] p-4">
        <div className="flex items-center justify-between"><h4 className="text-sm font-extrabold text-[#263044]">Amostras de erros</h4><span className="font-mono text-[9px] uppercase tracking-[.1em] text-[#989498]">{summary.amostras_erros?.length ?? 0} mostradas</span></div>
        {(summary.amostras_erros ?? []).length === 0 ? <p className="mt-4 flex items-center gap-2 text-xs text-[#417846]"><CheckCircle2 size={15} /> Nenhuma amostra de erro retornada.</p> : <div className="mt-4 overflow-hidden rounded-lg border border-[#eee7dc]"><div className="grid grid-cols-[75px_1fr] bg-[#f7f2eb] px-3 py-2 font-mono text-[9px] uppercase tracking-[.1em] text-[#8b8d96]"><span>Linha</span><span>Motivo</span></div>{summary.amostras_erros.map((item, index) => <div key={`${item.linha}-${index}`} className="grid grid-cols-[75px_1fr] border-t border-[#eee7dc] px-3 py-2.5 text-xs text-[#626876]"><span className="font-mono text-[#a64220]">{item.linha}</span><span>{item.motivo}</span></div>)}</div>}
      </div>
    </div>
  );
}

function ImportPanel({ campaignId }: { campaignId: string }) {
  const requestUpload = useRequestCampaignImportUploadUrl();
  const validateImport = useValidateCampaignImport();
  const inputRef = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [dragging, setDragging] = useState(false);
  const [deduplicatePhone, setDeduplicatePhone] = useState(false);
  const [summary, setSummary] = useState<ImportValidationSummary | null>(null);
  const [importJobId, setImportJobId] = useState<string | null>(null);
  const [phase, setPhase] = useState<'idle' | 'requesting' | 'uploading' | 'processing'>('idle');
  const [error, setError] = useState<string | null>(null);
  const importJobQuery = useGetCampaignImport(campaignId, importJobId ?? '', {
    query: {
      enabled: Boolean(importJobId),
      queryKey: getGetCampaignImportQueryKey(campaignId, importJobId ?? ''),
      refetchInterval: 1000,
    },
  });

  useEffect(() => {
    const job = importJobQuery.data;
    if (!job) return;
    if (job.status === 'concluida') {
      setSummary(job.resultado);
      setImportJobId(null);
      setPhase('idle');
      return;
    }
    if (job.status === 'erro') {
      setError(job.erro ?? 'Não foi possível validar o arquivo.');
      setImportJobId(null);
      setPhase('idle');
    }
  }, [importJobQuery.data]);

  useEffect(() => {
    if (!importJobQuery.isError || !importJobId) return;
    setError(getErrorMessage(importJobQuery.error, 'Não foi possível consultar o progresso da validação.'));
    setImportJobId(null);
    setPhase('idle');
  }, [importJobQuery.error, importJobQuery.isError, importJobId]);

  const chooseFile = (nextFile?: File) => {
    if (!nextFile) return;
    if (!nextFile.name.toLowerCase().endsWith('.csv') && nextFile.type !== 'text/csv') {
      setError('Escolha um arquivo CSV para continuar.');
      setFile(null);
      return;
    }
    setError(null);
    setSummary(null);
    setImportJobId(null);
    setFile(nextFile);
  };
  const onDrop = (event: DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragging(false);
    chooseFile(event.dataTransfer.files?.[0]);
  };
  const validate = async () => {
    if (!file) {
      setError('Selecione um CSV antes de validar.');
      return;
    }
    setError(null);
    try {
      setPhase('requesting');
      const upload = await requestUpload.mutateAsync({ campaignId, data: { nome_arquivo: file.name, tamanho: file.size } });
      setPhase('uploading');
      const uploadBody = new FormData();
      uploadBody.append('cacheControl', '3600');
      uploadBody.append('', file);
      const response = await fetch(upload.signed_url, { method: 'PUT', body: uploadBody });
      if (!response.ok) throw new Error(`O upload do arquivo foi recusado (${response.status}).`);
       setPhase('processing');
       const job = await validateImport.mutateAsync({ campaignId, data: { storage_path: upload.path, deduplicar_por_telefone: deduplicatePhone } });
       setImportJobId(job.id);
    } catch (uploadError) {
      setPhase('idle');
      setError(getErrorMessage(uploadError, 'Não foi possível concluir a validação do CSV.'));
    }
  };
  const isBusy = phase !== 'idle';
  const job = importJobQuery.data;
  const progress = job?.total_linhas
    ? Math.min(100, Math.round((job.linhas_processadas / job.total_linhas) * 100))
    : null;
  const phaseLabel = phase === 'requesting'
    ? 'Preparando upload...'
    : phase === 'uploading'
      ? 'Enviando arquivo...'
      : phase === 'processing'
        ? 'Processando destinatários...'
        : 'Validar CSV';

  return (
    <section className="panel p-5 sm:p-7" data-testid="panel-import">
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-start">
        <div><p className="section-kicker">Importação de destinatários</p><h2 className="mt-2 text-xl font-extrabold tracking-[-.05em] text-[#263044]">Traga a base. Nós mostramos o risco.</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[#747783]">O arquivo é enviado diretamente para o armazenamento assinado e só depois validado. Nada é enviado a clientes nesta fase.</p></div>
        <div className="flex shrink-0 items-center gap-2 rounded-full border border-[#cfe4c7] bg-[#f2f8ee] px-3 py-2 font-mono text-[9px] uppercase tracking-[.12em] text-[#417846]"><ShieldCheck size={13} /> Sem envio</div>
      </div>
      <div className={`drop-zone mt-6 p-6 text-center ${dragging ? 'is-dragging' : ''}`} data-testid="dropzone-import">
        <label htmlFor="campaign-csv" onDragOver={(event) => { event.preventDefault(); setDragging(true); }} onDragLeave={() => setDragging(false)} onDrop={onDrop} className="block cursor-pointer">
          <span className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-[#d7ef56] text-[#263044] shadow-[4px_4px_0_#e96527]"><UploadCloud size={25} /></span>
          <span className="mt-5 block text-sm font-extrabold text-[#263044]">{file ? file.name : 'Solte o CSV aqui ou escolha um arquivo'}</span>
          <span className="mt-2 block text-xs text-[#7d7e87]">{file ? `${(file.size / 1024).toFixed(1)} KB · pronto para validação` : 'Somente .csv · os bytes não passam pelo servidor da API'}</span>
          <input ref={inputRef} id="campaign-csv" type="file" accept=".csv,text/csv" className="sr-only" onChange={(event) => chooseFile(event.target.files?.[0])} data-testid="input-import-csv" />
        </label>
      </div>
      <div className="mt-5 flex flex-col justify-between gap-4 border-t border-[#eee7dc] pt-5 sm:flex-row sm:items-center">
        <label className="flex items-start gap-3 text-xs text-[#626876]"><input type="checkbox" checked={deduplicatePhone} onChange={(event) => setDeduplicatePhone(event.target.checked)} className="mt-0.5 accent-[#e96527]" data-testid="checkbox-deduplicate-phone" /><span><strong className="block text-[#263044]">Deduplicar por telefone</strong><span className="mt-1 block leading-5">Além do e-mail, considera o telefone na validação.</span></span></label>
        <button onClick={validate} disabled={!file || isBusy} className="action-button action-button-primary" data-testid="button-validate-import">{isBusy ? <><LoaderCircle size={16} className="animate-spin" /> {phaseLabel}</> : <><FileCheck2 size={16} /> {phaseLabel}</>}</button>
      </div>
      {phase === 'processing' && job && <div className="mt-5 rounded-xl border border-[#d9e3e0] bg-[#f1f7f5] p-4" data-testid="import-progress">
        <div className="flex items-center justify-between gap-3 text-xs font-bold text-[#247b79]">
          <span>{job.status === 'pendente' ? 'Aguardando processamento...' : 'Validação em andamento...'}</span>
          <span>{progress == null ? `${formatNumber(job.linhas_processadas)} linhas processadas` : `${progress}%`}</span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-[#dce9e5]">
          <div className="h-full rounded-full bg-[#247b79] transition-[width] duration-500" style={{ width: `${progress ?? 4}%` }} />
        </div>
        <p className="mt-2 text-[11px] text-[#6d7f7c]">{job.total_linhas == null ? 'Lendo o arquivo e contando linhas...' : `${formatNumber(job.linhas_processadas)} de ${formatNumber(job.total_linhas)} linhas`}</p>
      </div>}
      {error && <div className="mt-5 flex items-start gap-3 rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm leading-5 text-[#a64220]" data-testid="status-import-error"><CircleAlert size={17} className="mt-0.5 shrink-0" /><span>{error}</span><button onClick={() => setError(null)} className="ml-auto rounded p-1" aria-label="Fechar erro de importação" data-testid="button-dismiss-import-error"><X size={14} /></button></div>}
      {summary && <ImportSummary summary={summary} />}
    </section>
  );
}

export function NewCampaignPage({ user }: { user: SessionUser }) {
  const [, setLocation] = useLocation();
  const queryClient = useQueryClient();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  return (
    <Shell user={user} title="Nova campanha" eyebrow="Campanhas / Criar" mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}>
      <div className="mx-auto max-w-4xl animate-rise-in-delay">
        <div className="mb-7 flex items-center gap-3"><Link href="/" className="action-button action-button-secondary !px-3" data-testid="link-back-campaigns"><ArrowLeft size={15} /></Link><div><p className="text-sm font-bold text-[#263044]">Voltar para a lista</p><p className="mt-1 text-xs text-[#85858b]">Preencha os metadados essenciais antes da importação.</p></div></div>
         <CampaignForm onSaved={(campaign) => { queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() }); setLocation(`/campaigns/${campaign.id}`); }} />
      </div>
    </Shell>
  );
}

export function CampaignDetailPage({ user, campaignId }: { user: SessionUser; campaignId: string }) {
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const campaignQuery = useGetCampaign(campaignId, { query: { enabled: Boolean(campaignId), queryKey: getGetCampaignQueryKey(campaignId) } });
  const deleteCampaign = useDeleteCampaign();
  const campaign = campaignQuery.data;

  const deleteCurrent = () => {
    deleteCampaign.mutate({ campaignId }, {
      onSuccess: () => {
        queryClient.removeQueries({ queryKey: getGetCampaignQueryKey(campaignId) });
        queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() });
        setLocation('/');
      },
    });
  };

  if (campaignQuery.isLoading) {
    return <Shell user={user} title="Campanha" eyebrow="Campanhas / Abrir" mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}><div className="panel mx-auto max-w-4xl p-7" data-testid="status-campaign-detail-loading"><div className="skeleton h-5 w-48 rounded-full" /><div className="mt-7 grid gap-4 sm:grid-cols-2">{Array.from({ length: 8 }).map((_, index) => <div key={index} className="skeleton h-12 rounded-xl" />)}</div></div></Shell>;
  }
  if (campaignQuery.isError || !campaign) {
    return <Shell user={user} title="Campanha indisponível" eyebrow="Campanhas / Erro" mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}><div className="rounded-2xl border border-[#efc9ba] bg-[#fff0e9] px-6 py-14 text-center" data-testid="status-campaign-detail-error"><CircleAlert className="mx-auto text-[#bd4f26]" size={24} /><h2 className="mt-4 text-xl font-extrabold text-[#8e3a20]">Não conseguimos abrir esta campanha.</h2><p className="mt-2 text-sm text-[#a65d46]">O registro pode ter sido removido ou estar temporariamente indisponível.</p><div className="mt-5 flex justify-center gap-3"><button onClick={() => campaignQuery.refetch()} className="action-button action-button-primary" data-testid="button-campaign-detail-retry"><RefreshCw size={14} /> Tentar novamente</button><Link href="/" className="action-button action-button-secondary" data-testid="link-campaign-detail-back">Voltar</Link></div></div></Shell>;
  }
  return (
    <Shell user={user} title={campaign.nome} eyebrow="Campanhas / Operação" mobileNavOpen={mobileNavOpen} setMobileNavOpen={setMobileNavOpen}>
      <div className="animate-rise-in-delay mx-auto max-w-5xl space-y-5">
        <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
          <div className="flex items-center gap-3"><Link href="/" className="action-button action-button-secondary !px-3" data-testid="link-back-campaign-list"><ArrowLeft size={15} /></Link><div><p className="font-mono text-[9px] uppercase tracking-[.12em] text-[#92939a]">ID {campaign.id}</p><div className="mt-1 flex items-center gap-2"><StatusPill status={campaign.status} /><span className="text-xs text-[#777984]">{statusDescriptions[campaign.status]}</span></div></div></div>
          <div className="relative"><button onClick={() => setConfirmDelete((open) => !open)} className="action-button action-button-danger" data-testid="button-delete-campaign"><Trash2 size={15} /> Excluir campanha</button>{confirmDelete && <div className="absolute right-0 top-12 z-10 w-72 rounded-xl border border-[#efc9ba] bg-[#fffaf6] p-4 text-left shadow-[0_18px_45px_rgba(38,48,68,.14)]"><p className="text-sm font-extrabold text-[#263044]">Excluir esta campanha?</p><p className="mt-1 text-xs leading-5 text-[#7d6c6c]">Esta ação remove os metadados da campanha.</p><div className="mt-4 flex justify-end gap-2"><button onClick={() => setConfirmDelete(false)} className="action-button action-button-secondary !px-3" data-testid="button-cancel-delete">Cancelar</button><button onClick={deleteCurrent} disabled={deleteCampaign.isPending} className="action-button action-button-danger !px-3" data-testid="button-confirm-delete">{deleteCampaign.isPending ? <LoaderCircle size={14} className="animate-spin" /> : 'Excluir'}</button></div></div>}</div>
        </div>
        {deleteCampaign.isError && <div className="rounded-xl border border-[#efc9ba] bg-[#fff0e9] px-4 py-3 text-sm text-[#a64220]" data-testid="status-delete-error">Não foi possível excluir a campanha. Tente novamente.</div>}
         <CampaignForm campaign={campaign} onSaved={(updated) => { queryClient.setQueryData(getGetCampaignQueryKey(campaignId), updated); queryClient.invalidateQueries({ queryKey: getListCampaignsQueryKey() }); }} />
        <ImportPanel campaignId={campaignId} />
      </div>
    </Shell>
  );
}