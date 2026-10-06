// Покрытие бронирования расписанием эксперта: каждое будущее бронирование
// сравнивается с предложенным расписанием (часовой пояс + недельные слоты +
// исключённые даты). Если интервал брони целиком укладывается хотя бы в один
// слот, бронирование остаётся валидным; иначе попадает в affectedBookings
// (PDR §4.6, ONTOLOGY §5.3).
import { Temporal } from '@js-temporal/polyfill';
import type { WeeklyInterval } from '../repository.js';
import { whollyWithinLocalInterval } from './public-slots.js';

function minutes(time: string): number {
  const [hours, minute] = time.split(':').map(Number);
  return hours! * 60 + minute!;
}

// Покрыт ли UTC-интервал расписанием: не в исключённой дате и каждый сегмент
// (разделённый по границам DST) попадает в один из недельных интервалов.
export function isCoveredBySchedule(
  startUtc: number,
  endUtc: number,
  timezone: string,
  weeklyIntervals: readonly WeeklyInterval[],
  excludedDates: readonly string[],
): boolean {
  const excluded = new Set(excludedDates);
  let segmentStart = startUtc;
  while (segmentStart < endUtc) {
    const zoned =
      Temporal.Instant.fromEpochMilliseconds(segmentStart).toZonedDateTimeISO(timezone);
    const transition = zoned.getTimeZoneTransition('next');
    const segmentEnd = Math.min(endUtc, transition?.epochMilliseconds ?? endUtc);
    const localDate = zoned.toPlainDate().toString();
    if (excluded.has(localDate)) return false;
    const weekday = zoned.dayOfWeek;
    let covered = false;
    for (const interval of weeklyIntervals) {
      if (interval.weekday !== weekday) continue;
      const firstMinute = minutes(interval.startLocal);
      const lastMinute = minutes(interval.endLocal);
      if (
        whollyWithinLocalInterval(
          segmentStart,
          segmentEnd,
          localDate,
          firstMinute,
          lastMinute,
          timezone,
        )
      ) {
        covered = true;
        break;
      }
    }
    if (!covered) return false;
    segmentStart = segmentEnd;
  }
  return true;
}
