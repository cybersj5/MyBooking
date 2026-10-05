import { Temporal } from '@js-temporal/polyfill';

export interface TimeInterval {
  startAtMs: number;
  endAtMs: number;
}

function assertEpochMilliseconds(value: number): void {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError('Некорректный UTC-момент');
  }
  Temporal.Instant.fromEpochMilliseconds(value);
}

function assertOrderedInterval(interval: TimeInterval): void {
  assertEpochMilliseconds(interval.startAtMs);
  assertEpochMilliseconds(interval.endAtMs);
  if (interval.startAtMs >= interval.endAtMs) {
    throw new RangeError('Некорректный интервал');
  }
}

export function overlaps(a: TimeInterval, b: TimeInterval): boolean {
  assertOrderedInterval(a);
  assertOrderedInterval(b);
  return a.startAtMs < b.endAtMs && b.startAtMs < a.endAtMs;
}

export function contains(container: TimeInterval, candidate: TimeInterval): boolean {
  assertOrderedInterval(container);
  assertOrderedInterval(candidate);
  return container.startAtMs <= candidate.startAtMs && candidate.endAtMs <= container.endAtMs;
}

export function isWithinSubmissionWindow(startAtMs: number, nowMs: number): boolean {
  assertEpochMilliseconds(startAtMs);
  assertEpochMilliseconds(nowMs);
  const hourMs = 60 * 60 * 1000;
  return startAtMs >= nowMs + 24 * hourMs && startAtMs <= nowMs + 30 * 24 * hourMs;
}

export function isBeforeThreeHourDeadline(startAtMs: number, nowMs: number): boolean {
  assertEpochMilliseconds(startAtMs);
  assertEpochMilliseconds(nowMs);
  return nowMs <= startAtMs - 3 * 60 * 60 * 1000;
}

export interface PossibleInstant {
  epochMilliseconds: number;
  offset: string;
}

export function possibleInstants(
  localDate: string,
  localTime: string,
  timeZone: string,
): PossibleInstant[] {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(localDate) || !/^\d{2}:\d{2}$/.test(localTime)) {
    throw new RangeError('Некорректные локальные дата или время');
  }
  if (
    !timeZone ||
    timeZone !== timeZone.trim() ||
    /^[+-]/.test(timeZone) ||
    timeZone.includes('[') ||
    timeZone.includes(']')
  ) {
    throw new RangeError('Некорректный часовой пояс');
  }

  new Intl.DateTimeFormat('en', { timeZone });
  const date = Temporal.PlainDate.from(localDate);
  const time = Temporal.PlainTime.from(localTime);
  const fields = {
    year: date.year,
    month: date.month,
    day: date.day,
    hour: time.hour,
    minute: time.minute,
    timeZone,
  };
  const candidates = (['earlier', 'later'] as const).map((disambiguation) =>
    Temporal.ZonedDateTime.from(fields, { disambiguation }),
  );

  return candidates
    .filter(
      (candidate) =>
        candidate.year === date.year &&
        candidate.month === date.month &&
        candidate.day === date.day &&
        candidate.hour === time.hour &&
        candidate.minute === time.minute,
    )
    .map((candidate) => {
      assertEpochMilliseconds(candidate.epochMilliseconds);
      return {
        epochMilliseconds: candidate.epochMilliseconds,
        offset: candidate.offset,
      };
    })
    .filter(
      (candidate, index, all) =>
        all.findIndex((other) => other.epochMilliseconds === candidate.epochMilliseconds) === index,
    )
    .sort((a, b) => a.epochMilliseconds - b.epochMilliseconds);
}

export function formatInstant(epochMilliseconds: number, timeZone: string): string {
  assertEpochMilliseconds(epochMilliseconds);
  if (
    !timeZone ||
    timeZone !== timeZone.trim() ||
    /^[+-]/.test(timeZone) ||
    timeZone.includes('[') ||
    timeZone.includes(']')
  ) {
    throw new RangeError('Некорректный часовой пояс');
  }
  new Intl.DateTimeFormat('en', { timeZone });

  return Temporal.Instant.fromEpochMilliseconds(epochMilliseconds)
    .toZonedDateTimeISO(timeZone)
    .toString({ timeZoneName: 'never', calendarName: 'never' });
}

export function endAfterDuration(startAtMs: number, durationMinutes: number): number {
  assertEpochMilliseconds(startAtMs);
  if (durationMinutes !== 15 && durationMinutes !== 30 && durationMinutes !== 60) {
    throw new RangeError('Некорректная длительность');
  }
  const endAtMs = startAtMs + durationMinutes * 60 * 1000;
  assertEpochMilliseconds(endAtMs);
  return endAtMs;
}

export function isAlignedStart(epochMilliseconds: number, timeZone: string): boolean {
  assertEpochMilliseconds(epochMilliseconds);
  if (
    !timeZone ||
    timeZone !== timeZone.trim() ||
    /^[+-]/.test(timeZone) ||
    timeZone.includes('[') ||
    timeZone.includes(']')
  ) {
    throw new RangeError('Некорректный часовой пояс');
  }
  new Intl.DateTimeFormat('en', { timeZone });

  const local =
    Temporal.Instant.fromEpochMilliseconds(epochMilliseconds).toZonedDateTimeISO(timeZone);
  return (
    local.minute % 15 === 0 &&
    local.second === 0 &&
    local.millisecond === 0 &&
    local.microsecond === 0 &&
    local.nanosecond === 0
  );
}
