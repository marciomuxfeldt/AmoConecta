import { Router, type IRouter, type Request, type Response } from "express";
import {
  GetAuthSessionResponse,
  LoginBody,
  LoginResponse,
} from "@workspace/api-zod";
import { getTechnicalError } from "../lib/technical-error";
import { createClient } from "@supabase/supabase-js";

const router: IRouter = Router();
const SESSION_COOKIE = "amoconecta_session";
const SESSION_MAX_AGE = 1000 * 60 * 60 * 24 * 7;

function supabaseAuthClient() {
  const url = process.env.SUPABASE_URL;
  const anonKey = process.env.SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    throw new Error(
      "SUPABASE_URL e SUPABASE_ANON_KEY são obrigatórias para o login.",
    );
  }

  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

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

  const { data, error } = await supabaseAuthClient().auth.getUser(token);
  if (error || !data.user) {
    clearSession(res);
    return null;
  }

  return {
    token,
    user: { id: data.user.id, email: data.user.email ?? null },
  };
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
  const { data: authData, error } =
    await supabaseAuthClient().auth.signInWithPassword(
    credentials,
  );

  if (error) {
    req.log.error(
      {
        supabaseStatus: error.status,
        technicalError: getTechnicalError(error),
      },
      "Supabase Auth login failed",
    );
    res.status(401).json({ error: "E-mail ou senha inválidos." });
    return;
  }

  if (!authData.session?.access_token || !authData.user?.id) {
    res.status(401).json({ error: "Não foi possível iniciar sua sessão." });
    return;
  }

  setSession(res, authData.session.access_token);
  const data = LoginResponse.parse({
    authenticated: true,
    user: {
      id: authData.user.id,
      email: authData.user.email ?? credentials.email,
    },
  });
  res.json(data);
});

router.post("/auth/logout", (_req, res) => {
  clearSession(res);
  res.status(204).send();
});

export default router;