import { createHash, randomUUID } from 'node:crypto';
import { Temporal } from '@js-temporal/polyfill';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { createGuestAuth } from '../auth/guest-auth.js';
import {
  endAfterDuration,
  isAlignedStart,
  isWithinSubmissionWindow,
  overlaps,
  type TimeInterval,
} from '../time/index.js';
import {
  findExpertByPublicId,
  findIdempotencyRecord,
  immediate,
  insertBooking,
  insertBookingTransition,
  insertIdempotencyRecord,
  readConfirmedBusyForParticipants,
  readScheduleRows,
  recordBookingConsent,
  type AuthDatabase,
  type WeeklyInterval,
} from '../repository.js';

const TOPIC_MIN = 1;
const TOPIC_MAX = 120;
const DESCRIPTION_MAX = 2000;
const SCHEDULE_DATE_FORMAT = /^\d{4}-\d{2}-\d{2}$/;

const idKey = z.string().trim().min(1).max(200);

const bodySchema = z.object({
  guestProof: z.string().regex(/^[a-f0-9]{64}$/, 'Некорректное подтверждение email.'),
  guestName: z.string().trim().min(1).max(120),
  guestTimezone: z.string().min(1).max(64),
  startAt: z.iso.datetime({ offset: true }),
  durationMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]).or(
    z
      .number()
      .int()
      .refine((value) => value === 15 || value === 30 || value === 60),
  ),
  topic: z.string().trim().min(TOPIC_MIN).max(TOPIC_MAX),
  description: z.string().trim().max(DESCRIPTION_MAX).optional(),
  consentVersion: z.string().min(1).max(64),
  consentAccepted: z.literal(true),
});

type Body = z.infer<typeof bodySchema>;

type Failure =
  | 'invalid_input'
  | 'not_found'
  | 'profile_incomplete'
  | 'time_unavailable'
  | 'idempotency_conflict';

function publicError(code: Failure, message: string) {
  return { code, message };
}

function canonicalizeBody(value: unknown): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return JSON.stringify(value);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const entries: Record<string, unknown> = {};
  for (const key of keys) entries[key] = record[key];
  return JSON.stringify(entries);
}

function hashPayload(scope: string, value: string): string {
  return createHash('sha256').update(scope).update('\0').update(value).digest('hex');
}

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

function findCoveringInterval(input: {
  startAtMs: number;
  endAtMs: number;
  timezone: string;
  weeklyIntervals: WeeklyInterval[];
  excludedDates: Set<string>;
}): WeeklyInterval | undefined {
  if (input.excludedDates.size > 0) {
    const zoned = Temporal.Instant.fromEpochMilliseconds(input.startAtMs).toZonedDateTimeISO(
      input.timezone,
    );
    const localDate = zoned.toPlainDate().toString();
    if (input.excludedDates.has(localDate)) return undefined;
  }
  for (const interval of input.weeklyIntervals) {
    const [startHour, startMinute] = interval.startLocal.split(':').map(Number);
    const [endHour, endMinute] = interval.endLocal.split(':').map(Number);
    const firstMinute = (startHour ?? 0) * 60 + (startMinute ?? 0);
    const lastMinute = (endHour ?? 0) * 60 + (endMinute ?? 0);
    const zoned = Temporal.Instant.fromEpochMilliseconds(input.startAtMs).toZonedDateTimeISO(
      input.timezone,
    );
    const localDate = zoned.toPlainDate().toString();
    if (interval.weekday !== zoned.dayOfWeek) continue;
    if (
      !whollyWithinLocalInterval(
        input.startAtMs,
        input.endAtMs,
        localDate,
        firstMinute,
        lastMinute,
        input.timezone,
      )
    )
      continue;
    return interval;
  }
  return undefined;
}

function parseScheduleDate(value: string): boolean {
  if (!SCHEDULE_DATE_FORMAT.test(value)) return false;
  try {
    Temporal.PlainDate.from(value, { overflow: 'reject' });
    return true;
  } catch {
    return false;
  }
}

function parseStartInstant(value: string): number | undefined {
  const instant = Temporal.Instant.from(value);
  return instant.epochMilliseconds;
}

