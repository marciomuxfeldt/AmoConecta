import { Router, type IRouter } from "express";
import { ListCampaignsResponse } from "@workspace/api-zod";
import { getSupabaseUser } from "./auth";
import { supabaseAdminClient } from "../lib/supabase";

const router: IRouter = Router();

router.get("/campaigns", async (req, res) => {
  try {
    const session = await getSupabaseUser(req, res);
    if (!session) {
      res.status(401).json({ error: "Sessão expirada. Entre novamente." });
      return;
    }

    const { data: campaigns, error } = await supabaseAdminClient()
      .from("campanha")
      .select("id,nome,status,agendada_para,criado_em")
      .order("criado_em", { ascending: false });

    if (error) {
      req.log.error(
        {
          supabaseStatus: error.code,
          supabaseError: error,
        },
        "Supabase campaign listing failed",
      );
      res.status(502).json({ error: "Não foi possível carregar as campanhas." });
      return;
    }

    const response = ListCampaignsResponse.parse(
      (campaigns ?? []).map((campaign) => ({
        ...campaign,
        enviados: 0,
        entregues: 0,
        abertos: 0,
        clicados: 0,
      })),
    );
    res.json(response);
  } catch (error) {
    req.log.error({ err: error }, "Campaign listing failed");
    res.status(502).json({ error: "Não foi possível carregar as campanhas." });
  }
});

export default router;