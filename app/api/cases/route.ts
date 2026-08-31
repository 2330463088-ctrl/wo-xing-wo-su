type CaseDraftRow = {
  id?: string;
  user_email: string;
  display_name?: string | null;
  draft: unknown;
  created_at?: string;
  updated_at?: string;
};

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, x-user-email",
    "Cache-Control": "no-store",
  };
}

function json(data: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: {
      ...corsHeaders(),
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {}),
    },
  });
}

function readEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

function getSupabaseConfig() {
  const url = readEnv("SUPABASE_URL").replace(/\/+$/, "");
  const serviceRoleKey = readEnv("SUPABASE_SERVICE_ROLE_KEY");

  if (!url || !serviceRoleKey) {
    return null;
  }

  return { url, serviceRoleKey };
}

function normalizeEmail(value: unknown) {
  return String(value || "").trim().toLowerCase();
}

function getRequestEmail(request: Request, fallback?: unknown) {
  return normalizeEmail(
    fallback ||
      request.headers.get("oai-authenticated-user-email") ||
      request.headers.get("x-user-email")
  );
}

async function supabaseRequest(
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const config = getSupabaseConfig();

  if (!config) {
    return json({
      ok: false,
      configured: false,
      message: "Supabase is not configured.",
    });
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
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const email = getRequestEmail(request, url.searchParams.get("email"));

  if (!email) {
    return json({ ok: false, message: "Missing email." }, { status: 400 });
  }

  const response = await supabaseRequest(
    `woxingwosu_case_drafts?select=*&user_email=eq.${encodeURIComponent(
      email
    )}&limit=1`
  );

  if (!response.ok) {
    const text = await response.text();
    return json(
      { ok: false, message: "Failed to load case draft.", detail: text },
      { status: response.status }
    );
  }

  const rows = (await response.json()) as CaseDraftRow[] | { configured?: false };

  if (!Array.isArray(rows)) {
    return json(rows);
  }

  return json({
    ok: true,
    draft: rows[0]?.draft || null,
    updatedAt: rows[0]?.updated_at || null,
  });
}

export async function POST(request: Request) {
  let body: {
    email?: string;
    displayName?: string;
    draft?: unknown;
  };

  try {
    body = await request.json();
  } catch {
    return json({ ok: false, message: "Invalid JSON body." }, { status: 400 });
  }

  const email = getRequestEmail(request, body.email);

  if (!email) {
    return json({ ok: false, message: "Missing email." }, { status: 400 });
  }

  const row: CaseDraftRow = {
    user_email: email,
    display_name: body.displayName || null,
    draft: body.draft || {},
    updated_at: new Date().toISOString(),
  };

  const response = await supabaseRequest(
    "woxingwosu_case_drafts?on_conflict=user_email",
    {
      method: "POST",
      headers: {
        Prefer: "resolution=merge-duplicates,return=representation",
      },
      body: JSON.stringify(row),
    }
  );

  if (!response.ok) {
    const text = await response.text();
    return json(
      { ok: false, message: "Failed to save case draft.", detail: text },
      { status: response.status }
    );
  }

  const rows = (await response.json()) as CaseDraftRow[] | { configured?: false };

  if (!Array.isArray(rows)) {
    return json(rows);
  }

  return json({
    ok: true,
    id: rows[0]?.id || null,
    updatedAt: rows[0]?.updated_at || null,
  });
}
