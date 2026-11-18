import { describe, expect, it, vi } from "vitest";
import { applyProposedAction, buildDaySlots, initializeDemoBookings, nearestAvailable, parseDocument, validateSlot } from "../lib/schedule";
import type { Booking, ScheduleDocument } from "../lib/types";

const empty = (): ScheduleDocument => ({ version: 1, initializedWeeks: [], bookings: [] });

describe("правила расписания", () => {
  it("создаёт 18 получасовых слотов с 09:00 до 17:30", () => {
    const slots = buildDaySlots(new Date("2026-11-16T00:00:00"));
    expect(slots).toHaveLength(18);
    expect(slots[0].getHours()).toBe(9);
    expect(slots.at(-1)?.getHours()).toBe(17);
    expect(slots.at(-1)?.getMinutes()).toBe(30);
  });

  it("отклоняет прошлое, выходной, 18:00 и занятый слот", () => {
    const now = new Date("2026-11-16T12:00:00");
    const occupied: Booking = { id: "b", start: "2026-11-17T10:00:00", durationMinutes: 30, type: "demo", createdAt: "2026-11-16T10:00:00" };
    expect(validateSlot("2026-11-16T10:00:00", [], now)).toBe("past");
    expect(validateSlot("2026-11-21T10:00:00", [], now)).toBe("weekend");
    expect(validateSlot("2026-11-17T18:00:00", [], now)).toBe("outside_hours");
    expect(validateSlot("2026-11-17T10:00:00", [occupied], now)).toBe("occupied");
  });

  it("инициализирует демо-встречи текущей и следующей недели только один раз", () => {
    const now = new Date("2026-11-16T08:00:00");
    const once = initializeDemoBookings(empty(), now);
    const twice = initializeDemoBookings(once, now);
    expect(once.bookings).toHaveLength(6);
    expect(twice.bookings).toHaveLength(6);
    expect(twice.initializedWeeks).toHaveLength(2);
  });

  it("не создаёт дубль и предлагает не более трёх альтернатив", () => {
    const now = new Date("2026-11-16T08:00:00");
    const first = applyProposedAction({ intent: "book", requestedStart: "2026-11-17T10:00:00", needsClarification: false, clarification: null }, empty(), now, "c1");
    const duplicate = applyProposedAction({ intent: "book", requestedStart: "2026-11-17T10:00:00", needsClarification: false, clarification: null }, first.document, now, "c1");
    expect(first.result.status).toBe("booked");
    expect(duplicate.result.status).toBe("unavailable");
    expect(duplicate.result.alternatives).toHaveLength(3);
  });

  it("заменяет запись атомарно, а при занятом новом слоте сохраняет старую", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "id" });
    const now = new Date("2026-11-16T08:00:00");
    const previous: Booking = { id: "old", start: "2026-11-17T10:00:00", durationMinutes: 30, type: "user", createdAt: "2026-11-16T08:00:00", conversationId: "c1" };
    const busy: Booking = { id: "busy", start: "2026-11-17T11:00:00", durationMinutes: 30, type: "demo", createdAt: "2026-11-16T08:00:00" };
    const source = { ...empty(), bookings: [previous, busy] };
    const failed = applyProposedAction({ intent: "replace", requestedStart: busy.start, needsClarification: false, clarification: null }, source, now, "c1");
    expect(failed.document.bookings.some((item) => item.id === "old")).toBe(true);
    const success = applyProposedAction({ intent: "replace", requestedStart: "2026-11-17T12:00:00", needsClarification: false, clarification: null }, source, now, "c1");
    expect(success.result.status).toBe("replaced");
    expect(success.document.bookings.some((item) => item.id === "old")).toBe(false);
  });

  it("безопасно восстанавливается после повреждённого localStorage", () => {
    expect(parseDocument("{bad json")).toEqual(empty());
    expect(nearestAvailable(null, [], new Date("2026-11-20T17:45:00"))).toHaveLength(3);
  });

  it("не меняет расписание при завершении разговора", () => {
    const source = empty();
    const ended = applyProposedAction({ intent: "end", requestedStart: null, needsClarification: false, clarification: null }, source, new Date("2026-11-16T08:00:00"), "c1");
    expect(ended.result.status).toBe("no_action");
    expect(ended.document).toBe(source);
  });
});
