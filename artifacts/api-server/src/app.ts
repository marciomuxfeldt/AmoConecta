import express, { type Express } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import pinoHttp from "pino-http";
import router from "./routes";
import resendWebhookRouter from "./routes/resend-webhook";
import { logger } from "./lib/logger";
import { getTechnicalError } from "./lib/technical-error";
import type { ErrorRequestHandler } from "express";

const app: Express = express();

// The public deployment sits behind Replit's reverse proxy. Trust the proxy
// hop so req.ip identifies the client address used by the login limiter.
app.set("trust proxy", 1);

app.use(
  pinoHttp({
    logger,
    serializers: {
      req(req) {
        return {
          id: req.id,
          method: req.method,
          url: req.url?.split("?")[0],
        };
      },
      res(res) {
        return {
          statusCode: res.statusCode,
        };
      },
    },
  }),
);
app.use(cors({ credentials: true }));
app.use(cookieParser());
// The Svix signature covers the exact request bytes. This narrowly scoped
// parser must run before express.json() consumes the body.
app.use(
  "/api/webhooks/resend",
  express.raw({ type: "application/json", limit: "1mb" }),
  resendWebhookRouter,
);
const webhookBodyParserError: ErrorRequestHandler = (error, _req, res, next) => {
  if ((error as { status?: number })?.status === 413) {
    res.status(413).json({ error: "O payload do webhook excede o limite de 1 MB." });
    return;
  }
  next(error);
};
app.use("/api/webhooks/resend", webhookBodyParserError);
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use("/api", router);

const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  if (res.headersSent) {
    next(error);
    return;
  }
  req.log.error(
    {
      requestId: req.id,
      technicalError: getTechnicalError(error),
    },
    "Unhandled API error",
  );
  res.status(500).json({
    error: "Não foi possível concluir a solicitação. A falha foi registrada.",
    request_id: req.id,
  });
};

app.use(errorHandler);

export default app;
