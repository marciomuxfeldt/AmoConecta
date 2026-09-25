import { memo, useEffect, useMemo, useRef, useState } from "react";
import {
  Bold,
  ExternalLink,
  GripVertical,
  ImagePlus,
  Italic,
  Link2,
  LoaderCircle,
  Minus,
  Monitor,
  MousePointer2,
  Plus,
  RefreshCw,
  Smartphone,
  Trash2,
  Type,
} from "lucide-react";
import {
  type EmailBlock,
  interpolateEmailText,
  interpolateName,
  normalizeEmailBlocks,
  renderEmailHtml,
  sanitizeRichTextHtml,
} from "@workspace/email-template";
import {
  RequestEmailImageUploadInputMimeType,
  useRequestCampaignAssetUploadUrl,
} from "@workspace/api-client-react";

type EmailEditorProps = {
  blocks: EmailBlock[];
  onChange: (blocks: EmailBlock[]) => void;
  campaignId?: string;
  subject: string;
  valorCredito?: number | null;
  validadeCredito?: string | null;
  disabled?: boolean;
  buttonHrefErrors?: ReadonlyMap<string, string>;
  onUploadingChange?: (blockId: string, uploading: boolean) => void;
  onSendTest?: () => void;
  testPending?: boolean;
  testError?: string | null;
  testSent?: boolean;
  testDisabledReason?: string | null;
};

const blockLabels: Record<EmailBlock["type"], string> = {
  text: "Texto",
  image: "Imagem",
  button: "Botão",
  divider: "Divisor",
};

const blockDescriptions: Record<EmailBlock["type"], string> = {
  text: "Mensagem com formatação",
  image: "Imagem hospedada no Storage",
  button: "Ação com destino",
  divider: "Separação visual",
};

function newId(type: EmailBlock["type"]) {
  return `${type}-${crypto.randomUUID()}`;
}

function newBlock(type: EmailBlock["type"]): EmailBlock {
  if (type === "text") return { id: newId(type), type, html: "<p>Olá, {{nome}}</p>" };
  if (type === "image") return { id: newId(type), type, src: "", alt: "", href: "" };
  if (type === "button") {
    return { id: newId(type), type, label: "Ver oferta", href: "" };
  }
  return { id: newId(type), type };
}

function updateBlock(
  blocks: EmailBlock[],
  id: string,
  updater: (block: EmailBlock) => EmailBlock,
) {
  return blocks.map((block) => (block.id === id ? updater(block) : block));
}

const MAX_ORIGINAL_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_EMAIL_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_WIDTH = 1200;

type ImageUploadState = {
  phase: "idle" | "processing" | "uploading" | "error";
  progress: number | null;
  previewUrl: string | null;
  processedBytes: number | null;
  warning: string | null;
  error: string | null;
};

const idleImageUploadState: ImageUploadState = {
  phase: "idle",
  progress: null,
  previewUrl: null,
  processedBytes: null,
  warning: null,
  error: null,
};

function formatBytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function canvasToBlob(canvas: HTMLCanvasElement, type: string, quality?: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error("O navegador não conseguiu preparar a imagem."));
      }
    }, type, quality);
  });
}

function loadImage(file: File) {
  return new Promise<HTMLImageElement>((resolve, reject) => {
    const sourceUrl = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => {
      URL.revokeObjectURL(sourceUrl);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(sourceUrl);
      reject(new Error("Não foi possível ler esta imagem."));
    };
    image.src = sourceUrl;
  });
}

async function compressImageForUpload(file: File) {
  const image = await loadImage(file);
  const sourceWidth = image.naturalWidth || image.width;
  const sourceHeight = image.naturalHeight || image.height;
  const width = Math.max(1, Math.min(sourceWidth, MAX_IMAGE_WIDTH));
  const height = Math.max(1, Math.round(sourceHeight * (width / sourceWidth)));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context) throw new Error("O navegador não conseguiu preparar a imagem.");
  context.drawImage(image, 0, 0, width, height);

  let hasTransparency = false;
  if (["image/png", "image/webp", "image/gif"].includes(file.type)) {
    const pixels = context.getImageData(0, 0, width, height).data;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] < 255) {
        hasTransparency = true;
        break;
      }
    }
  }

  const mimeType = hasTransparency ? "image/png" : "image/jpeg";
  const extension = hasTransparency ? "png" : "jpg";
  const blob = await canvasToBlob(canvas, mimeType, mimeType === "image/png" ? undefined : 0.8);
  if (blob.size > MAX_EMAIL_IMAGE_BYTES) {
    throw new Error("A imagem ainda ficou maior que 5 MB após a compressão.");
  }
  const baseName = file.name.replace(/\.[^/.]+$/u, "") || "imagem";
  return new File([blob], `${baseName}.${extension}`, { type: mimeType, lastModified: Date.now() });
}

