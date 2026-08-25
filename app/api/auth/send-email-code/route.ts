import { env } from "cloudflare:workers";

type ChallengePayload = {
  email: string;
  expiresAt: number;
  nonce: string;
  codeHash: string;
};

type EmailDelivery = {
  sent: boolean;
  provider: "resend" | "sendgrid" | "preview";
  message?: string;
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

function normalizeEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function randomCode(): string {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return String(values[0] % 1000000).padStart(6, "0");
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  bytes.forEach((byte) => {
    binary += String.fromCharCode(byte);
  });
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlText(text: string): string {
  return base64Url(new TextEncoder().encode(text));
}

function authSecret(): string {
  return (
    readEnv("AUTH_CODE_SECRET") ||
    readEnv("RESEND_API_KEY") ||
    readEnv("SENDGRID_API_KEY") ||
    "woxingwosu-local-preview-secret"
  );
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

async function buildChallenge(email: string, code: string): Promise<{ challenge: string; expiresAt: number }> {
  const secret = authSecret();
  const expiresAt = Date.now() + 10 * 60 * 1000;
  const nonce = crypto.randomUUID();
  const codeHash = await hmac(`${email}|${code}|${expiresAt}|${nonce}`, secret);
  const payload: ChallengePayload = { email, expiresAt, nonce, codeHash };
  const encodedPayload = base64UrlText(JSON.stringify(payload));
  const signature = await hmac(encodedPayload, secret);
  return { challenge: `${encodedPayload}.${signature}`, expiresAt };
}

function emailContent(code: string) {
  return {
    subject: "我行我诉登录验证码",
    text: `您的我行我诉登录验证码是：${code}。验证码10分钟内有效，请勿转发给他人。`,
    html: `<div style="font-family:Arial,'Microsoft YaHei',sans-serif;line-height:1.7;color:#1f2d33"><h2>我行我诉登录验证码</h2><p>您的验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>验证码10分钟内有效，请勿转发给他人。</p></div>`,
  };
}

function senderText(): string {
  return readEnv("AUTH_EMAIL_FROM") || "我行我诉 <onboarding@resend.dev>";
}

function senderParts(): { email: string; name?: string } {
  const explicitEmail = readEnv("AUTH_EMAIL_FROM_EMAIL");
  const explicitName = readEnv("AUTH_EMAIL_FROM_NAME");
  if (explicitEmail) {
    return { email: explicitEmail, name: explicitName || "我行我诉" };
  }

  const sender = senderText();
  const match = sender.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (!match) {
    return { email: sender, name: "我行我诉" };
  }

  const name = match[1].replace(/^["']|["']$/g, "").trim();
  return { email: match[2].trim(), name: name || "我行我诉" };
}

async function sendWithResend(email: string, code: string): Promise<void> {
  const apiKey = readEnv("RESEND_API_KEY");
  if (!apiKey) {
    return;
  }

  const content = emailContent(code);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: senderText(),
      to: email,
      subject: content.subject,
      text: content.text,
      html: content.html,
    }),
  });

  if (!response.ok) {
    throw new Error(`Resend returned ${response.status}`);
  }
}

async function sendWithSendGrid(email: string, code: string): Promise<void> {
  const apiKey = readEnv("SENDGRID_API_KEY");
  if (!apiKey) {
    return;
  }

  const content = emailContent(code);
  const from = senderParts();
  const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      personalizations: [{ to: [{ email }] }],
      from,
      subject: content.subject,
      content: [
        { type: "text/plain", value: content.text },
        { type: "text/html", value: content.html },
      ],
    }),
  });

  if (!response.ok) {
    throw new Error(`SendGrid returned ${response.status}`);
  }
}

async function sendEmail(email: string, code: string): Promise<EmailDelivery> {
  if (readEnv("RESEND_API_KEY")) {
    await sendWithResend(email, code);
    return { sent: true, provider: "resend" };
  }

  if (readEnv("SENDGRID_API_KEY")) {
    await sendWithSendGrid(email, code);
    return { sent: true, provider: "sendgrid" };
  }

  return {
    sent: false,
    provider: "preview",
    message: "未配置邮件服务密钥，已返回本地测试验证码",
  };
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function POST(request: Request) {
  try {
    const payload = (await request.json().catch(() => null)) as { email?: unknown } | null;
    const email = normalizeEmail(payload?.email);

    if (!isValidEmail(email)) {
      return jsonResponse({ ok: false, message: "请填写正确的邮箱" }, 400);
    }

    const code = randomCode();
    const { challenge, expiresAt } = await buildChallenge(email, code);
    const delivery = await sendEmail(email, code);

    return jsonResponse({
      ok: true,
      sent: delivery.sent,
      provider: delivery.provider,
      challenge,
      expiresAt,
      message: delivery.message,
      devCode: delivery.sent ? undefined : code,
    });
  } catch {
    return jsonResponse({ ok: false, message: "验证码发送失败，请稍后重试" }, 500);
  }
}
