import { jsonError, proxyFetch, proxyHeaders, PublicApiError } from "@/lib/server/proxyapi";

export const runtime = "nodejs";
export const maxDuration = 30;

const STT_MODEL = process.env.STT_MODEL?.trim() || "x-ai/grok-stt-2.0";
const STT_PROMPT = "Русская речь о записи на встречу: даты, дни недели и время.";

function normalizeTranscript(value: string): string {
  return value.toLocaleLowerCase("ru-RU").replace(/[^а-яё0-9]+/gi, " ").trim();
}

function isPromptEcho(value: string): boolean {
  const normalized = normalizeTranscript(value);
  if (!normalized) return false;
  if (normalized === normalizeTranscript(STT_PROMPT)) return true;
  // Also reject the longer hint used by the previous STT configuration.
  return normalized.includes("ожидаются русские даты дни недели и время")
    || (normalized.includes("время произносится") && normalized.includes("семнадцать ноль ноль"));
}

export async function POST(request: Request) {
  try {
    const length = Number(request.headers.get("content-length") ?? 0);
    if (length > 8_000_000) throw new PublicApiError(413, "Аудиофрагмент слишком большой. Скажите короче и повторите.");
    const incoming = await request.formData();
    const file = incoming.get("file");
    if (!(file instanceof File) || file.size < 100) throw new PublicApiError(400, "Не удалось услышать речь. Повторите фразу.");
    const form = new FormData();
    form.set("model", STT_MODEL);
    form.set("language", "ru");
    form.set("prompt", STT_PROMPT);
    form.set("response_format", "json");
    form.set("file", file, file.name || "speech.webm");
    const response = await proxyFetch("/audio/transcriptions", {
      method: "POST",
      headers: { Authorization: (proxyHeaders() as Record<string, string>).Authorization },
      body: form,
      signal: request.signal,
    });
    const payload = await response.json() as { text?: unknown };
    const text = typeof payload.text === "string" ? payload.text.trim() : "";
    return Response.json({ text: isPromptEcho(text) ? "" : text });
  } catch (error) {
    return jsonError(error);
  }
}
