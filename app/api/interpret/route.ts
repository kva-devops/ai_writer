import { z } from "zod";
import { extractResponseText, jsonError, proxyFetch, proxyHeaders, PublicApiError, readJsonBody } from "@/lib/server/proxyapi";

export const runtime = "nodejs";
export const maxDuration = 30;

const RequestSchema = z.object({
  turnId: z.string().min(1).max(100),
  transcript: z.string().min(1).max(2000),
  timezone: z.string().min(1).max(100),
  now: z.string().datetime({ offset: true }).or(z.string().datetime({ local: true })),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), text: z.string().max(2000) })).max(20),
  schedule: z.object({ bookedStarts: z.array(z.string()).max(500) }),
  conversationBookingStart: z.string().nullable(),
});

const ActionSchema = z.object({
  intent: z.enum(["book", "replace", "ask", "cancel", "end", "unknown"]),
  requestedStart: z.string().nullable(),
  needsClarification: z.boolean(),
  clarification: z.string().nullable(),
});

const actionJsonSchema = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["book", "replace", "ask", "cancel", "end", "unknown"] },
    requestedStart: { type: ["string", "null"] },
    needsClarification: { type: "boolean" },
    clarification: { type: ["string", "null"] },
  },
  required: ["intent", "requestedStart", "needsClarification", "clarification"],
  additionalProperties: false,
} as const;

export async function POST(request: Request) {
  try {
    const body = RequestSchema.parse(await readJsonBody(request));
    const response = await proxyFetch("/responses", {
      method: "POST",
      headers: proxyHeaders(),
      signal: request.signal,
      body: JSON.stringify({
        model: "openai/gpt-5-mini",
        // Without an explicit minimal effort GPT-5 can spend the whole output
        // budget on hidden reasoning and return no JSON at all.
        reasoning: { effort: "minimal" },
        max_output_tokens: 240,
        text: {
          format: {
            type: "json_schema",
            name: "booking_action",
            strict: true,
            schema: actionJsonSchema,
          },
        },
        instructions: [
          "Ты интерпретатор запроса русскоязычного секретаря. Верни ТОЛЬКО JSON без markdown.",
          "Поля: intent (book|replace|ask|cancel|end|unknown), requestedStart (локальная ISO дата YYYY-MM-DDTHH:mm:ss или null), needsClarification, clarification.",
          "book — новая точная запись; replace — пользователь явно меняет уже сделанную в этой беседе запись; ask — вопрос без записи.",
          "end — явное завершение разговора: пользователь говорит, что это всё, благодарит и прощается, говорит 'до свидания' или 'пока'. Для end requestedStart=null и needsClarification=false.",
          "Если нет точной даты или времени, needsClarification=true и requestedStart=null. Интервалы вроде 'после обеда' неоднозначны.",
          "Понимай сегодня/завтра и русские обозначения времени в переданном часовом поясе. Не решай доступность и не обещай запись.",
        ].join(" "),
        input: JSON.stringify(body),
      }),
    });
    const payload = await response.json();
    const responseStatus = payload && typeof payload === "object" && "status" in payload
      ? (payload as { status?: unknown }).status
      : undefined;
    if (responseStatus === "incomplete") {
      throw new PublicApiError(502, "Помощнику не хватило времени сформировать ответ. Повторите попытку.");
    }
    const text = extractResponseText(payload).trim().replace(/^```json\s*/i, "").replace(/```$/, "");
    if (!text) throw new PublicApiError(502, "Помощник не сформировал действие. Повторите попытку.");
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { throw new PublicApiError(502, "Помощник вернул непонятный ответ. Повторите фразу точнее."); }
    return Response.json({ turnId: body.turnId, action: ActionSchema.parse(parsed) });
  } catch (error) {
    if (error instanceof z.ZodError) return Response.json({ error: "Некорректные данные запроса." }, { status: 400 });
    return jsonError(error);
  }
}