function isValidTimeZone(value: string): boolean {
  if (!value || value !== value.trim()) return false;
  if (/^[+-]/.test(value) || value.includes('[') || value.includes(']')) return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function buildBookingResponse(input: {
  id: string;
  startAtMs: number;
  endAtMs: number;
  topic: string;
  description?: string;
  guestName: string;
  guestTimezone: string;
  expertName: string;
  expertPublicId: string;
}) {
  const response: {
    id: string;
    status: 'pending';
    startAt: string;
    endAt: string;
    topic: string;
    description?: string;
    guestName: string;
    guestTimezone: string;
    expertName: string;
    expertPublicId: string;
    completed: false;
  } = {
    id: input.id,
    status: 'pending',
    startAt: new Date(input.startAtMs).toISOString(),
    endAt: new Date(input.endAtMs).toISOString(),
    topic: input.topic,
    guestName: input.guestName,
    guestTimezone: input.guestTimezone,
    expertName: input.expertName,
    expertPublicId: input.expertPublicId,
    completed: false,
  };
  if (input.description !== undefined) response.description = input.description;
  return response;
}

export function registerBookingCreate(
  app: FastifyInstance,
  options: {
    database: AuthDatabase;
    now: () => number;
    consentVersion: string;
    allowedOrigin: string;
    guest: ReturnType<typeof createGuestAuth>;
  },
) {
  app.post<{ Params: { publicId: string } }>(
    '/api/v1/experts/:publicId/bookings',
    async (request, reply) => {
      if (request.headers.origin !== options.allowedOrigin) {
        return reply.code(403).send(publicError('invalid_input', 'Недопустимый источник запроса.'));
      }
      const idempotencyKey = idKey.safeParse(request.headers['idempotency-key']);
      if (!idempotencyKey.success) {
        return reply.code(400).send(publicError('invalid_input', 'Укажите ключ идемпотентности.'));
      }
      const parsed = bodySchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send(publicError('invalid_input', 'Проверьте параметры заявки.'));
      }
      const body: Body = parsed.data;
      if (body.consentVersion !== options.consentVersion) {
        return reply
          .code(400)
          .send(publicError('invalid_input', 'Согласие на обработку устарело.'));
      }
      if (!isValidTimeZone(body.guestTimezone)) {
        return reply.code(400).send(publicError('invalid_input', 'Проверьте часовой пояс гостя.'));
      }
      const startAtMs = parseStartInstant(body.startAt);
      if (startAtMs === undefined) {
        return reply.code(400).send(publicError('invalid_input', 'Проверьте момент начала.'));
      }
      let endAtMs: number;
      try {
        endAtMs = endAfterDuration(startAtMs, body.durationMinutes);
      } catch {
        return reply
          .code(400)
          .send(publicError('invalid_input', 'Проверьте длительность встречи.'));
      }
      const nowMs = options.now();
      if (!isWithinSubmissionWindow(startAtMs, nowMs)) {
        return reply.code(400).send(publicError('invalid_input', 'Время вне окна подачи заявки.'));
      }
      const expert = findExpertByPublicId(options.database, request.params.publicId);
      if (!expert || !expert.timezone || !expert.name) {
        return reply.code(404).send(publicError('not_found', 'Эксперт не найден.'));
      }
      const expertTimezone = expert.timezone;
      const expertName = expert.name;
      const expertPublicId = expert.publicId;
      const expertId = expert.id;
      if (!isAlignedStart(startAtMs, expertTimezone)) {
        return reply
          .code(400)
          .send(publicError('invalid_input', 'Момент начала должен быть кратен 15 минутам.'));
      }
      const result = immediate(options.database, () => {
        const scope = `guest_booking:${request.params.publicId}`;
        const keyHash = hashPayload(scope, idempotencyKey.data);
        const bodyHash = hashPayload(scope, canonicalizeBody(body));
        const existing = findIdempotencyRecord(options.database, scope, keyHash);
        if (existing) {
          if (existing.bodyHash === bodyHash) {
            return {
              kind: 'replay' as const,
              status: 201 as const,
              value: JSON.parse(existing.resultJson) as Record<string, unknown>,
            };
          }
          return {
            kind: 'idempotency_conflict' as const,
            status: 409 as const,
            reason: 'idempotency_conflict' as const,
          };
        }
        const proofResult = options.guest.resolveGuestProof(
          body.guestProof,
          request.params.publicId,
        );
        if (!proofResult.ok) {
          return {
            kind: 'invalid_input' as const,
            status: 400 as const,
            reason: 'invalid_input' as const,
          };
        }
        const schedule = readScheduleRows(options.database, expertId);
        const excluded = new Set(
          schedule.excludedDates.filter((value) => parseScheduleDate(value)),
        );
        const covering = findCoveringInterval({
          startAtMs,
          endAtMs,
          timezone: expertTimezone,
          weeklyIntervals: schedule.weeklyIntervals,
          excludedDates: excluded,
        });
        if (!covering) {
          return {
            kind: 'time_unavailable' as const,
            status: 400 as const,
            reason: 'time_unavailable' as const,
          };
        }
        const busy = readConfirmedBusyForParticipants(
          options.database,
          expertId,
          proofResult.value.email,
        );
        const candidate: TimeInterval = { startAtMs, endAtMs };
        if (busy.some((interval) => overlaps(candidate, interval))) {
          return {
            kind: 'time_unavailable' as const,
            status: 409 as const,
            reason: 'time_unavailable' as const,
          };
        }
        const bookingId = randomUUID();
        const transitionId = randomUUID();
        const consentId = randomUUID();
        const idempotencyId = randomUUID();
        const description = body.description === undefined ? null : body.description.trim();
        insertBooking(options.database, {
          id: bookingId,
          expertId,
          guestEmail: proofResult.value.email,
          guestName: body.guestName,
          guestTimezone: body.guestTimezone,
          startUtc: startAtMs,
          endUtc: endAtMs,
          subject: body.topic,
          description,
          now: nowMs,
        });
        insertBookingTransition(options.database, {
          id: transitionId,
          bookingId,
          fromStatus: null,
          now: nowMs,
        });
        recordBookingConsent(options.database, {
          id: consentId,
          bookingId,
          version: body.consentVersion,
          now: nowMs,
        });
        options.guest.consumeProof(proofResult.value.proofId);
        const response = buildBookingResponse({
          id: bookingId,
          startAtMs,
          endAtMs,
          topic: body.topic,
          ...(description === null ? {} : { description }),
          guestName: body.guestName,
          guestTimezone: body.guestTimezone,
          expertName: expertName,
          expertPublicId,
        });
        insertIdempotencyRecord(options.database, {
          id: idempotencyId,
          scope,
          keyHash,
          bodyHash,
          resultJson: JSON.stringify(response),
          now: nowMs,
        });
        options.guest.createBookingAccess(bookingId, proofResult.value.email);
        return {
          kind: 'created' as const,
          status: 201 as const,
          value: response,
        };
      });
      if (result.kind === 'replay') {
        return reply.code(result.status).send(result.value);
      }
      if (result.kind === 'created') {
        return reply.code(result.status).send(result.value);
      }
      return reply
        .code(result.status)
        .send(publicError(result.reason, 'Не удалось создать заявку.'));
    },
  );
}
