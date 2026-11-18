"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ScheduleBoard } from "./ScheduleBoard";
import { applyProposedAction, initializeDemoBookings, localIso, parseDocument, STORAGE_KEY } from "@/lib/schedule";
import type { BookingResult, ChatMessage, ConversationStatus, ProposedAction, ScheduleDocument } from "@/lib/types";

const statusCopy: Record<ConversationStatus, { label: string; hint: string }> = {
  idle: { label: "Готов к разговору", hint: "Микрофон пока выключен" },
  connecting: { label: "Подключаю микрофон", hint: "Разрешите доступ в браузере" },
  listening: { label: "Слушаю", hint: "Скажите, когда хотите встретиться" },
  transcribing: { label: "Распознаю речь", hint: "Закрепляю окончательный текст" },
  thinking: { label: "Проверяю расписание", hint: "Помощник думает" },
  speaking: { label: "Помощник говорит", hint: "Можно перебить голосом или кнопкой" },
  ending: { label: "Завершаю", hint: "Освобождаю микрофон" },
  disconnected: { label: "Соединение прервано", hint: "Проверьте сеть и повторите" },
  error: { label: "Нужна помощь", hint: "Исправьте ошибку и повторите" },
};

const dateTimeFormatter = new Intl.DateTimeFormat("ru-RU", { weekday: "long", day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });

async function readError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: string };
    return payload.error ?? "Неизвестная ошибка.";
  } catch {
    return "Сервис временно недоступен. Повторите попытку.";
  }
}

