import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetAuthSessionResponse,
  LoginBody,
  LoginResponse,
} from "@workspace/api-zod";
import { supabaseProxy } from "../lib/supabase";

const router: IRouter = Router();
const SESSION_COOKIE = "amoconecta_session";
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 7;

type SupabaseUser = {
  id: string;
  email?: string | null;
};

function sessionToken(req: Request): string | undefined {
  const token = req.cookies?.[SESSION_COOKIE];
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

function clearSession(res: Response): void {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}

function setSession(res: Response, token: string): void {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: SESSION_MAX_AGE,
  });
}

export async function getSupabaseUser(
  req: Request,
  res: Response,
): Promise<{ token: string; user: SupabaseUser } | null> {
  const token = sessionToken(req);
  if (!token) return null;

  const response = await supabaseProxy("/auth/v1/user", {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!response.ok) {
    clearSession(res);
    return null;
  }

  const user = (await response.json()) as SupabaseUser;
  if (!user.id) {
    clearSession(res);
    return null;
  }

  return { token, user };
}

router.get("/auth/session", async (req, res) => {
  const session = await getSupabaseUser(req, res);
  const data = GetAuthSessionResponse.parse({
    authenticated: Boolean(session),
    user: session
      ? { id: session.user.id, email: session.user.email ?? "" }
      : null,
  });
  res.json(data);
});

router.post("/auth/login", async (req, res) => {
  const credentials = LoginBody.parse(req.body);
  const response = await supabaseProxy("/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials),
  });

  if (!response.ok) {
    const originalError = await response.text();
    let supabaseError: unknown = originalError;
    try {
      supabaseError = JSON.parse(originalError);
    } catch {
      // Preserve the exact text when Supabase does not return JSON.
    }
    req.log.error(
      {
        supabaseStatus: response.status,
        supabaseError,
      },
      "Supabase Auth login failed",
    );
    res.status(401).json({ error: "E-mail ou senha inválidos." });
    return;
  }

  const payload = (await response.json()) as {
    access_token?: string;
    user?: SupabaseUser;
  };

  if (!payload.access_token || !payload.user?.id) {
    res.status(401).json({ error: "Não foi possível iniciar sua sessão." });
    return;
  }

  setSession(res, payload.access_token);
  const data = LoginResponse.parse({
    authenticated: true,
    user: {
      id: payload.user.id,
      email: payload.user.email ?? credentials.email,
    },
  });
  res.json(data);
});

router.post("/auth/logout", (_req, res) => {
  clearSession(res);
  res.status(204).send();
});

export default router;