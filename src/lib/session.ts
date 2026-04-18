// Session management: short-lived signed cookie holds a session id,
// the full session payload lives in KV. Keeps cookies small and lets
// us revoke sessions by deleting the KV entry.

import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "wb_session";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days

export interface SessionData {
  slackUserId: string;
  slackTeamId: string;
  name: string;
  email?: string;
  avatar?: string;
  aiSearchInstanceId: string;
  createdAt: number;
}

function secretKey(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function signSessionCookie(
  sessionId: string,
  secret: string,
): Promise<string> {
  return await new SignJWT({ sid: sessionId })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${COOKIE_MAX_AGE}s`)
    .sign(secretKey(secret));
}

export async function verifySessionCookie(
  token: string,
  secret: string,
): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, secretKey(secret));
    return typeof payload.sid === "string" ? payload.sid : null;
  } catch {
    return null;
  }
}

export function sessionCookieHeader(token: string, secure = true): string {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function clearSessionCookieHeader(secure = true): string {
  const attrs = [`${COOKIE_NAME}=`, "HttpOnly", "Path=/", "SameSite=Lax", "Max-Age=0"];
  if (secure) attrs.push("Secure");
  return attrs.join("; ");
}

export function readSessionCookie(cookieHeader: string | null): string | null {
  if (!cookieHeader) return null;
  const pairs = cookieHeader.split(";").map((p) => p.trim());
  for (const pair of pairs) {
    const [name, ...rest] = pair.split("=");
    if (name === COOKIE_NAME) return rest.join("=");
  }
  return null;
}

export async function loadSession(
  kv: KVNamespace,
  sessionId: string,
): Promise<SessionData | null> {
  return await kv.get<SessionData>(`session:${sessionId}`, "json");
}

export async function saveSession(
  kv: KVNamespace,
  sessionId: string,
  data: SessionData,
): Promise<void> {
  await kv.put(`session:${sessionId}`, JSON.stringify(data), {
    expirationTtl: COOKIE_MAX_AGE,
  });
}

export async function deleteSession(
  kv: KVNamespace,
  sessionId: string,
): Promise<void> {
  await kv.delete(`session:${sessionId}`);
}

export function newSessionId(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