export function VoiceSecretary() {
  const [document, setDocument] = useState<ScheduleDocument>({ version: 1, initializedWeeks: [], bookings: [] });
  const [weekAnchor, setWeekAnchor] = useState(() => new Date());
  const [now, setNow] = useState(() => new Date());
  const [status, setStatus] = useState<ConversationStatus>("idle");
  const [active, setActive] = useState(false);
  const [ended, setEnded] = useState(false);
  const [preliminary, setPreliminary] = useState("");
  const [finalTranscript, setFinalTranscript] = useState("");
  const [streamingText, setStreamingText] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [typedText, setTypedText] = useState("");
  const [storageWarning, setStorageWarning] = useState<string | null>(null);

  const statusRef = useRef(status);
  const activeRef = useRef(active);
  const documentRef = useRef(document);
  const turnRef = useRef("");
  const conversationRef = useRef("");
  const controllersRef = useRef(new Set<AbortController>());
  const streamRef = useRef<MediaStream | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const bargeInPreRollRef = useRef<MediaRecorder | null>(null);
  const segmentRecorderRef = useRef<MediaRecorder | null>(null);
  const segmentTimerRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const recordingTurnRef = useRef("");
  const heardSpeechRef = useRef(false);
  const speechStartedAtRef = useRef(0);
  const lastVoiceAtRef = useRef(0);
  const vadReadyAtRef = useRef(0);
  const audioContextRef = useRef<AudioContext | null>(null);
  const animationRef = useRef(0);
  const currentAudioRef = useRef<HTMLAudioElement | null>(null);
  const audioUrlsRef = useRef(new Set<string>());
  const ttsChainRef = useRef<Promise<void>>(Promise.resolve());
  const ttsTokenRef = useRef(0);
  const streamingRef = useRef("");
  const committedBookingRef = useRef<string | undefined>(undefined);
  const pendingBookingStartRef = useRef<string | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const preliminaryChainRef = useRef<Promise<void>>(Promise.resolve());
  const endConversationRef = useRef<() => void>(() => undefined);

  useEffect(() => { statusRef.current = status; }, [status]);
  useEffect(() => { activeRef.current = active; }, [active]);
  useEffect(() => { documentRef.current = document; }, [document]);

  useEffect(() => {
    try {
      const initialized = initializeDemoBookings(parseDocument(localStorage.getItem(STORAGE_KEY)), new Date());
      localStorage.setItem(STORAGE_KEY, JSON.stringify(initialized));
      setDocument(initialized);
    } catch {
      setStorageWarning("Хранилище браузера недоступно. Расписание показано временно, запись будет отключена.");
      setDocument(initializeDemoBookings(parseDocument(null), new Date()));
    }
    const interval = window.setInterval(() => setNow(new Date()), 30_000);
    return () => window.clearInterval(interval);
  }, []);

  const addController = () => {
    const controller = new AbortController();
    controllersRef.current.add(controller);
    controller.signal.addEventListener("abort", () => controllersRef.current.delete(controller), { once: true });
    return controller;
  };

  const appendMessage = useCallback((message: ChatMessage) => {
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
  }, []);

  const clearMessages = useCallback(() => {
    messagesRef.current = [];
    setMessages([]);
  }, []);

  const stopPlayback = useCallback(() => {
    ttsTokenRef.current += 1;
    const audio = currentAudioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
      currentAudioRef.current = null;
    }
    audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    audioUrlsRef.current.clear();
    ttsChainRef.current = Promise.resolve();
  }, []);

  const abortTurn = useCallback((markInterrupted: boolean) => {
    controllersRef.current.forEach((controller) => controller.abort());
    controllersRef.current.clear();
    stopPlayback();
    const partial = streamingRef.current.trim();
    if (markInterrupted && partial) {
      appendMessage({
        id: crypto.randomUUID(), role: "assistant", text: partial, interrupted: true, bookingId: committedBookingRef.current,
      });
    }
    streamingRef.current = "";
    setStreamingText("");
    committedBookingRef.current = undefined;
  }, [appendMessage, stopPlayback]);

  const transcribeBlob = async (blob: Blob, turnId: string, final: boolean): Promise<string> => {
    const controller = addController();
    const form = new FormData();
    form.set("file", blob, `speech-${final ? "final" : "part"}.webm`);
    const response = await fetch("/api/stt", { method: "POST", body: form, signal: controller.signal });
    controllersRef.current.delete(controller);
    if (turnRef.current !== turnId) return "";
    if (!response.ok) throw new Error(await readError(response));
    const payload = await response.json() as { text?: string };
    return payload.text?.trim() ?? "";
  };

  const preparePhrase = useCallback(async (text: string, turnId: string, token: number): Promise<string | null> => {
    if (!text.trim() || turnRef.current !== turnId || token !== ttsTokenRef.current) return null;
    const controller = addController();
    try {
      const response = await fetch("/api/tts", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: controller.signal,
        body: JSON.stringify({ text: text.trim(), turnId }),
      });
      if (!response.ok) throw new Error(await readError(response));
      if (turnRef.current !== turnId || token !== ttsTokenRef.current) return null;
      const blob = await response.blob();
      if (turnRef.current !== turnId || token !== ttsTokenRef.current) return null;
      const url = URL.createObjectURL(blob);
      audioUrlsRef.current.add(url);
      return url;
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return null;
      throw caught;
    } finally {
      controllersRef.current.delete(controller);
    }
  }, []);

  const playPreparedPhrase = useCallback(async (preparedUrl: Promise<string | null>, turnId: string, token: number) => {
    const url = await preparedUrl;
    if (!url || turnRef.current !== turnId || token !== ttsTokenRef.current) {
      if (url) {
        URL.revokeObjectURL(url);
        audioUrlsRef.current.delete(url);
      }
      return;
    }
    const audio = new Audio(url);
    currentAudioRef.current = audio;
    await new Promise<void>((resolve, reject) => {
      audio.onended = () => resolve();
      audio.onerror = () => reject(new Error("Не удалось воспроизвести ответ. Проверьте звук и повторите."));
      audio.play().catch(reject);
    });
    currentAudioRef.current = null;
    URL.revokeObjectURL(url);
    audioUrlsRef.current.delete(url);
  }, []);

  const enqueuePhrase = useCallback((text: string, turnId: string) => {
    const token = ttsTokenRef.current;
    statusRef.current = "speaking";
    setStatus("speaking");
    // Start synthesizing immediately. Playback remains ordered by the chain,
    // but later phrases are already being prepared while the first one plays.
    const preparedUrl = preparePhrase(text, turnId, token);
    ttsChainRef.current = ttsChainRef.current.then(() => playPreparedPhrase(preparedUrl, turnId, token));
  }, [playPreparedPhrase, preparePhrase]);

  const evaluateAction = (action: ProposedAction): BookingResult => {
    if (action.intent === "cancel") {
      pendingBookingStartRef.current = null;
      return { status: "no_action", requestedStart: null, alternatives: [], detail: "Выбранное время отменено." };
    }
    const previewAction = ["book", "replace"].includes(action.intent)
      ? { ...action, intent: "book" as const }
      : action;
    const applied = applyProposedAction(previewAction, documentRef.current, new Date(), conversationRef.current);
    if (applied.result.status === "booked" && applied.result.booking) {
      pendingBookingStartRef.current = applied.result.booking.start;
      return { ...applied.result, status: "selected" };
    }
    return applied.result;
  };

  const commitPendingBooking = (): BookingResult => {
    const requestedStart = pendingBookingStartRef.current;
    if (!requestedStart) return { status: "no_action", requestedStart: null, alternatives: [] };
    const applied = applyProposedAction({
      intent: "book", requestedStart, needsClarification: false, clarification: null,
    }, documentRef.current, new Date(), conversationRef.current);
    if (applied.result.status === "booked") {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(applied.document));
        const verified = parseDocument(localStorage.getItem(STORAGE_KEY));
        if (!applied.result.booking || !verified.bookings.some((item) => item.id === applied.result.booking!.id)) throw new Error("verify");
        documentRef.current = verified;
        setDocument(verified);
        pendingBookingStartRef.current = null;
      } catch {
        return { status: "error", requestedStart, reason: "storage", alternatives: [], detail: "Не удалось сохранить запись в браузере." };
      }
    }
    return applied.result;
  };

  const processTranscript = useCallback(async (transcript: string, turnId: string) => {
    if (!transcript.trim() || turnRef.current !== turnId) return;
    setFinalTranscript(transcript);
    setPreliminary("");
    const history = messagesRef.current.map(({ role, text, interrupted }) => ({
      role,
      text: interrupted ? `${text} [ответ был прерван]` : text,
    }));
    appendMessage({ id: crypto.randomUUID(), role: "user", text: transcript });
    setStatus("thinking");
    try {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const interpretController = addController();
      const interpretResponse = await fetch("/api/interpret", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: interpretController.signal,
        body: JSON.stringify({
          turnId, transcript, timezone, now: new Date().toISOString(), history,
          schedule: { bookedStarts: documentRef.current.bookings.map((item) => item.start) },
          conversationBookingStart: pendingBookingStartRef.current,
        }),
      });
      controllersRef.current.delete(interpretController);
      if (turnRef.current !== turnId) return;
      if (!interpretResponse.ok) throw new Error(await readError(interpretResponse));
      const interpreted = await interpretResponse.json() as { turnId: string; action: ProposedAction };
      if (interpreted.turnId !== turnId) return;
      const endingRequested = interpreted.action.intent === "end";
      const result = endingRequested ? commitPendingBooking() : evaluateAction(interpreted.action);
      const shouldEnd = endingRequested && ["booked", "no_action"].includes(result.status);
      const persistedBookingId = ["booked", "replaced"].includes(result.status) ? result.booking?.id : undefined;
      committedBookingRef.current = persistedBookingId;

      let full = "";
      setStreamingText("");

      if (shouldEnd) {
        full = "До свидания!";
        streamingRef.current = full;
        setStreamingText(full);
        enqueuePhrase(full, turnId);
      } else if (result.status === "selected" && result.booking) {
        const formattedStart = dateTimeFormatter.format(new Date(result.booking.start));
        full = `Выбрано ${formattedStart}.`;
        streamingRef.current = full;
        setStreamingText(full);
        enqueuePhrase(full, turnId);
      } else if (interpreted.action.intent === "cancel") {
        full = "Хорошо, выбранное время отменено.";
        streamingRef.current = full;
        setStreamingText(full);
        enqueuePhrase(full, turnId);
      } else {
        const responseController = addController();
        const response = await fetch("/api/respond", {
          method: "POST", headers: { "Content-Type": "application/json" }, signal: responseController.signal,
          body: JSON.stringify({
            turnId,
            transcript,
            result,
            timezone,
            intent: endingRequested ? "book" : interpreted.action.intent,
            conversationBookingStart: pendingBookingStartRef.current,
          }),
        });
        if (!response.ok) throw new Error(await readError(response));
        if (!response.body) throw new Error("Сервис не вернул поток ответа.");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let spokenLength = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (turnRef.current !== turnId) { await reader.cancel(); return; }
          full += decoder.decode(value, { stream: true });
          streamingRef.current = full;
          setStreamingText(full);
          while (true) {
            const pending = full.slice(spokenLength);
            const match = pending.match(/^([\s\S]*?[.!?…]+)\s+/);
            if (!match) break;
            const phrase = match[1].trim();
            if (phrase) enqueuePhrase(phrase, turnId);
            spokenLength += match[0].length;
          }
        }
        controllersRef.current.delete(responseController);
        const remainder = full.slice(spokenLength).trim();
        if (remainder) enqueuePhrase(remainder, turnId);
      }

      await ttsChainRef.current;
      if (turnRef.current !== turnId) return;
      appendMessage({ id: crypto.randomUUID(), role: "assistant", text: full.trim(), bookingId: persistedBookingId });
      streamingRef.current = "";
      setStreamingText("");
      committedBookingRef.current = undefined;
      if (shouldEnd) {
        endConversationRef.current();
        return;
      }
      setStatus("listening");
      startRecorder();
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      const message = caught instanceof Error ? caught.message : "Не удалось обработать фразу.";
      if (committedBookingRef.current) {
        appendMessage({
          id: crypto.randomUUID(),
          role: "assistant",
          text: "Запись сохранена, но голосовой ответ не удалось завершить.",
          interrupted: true,
          bookingId: committedBookingRef.current,
        });
      }
      setError(message);
      setStatus(message.includes("связ") || message.includes("сеть") ? "disconnected" : "error");
    }
  }, [appendMessage, enqueuePhrase]);

  const finishRecording = useCallback(async (turnId: string, chunks: Blob[]) => {
    if (!chunks.length || turnRef.current !== turnId) return;
    heardSpeechRef.current = false;
    setStatus("transcribing");
    try {
      const blob = new Blob(chunks, { type: chunks[0].type || "audio/webm" });
      const transcript = await transcribeBlob(blob, turnId, true);
      if (!transcript) throw new Error("Речь не распознана. Попробуйте сказать фразу ещё раз.");
      await processTranscript(transcript, turnId);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError(caught instanceof Error ? caught.message : "Не удалось распознать речь.");
      setStatus("error");
    }
  }, [processTranscript]);

  const stopSegmentRecorder = useCallback(() => {
    if (segmentTimerRef.current !== null) {
      window.clearTimeout(segmentTimerRef.current);
      segmentTimerRef.current = null;
    }
    const segment = segmentRecorderRef.current;
    segmentRecorderRef.current = null;
    if (segment?.state === "recording") {
      segment.ondataavailable = null;
      segment.onstop = null;
      segment.stop();
    }
  }, []);

  const startRecorder = useCallback((existingTurn?: string, bufferedRecorder?: MediaRecorder) => {
    if (!activeRef.current || !streamRef.current || recorderRef.current?.state === "recording") return;
    const turnId = existingTurn && turnRef.current === existingTurn ? existingTurn : crypto.randomUUID();
    const adoptedRecorder = bufferedRecorder?.state === "recording" ? bufferedRecorder : null;
    const stalePreRoll = bargeInPreRollRef.current;
    bargeInPreRollRef.current = null;
    if (stalePreRoll && stalePreRoll !== adoptedRecorder && stalePreRoll.state === "recording") {
      stalePreRoll.ondataavailable = null;
      stalePreRoll.onstop = null;
      stalePreRoll.stop();
    }
    const startedAt = performance.now();
    turnRef.current = turnId;
    recordingTurnRef.current = turnId;
    chunksRef.current = [];
    preliminaryChainRef.current = Promise.resolve();
    heardSpeechRef.current = Boolean(adoptedRecorder);
    speechStartedAtRef.current = adoptedRecorder ? startedAt - 150 : 0;
    lastVoiceAtRef.current = startedAt;
    vadReadyAtRef.current = adoptedRecorder ? startedAt : startedAt + 350;
    setPreliminary("");
    setFinalTranscript("");
    setError(null);
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
    const recorderOptions: MediaRecorderOptions = { mimeType, audioBitsPerSecond: 64_000 };
    const recorder = adoptedRecorder ?? new MediaRecorder(streamRef.current, recorderOptions);
    recorderRef.current = recorder;
    recorder.ondataavailable = (event) => {
      if (event.data.size < 100 || recordingTurnRef.current !== turnId) return;
      chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const chunks = [...chunksRef.current];
      recorderRef.current = null;
      finishRecording(turnId, chunks);
    };
    if (!adoptedRecorder) recorder.start();

    // MediaRecorder timeslice chunks are not guaranteed to be standalone WebM
    // files. A short recorder that is stopped and recreated produces a valid
    // file for every preliminary STT request, while the recorder above keeps
    // an independent, uninterrupted final utterance.
    const startSegment = () => {
      if (!activeRef.current || recordingTurnRef.current !== turnId || recorderRef.current?.state !== "recording" || !streamRef.current) return;
      const segmentParts: Blob[] = [];
      const segment = new MediaRecorder(streamRef.current, recorderOptions);
      segmentRecorderRef.current = segment;
      segment.ondataavailable = (event) => {
        if (event.data.size >= 100) segmentParts.push(event.data);
      };
      segment.onstop = () => {
        if (segmentRecorderRef.current === segment) segmentRecorderRef.current = null;
        const shouldContinue = activeRef.current && recordingTurnRef.current === turnId && recorderRef.current?.state === "recording";
        const confirmedSpeech = heardSpeechRef.current
          && lastVoiceAtRef.current - speechStartedAtRef.current >= 250;
        if (confirmedSpeech && segmentParts.length && turnRef.current === turnId) {
          const blob = new Blob(segmentParts, { type: segmentParts[0].type || mimeType });
          preliminaryChainRef.current = preliminaryChainRef.current.then(async () => {
            try {
              const text = await transcribeBlob(blob, turnId, false);
              // A 1.6-second fragment cannot contain a long paragraph. Large
              // results are silence/noise hallucinations and must not reach UI.
              if (text && text.length <= 120 && turnRef.current === turnId && statusRef.current === "listening") {
                setPreliminary((value) => `${value} ${text}`.trim());
              }
            } catch {
              // The final pass reports actionable recognition errors.
            }
          });
        }
        if (shouldContinue) startSegment();
      };
      segment.start();
      segmentTimerRef.current = window.setTimeout(() => {
        segmentTimerRef.current = null;
        if (segment.state === "recording") segment.stop();
      }, 800);
    };
    startSegment();
    statusRef.current = "listening";
    setStatus("listening");
  }, [finishRecording]);

  const interruptAndListen = useCallback((bufferedRecorder?: MediaRecorder) => {
    if (!activeRef.current) return;
    const adoptedRecorder = bufferedRecorder?.state === "recording" ? bufferedRecorder : null;
    const pendingRecorder = bargeInPreRollRef.current;
    bargeInPreRollRef.current = null;
    if (pendingRecorder && pendingRecorder !== adoptedRecorder && pendingRecorder.state === "recording") {
      pendingRecorder.ondataavailable = null;
      pendingRecorder.onstop = null;
      pendingRecorder.stop();
    }
    const wasResponding = ["thinking", "speaking"].includes(statusRef.current);
    abortTurn(wasResponding);
    stopSegmentRecorder();
    const oldRecorder = recorderRef.current;
    recordingTurnRef.current = "";
    if (oldRecorder?.state === "recording") {
      oldRecorder.onstop = null;
      oldRecorder.stop();
      recorderRef.current = null;
    }
    turnRef.current = crypto.randomUUID();
    startRecorder(turnRef.current, adoptedRecorder ?? undefined);
  }, [abortTurn, startRecorder, stopSegmentRecorder]);

  const setupVad = useCallback((stream: MediaStream) => {
    const context = new AudioContext();
    audioContextRef.current = context;
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    context.createMediaStreamSource(stream).connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    let consecutiveVoice = 0;
    let consecutiveBargeInVoice = 0;
    let bargeInTriggered = false;
    let noiseFloor = 0.008;
    const stopBargeInPreRoll = () => {
      const recorder = bargeInPreRollRef.current;
      bargeInPreRollRef.current = null;
      if (recorder?.state === "recording") {
        recorder.ondataavailable = null;
        recorder.onstop = null;
        recorder.stop();
      }
    };
    const startBargeInPreRoll = () => {
      if (bargeInPreRollRef.current?.state === "recording") return;
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
      const recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
      recorder.start();
      bargeInPreRollRef.current = recorder;
    };
    const tick = () => {
      if (!activeRef.current) return;
      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const sample of data) { const normalized = (sample - 128) / 128; sum += normalized * normalized; }
      const rms = Math.sqrt(sum / data.length);
      const currentStatus = statusRef.current;
      // Automatic barge-in is only useful once audio is playing. During
      // thinking, residual speech/noise must not invalidate the active turn.
      const responding = currentStatus === "speaking";
      if (currentStatus === "listening" && !heardSpeechRef.current) {
        noiseFloor = noiseFloor * 0.96 + rms * 0.04;
      }
      const speechThreshold = responding
        ? Math.max(0.01, Math.min(0.04, noiseFloor * 1.7))
        : Math.max(0.018, Math.min(0.065, noiseFloor * 2.8));
      const voice = rms > speechThreshold;
      const time = performance.now();

      if (responding) {
        consecutiveVoice = 0;
        if (voice && !bargeInTriggered && consecutiveBargeInVoice === 0) startBargeInPreRoll();
        consecutiveBargeInVoice = voice ? consecutiveBargeInVoice + 1 : Math.max(0, consecutiveBargeInVoice - 1);
        if (!bargeInTriggered && consecutiveBargeInVoice >= 8) {
          bargeInTriggered = true;
          consecutiveBargeInVoice = 0;
          const bufferedRecorder = bargeInPreRollRef.current;
          bargeInPreRollRef.current = null;
          interruptAndListen(bufferedRecorder ?? undefined);
        } else if (!bargeInTriggered && consecutiveBargeInVoice === 0 && !voice) {
          stopBargeInPreRoll();
        }
      } else if (currentStatus === "listening" && time >= vadReadyAtRef.current && voice) {
        bargeInTriggered = false;
        consecutiveBargeInVoice = 0;
        consecutiveVoice += 1;
        lastVoiceAtRef.current = time;
        if (!heardSpeechRef.current && consecutiveVoice >= 8) {
          heardSpeechRef.current = true;
          speechStartedAtRef.current = time;
        }
      } else {
        if (!responding) {
          stopBargeInPreRoll();
          bargeInTriggered = false;
          consecutiveBargeInVoice = 0;
        }
        if (currentStatus === "listening") consecutiveVoice = Math.max(0, consecutiveVoice - 1);
      }
      if (statusRef.current === "listening" && heardSpeechRef.current && recorderRef.current?.state === "recording" && time - lastVoiceAtRef.current > 1200 && time - speechStartedAtRef.current > 300) {
        stopSegmentRecorder();
        recorderRef.current.stop();
      }
      animationRef.current = requestAnimationFrame(tick);
    };
    animationRef.current = requestAnimationFrame(tick);
  }, [interruptAndListen, stopSegmentRecorder]);

  const startConversation = async () => {
    setStatus("connecting");
    setError(null);
    setEnded(false);
    clearMessages();
    pendingBookingStartRef.current = null;
    setPreliminary("");
    setFinalTranscript("");
    conversationRef.current = crypto.randomUUID();
    try {
      if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") throw new Error("Этот браузер не поддерживает запись с микрофона.");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          channelCount: { ideal: 1 },
          sampleRate: { ideal: 48_000 },
        },
      });
      streamRef.current = stream;
      setActive(true);
      activeRef.current = true;
      setupVad(stream);
      turnRef.current = crypto.randomUUID();
      startRecorder(turnRef.current);
    } catch (caught) {
      const message = caught instanceof DOMException && caught.name === "NotAllowedError"
        ? "Доступ к микрофону запрещён. Разрешите его в настройках сайта и нажмите «Повторить»."
        : caught instanceof DOMException && caught.name === "NotFoundError"
          ? "Микрофон не найден. Подключите устройство и повторите."
          : caught instanceof Error ? caught.message : "Не удалось включить микрофон.";
      setError(message);
      setStatus("error");
    }
  };

  const endConversation = useCallback(() => {
    setStatus("ending");
    pendingBookingStartRef.current = null;
    activeRef.current = false;
    setActive(false);
    abortTurn(false);
    cancelAnimationFrame(animationRef.current);
    stopSegmentRecorder();
    const preRollRecorder = bargeInPreRollRef.current;
    bargeInPreRollRef.current = null;
    if (preRollRecorder?.state === "recording") {
      preRollRecorder.ondataavailable = null;
      preRollRecorder.onstop = null;
      preRollRecorder.stop();
    }
    const recorder = recorderRef.current;
    recordingTurnRef.current = "";
    if (recorder?.state === "recording") { recorder.onstop = null; recorder.stop(); }
    recorderRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    audioContextRef.current?.close().catch(() => undefined);
    audioContextRef.current = null;
    setEnded(true);
    setStatus("idle");
  }, [abortTurn, stopSegmentRecorder]);

  useEffect(() => {
    endConversationRef.current = endConversation;
  }, [endConversation]);

  useEffect(() => () => {
    activeRef.current = false;
    cancelAnimationFrame(animationRef.current);
    if (segmentTimerRef.current !== null) window.clearTimeout(segmentTimerRef.current);
    if (segmentRecorderRef.current?.state === "recording") segmentRecorderRef.current.stop();
    if (bargeInPreRollRef.current?.state === "recording") bargeInPreRollRef.current.stop();
    controllersRef.current.forEach((controller) => controller.abort());
    streamRef.current?.getTracks().forEach((track) => track.stop());
    currentAudioRef.current?.pause();
    audioUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
  }, []);

  const submitTyped = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = typedText.trim();
    if (!text || !active) return;
    abortTurn(["thinking", "speaking"].includes(statusRef.current));
    stopSegmentRecorder();
    const recorder = recorderRef.current;
    recordingTurnRef.current = "";
    if (recorder?.state === "recording") { recorder.onstop = null; recorder.stop(); recorderRef.current = null; }
    const turnId = crypto.randomUUID();
    turnRef.current = turnId;
    setTypedText("");
    await processTranscript(text, turnId);
  };

  const changeWeek = (days: number) => setWeekAnchor((value) => { const next = new Date(value); next.setDate(next.getDate() + days); return next; });
  const userBookings = document.bookings.filter((booking) => booking.type === "user");

  return (
    <main>
      <header className="hero">
        <div className="brand"><span className="brand__mark">С</span><span>Секретарь-помощник</span></div>
        <div className="hero__grid">
          <div className="hero__copy">
            <span className="eyebrow">Голосовая запись · 30 минут</span>
            <h1>Найдём удобное время для встречи</h1>
            <p>Скажите, когда вам удобно. Помощник сверится с расписанием, предложит варианты и подтвердит запись голосом.</p>
            {!active ? (
              <button className="primary-button" onClick={startConversation} disabled={status === "connecting"}>
                <span className="mic-icon">●</span>{status === "connecting" ? "Подключаю…" : "Начать разговор"}
              </button>
            ) : (
              <div className="hero__actions">
                <button className="primary-button" onClick={() => interruptAndListen()}><span className="mic-icon">●</span>{["thinking", "speaking"].includes(status) ? "Перебить и говорить" : "Говорить сейчас"}</button>
                <button className="secondary-button" onClick={endConversation}>Завершить разговор</button>
              </div>
            )}
            <p className="privacy-note">Микрофон включается только после вашего нажатия. Записи встреч хранятся в этом браузере.</p>
          </div>

          <aside className={`conversation-card conversation-card--${status}`} aria-live="polite">
            <div className="status-line"><span className="status-dot" /><div><strong>{statusCopy[status].label}</strong><small>{statusCopy[status].hint}</small></div></div>
            <div className="voice-orb" aria-hidden="true"><span /><span /><span /><span /><span /></div>
            <p className="example">«Запиши меня завтра в 17:00»</p>
            {preliminary && <div className="transcript transcript--draft"><small>Черновик распознавания</small><p>{preliminary}</p></div>}
            {finalTranscript && <div className="transcript"><small>Окончательная реплика</small><p>{finalTranscript}</p></div>}
            {streamingText && <div className="transcript transcript--assistant"><small>Ответ формируется</small><p>{streamingText}<i className="cursor" /></p></div>}
            {error && <div className="error-box" role="alert"><p>{error}</p><button onClick={active ? () => interruptAndListen() : startConversation}>Повторить</button></div>}
          </aside>
        </div>
      </header>

      {active && (
        <section className="dialog-panel" aria-labelledby="dialog-title">
          <div className="dialog-panel__title"><div><span className="eyebrow">Текущий разговор</span><h2 id="dialog-title">История реплик</h2></div><span className="connected"><i />Сессия работает</span></div>
          <div className="messages">
            {messages.length === 0 && <p className="empty-message">Начните с фразы о дате и времени. Например: «Можно в среду в час дня?»</p>}
            {messages.map((message) => <div className={`message message--${message.role}`} key={message.id}><small>{message.role === "user" ? "Вы" : "Помощник"}</small><p>{message.text}</p>{message.interrupted && <em>Ответ прерван{message.bookingId ? ". Запись уже сохранена." : ""}</em>}</div>)}
          </div>
          <form className="text-fallback" onSubmit={submitTyped}><label htmlFor="typed">Нет микрофона? Введите фразу для проверки</label><div><input id="typed" value={typedText} onChange={(event) => setTypedText(event.target.value)} placeholder="Например: завтра в 17:00" /><button type="submit">Отправить</button></div></form>
        </section>
      )}

      {ended && (
        <section className="summary" aria-labelledby="summary-title"><div><span className="eyebrow">Разговор завершён</span><h2 id="summary-title">Итог</h2></div>{messages.length ? <div className="messages">{messages.map((message) => <div className={`message message--${message.role}`} key={`summary-${message.id}`}><small>{message.role === "user" ? "Вы" : "Помощник"}</small><p>{message.text}</p>{message.interrupted && <em>Ответ был прерван</em>}</div>)}</div> : <p>В этом разговоре не было законченных реплик.</p>}{userBookings.length > 0 && <p className="summary__booking">Последняя сохранённая встреча: <strong>{dateTimeFormatter.format(new Date(userBookings[userBookings.length - 1].start))}</strong></p>}<button className="primary-button" onClick={startConversation}>Новый разговор</button></section>
      )}

      {storageWarning && <div className="storage-warning" role="alert">{storageWarning}</div>}
      <ScheduleBoard anchor={weekAnchor} bookings={document.bookings} now={now} onPrevious={() => changeWeek(-7)} onNext={() => changeWeek(7)} onToday={() => setWeekAnchor(new Date())} />

      <footer><p>Рабочее время: понедельник–пятница, 09:00–18:00</p><p>Часовой пояс: {Intl.DateTimeFormat().resolvedOptions().timeZone}</p></footer>
    </main>
  );
}