function uploadSignedImage(
  signedUrl: string,
  body: FormData,
  onProgress: (progress: number) => void,
  xhrRef: { current: XMLHttpRequest | null },
) {
  return new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const rejectWithDiagnostics = (
      kind: "http" | "network" | "aborted",
      eventType: string | null = null,
    ) => {
      const diagnostic = {
        stage: "storage-put",
        kind,
        status: xhr.status,
        statusText: xhr.statusText || null,
        responseText: xhr.responseText || null,
        eventType,
      };
      const status = xhr.status > 0
        ? `HTTP ${xhr.status}${xhr.statusText ? ` ${xhr.statusText}` : ""}`
        : "sem resposta HTTP (status 0)";
      const response = xhr.responseText ? ` Resposta do Storage: ${xhr.responseText}` : "";
      const message = kind === "http"
        ? `O Storage recusou o upload (${status}).${response}`
        : kind === "aborted"
          ? `O navegador interrompeu o upload antes de receber resposta do Storage (${status}).`
          : `Não houve resposta HTTP do Storage (${status}); a falha pode ser de rede ou CORS.`;
      xhrRef.current = null;
      reject(Object.assign(new Error(message), { diagnostic }));
    };
    xhrRef.current = xhr;
    xhr.open("PUT", signedUrl);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.round((event.loaded / event.total) * 100));
      }
    };
    xhr.onload = () => {
      xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        rejectWithDiagnostics("http");
      }
    };
    xhr.onerror = () => {
      rejectWithDiagnostics("network", "error");
    };
    xhr.onabort = () => {
      rejectWithDiagnostics("aborted", "abort");
    };
    xhr.send(body);
  });
}

function imageUploadFailureMessage(
  error: unknown,
  uploadStage: "image-processing" | "requesting-upload-url" | "storage-put",
): string {
  const record = error && typeof error === "object"
    ? error as Record<string, unknown>
    : {};
  const diagnostic = record.diagnostic && typeof record.diagnostic === "object"
    ? record.diagnostic as Record<string, unknown>
    : null;
  if (diagnostic?.kind === "aborted") {
    return `${error instanceof Error ? error.message : "O upload foi interrompido."} Mantenha a tela aberta e tente novamente.`;
  }
  if (diagnostic?.kind === "network") {
    return `${error instanceof Error ? error.message : "Falha de rede ao enviar a imagem."} Verifique a conexão; se persistir, peça à equipe técnica para conferir a configuração CORS do Storage.`;
  }
  if (uploadStage === "requesting-upload-url" && record.name === "TypeError") {
    return "A solicitação para preparar o upload falhou sem resposta HTTP (possível falha de rede ou proxy). A imagem não foi enviada; verifique a conexão e tente novamente.";
  }
  const data = record.data && typeof record.data === "object"
    ? record.data as Record<string, unknown>
    : {};
  const technical = data.technical_error && typeof data.technical_error === "object"
    ? data.technical_error as Record<string, unknown>
    : null;
  const technicalDetails = technical
    ? [
        technical.name,
        technical.message,
        technical.code,
        technical.details,
        technical.hint,
        technical.cause,
      ].filter((value): value is string => typeof value === "string" && value.length > 0).join(" · ")
    : null;
  const status = typeof record.status === "number"
    ? ` (HTTP ${record.status}${typeof record.statusText === "string" && record.statusText ? ` ${record.statusText}` : ""})`
    : "";
  const message = typeof data.error === "string"
    ? data.error
    : error instanceof Error && error.message
      ? error.message
      : "Não foi possível enviar a imagem.";
  const details = technicalDetails ? ` Causa técnica: ${technicalDetails}.` : "";
  const requestId = typeof data.request_id === "string"
    ? ` Referência da requisição: ${data.request_id}.`
    : "";
  return `${message}${status}.${details}${requestId} A imagem não foi enviada. Tente novamente; se persistir, encaminhe estes detalhes à equipe técnica.`;
}

function insertLink() {
  const href = window.prompt("Destino do link", "https://");
  if (!href?.trim()) return;
  document.execCommand("createLink", false, href.trim());
}

