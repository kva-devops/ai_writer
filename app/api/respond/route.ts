import { z } from "zod";
import { jsonError, proxyFetch, proxyHeaders, readJsonBody } from "@/lib/server/proxyapi";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({
  turnId: z.string().min(1).max(100),
  transcript: z.string().min(1).max(2000),
  intent: z.enum(["book", "replace", "ask", "cancel", "end", "unknown"]),
  conversationBookingStart: z.string().nullable(),
  result: z.object({
    status: z.enum(["selected", "booked", "replaced", "unavailable", "clarification", "no_action", "error"]),
    requestedStart: z.string().nullable(),
    reason: z.string().optional(),
    alternatives: z.array(z.string()).max(3),
    detail: z.string().optional(),
  }),
  timezone: z.string().max(100),
});

export async function POST(request: Request) {
  try {
    const body = RequestSchema.parse(await readJsonBody(request));
    const upstream = await proxyFetch("/responses", {
      method: "POST",
      headers: proxyHeaders(),
      signal: request.signal,
      body: JSON.stringify({
        model: "openai/gpt-5-mini",
        stream: true,
        reasoning: { effort: "minimal" },
        text: { verbosity: "low" },
        max_output_tokens: 140,
        instructions: [
          "Ты предельно краткий доброжелательный русскоязычный секретарь.",
          "Опирайся только на фактический результат клиентской проверки. Никогда не называй запись успешной, если status не booked/replaced.",
          "Для booked/replaced подтверди дату и время. Для unavailable коротко объясни причину и предложи переданные альтернативы (не более трёх).",
          "Для clarification задай один конкретный вопрос.",
          "Если intent=end, только коротко попрощайся, не повторяя дату, время или условия записи.",
          "После booked/replaced подтверди запись и коротко скажи, что пользователь может попрощаться или назвать другое время.",
          "Ответь без рассуждений, объяснения процесса, markdown и списков, максимум двумя короткими предложениями.",
          "Первое предложение должно быть самостоятельным, содержать не более восьми слов и сразу передавать главный результат. Детали при необходимости дай вторым предложением.",
        ].join(" "),
        input: JSON.stringify(body),
      }),
    });
    if (!upstream.body) return new Response("", { status: 502 });

    const decoder = new TextDecoder();
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const reader = upstream.body!.getReader();
        let buffer = "";
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) {
              if (!line.startsWith("data:")) continue;
              const data = line.slice(5).trim();
              if (!data || data === "[DONE]") continue;
              try {
                const event = JSON.parse(data) as { type?: string; delta?: unknown };
                if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
                  controller.enqueue(encoder.encode(event.delta));
                }
              } catch { /* Ignore non-JSON keepalive lines. */ }
            }
          }
          controller.close();
        } catch (error) {
          controller.error(error);
        } finally {
          reader.releaseLock();
        }
      },
      cancel() { upstream.body?.cancel(); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-cache, no-transform" } });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Некорректные данные запроса." }, { status: 400 });
    return jsonError(error);
  }
}
