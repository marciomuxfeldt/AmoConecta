export const LOGIN_RATE_LIMIT = 5;
export const LOGIN_RATE_WINDOW_MS = 15 * 60 * 1000;

type LoginAttemptState = {
  attempts: number;
  windowStartedAt: number;
  blockedUntil: number;
};

const attemptsByIp = new Map<string, LoginAttemptState>();

function stateFor(ip: string, now: number): LoginAttemptState {
  const current = attemptsByIp.get(ip);
  if (!current || now - current.windowStartedAt >= LOGIN_RATE_WINDOW_MS) {
    const fresh = {
      attempts: 0,
      windowStartedAt: now,
      blockedUntil: 0,
    };
    attemptsByIp.set(ip, fresh);
    return fresh;
  }
  return current;
}

function retryAfterSeconds(blockedUntil: number, now: number): number {
  return Math.max(1, Math.ceil((blockedUntil - now) / 1000));
}

export function checkLoginAttempt(
  ip: string,
  now = Date.now(),
): { allowed: true } | { allowed: false; retryAfterSeconds: number } {
  const state = stateFor(ip, now);
  if (state.blockedUntil > now) {
    return {
      allowed: false,
      retryAfterSeconds: retryAfterSeconds(state.blockedUntil, now),
    };
  }

  state.attempts += 1;
  if (state.attempts >= LOGIN_RATE_LIMIT) {
    state.blockedUntil = state.windowStartedAt + LOGIN_RATE_WINDOW_MS;
  }
  return { allowed: true };
}

export function resetLoginAttempts(ip: string): void {
  attemptsByIp.delete(ip);
}

export function clearLoginAttemptStates(): void {
  attemptsByIp.clear();
}