/**
 * 查询用户会员状态
 */

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, x-user-email",
    "Cache-Control": "no-store",
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
    },
  });
}

function readEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

function normalizeEmail(value: unknown): string {
  return String(value || "").trim().toLowerCase();
}

function getSupabaseConfig() {
  const url = readEnv("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRoleKey) return null;
  return { url, serviceRoleKey };
}

async function supabaseRequest(path: string, init: RequestInit = {}): Promise<Response> {
  const config = getSupabaseConfig();
  if (!config) {
    return jsonResponse({ ok: false, message: "Supabase 未配置" }, 500);
  }
  return fetch(`${config.url}/rest/v1/${path}`, {
    ...init,
    headers: {
      apikey: config.serviceRoleKey,
      Authorization: `Bearer ${config.serviceRoleKey}`,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: corsHeaders() });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const email = normalizeEmail(
    url.searchParams.get("email") || request.headers.get("x-user-email")
  );

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return jsonResponse({ ok: false, isVip: false, message: "未登录" }, 401);
  }

  const resp = await supabaseRequest(
    `users?email=eq.${encodeURIComponent(email)}&limit=1&select=*`
  );

  // 如果表不存在，说明还没初始化，返回非会员
  if (resp.status === 404 || resp.status === 400) {
    return jsonResponse({
      ok: true,
      isVip: false,
      email,
      message: "",
    });
  }

  if (!resp.ok) {
    return jsonResponse({ ok: false, message: "查询失败" }, resp.status);
  }

  const users = (await resp.json()) as {
    is_vip?: boolean;
    vip_expires_at?: string;
    total_paid?: number;
  }[];

  const user = users[0];
  if (!user) {
    return jsonResponse({
      ok: true,
      isVip: false,
      email,
      message: "",
    });
  }

  const isVip =
    user.is_vip &&
    user.vip_expires_at &&
    new Date(user.vip_expires_at) > new Date();

  return jsonResponse({
    ok: true,
    isVip,
    email,
    vipExpiresAt: user.vip_expires_at || null,
    totalPaid: user.total_paid || 0,
  });
}
