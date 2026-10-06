// Снимок последствий смены расписания: какие будущие бронирования
// эксперта-организатора перестанут попадать в новое расписание, плюс
// непрозрачная `version` для сравнения на PUT (PDR §4.6, AVAIL-01,
// онтология §5.3, ADR-001 §2).
import { createHash } from 'node:crypto';
import {
  findExpertById,
  findFutureOrganizerBookings,
  readScheduleRows,
  type AuthDatabase,
  type FutureOrganizerBookingRow,
  type WeeklyInterval,
} from '../repository.js';
import { isCoveredBySchedule } from './coverage.js';

export type AffectedBooking = {
  id: string;
  status: string;
};

export type AvailabilityPreview = {
  version: string;
  affectedBookings: AffectedBooking[];
};

type ProposedSchedule = {
  timezone: string;
  weeklyIntervals: WeeklyInterval[];
  excludedDates: string[];
};

function hashSchedule(schedule: ProposedSchedule): string {
  const payload = JSON.stringify(schedule);
  return createHash('sha256').update(payload).digest('hex');
}

// Хэш набора (id, status, startUtc) — порядок фиксируем сортировкой по id.
function hashBookingList(rows: readonly FutureOrganizerBookingRow[]): string {
  const sorted = [...rows].sort((left, right) => left.id.localeCompare(right.id));
  const payload = sorted
    .map((row) => `${row.id}\t${row.status}\t${row.startUtc}`)
    .join('\n');
  return createHash('sha256').update(payload).digest('hex');
}

// Непрозрачная `version` для цикла preview → PUT.
// Состав: sha256(expertId, от хэша предложенного расписания, от хэша полного
// списка будущих организаторских бронирований). Полный список включён в
// версию, чтобы появление новой pending между preview и PUT (даже если она
// попадает в новое расписание и формально не «затронута») меняло версию и
// приводило к 409. Усечение до 16 hex-символов сохраняет требование
// «непрозрачная строка» и оставляет достаточно энтропии.
export function computeAvailabilityVersion(
  expertId: string,
  schedule: ProposedSchedule,
  futureBookings: readonly FutureOrganizerBookingRow[],
): string {
  const digest = createHash('sha256');
  digest.update(expertId);
  digest.update('\0');
  digest.update(hashSchedule(schedule));
  digest.update('\0');
  digest.update(hashBookingList(futureBookings));
  return digest.digest('hex').slice(0, 16);
}

function readProposedSchedule(database: AuthDatabase, expertId: string): ProposedSchedule {
  const expert = findExpertById(database, expertId);
  if (!expert || expert.timezone === null) throw new Error('Expert profile incomplete');
  const rows = readScheduleRows(database, expertId);
  return {
    timezone: expert.timezone,
    weeklyIntervals: rows.weeklyIntervals,
    excludedDates: rows.excludedDates,
  };
}

export function computeAffectedBookings(
  database: AuthDatabase,
  expertId: string,
  nowMs: number,
  schedule: ProposedSchedule,
): { affected: AffectedBooking[]; future: FutureOrganizerBookingRow[] } {
  const future = findFutureOrganizerBookings(database, expertId, nowMs);
  const affected: AffectedBooking[] = [];
  for (const row of future) {
    if (
      isCoveredBySchedule(
        row.startUtc,
        row.endUtc,
        schedule.timezone,
        schedule.weeklyIntervals,
        schedule.excludedDates,
      )
    )
      continue;
    affected.push({ id: row.id, status: row.status });
  }
  return { affected, future };
}

export function previewAvailability(
  database: AuthDatabase,
  expertId: string,
  nowMs: number,
): AvailabilityPreview {
  const schedule = readProposedSchedule(database, expertId);
  const { affected, future } = computeAffectedBookings(database, expertId, nowMs, schedule);
  const version = computeAvailabilityVersion(expertId, schedule, future);
  return { version, affectedBookings: affected };
}
