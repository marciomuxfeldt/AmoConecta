import { supabaseAdminClient } from "./supabase";

export type EmailBrandingSettings = {
  cor_botao_email: string;
  atualizado_em: string;
};

export async function getEmailBrandingSettings(): Promise<EmailBrandingSettings> {
  const { data, error } = await supabaseAdminClient()
    .from("configuracao_email_global")
    .select("cor_botao,atualizado_em")
    .eq("id", 1)
    .single();
  if (error) throw error;
  if (!data || typeof data.cor_botao !== "string" || typeof data.atualizado_em !== "string") {
    throw new Error("A configuração global da cor do e-mail está incompleta.");
  }
  return {
    cor_botao_email: data.cor_botao,
    atualizado_em: data.atualizado_em,
  };
}

export async function updateEmailBrandingSettings(
  color: string,
): Promise<EmailBrandingSettings> {
  const { data, error } = await supabaseAdminClient()
    .from("configuracao_email_global")
    .upsert(
      {
        id: 1,
        cor_botao: color,
        atualizado_em: new Date().toISOString(),
      },
      { onConflict: "id" },
    )
    .select("cor_botao,atualizado_em")
    .single();
  if (error) throw error;
  if (!data || typeof data.cor_botao !== "string" || typeof data.atualizado_em !== "string") {
    throw new Error("Não foi possível confirmar a identidade visual atualizada.");
  }
  return {
    cor_botao_email: data.cor_botao,
    atualizado_em: data.atualizado_em,
  };
}

export async function countChronicDisengagedContacts(): Promise<number> {
  const { data, error } = await supabaseAdminClient().rpc(
    "count_chronic_disengagement",
  );
  if (error) throw error;
  const count = typeof data === "number" ? data : Number(data);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("A contagem de contatos desengajados retornou um valor inválido.");
  }
  return count;
}

export function getEmailColorSnapshot(
  settings: EmailBrandingSettings,
): string {
  return settings.cor_botao_email;
}