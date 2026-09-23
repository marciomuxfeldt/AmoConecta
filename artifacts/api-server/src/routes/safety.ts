import { Router, type IRouter } from "express";
import { getSupabaseUser } from "./auth";
import { getSafetyMode } from "../lib/safety-mode";
import {
  configuredReplyToEmail,
  configuredSenderEmail,
  configuredSenderName,
  isVerifiedSenderEmail,
  VERIFIED_SENDER_DOMAIN,
} from "../lib/sender-config";

const router: IRouter = Router();

router.get("/safety-mode", async (req, res) => {
  const session = await getSupabaseUser(req, res);
  if (!session) {
    res.status(401).json({ error: "Sessão expirada. Entre novamente." });
    return;
  }
  res.json(getSafetyMode());
});

router.get("/campaign-defaults", async (req, res) => {
  const session = await getSupabaseUser(req, res);
  if (!session) {
    res.status(401).json({ error: "Sessão expirada. Entre novamente." });
    return;
  }
  const senderEmail = configuredSenderEmail();
  if (!senderEmail || !isVerifiedSenderEmail(senderEmail)) {
    res.status(503).json({
      error: `SENDER_EMAIL precisa ser configurado com um endereço do domínio @${VERIFIED_SENDER_DOMAIN}.`,
    });
    return;
  }
    res.json({
      remetente_email: senderEmail,
      remetente_nome: configuredSenderName(),
      reply_to: configuredReplyToEmail(),
      teto_hora: 100,
      teto_dia: 1000,
    });
});

export default router;