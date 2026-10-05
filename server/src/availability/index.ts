import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  readScheduleRows,
  replaceScheduleRows,
  type AuthDatabase,
  type WeeklyInterval,
} from '../repository.js';

const time = z.string().regex(/^([01]\d|2[0-3]):(00|15|30|45)$/);
const endTime = z.string().regex(/^(([01]\d|2[0-3]):(00|15|30|45)|24:00)$/);
const intervalSchema = z.object({
  weekday: z.number().int().min(1).max(7),
  startLocal: time,
  endLocal: endTime,
});
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((date) => {
    const parsed = new Date(`${date}T00:00:00Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === date;
  });
const scheduleSchema = z.object({
  weeklyIntervals: z.array(intervalSchema),
  excludedDates: z.array(dateSchema),
});

function minutes(value: string) {
  const [hours, minute] = value.split(':').map(Number);
  return hours! * 60 + minute!;
}

export function validateAvailability(input: unknown) {
  const schedule = scheduleSchema.parse(input);
  const intervals: WeeklyInterval[] = [...schedule.weeklyIntervals].sort(
    (left, right) =>
      left.weekday - right.weekday || minutes(left.startLocal) - minutes(right.startLocal),
  );
  for (let index = 0; index < intervals.length; index++) {
    const current = intervals[index]!;
    if (minutes(current.startLocal) >= minutes(current.endLocal)) {
      throw new Error('Invalid weekly interval');
    }
    const previous = intervals[index - 1];
    if (
      previous &&
      previous.weekday === current.weekday &&
      minutes(previous.endLocal) > minutes(current.startLocal)
    ) {
      throw new Error('Overlapping weekly intervals');
    }
  }
  if (new Set(schedule.excludedDates).size !== schedule.excludedDates.length) {
    throw new Error('Duplicate excluded date');
  }
  return { weeklyIntervals: intervals, excludedDates: [...schedule.excludedDates].sort() };
}

export function readAvailability(database: AuthDatabase, expertId: string) {
  const schedule = readScheduleRows(database, expertId);
  const version = createHash('sha256').update(JSON.stringify(schedule)).digest('hex');
  return { ...schedule, version };
}

export function replaceAvailability(database: AuthDatabase, expertId: string, input: unknown) {
  const schedule = validateAvailability(input);
  replaceScheduleRows(database, expertId, schedule.weeklyIntervals, schedule.excludedDates);
  return readAvailability(database, expertId);
}