function RichTextBlock({
  block,
  onChange,
  disabled = false,
}: {
  block: Extract<EmailBlock, { type: "text" }>;
  onChange: (html: string) => void;
  disabled?: boolean;
}) {
  const editorRef = useRef<HTMLDivElement>(null);
  const initialHtmlRef = useRef(sanitizeRichTextHtml(block.html));
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const initializedRef = useRef(false);
  const setEditorRef = (node: HTMLDivElement | null) => {
    editorRef.current = node;
    if (node && !initializedRef.current) {
      node.innerHTML = initialHtmlRef.current;
      initializedRef.current = true;
    }
  };
  const syncState = () => {
    if (!disabled && editorRef.current) {
      onChangeRef.current(sanitizeRichTextHtml(editorRef.current.innerHTML));
    }
  };
  const command = (name: string, value?: string) => {
    if (disabled) return;
    editorRef.current?.focus();
    document.execCommand(name, false, value);
    syncState();
  };

  return (
    <div className="overflow-hidden rounded-[1rem] border border-[#ded5c8] bg-[#fffdf9] shadow-[0_5px_16px_rgba(38,48,68,.035)]">
      <div className="flex flex-wrap items-center gap-1 border-b border-[#eee7dc] bg-[#f8f3ec] px-2.5 py-2">
        <span className="mr-1 px-1.5 font-mono text-[9px] uppercase tracking-[.14em] text-[#99959a]">Formatação</span>
        <button type="button" disabled={disabled} onMouseDown={(event) => { event.preventDefault(); command("bold"); }} className="focus-ring rounded-lg p-2 text-[#42495b] transition-colors hover:bg-[#ebe3d8] hover:text-[#263044] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Aplicar negrito" title="Negrito" data-testid={`button-bold-${block.id}`}><Bold size={14} /></button>
        <button type="button" disabled={disabled} onMouseDown={(event) => { event.preventDefault(); command("italic"); }} className="focus-ring rounded-lg p-2 text-[#42495b] transition-colors hover:bg-[#ebe3d8] hover:text-[#263044] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Aplicar itálico" title="Itálico" data-testid={`button-italic-${block.id}`}><Italic size={14} /></button>
        <button type="button" disabled={disabled} onMouseDown={(event) => { event.preventDefault(); insertLink(); if (editorRef.current) onChange(sanitizeRichTextHtml(editorRef.current.innerHTML)); }} className="focus-ring rounded-lg p-2 text-[#42495b] transition-colors hover:bg-[#ebe3d8] hover:text-[#263044] disabled:cursor-not-allowed disabled:opacity-40" aria-label="Adicionar link ao texto" title="Adicionar link" data-testid={`button-link-${block.id}`}><Link2 size={14} /></button>
        <span className="ml-auto font-mono text-[9px] uppercase tracking-[.1em] text-[#99959a]">Use {"{{nome}}"} na saudação</span>
      </div>
      <div
        ref={setEditorRef}
        contentEditable={!disabled}
        suppressContentEditableWarning
        onInput={syncState}
        onBlur={syncState}
        aria-label="Conteúdo do bloco de texto"
        className={`min-h-28 px-4 py-4 text-sm leading-6 text-[#42495b] outline-none empty:before:text-[#a7a7aa] empty:before:content-['Escreva_a_mensagem...'] focus:bg-[#fffefa] ${disabled ? "bg-[#f8f3ec] opacity-75" : ""}`}
        data-testid={`editor-text-${block.id}`}
      />
    </div>
  );
}

const MemoizedRichTextBlock = memo(
  RichTextBlock,
  (previous, next) =>
    previous.block.id === next.block.id &&
    previous.onChange === next.onChange &&
    previous.disabled === next.disabled,
);

