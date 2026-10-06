import { Temporal } from '@js-temporal/polyfill';
import {
  endAfterDuration,
  formatInstant,
  isWithinSubmissionWindow,
  overlaps,
  possibleInstants,
  type TimeInterval,
} from '../time/index.js';
import type { WeeklyInterval } from '../repository.js';

function whollyWithinLocalInterval(
  startAtMs: number,
  endAtMs: number,
  localDate: string,
  firstMinute: number,
  lastMinute: number,
  timezone: string,
): boolean {
  function inside(epochMilliseconds: number) {
    const local =
      Temporal.Instant.fromEpochMilliseconds(epochMilliseconds).toZonedDateTimeISO(timezone);
    const minute = local.hour * 60 + local.minute;
    return (
      local.toPlainDate().toString() === localDate && minute >= firstMinute && minute < lastMinute
    );
  }

  let segmentStart = startAtMs;
  while (segmentStart < endAtMs) {
    const zoned = Temporal.Instant.fromEpochMilliseconds(segmentStart).toZonedDateTimeISO(timezone);
    const transition = zoned.getTimeZoneTransition('next');
    const segmentEnd = Math.min(endAtMs, transition?.epochMilliseconds ?? endAtMs);
    if (!inside(segmentStart) || !inside(segmentEnd - 1)) return false;
    segmentStart = segmentEnd;
  }
  return true;
}

export function calculatePublicSlots(input: {
  timezone: string;
  weeklyIntervals: WeeklyInterval[];
  excludedDates: string[];
  from: string;
  to: string;
  durationMinutes: 15 | 30 | 60;
  nowMs: number;
  busyIntervals: TimeInterval[];
}) {
  const slots: { startAt: string }[] = [];
  const excluded = new Set(input.excludedDates);
  for (
    let day = Temporal.PlainDate.from(input.from), last = Temporal.PlainDate.from(input.to);
    Temporal.PlainDate.compare(day, last) < 0;
    day = day.add({ days: 1 })
  ) {
    const localDate = day.toString();
    if (excluded.has(localDate)) continue;
    for (const interval of input.weeklyIntervals) {
      if (interval.weekday !== day.dayOfWeek) continue;
      const [startHour, startMinute] = interval.startLocal.split(':').map(Number);
      const [endHour, endMinute] = interval.endLocal.split(':').map(Number);
      const firstMinute = startHour! * 60 + startMinute!;
      const lastMinute = endHour! * 60 + endMinute!;
      for (let minute = firstMinute; minute < lastMinute; minute += 15) {
        const localTime = `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;
        for (const instant of possibleInstants(localDate, localTime, input.timezone)) {
          if (!isWithinSubmissionWindow(instant.epochMilliseconds, input.nowMs)) continue;
          const candidate = {
            startAtMs: instant.epochMilliseconds,
            endAtMs: endAfterDuration(instant.epochMilliseconds, input.durationMinutes),
          };
          if (
            !whollyWithinLocalInterval(
              candidate.startAtMs,
              candidate.endAtMs,
              localDate,
              firstMinute,
              lastMinute,
              input.timezone,
            )
          )
            continue;
          if (input.busyIntervals.some((busy) => overlaps(candidate, busy))) continue;
          slots.push({ startAt: formatInstant(instant.epochMilliseconds, input.timezone) });
        }
      }
    }
  }
  return slots;
}
