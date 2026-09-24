import { createHmac, timingSafeEqual } from "node:crypto";

export const RESEND_WEBHOOK_MAX_AGE_SECONDS = 5 * 60;

export type SvixHeaders = {
  id: string | undefined;
  timestamp: string | undefined;
  signature: string | undefined;
};

export function verifyResendWebhookSignature(
  payload: Buffer,
  headers: SvixHeaders,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000),
): boolean {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature || !secret.startsWith("whsec_")) {
    return false;
  }
  if (!/^\d+$/u.test(timestamp)) return false;

  const timestampSeconds = Number(timestamp);
  if (
    !Number.isSafeInteger(timestampSeconds) ||
    Math.abs(nowSeconds - timestampSeconds) > RESEND_WEBHOOK_MAX_AGE_SECONDS
  ) {
    return false;
  }

  let key: Buffer;
  try {
    key = Buffer.from(secret.slice("whsec_".length), "base64");
  } catch {
    return false;
  }
  if (key.length === 0) return false;

  const signedContent = Buffer.concat([
    Buffer.from(`${id}.${timestamp}.`, "utf8"),
    payload,
  ]);
  const expected = createHmac("sha256", key).update(signedContent).digest();

  return signature.split(" ").some((entry) => {
    const [version, encodedSignature] = entry.split(",", 2);
    if (version !== "v1" || !encodedSignature) return false;
    try {
      const received = Buffer.from(encodedSignature, "base64");
      return (
        received.length === expected.length &&
        timingSafeEqual(received, expected)
      );
    } catch {
      return false;
    }
  });
}