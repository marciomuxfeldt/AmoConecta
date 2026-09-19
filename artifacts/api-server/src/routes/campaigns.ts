import { Router, type IRouter } from "express";
import { ListCampaignsResponse } from "@workspace/api-zod";
import { getSupabaseUser } from "./auth";
import { supabaseProxy } from "../lib/supabase";

const router: IRouter = Router();

router.get("/campaigns", async (req, res) => {
  const session = await getSupabaseUser(req, res);
  if (!session) {
    res.status(401).json({ error: "Sessão expirada. Entre novamente." });
    return;
  }

  const response = await supabaseProxy(
    "/rest/v1/campanha?select=id,nome,status,agendada_para,criado_em&order=criado_em.desc",
    { headers: { Authorization: `Bearer ${session.token}` } },
  );

  if (!response.ok) {
    res.status(502).json({ error: "Não foi possível carregar as campanhas." });
    return;
  }

  const campaigns = (await response.json()) as Array<{
    id: string;
    nome: string;
    status: "rascunho" | "agendada" | "enviando" | "pausada" | "concluida";
    agendada_para: string | null;
    criado_em: string;
  }>;

  const data = ListCampaignsResponse.parse(
    campaigns.map((campaign) => ({
      ...campaign,
      enviados: 0,
      entregues: 0,
      abertos: 0,
      clicados: 0,
    })),
  );
  res.json(data);
});

export default router;