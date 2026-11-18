import type { Booking, BookingResult, ProposedAction, ScheduleDocument } from "./types";

export const STORAGE_KEY = "voice-secretary.schedule.v1";
export const SLOT_MINUTES = 30;
const WORK_START = 9 * 60;
const LAST_START = 17 * 60 + 30;

const pad = (value: number) => String(value).padStart(2, "0");

export function localIso(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:00`;
}

export function startOfWeek(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  const day = result.getDay() || 7;
  result.setDate(result.getDate() - day + 1);
  return result;
}

export function dateKey(date: Date): string {
  return localIso(date).slice(0, 10);
}

export function weekKey(date: Date): string {
  return dateKey(startOfWeek(date));
}

export function buildWeekDays(anchor: Date): Date[] {
  const monday = startOfWeek(anchor);
  return Array.from({ length: 5 }, (_, index) => {
    const day = new Date(monday);
    day.setDate(day.getDate() + index);
    return day;
  });
}

export function buildDaySlots(day: Date): Date[] {
  const slots: Date[] = [];
  for (let minute = WORK_START; minute <= LAST_START; minute += SLOT_MINUTES) {
    const slot = new Date(day);
    slot.setHours(Math.floor(minute / 60), minute % 60, 0, 0);
    slots.push(slot);
  }
  return slots;
}

export function createEmptyDocument(): ScheduleDocument {
  return { version: 1, initializedWeeks: [], bookings: [] };
}

export function parseDocument(raw: string | null): ScheduleDocument {
  if (!raw) return createEmptyDocument();
  try {
    const parsed = JSON.parse(raw) as Partial<ScheduleDocument>;
    if (parsed.version !== 1 || !Array.isArray(parsed.bookings) || !Array.isArray(parsed.initializedWeeks)) {
      return createEmptyDocument();
    }
    const bookings = parsed.bookings.filter((item): item is Booking =>
      Boolean(item && typeof item.id === "string" && typeof item.start === "string" && item.durationMinutes === 30 && (item.type === "demo" || item.type === "user")),
    );
    return { version: 1, initializedWeeks: parsed.initializedWeeks.filter((x): x is string => typeof x === "string"), bookings };
  } catch {
    return createEmptyDocument();
  }
}

export function initializeDemoBookings(document: ScheduleDocument, now: Date): ScheduleDocument {
  const next = structuredClone(document);
  for (const offset of [0, 7]) {
    const anchor = new Date(now);
    anchor.setDate(anchor.getDate() + offset);
    const monday = startOfWeek(anchor);
    const key = weekKey(monday);
    if (next.initializedWeeks.includes(key)) continue;
    const examples = [
      { day: 0, hour: 10 },
      { day: 2, hour: 13 },
      { day: 4, hour: 16 },
    ];
    for (const example of examples) {
      const start = new Date(monday);
      start.setDate(start.getDate() + example.day);
      start.setHours(example.hour, 0, 0, 0);
      const iso = localIso(start);
      if (!next.bookings.some((booking) => booking.start === iso)) {
        next.bookings.push({ id: `demo-${key}-${example.day}-${example.hour}`, start: iso, durationMinutes: 30, type: "demo", createdAt: localIso(now) });
      }
    }
    next.initializedWeeks.push(key);
  }
  return next;
}

export function validateSlot(startIso: string, bookings: Booking[], now: Date): BookingResult["reason"] | null {
  const start = new Date(startIso);
  if (Number.isNaN(start.getTime())) return "invalid";
  if (start.getTime() <= now.getTime()) return "past";
  const day = start.getDay();
  if (day === 0 || day === 6) return "weekend";
  const minutes = start.getHours() * 60 + start.getMinutes();
  if (minutes < WORK_START || minutes > LAST_START || start.getMinutes() % SLOT_MINUTES !== 0) return "outside_hours";
  if (bookings.some((booking) => new Date(booking.start).getTime() === start.getTime())) return "occupied";
  return null;
}

export function nearestAvailable(fromIso: string | null, bookings: Booking[], now: Date, limit = 3): string[] {
  let cursor = fromIso ? new Date(fromIso) : new Date(now);
  if (Number.isNaN(cursor.getTime()) || cursor < now) cursor = new Date(now);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(Math.ceil(cursor.getMinutes() / SLOT_MINUTES) * SLOT_MINUTES);
  const results: string[] = [];
  for (let index = 0; index < 800 && results.length < limit; index += 1) {
    if (cursor.getHours() < 9) cursor.setHours(9, 0, 0, 0);
    if (cursor.getHours() > 17 || (cursor.getHours() === 17 && cursor.getMinutes() > 30)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(9, 0, 0, 0);
    }
    if (!validateSlot(localIso(cursor), bookings, now)) results.push(localIso(cursor));
    cursor = new Date(cursor.getTime() + SLOT_MINUTES * 60_000);
  }
  return results;
}

export function applyProposedAction(
  action: ProposedAction,
  document: ScheduleDocument,
  now: Date,
  conversationId: string,
): { document: ScheduleDocument; result: BookingResult } {
  if (action.needsClarification || !action.requestedStart || !["book", "replace"].includes(action.intent)) {
    return {
      document,
      result: {
        status: action.needsClarification ? "clarification" : "no_action",
        requestedStart: action.requestedStart,
        alternatives: nearestAvailable(action.requestedStart, document.bookings, now),
        detail: action.clarification ?? undefined,
      },
    };
  }
  const previous = action.intent === "replace"
    ? [...document.bookings].reverse().find((booking) => booking.type === "user" && booking.conversationId === conversationId)
    : undefined;
  const withoutPrevious = previous ? document.bookings.filter((booking) => booking.id !== previous.id) : document.bookings;
  const reason = validateSlot(action.requestedStart, withoutPrevious, now);
  if (reason) {
    return { document, result: { status: "unavailable", requestedStart: action.requestedStart, reason, alternatives: nearestAvailable(action.requestedStart, document.bookings, now) } };
  }
  const booking: Booking = {
    id: `user-${crypto.randomUUID()}`,
    start: localIso(new Date(action.requestedStart)),
    durationMinutes: 30,
    type: "user",
    createdAt: localIso(now),
    conversationId,
  };
  return {
    document: { ...document, bookings: [...withoutPrevious, booking] },
    result: { status: previous ? "replaced" : "booked", requestedStart: booking.start, booking, alternatives: [] },
  };
}
