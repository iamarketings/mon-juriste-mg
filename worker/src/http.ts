export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function json(data: unknown, status = 200, extraHeaders?: HeadersInit): Response {
  const headers = new Headers(extraHeaders);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(data), { status, headers });
}

export async function readJson<T>(request: Request): Promise<T> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    throw new HttpError(415, "Le corps doit être envoyé en application/json.");
  }

  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Le JSON envoyé est invalide.");
  }
}

export function corsHeaders(origin: string | undefined): HeadersInit {
  return {
    "access-control-allow-origin": origin || "http://localhost:3000",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization, x-monjuris-access",
    vary: "Origin",
  };
}
