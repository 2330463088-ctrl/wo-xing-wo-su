function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    "Cache-Control": "no-store",
  };
}

function safeDecodeURIComponent(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function GET(request: Request) {
  const email = request.headers.get("oai-authenticated-user-email");
  if (!email) {
    return Response.json(
      { ok: false, signedIn: false },
      { status: 200, headers: corsHeaders() },
    );
  }

  const encodedFullName = request.headers.get("oai-authenticated-user-full-name");
  const fullName =
    encodedFullName &&
    request.headers.get("oai-authenticated-user-full-name-encoding") ===
      "percent-encoded-utf-8"
      ? safeDecodeURIComponent(encodedFullName)
      : null;

  return Response.json(
    {
      ok: true,
      signedIn: true,
      email,
      displayName: fullName || email.split("@")[0] || "用户",
    },
    { status: 200, headers: corsHeaders() },
  );
}
