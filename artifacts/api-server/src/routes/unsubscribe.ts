import { Router, type IRouter, type Request, type Response } from "express";
import { addSuppression, verifyUnsubscribeToken } from "../lib/worker";
import { getTechnicalError } from "../lib/technical-error";

const router: IRouter = Router();

function page(title: string, body: string): string {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>body{margin:0;background:#f4f0e9;color:#263044;font:16px Arial,sans-serif}main{box-sizing:border-box;max-width:560px;margin:12vh auto;padding:32px;background:#fffdf9;border:1px solid #e5ddd0;border-radius:16px;text-align:center}h1{font-size:24px}p{line-height:1.6;color:#626775}button{border:0;border-radius:8px;background:#e96527;color:#fff;padding:12px 20px;font-weight:bold;cursor:pointer}</style></head><body><main><h1>${title}</h1>${body}</main></body></html>`;
}

async function getUnsubscribe(req: Request, res: Response): Promise<void> {
  const token = typeof req.query.t === "string" ? req.query.t : "";
  const campaignId = typeof req.query.c === "string" ? req.query.c : null;
  const email = verifyUnsubscribeToken(token);
  if (!email) {
    res.status(400).type("html").send(
      page("Linko inválido", "<p>Este link de descadastro expirou ou não é válido.</p>"),
    );
    return;
  }

  if (req.query.confirm !== "1") {
    const action = `/api/unsubscribe?t=${encodeURIComponent(token)}${campaignId ? `&c=${encodeURIComponent(campaignId)}` : ""}&confirm=1`;
    res.type("html").send(
      page(
        "Confirmar descadastro",
        `<p>Deseja parar de receber comunicações da AmoConecta?</p><form method="post" action="${action}"><button type="submit">Confirmar descadastro</button></form>`,
      ),
    );
    return;
  }

  try {
    await addSuppression(email, campaignId);
    res.type("html").send(
      page("Descadastro confirmado", "<p>Você não receberá novos envios da AmoConecta.</p>"),
    );
  } catch (error) {
    req.log.error({ technicalError: getTechnicalError(error) }, "Public unsubscribe failed");
    res.status(502).type("html").send(
      page("Não foi possível concluir", "<p>Tente novamente em alguns instantes.</p>"),
    );
  }
}

async function postUnsubscribe(req: Request, res: Response): Promise<void> {
  const token = typeof req.query.t === "string" ? req.query.t : "";
  const campaignId = typeof req.query.c === "string" ? req.query.c : null;
  const email = verifyUnsubscribeToken(token);
  if (!email) {
    res.status(400).json({ error: "Link de descadastro inválido." });
    return;
  }
  try {
    await addSuppression(email, campaignId);
    res.status(204).send();
  } catch (error) {
    req.log.error({ technicalError: getTechnicalError(error) }, "One-click unsubscribe failed");
    res.status(502).json({ error: "Não foi possível concluir o descadastro." });
  }
}

router.get(["/unsubscribe", "/descadastro"], getUnsubscribe);
router.post(["/unsubscribe", "/descadastro"], postUnsubscribe);

export default router;