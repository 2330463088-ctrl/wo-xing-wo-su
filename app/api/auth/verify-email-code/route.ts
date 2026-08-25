import { env } from "cloudflare:workers";

type ChallengePayload = {
  email: string;
  expiresAt: number;
  nonce: string;
  codeHash: string;
};

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(payload: Record<string, unknown>, status = 200): Response {
  return Response.json(payload, {
    status,
    headers: corsHeaders(),
  });
}

function readEnv(name: string): string {
  return String((env as Record<string, string | undefined>)[name] || "").trim();
}

function authSecret(): string {
  return readEnv("AUTH_CODE_SECRET") || readEnv("RESEND_API_KEY") || "woxingwosu-local-preview-secret";
}

function normalizeEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function decodeBase64UrlText(value: string): string {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

function timingSafeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) {
    return false;
  }
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) {
    diff |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return diff === 0;
}

async function hmac(input: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(input));
  return base64Url(new Uint8Array(signature));
}

async function verifyChallenge(email: string, code: string, challenge: string): Promise<boolean> {
  const [encodedPayload, signature] = challenge.split(".");
  if (!encodedPayload || !signature) {
    return false;
  }

  const secret = authSecret();
  const expectedSignature = await hmac(encodedPayload, secret);
  if (!timingSafeEqual(expectedSignature, signature)) {
    return false;
  }

  const payload = JSON.parse(decodeBase64UrlText(encodedPayload)) as ChallengePayload;
  if (payload.email !== email || Date.now() > Number(payload.expiresAt || 0)) {
    return false;
  }

  const expectedCodeHash = await hmac(`${email}|${code}|${payload.expiresAt}|${payload.nonce}`, secret);
  return timingSafeEqual(expectedCodeHash, payload.codeHash);
}

function displayNameForEmail(email: string): string {
  return email.split("@")[0]?.slice(0, 12) || "用户";
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => null)) as {
      email?: unknown;
      code?: unknown;
      challenge?: unknown;
    } | null;

    const email = normalizeEmail(payload?.email);
    const code = String(payload?.code || "").trim();
    const challenge = String(payload?.challenge || "").trim();

    if (!isValidEmail(email) || !/^\d{6}$/.test(code) || !challenge) {
      return jsonResponse({ ok: false, message: "验证码不正确或已过期" }, 400);
    }

    const ok = await verifyChallenge(email, code, challenge);
    if (!ok) {
      return jsonResponse({ ok: false, message: "验证码不正确或已过期" }, 401);
    }

    return jsonResponse({
      ok: true,
      email,
      displayName: displayNameForEmail(email),
    });
  } catch {
    return jsonResponse({ ok: false, message: "验证码不正确或已过期" }, 400);
  }
}
