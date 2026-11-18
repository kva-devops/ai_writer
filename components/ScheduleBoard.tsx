"use client";

import { buildDaySlots, buildWeekDays, dateKey, localIso, startOfWeek } from "@/lib/schedule";
import type { Booking } from "@/lib/types";

type Props = {
  anchor: Date;
  bookings: Booking[];
  now: Date;
  onPrevious: () => void;
  onNext: () => void;
  onToday: () => void;
};

const dayFormatter = new Intl.DateTimeFormat("ru-RU", { weekday: "short", day: "numeric", month: "short" });
const monthFormatter = new Intl.DateTimeFormat("ru-RU", { day: "numeric", month: "long" });
const timeFormatter = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });

export function ScheduleBoard({ anchor, bookings, now, onPrevious, onNext, onToday }: Props) {
  const days = buildWeekDays(anchor);
  const monday = startOfWeek(anchor);
  const friday = days[4];

  return (
    <section className="schedule" aria-labelledby="schedule-title">
      <div className="schedule__head">
        <div>
          <span className="eyebrow">Расписание</span>
          <h2 id="schedule-title">{monthFormatter.format(monday)} — {monthFormatter.format(friday)}</h2>
        </div>
        <div className="week-nav" aria-label="Навигация по неделям">
          <button className="icon-button" onClick={onPrevious} aria-label="Предыдущая неделя">←</button>
          <button className="text-button" onClick={onToday}>Сегодня</button>
          <button className="icon-button" onClick={onNext} aria-label="Следующая неделя">→</button>
        </div>
      </div>

      <div className="legend" aria-label="Обозначения расписания">
        <span><i className="legend__dot legend__dot--free" />Свободно</span>
        <span><i className="legend__dot legend__dot--busy" />Занято</span>
        <span><i className="legend__dot legend__dot--past" />Прошло</span>
      </div>

      <div className="days" tabIndex={0} aria-label="Рабочая неделя. На узком экране прокручивается горизонтально.">
        {days.map((day) => {
          const today = dateKey(day) === dateKey(now);
          return (
            <article className="day" key={dateKey(day)}>
              <header className={today ? "day__title day__title--today" : "day__title"}>
                <span>{dayFormatter.format(day)}</span>
                {today && <em>сегодня</em>}
              </header>
              <div className="slots">
                {buildDaySlots(day).map((start) => {
                  const iso = localIso(start);
                  const booking = bookings.find((item) => new Date(item.start).getTime() === start.getTime());
                  const past = start.getTime() <= now.getTime();
                  const state = past ? "past" : booking ? "busy" : "free";
                  const end = new Date(start.getTime() + 30 * 60_000);
                  return (
                    <div className={`slot slot--${state}`} key={iso} aria-label={`${dayFormatter.format(day)}, ${timeFormatter.format(start)}–${timeFormatter.format(end)}, ${state === "free" ? "свободно" : state === "busy" ? "занято" : "прошло"}`}>
                      <strong>{timeFormatter.format(start)}</strong>
                      <span>{timeFormatter.format(end)}</span>
                      <small>{state === "free" ? "свободно" : state === "busy" ? "занято" : "прошло"}</small>
                    </div>
                  );
                })}
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
