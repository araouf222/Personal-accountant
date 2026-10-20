import { OAuth2Client } from "google-auth-library";
import { config } from "../config.js";
import { decrypt } from "./crypto.js";

/**
 * drive.file = the bot can only see/edit files IT created in the user's Drive.
 * It cannot list or read anything else. Google classes it as non-sensitive.
 */
export const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

export function redirectUri() {
  return `${config.appUrl}/api/oauth/callback`;
}

export function newClient() {
  return new OAuth2Client({
    clientId: config.googleClientId,
    clientSecret: config.googleClientSecret,
    redirectUri: redirectUri(),
  });
}

export function authUrl(state: string): string {
  return newClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // always return a refresh token
    scope: SCOPES,
    state,
    include_granted_scopes: false,
  });
}

export async function exchangeCode(code: string) {
  const client = newClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.refresh_token)
    throw new Error("Google returned no refresh token");
  const granted = (tokens.scope ?? "").split(" ");
  const hasScope = SCOPES.every((s) => granted.includes(s));
  client.setCredentials(tokens);
  return { client, refreshToken: tokens.refresh_token, hasScope };
}

export function clientFor(refreshTokenEnc: string): OAuth2Client {
  const client = newClient();
  client.setCredentials({ refresh_token: decrypt(refreshTokenEnc) });
  return client;
}

export async function revoke(refreshTokenEnc: string): Promise<void> {
  try {
    await newClient().revokeToken(decrypt(refreshTokenEnc));
  } catch (error) {
    console.warn("Token revoke failed (may already be revoked):", error);
  }
}

/** True when Google says the user's access is gone (revoked, expired, password change...). */
export function isAuthGone(error: unknown): boolean {
  const e = error as {
    message?: string;
    status?: number;
    response?: { status?: number; data?: unknown };
  };
  let data = "";
  try {
    data = JSON.stringify(e?.response?.data ?? "");
  } catch {}
  const text = `${e?.message ?? String(error)} ${data} ${e?.status ?? ""} ${e?.response?.status ?? ""}`;
  return /invalid_grant|invalid_token|unauthorized_client|\b401\b/.test(text);
}
