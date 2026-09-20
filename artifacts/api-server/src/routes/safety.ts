import { Router, type IRouter } from "express";
import { getSupabaseUser } from "./auth";
import { getSafetyMode } from "../lib/safety-mode";

const router: IRouter = Router();

router.get("/safety-mode", async (req, res) => {
  const session = await getSupabaseUser(req, res);
  if (!session) {
    res.status(401).json({ error: "Sessão expirada. Entre novamente." });
    return;
  }
  res.json(getSafetyMode());
});

export default router;