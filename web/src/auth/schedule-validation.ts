// Чистая валидация черновика расписания на клиенте. Не делает сетевых вызовов и не
// зависит от React. Используется для подсветки полей и блокировки кнопки «Сохранить».

import type { WeeklyInterval, AvailabilityInput } from './schedule-api';

export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
export const STEP_MINUTES = 15;
export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const WEEKDAYS: ReadonlySet<number> = new Set([1, 2, 3, 4, 5, 6, 7]);

export function isTimeValid(value: string): boolean {
  if (!TIME_PATTERN.test(value)) return false;
  const minutes = Number(value.slice(3, 5));
  return minutes % STEP_MINUTES === 0;
}

export function isDateValid(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  // Проверяем, что после разбора календарная дата не «перетекла» в другой день.
  return (
    parsed.getUTCFullYear() === Number(value.slice(0, 4)) &&
    parsed.getUTCMonth() + 1 === Number(value.slice(5, 7)) &&
    parsed.getUTCDate() === Number(value.slice(8, 10))
  );
}

function timeToMinutes(value: string): number {
  const [h, m] = value.split(':');
  return Number(h) * 60 + Number(m);
}

export function intervalIsValid(interval: WeeklyInterval): string | null {
  if (!WEEKDAYS.has(interval.weekday)) {
    return 'День недели должен быть от 1 до 7.';
  }
  if (!isTimeValid(interval.startLocal) || !isTimeValid(interval.endLocal)) {
    return 'Время должно быть кратно 15 минутам.';
  }
  if (interval.endLocal === '24:00') {
    return 'Конец не может быть 24:00.';
  }
  if (timeToMinutes(interval.endLocal) <= timeToMinutes(interval.startLocal)) {
    return 'Конец должен быть позже начала.';
  }
  return null;
}

function intervalsOverlap(a: WeeklyInterval, b: WeeklyInterval): boolean {
  if (a.weekday !== b.weekday) return false;
  return (
    timeToMinutes(a.startLocal) < timeToMinutes(b.endLocal) &&
    timeToMinutes(b.startLocal) < timeToMinutes(a.endLocal)
  );
}

export function groupByWeekday(intervals: WeeklyInterval[]): Map<number, WeeklyInterval[]> {
  const map = new Map<number, WeeklyInterval[]>();
  for (const item of intervals) {
    const list = map.get(item.weekday);
    if (list) {
      list.push(item);
    } else {
      map.set(item.weekday, [item]);
    }
  }
  return map;
}

export type ValidationIssue = {
  path: string;
  message: string;
};

export function validateDraft(input: AvailabilityInput): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seenWeekdays = new Map<number, WeeklyInterval[]>();

  input.weeklyIntervals.forEach((interval, index) => {
    const message = intervalIsValid(interval);
    if (message) {
      issues.push({ path: `weeklyIntervals[${index}]`, message });
      return;
    }
    const list = seenWeekdays.get(interval.weekday) ?? [];
    list.push(interval);
    seenWeekdays.set(interval.weekday, list);
  });

  for (const [weekday, list] of seenWeekdays) {
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a && b && intervalsOverlap(a, b)) {
          issues.push({
            path: `weeklyIntervals.weekday[${weekday}]`,
            message: 'Интервалы в одном дне не должны пересекаться.',
          });
        }
      }
    }
  }

  const seenDates = new Set<string>();
  input.excludedDates.forEach((date, index) => {
    if (!isDateValid(date)) {
      issues.push({ path: `excludedDates[${index}]`, message: 'Дата должна быть в формате ГГГГ-ММ-ДД.' });
      return;
    }
    if (seenDates.has(date)) {
      issues.push({ path: `excludedDates[${index}]`, message: 'Дата уже добавлена.' });
    }
    seenDates.add(date);
  });

  return issues;
}

export const WEEKDAY_LABELS: Readonly<Record<number, string>> = {
  1: 'Понедельник',
  2: 'Вторник',
  3: 'Среда',
  4: 'Четверг',
  5: 'Пятница',
  6: 'Суббота',
  7: 'Воскресенье',
};

export const BOOKING_STATUS_LABELS: Readonly<Record<'pending' | 'confirmed', string>> = {
  pending: 'ожидает решения',
  confirmed: 'подтверждена',
};
