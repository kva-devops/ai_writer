import { z } from "zod";
import { jsonError, proxyFetch, proxyHeaders, readJsonBody } from "@/lib/server/proxyapi";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({ text: z.string().min(1).max(700), turnId: z.string().min(1).max(100) });

export async function POST(request: Request) {
  try {
    const body = RequestSchema.parse(await readJsonBody(request, 5000));
    const response = await proxyFetch("/audio/speech", {
      method: "POST",
      headers: proxyHeaders(),
      signal: request.signal,
      body: JSON.stringify({
        model: "openai/gpt-4o-mini-tts",
        input: body.text,
        voice: "alloy",
        response_format: "mp3",
        speed: 1.2,
        instructions: "Говори по-русски доброжелательно, чётко и естественно. Темп быстрый разговорный, без растягивания слов и длинных пауз.",
      }),
    });
    return new Response(response.body, { headers: { "Content-Type": response.headers.get("content-type") ?? "audio/mpeg", "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Некорректный текст для озвучивания." }, { status: 400 });
    return jsonError(error);
  }
}
