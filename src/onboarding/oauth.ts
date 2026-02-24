import { createHash, randomBytes } from "node:crypto";

// OpenAI Codex public OAuth client
// https://developers.openai.com/codex/auth/
const OPENAI_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const OPENAI_AUTHORIZE_ENDPOINT = "https://auth.openai.com/oauth/authorize";
const OPENAI_TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const SCOPES = ["openid", "profile", "email", "offline_access"];

const EXPIRY_BUFFER_MS = 5 * 60 * 1000; // Refresh 5 min before actual expiry

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  clientId: string;
}

// ─── PKCE ──────────────────────────────────────────────────────────────

export function generatePkce(): PkcePair {
  const verifier = randomBytes(32).toString("hex"); // 64 hex chars
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// ─── State (CSRF) ──────────────────────────────────────────────────────

export function generateState(): string {
  return randomBytes(16).toString("hex");
}

// ─── Authorization URL ─────────────────────────────────────────────────

export function buildAuthorizeUrl(params: {
  state: string;
  challenge: string;
}): string {
  const qs = new URLSearchParams({
    client_id: OPENAI_CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    response_type: "code",
    scope: SCOPES.join(" "),
    state: params.state,
    code_challenge: params.challenge,
    code_challenge_method: "S256",
    id_token_add_organizations: "true",
    codex_cli_simplified_flow: "true",
  });
  return `${OPENAI_AUTHORIZE_ENDPOINT}?${qs.toString()}`;
}

// ─── Token Exchange ────────────────────────────────────────────────────

export async function exchangeCodeForTokens(params: {
  code: string;
  codeVerifier: string;
}): Promise<OAuthTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: OPENAI_CLIENT_ID,
    code: params.code,
    redirect_uri: REDIRECT_URI,
    code_verifier: params.codeVerifier,
  });

  const response = await fetch(OPENAI_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token exchange failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const accessToken = data.access_token?.trim();
  const refreshToken = data.refresh_token?.trim();

  if (!accessToken) {
    throw new Error("Token exchange returned no access_token");
  }
  if (!refreshToken) {
    throw new Error("Token exchange returned no refresh_token");
  }

  return {
    accessToken,
    refreshToken,
    expiresAt: computeExpiresAt(data.expires_in ?? 0),
    clientId: OPENAI_CLIENT_ID,
  };
}

// ─── Token Refresh ─────────────────────────────────────────────────────

export async function refreshTokens(params: {
  refreshToken: string;
  clientId?: string;
}): Promise<OAuthTokens> {
  const clientId = params.clientId ?? OPENAI_CLIENT_ID;

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    refresh_token: params.refreshToken,
  });

  const response = await fetch(OPENAI_TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Token refresh failed (HTTP ${response.status}): ${text.slice(0, 200)}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  const accessToken = data.access_token?.trim();
  if (!accessToken) {
    throw new Error("Token refresh returned no access_token");
  }

  // RFC 6749 section 6: new refresh token is optional; if present, replace old.
  const newRefreshToken = data.refresh_token?.trim() || params.refreshToken;

  return {
    accessToken,
    refreshToken: newRefreshToken,
    expiresAt: computeExpiresAt(data.expires_in ?? 0),
    clientId,
  };
}

// ─── Expiry ────────────────────────────────────────────────────────────

export function computeExpiresAt(expiresInSeconds: number): number {
  const now = Date.now();
  const value = now + Math.max(0, Math.floor(expiresInSeconds)) * 1000 - EXPIRY_BUFFER_MS;
  return Math.max(value, now + 30_000); // Minimum 30s from now
}

export function isTokenExpired(expiresAt: number): boolean {
  return Date.now() >= expiresAt;
}

// ─── Manual URL Parsing ────────────────────────────────────────────────

export function parseCallbackUrl(
  input: string,
  expectedState: string,
): { code: string; state: string } | { error: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { error: "No input provided" };
  }

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    // Support pasting just the query string: ?code=...&state=...
    const qs = trimmed.startsWith("?") ? trimmed : `?${trimmed}`;
    try {
      url = new URL(`http://localhost/${qs}`);
    } catch {
      return { error: "Paste the full redirect URL (must include code + state)." };
    }
  }

  const code = url.searchParams.get("code")?.trim();
  const state = url.searchParams.get("state")?.trim();

  if (!code) return { error: "Missing 'code' parameter in URL" };
  if (!state) return { error: "Missing 'state' parameter. Paste the full redirect URL." };
  if (state !== expectedState) return { error: "State mismatch — possible CSRF attack. Please retry login." };

  return { code, state };
}

// ─── Remote Environment Detection ──────────────────────────────────────

export function isRemoteEnvironment(): boolean {
  return !!(
    process.env.SSH_CLIENT ||
    process.env.SSH_TTY ||
    process.env.SSH_CONNECTION ||
    process.env.REMOTE_CONTAINERS ||
    process.env.CODESPACES
  );
}

// ─── Exports for external use ──────────────────────────────────────────

export { REDIRECT_URI, OPENAI_CLIENT_ID };
