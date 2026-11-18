export type ConversationStatus =
  | "idle"
  | "connecting"
  | "listening"
  | "transcribing"
  | "thinking"
  | "speaking"
  | "ending"
  | "disconnected"
  | "error";

export type Booking = {
  id: string;
  start: string;
  durationMinutes: 30;
  type: "demo" | "user";
  createdAt: string;
  conversationId?: string;
};

export type ScheduleDocument = {
  version: 1;
  initializedWeeks: string[];
  bookings: Booking[];
};

export type ChatMessage = {
  id: string;
  role: "user" | "assistant";
  text: string;
  interrupted?: boolean;
  bookingId?: string;
};

export type ScheduleSnapshot = {
  timezone: string;
  now: string;
  bookedStarts: string[];
};

export type ProposedAction = {
  intent: "book" | "replace" | "ask" | "cancel" | "end" | "unknown";
  requestedStart: string | null;
  needsClarification: boolean;
  clarification: string | null;
};

export type BookingResult = {
  status: "selected" | "booked" | "replaced" | "unavailable" | "clarification" | "no_action" | "error";
  requestedStart: string | null;
  booking?: Booking;
  reason?: "past" | "weekend" | "outside_hours" | "occupied" | "invalid" | "storage";
  alternatives: string[];
  detail?: string;
};
