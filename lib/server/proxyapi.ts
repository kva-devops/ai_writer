const BASE_URL = "https://api.proxyapi.ru/v1";

export class PublicApiError extends Error {
  constructor(public readonly status: number, message: string) {
    super(message);
  }
}

export function proxyHeaders(contentType = "application/json"): HeadersInit {
  const key = process.env.PROXYAPI_API_KEY;
  if (!key) throw new PublicApiError(503, "Ключ ProxyAPI не настроен. Добавьте PROXYAPI_API_KEY в .env.local.");
  return { Authorization: `Bearer ${key}`, "Content-Type": contentType };
}

export async function proxyFetch(path: string, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(`${BASE_URL}${path}`, { ...init, signal: init.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new PublicApiError(502, "Не удалось связаться с ProxyAPI. Проверьте подключение и повторите.");
  }
  if (!response.ok) {
    const message = response.status === 401 || response.status === 403
      ? "ProxyAPI отклонил ключ. Проверьте PROXYAPI_API_KEY."
      : response.status === 429
        ? "Слишком много запросов к ProxyAPI. Подождите немного и повторите."
        : response.status === 402
          ? "На балансе ProxyAPI недостаточно средств."
          : "ProxyAPI временно не выполнил запрос. Повторите попытку.";
    throw new PublicApiError(response.status >= 500 ? 502 : response.status, message);
  }
  return response;
}

export function jsonError(error: unknown): Response {
  if (error instanceof PublicApiError) return Response.json({ error: error.message }, { status: error.status });
  if (error instanceof DOMException && error.name === "AbortError") return Response.json({ error: "Запрос отменён." }, { status: 499 });
  return Response.json({ error: "Не удалось обработать запрос. Повторите попытку." }, { status: 500 });
}

export async function readJsonBody<T>(request: Request, maxBytes = 100_000): Promise<T> {
  const length = Number(request.headers.get("content-length") ?? 0);
  if (length > maxBytes) throw new PublicApiError(413, "Запрос слишком большой.");
  return request.json() as Promise<T>;
}

export function extractResponseText(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "";
  const output = (payload as { output?: unknown }).output;
  if (!Array.isArray(output)) return "";
  return output.flatMap((item) => {
    if (!item || typeof item !== "object" || !Array.isArray((item as { content?: unknown }).content)) return [];
    return (item as { content: unknown[] }).content.flatMap((content) => {
      if (!content || typeof content !== "object") return [];
      const text = (content as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    });
  }).join("");
}