function BlockCard({
  block,
  index,
  blocks,
  onChange,
  onRemove,
  onDragStart,
  onDrop,
  onDragEnd,
  dragging,
  campaignId,
  resetKey,
  onUploadingChange,
  disabled = false,
  buttonHrefError,
}: {
  block: EmailBlock;
  index: number;
  blocks: EmailBlock[];
  onChange: (blocks: EmailBlock[]) => void;
  onRemove: () => void;
  onDragStart: () => void;
  onDrop: () => void;
  onDragEnd: () => void;
  dragging: boolean;
  campaignId?: string;
  resetKey: string;
  onUploadingChange?: (blockId: string, uploading: boolean) => void;
  disabled?: boolean;
  buttonHrefError?: string;
}) {
  const upload = useRequestCampaignAssetUploadUrl();
  const [imageUpload, setImageUpload] = useState<ImageUploadState>(idleImageUploadState);
  const retryFileRef = useRef<File | null>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);
  const blocksRef = useRef(blocks);
  const onChangeRef = useRef(onChange);
  blocksRef.current = blocks;
  onChangeRef.current = onChange;

  useEffect(() => {
    return () => {
      xhrRef.current?.abort();
      onUploadingChange?.(block.id, false);
    };
  }, []);

  useEffect(() => {
    return () => {
      if (imageUpload.previewUrl) URL.revokeObjectURL(imageUpload.previewUrl);
    };
  }, [imageUpload.previewUrl]);

  const update = (next: EmailBlock) => {
    if (!disabled) onChange(updateBlock(blocks, block.id, () => next));
  };
  const updateText = useMemo(
    () => (html: string) => {
      const currentBlock = blocksRef.current.find((candidate) => candidate.id === block.id);
      if (currentBlock?.type !== "text") return;
      onChangeRef.current(updateBlock(blocksRef.current, block.id, (candidate) => (
        candidate.type === "text" ? { ...candidate, html } : candidate
      )));
    },
    [block.id],
  );
  const uploadImage = async (selectedFile?: File) => {
    const file = selectedFile ?? retryFileRef.current;
    if (disabled || !file || block.type !== "image") return;
    if (!campaignId) {
      setImageUpload({ ...idleImageUploadState, phase: "error", error: "O rascunho ainda não está pronto para receber imagens. Aguarde e tente novamente." });
      return;
    }
    const allowed = Object.values(RequestEmailImageUploadInputMimeType) as string[];
    if (!allowed.includes(file.type)) {
      setImageUpload({ ...idleImageUploadState, phase: "error", error: "Use uma imagem JPG, PNG, GIF ou WEBP." });
      return;
    }
    const previewUrl = URL.createObjectURL(file);
    retryFileRef.current = file;
    const warning = file.size > MAX_ORIGINAL_IMAGE_BYTES
      ? "O arquivo original passa de 10 MB; vamos reduzi-lo antes do envio."
      : null;
    setImageUpload({ phase: "processing", progress: null, previewUrl, processedBytes: null, warning, error: null });
    onUploadingChange?.(block.id, true);
    let uploadStage: "image-processing" | "requesting-upload-url" | "storage-put" = "image-processing";
    try {
      const compressedFile = await compressImageForUpload(file);
      setImageUpload((current) => ({ ...current, phase: "uploading", progress: 0, processedBytes: compressedFile.size }));
      uploadStage = "requesting-upload-url";
      const signed = await upload.mutateAsync({
        campaignId,
        data: {
          nome_arquivo: compressedFile.name,
          tamanho: compressedFile.size,
          mime_type: compressedFile.type as RequestEmailImageUploadInputMimeType,
        },
      });
      uploadStage = "storage-put";
      const body = new FormData();
      body.append("cacheControl", "31536000");
      body.append("", compressedFile);
      await uploadSignedImage(
        signed.signed_url,
        body,
        (progress) => setImageUpload((current) => ({ ...current, progress })),
        xhrRef,
      );
      const currentBlock = blocksRef.current.find((candidate) => candidate.id === block.id);
      if (currentBlock?.type === "image") {
        onChangeRef.current(updateBlock(blocksRef.current, block.id, (candidate) => (
          candidate.type === "image"
              ? { ...candidate, src: signed.public_url }
            : candidate
        )));
      }
        setImageUpload({ ...idleImageUploadState, processedBytes: compressedFile.size });
    } catch (error) {
      const record = error && typeof error === "object"
        ? error as Record<string, unknown>
        : {};
      const diagnostic = record.diagnostic && typeof record.diagnostic === "object"
        ? record.diagnostic as Record<string, unknown>
        : null;
      const data = record.data && typeof record.data === "object"
        ? record.data as Record<string, unknown>
        : null;
      console.error("Campaign image upload failed", {
        stage: uploadStage,
        campaignId,
        fileName: file.name,
        fileSize: file.size,
        contentType: file.type,
        status: typeof record.status === "number" ? record.status : diagnostic?.status,
        statusText: typeof record.statusText === "string" ? record.statusText : diagnostic?.statusText,
        response: data ?? diagnostic ?? null,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
      setImageUpload((current) => ({
        ...current,
        phase: "error",
        progress: null,
        error: imageUploadFailureMessage(error, uploadStage),
      }));
    } finally {
      onUploadingChange?.(block.id, false);
    }
  };

  return (
    <div
      draggable={!disabled}
      onDragStart={disabled ? undefined : onDragStart}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => { event.preventDefault(); if (!disabled) onDrop(); }}
      onDragEnd={disabled ? undefined : onDragEnd}
      aria-label={`Bloco ${index + 1}: ${blockLabels[block.type]}`}
      className={`group rounded-[1.1rem] border bg-[#fbf9f5] p-3.5 transition-[border-color,box-shadow,transform] duration-200 ${buttonHrefError ? "border-[#bd4f26] bg-[#fff7f2] shadow-[0_0_0_3px_rgba(189,79,38,.10)]" : dragging ? "border-[#e96527] shadow-[0_0_0_3px_rgba(233,101,39,.14),0_12px_24px_rgba(38,48,68,.08)]" : "border-[#e5ddd0] hover:-translate-y-px hover:border-[#d4c7b7] hover:shadow-[0_8px_20px_rgba(38,48,68,.045)]"}`}
      data-testid={`email-block-${block.type}-${index}`}
    >
      <div className="mb-3.5 flex items-center gap-2">
        <button type="button" disabled={disabled} className="focus-ring cursor-grab rounded-lg p-1.5 text-[#92939a] transition-colors hover:bg-[#eee7dc] hover:text-[#263044] active:cursor-grabbing disabled:cursor-not-allowed disabled:opacity-40" aria-label={`Arrastar bloco ${index + 1}, ${blockLabels[block.type]}`} aria-grabbed={dragging} title="Arrastar para reordenar" data-testid={`button-drag-${block.id}`}><GripVertical size={16} /></button>
        <div className="flex h-8 w-8 items-center justify-center rounded-[.65rem] bg-[#d7ef56] text-[#263044] shadow-[2px_2px_0_rgba(233,101,39,.35)]">
          {block.type === "text" ? <Type size={14} /> : block.type === "image" ? <ImagePlus size={14} /> : block.type === "button" ? <MousePointer2 size={14} /> : <Minus size={14} />}
        </div>
         <div className="min-w-0"><div className="flex items-center gap-2"><p className="text-xs font-extrabold text-[#263044]">{blockLabels[block.type]}</p><span className="font-mono text-[9px] text-[#b0a9a1]">{String(index + 1).padStart(2, "0")}</span>{buttonHrefError && <span className="rounded-full border border-[#eac0ad] bg-[#fff0e8] px-2 py-0.5 font-mono text-[8px] font-bold uppercase tracking-[.08em] text-[#a64220]">Destino inválido</span>}</div><p className="mt-0.5 text-[10px] text-[#92939a]">{blockDescriptions[block.type]}</p></div>
        <button type="button" disabled={disabled} onClick={onRemove} className="focus-ring ml-auto rounded-lg p-2 text-[#a64220] opacity-75 transition-colors hover:bg-[#fff0e9] hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-30" aria-label={`Remover bloco ${index + 1}, ${blockLabels[block.type]}`} title="Remover bloco" data-testid={`button-remove-${block.id}`}><Trash2 size={14} /></button>
      </div>

      {block.type === "text" && <MemoizedRichTextBlock key={`${block.id}:${resetKey}`} block={block} onChange={updateText} disabled={disabled} />}

      {block.type === "image" && (
        <div className="space-y-3">
          {imageUpload.phase !== "idle" && imageUpload.previewUrl ? (
            <div className="relative overflow-hidden rounded-xl border border-[#d4e5df] bg-[#f1f7f5]">
              <img src={imageUpload.previewUrl} alt={block.alt || "Imagem sendo enviada"} className="max-h-56 w-full object-contain opacity-80" />
              <div className="absolute inset-x-0 bottom-0 bg-[#263044]/90 px-3 py-2.5 text-[#fbf9f5]">
                <div className="flex items-center gap-2 text-xs font-bold"><LoaderCircle size={14} className="animate-spin text-[#d7ef56]" /> {imageUpload.phase === "error" ? "Falha no envio" : "Enviando imagem…"}</div>
                {imageUpload.phase === "processing" && <p className="mt-1 pl-5 text-[10px] text-[#d3d8dd]">Reduzindo para até 1200 px…</p>}
                {imageUpload.phase === "uploading" && <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/20" role="progressbar" aria-label="Progresso do upload da imagem" aria-valuemin={0} aria-valuemax={100} aria-valuenow={imageUpload.progress ?? 0}><div className="h-full rounded-full bg-[#d7ef56] transition-[width] duration-150" style={{ width: `${imageUpload.progress ?? 0}%` }} /></div>}
              </div>
            </div>
          ) : block.src ? <div className="relative overflow-hidden rounded-xl border border-[#e5ddd0] bg-white"><img src={block.src} alt={block.alt} className="max-h-56 w-full object-contain" /><div className="absolute bottom-2 left-2 flex items-center gap-2 rounded-full bg-[#263044]/85 px-2.5 py-1 font-mono text-[9px] uppercase tracking-[.08em] text-[#fbf9f5]"><span>Imagem pronta</span>{imageUpload.processedBytes != null && <span>· {formatBytes(imageUpload.processedBytes)}</span>}</div></div> : <div className="rounded-xl border border-dashed border-[#d8cdbd] bg-[#f8f3ec] px-4 py-9 text-center"><ImagePlus size={20} className="mx-auto mb-2 text-[#c3b6a7]" /><p className="text-xs font-bold text-[#6d7180]">Nenhuma imagem adicionada</p><p className="mt-1 text-[10px] text-[#99959a]">JPG, PNG, GIF ou WEBP</p></div>}
          {imageUpload.warning && <p className="rounded-lg border border-[#f1dfb8] bg-[#fff9e9] px-3 py-2 text-xs text-[#8b671c]" role="status">{imageUpload.warning}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
             <label className="action-button action-button-secondary focus-within:ring-2 focus-within:ring-[#d7ef56] focus-within:ring-offset-2 cursor-pointer text-center"><ImagePlus size={14} /> {imageUpload.phase === "error" ? "Escolher outra imagem" : "Escolher imagem"}<input type="file" accept="image/jpeg,image/png,image/gif,image/webp" className="sr-only" disabled={disabled || imageUpload.phase === "processing" || imageUpload.phase === "uploading" || upload.isPending} onChange={(event) => { void uploadImage(event.target.files?.[0]); event.currentTarget.value = ""; }} data-testid={`input-image-upload-${block.id}`} /></label>
             {imageUpload.phase === "error" ? <button type="button" disabled={disabled} onClick={() => { void uploadImage(); }} className="action-button action-button-secondary !border-[#efc9ba] !text-[#a64220] disabled:cursor-not-allowed disabled:opacity-40" data-testid={`button-retry-image-upload-${block.id}`}><RefreshCw size={14} /> Tentar novamente</button> : <div />}
             <div><label htmlFor={`image-alt-${block.id}`} className="field-label">Texto alternativo</label><input id={`image-alt-${block.id}`} disabled={disabled} value={block.alt} onChange={(event) => update({ ...block, alt: event.target.value.slice(0, 160) })} className="field-control disabled:cursor-not-allowed disabled:bg-[#f3eee7]" placeholder="Descreva a imagem" aria-label="Texto alternativo da imagem" data-testid={`input-image-alt-${block.id}`} /><p className="mt-1.5 text-[10px] leading-4 text-[#8d8780]">Sem texto alternativo, a imagem aparece como espaço vazio para quem bloqueia imagens.</p></div>
          </div>
        <div><label htmlFor={`image-href-${block.id}`} className="field-label">Link da imagem <span className="font-normal text-[#99959a]">· opcional</span></label><input id={`image-href-${block.id}`} disabled={disabled} value={block.href ?? ""} onChange={(event) => update({ ...block, href: event.target.value })} className="field-control disabled:cursor-not-allowed disabled:bg-[#f3eee7]" placeholder="https://..." aria-label="Link opcional da imagem" data-testid={`input-image-link-${block.id}`} /></div>
           {imageUpload.phase === "error" && imageUpload.error && <p className="rounded-lg border border-[#efc9ba] bg-[#fff0e9] px-3 py-2 text-xs text-[#a64220]" role="alert">{imageUpload.error}</p>}
        </div>
      )}

      {block.type === "button" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div><label htmlFor={`button-label-${block.id}`} className="field-label">Texto do botão</label><input id={`button-label-${block.id}`} disabled={disabled} value={block.label} onChange={(event) => update({ ...block, label: event.target.value.slice(0, 120) })} className="field-control disabled:cursor-not-allowed disabled:bg-[#f3eee7]" placeholder="Ex.: Ver oferta" aria-label="Rótulo do botão" data-testid={`input-button-label-${block.id}`} /></div>
          <div><label htmlFor={`button-href-${block.id}`} className="field-label">Destino do clique</label><input id={`button-href-${block.id}`} disabled={disabled} value={block.href} onChange={(event) => update({ ...block, href: event.target.value })} className={`field-control disabled:cursor-not-allowed disabled:bg-[#f3eee7] ${buttonHrefError ? "!border-[#bd4f26] !bg-[#fff7f2]" : ""}`} placeholder="https://..." aria-label="Destino do botão" aria-invalid={Boolean(buttonHrefError)} aria-describedby={buttonHrefError ? `button-href-error-${block.id}` : undefined} data-testid={`input-button-link-${block.id}`} />{buttonHrefError && <p id={`button-href-error-${block.id}`} className="mt-1.5 text-[11px] font-semibold leading-4 text-[#a64220]" role="alert" data-testid={`error-button-link-${block.id}`}>{buttonHrefError}</p>}</div>
        </div>
      )}

      {block.type === "divider" && <div className="rounded-xl border border-[#eee7dc] bg-[#f8f3ec] px-4 py-4"><div className="flex items-center gap-3"><div className="h-px flex-1 bg-[#dcd3c5]" /><Minus size={14} className="text-[#b5a99c]" /><div className="h-px flex-1 bg-[#dcd3c5]" /></div><p className="mt-2 text-center font-mono text-[9px] uppercase tracking-[.12em] text-[#99959a]">Separador no e-mail</p></div>}
    </div>
  );
}

export function EmailEditor({
  blocks,
  onChange,
  buttonHrefErrors,
  campaignId,
  subject,
  valorCredito,
  validadeCredito,
  onUploadingChange,
  onSendTest,
  testPending = false,
  testError = null,
  testSent = false,
  testDisabledReason = null,
  disabled = false,
}: EmailEditorProps) {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [previewMode, setPreviewMode] = useState<"desktop" | "mobile">("desktop");
  const [previewName, setPreviewName] = useState("Marina");
  const normalizedBlocks = useMemo(() => normalizeEmailBlocks(blocks), [blocks]);
  const previewHtml = useMemo(
    () => renderEmailHtml(normalizedBlocks, {
      name: previewName || null,
      valorCredito,
      validadeCredito,
    }),
    [normalizedBlocks, previewName, valorCredito, validadeCredito],
  );
  const missingVariables = useMemo(() => {
    const source = `${subject}\n${normalizedBlocks.map((block) => (
      block.type === "text" ? block.html : block.type === "button" ? block.label : block.type === "image" ? block.alt : ""
    )).join("\n")}`;
    return [
      source.match(/\{\{\s*valor_credito\s*\}\}/iu) && valorCredito == null ? "valor do crédito" : null,
      source.match(/\{\{\s*validade_credito\s*\}\}/iu) && !validadeCredito ? "validade do crédito" : null,
    ].filter((value): value is string => Boolean(value));
  }, [normalizedBlocks, subject, valorCredito, validadeCredito]);
  const editorSessionKey = campaignId ?? "new-campaign";

  const addBlock = (type: EmailBlock["type"]) => {
    if (!disabled) onChange([...blocks, newBlock(type)]);
  };
  const removeBlock = (id: string) => {
    if (!disabled) onChange(blocks.filter((block) => block.id !== id));
  };
  const reorder = (targetId: string) => {
    if (!draggingId || draggingId === targetId) return;
    const from = blocks.findIndex((block) => block.id === draggingId);
    const to = blocks.findIndex((block) => block.id === targetId);
    if (from < 0 || to < 0) return;
    const next = [...blocks];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    onChange(next);
  };

  return (
    <section className="panel overflow-hidden" data-testid="panel-email-editor">
      <div className="border-b border-[#eee7dc] bg-[#fbf9f5] p-5 sm:p-7">
        <div className="flex flex-col justify-between gap-5 lg:flex-row lg:items-start">
          <div><div className="flex items-center gap-3"><p className="section-kicker">04 · Corpo do e-mail</p><span className="rounded-full bg-[#f1f7f5] px-2.5 py-1 font-mono text-[9px] uppercase tracking-[.1em] text-[#247b79]">Editor ativo</span></div><h2 className="mt-2 text-xl font-extrabold tracking-[-.05em] text-[#263044] sm:text-2xl">Monte a mensagem bloco a bloco.</h2><p className="mt-2 max-w-2xl text-sm leading-6 text-[#747783]">A ordem é sua. Veja a leitura final ao lado enquanto prepara uma mensagem pronta para chegar bem.</p></div>
          <button type="button" onClick={onSendTest} disabled={!campaignId || !onSendTest || testPending || Boolean(testDisabledReason)} title={testDisabledReason ?? (!campaignId ? "Salve a campanha antes de enviar um teste" : undefined)} className="action-button action-button-secondary disabled:cursor-not-allowed disabled:opacity-50" aria-describedby="test-send-note" data-testid="button-send-test">{testPending ? <LoaderCircle size={14} className="animate-spin" /> : <ExternalLink size={14} />} {testPending ? "Enviando…" : "Enviar teste"}</button>
        </div>
        <p id="test-send-note" className={`mt-2 text-right font-mono text-[9px] uppercase tracking-[.08em] lg:pr-1 ${testError ? "text-[#a64220]" : testSent ? "text-[#247b79]" : "text-[#aaa3a1]"}`}>{testError ?? (testSent ? "Teste enviado para o e-mail da sua sessão." : testDisabledReason ?? (campaignId ? "O teste respeita supressão e a lista de segurança." : "Salve a campanha antes de enviar um teste."))}</p>
      </div>
      <div className="grid gap-7 p-5 sm:p-7 xl:grid-cols-[minmax(0,.9fr)_minmax(360px,1.1fr)]">
        <div>
          <div className="mb-4 flex items-end justify-between gap-3"><div><p className="font-mono text-[10px] uppercase tracking-[.13em] text-[#d35f2a]">Composição</p><p className="mt-1 text-sm font-extrabold text-[#263044]">Blocos editáveis</p><p className="mt-1 text-[11px] text-[#92939a]">{blocks.length} {blocks.length === 1 ? "bloco" : "blocos"} · arraste para reordenar</p></div><span className="rounded-full bg-[#f1f7f5] px-3 py-1.5 font-mono text-[9px] uppercase tracking-[.1em] text-[#247b79]">Sem limite</span></div>
          <div className="space-y-3">
              {blocks.map((block, index) => <BlockCard key={block.id} block={block} index={index} blocks={blocks} onChange={onChange} onRemove={() => removeBlock(block.id)} onDragStart={() => setDraggingId(block.id)} onDrop={() => { reorder(block.id); setDraggingId(null); }} onDragEnd={() => setDraggingId(null)} dragging={draggingId === block.id} campaignId={campaignId} resetKey={editorSessionKey} onUploadingChange={onUploadingChange} disabled={disabled} buttonHrefError={block.type === "button" ? buttonHrefErrors?.get(block.id) : undefined} />)}
            {blocks.length === 0 && <div className="rounded-2xl border border-dashed border-[#d8cdbd] bg-[#f8f3ec] px-5 py-12 text-center"><div className="mx-auto flex h-10 w-10 items-center justify-center rounded-xl bg-[#d7ef56] text-[#263044]"><Plus size={18} /></div><p className="mt-4 text-sm font-bold text-[#42495b]">Comece pelo primeiro bloco</p><p className="mt-1 text-xs leading-5 text-[#85858b]">A prévia já mostra o rodapé fixo enquanto você cria.</p></div>}
          </div>
          <div className="mt-5 rounded-2xl border border-[#eee7dc] bg-[#f8f3ec] p-3"><p className="mb-2 px-1 font-mono text-[9px] uppercase tracking-[.12em] text-[#99959a]">Adicionar ao e-mail</p><div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
             {(["text", "image", "button", "divider"] as const).map((type) => <button key={type} type="button" disabled={disabled} onClick={() => addBlock(type)} className="action-button action-button-secondary !min-h-10 !px-2 text-[11px] shadow-[0_2px_0_rgba(38,48,68,.04)] disabled:cursor-not-allowed disabled:opacity-40" data-testid={`button-add-${type}`}><Plus size={13} className="text-[#e96527]" /> {blockLabels[type]}</button>)}
          </div></div>
        </div>
        <div className="min-w-0">
           <div className="mb-4 flex flex-wrap items-start justify-between gap-3"><div><div className="flex items-center gap-2"><p className="font-mono text-[10px] uppercase tracking-[.13em] text-[#d35f2a]">Verificação</p><span className="h-1.5 w-1.5 rounded-full bg-[#63a76f]" /><span className="font-mono text-[9px] uppercase tracking-[.1em] text-[#63a76f]">Ao vivo</span></div><p className="mt-1 text-sm font-extrabold text-[#263044]">Pré-visualização</p><p className="mt-1 max-w-md text-[11px] leading-5 text-[#92939a]">Assunto: {interpolateEmailText(interpolateName(subject || "Sem assunto", previewName || null), { valorCredito, validadeCredito })}</p></div><div className="flex rounded-xl border border-[#e5ddd0] bg-[#f8f3ec] p-1" role="group" aria-label="Tamanho da prévia"><button type="button" onClick={() => setPreviewMode("desktop")} className={`focus-ring rounded-lg p-2.5 transition-colors ${previewMode === "desktop" ? "bg-white text-[#247b79] shadow-sm" : "text-[#92939a] hover:text-[#42495b]"}`} aria-label="Mostrar prévia desktop" aria-pressed={previewMode === "desktop"} title="Desktop" data-testid="button-preview-desktop"><Monitor size={14} /></button><button type="button" onClick={() => setPreviewMode("mobile")} className={`focus-ring rounded-lg p-2.5 transition-colors ${previewMode === "mobile" ? "bg-white text-[#247b79] shadow-sm" : "text-[#92939a] hover:text-[#42495b]"}`} aria-label="Mostrar prévia celular" aria-pressed={previewMode === "mobile"} title="Celular" data-testid="button-preview-mobile"><Smartphone size={14} /></button></div></div>
          <div className="mb-4 flex flex-wrap items-center gap-2 rounded-xl border border-[#eee7dc] bg-[#f8f3ec] p-2.5"><label className="px-1 text-[10px] font-bold uppercase tracking-[.08em] text-[#85858b]" htmlFor="email-preview-name">Nome do destinatário</label><input id="email-preview-name" value={previewName} onChange={(event) => setPreviewName(event.target.value)} className="field-control !w-40 !py-2 text-xs shrink-0" placeholder="Vazio = sem nome" data-testid="input-preview-name" /><button type="button" onClick={() => setPreviewName("")} className="focus-ring rounded-lg px-2 py-1 text-[10px] font-bold text-[#247b79] transition-colors hover:bg-[#e5f0ed]" data-testid="button-preview-no-name">Sem nome</button></div>
          <div className="flex min-h-[500px] justify-center overflow-auto rounded-2xl border border-[#dcd3c5] bg-[#e9e1d6] p-3 shadow-inner sm:p-5">
            <iframe title={`Prévia do e-mail em modo ${previewMode === "desktop" ? "desktop" : "celular"}`} srcDoc={previewHtml} className="h-[620px] shrink-0 border-0 bg-white shadow-[0_12px_30px_rgba(38,48,68,.12)] transition-[width] duration-200" style={{ width: previewMode === "desktop" ? 600 : 360, maxWidth: "100%" }} data-testid={`email-preview-${previewMode}`} />
          </div>
           <p className="mt-3 flex items-start gap-2 text-[10px] leading-5 text-[#92939a]"><span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full bg-[#d7ef56]" /> <span>Variáveis disponíveis: <code>{'{{nome}}'}</code>, <code>{'{{valor_credito}}'}</code> e <code>{'{{validade_credito}}'}</code>. O rodapé é automático.</span></p>
           {missingVariables.length > 0 && <p className="mt-2 rounded-xl border border-[#e8c56f] bg-[#fff7dc] px-3 py-2 text-[10px] leading-5 text-[#74561c]" role="status" data-testid="warning-missing-email-variables">Preencha {missingVariables.join(' e ')} antes de enviar para que as variáveis apareçam corretamente.</p>}
        </div>
      </div>
    </section>
  );
}