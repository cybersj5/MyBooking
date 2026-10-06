// Атомарная смена расписания эксперта: под BEGIN IMMEDIATE повторно
// пересчитывает `version` и список последствий, требует confirmAffected
// при непустом списке, закрывает затронутые бронирования, пишет переходы
// и ставит в очередь notify-задачи. Транзакция охватывает и замену
// расписания, поэтому срабатывание SQL-триггера на excluded_date откатывает
// всё изменение (PDR §4.6, BOOK-01, ADR-001 §2, ONTOLOGY §5.3, §6).
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  enqueueJob,
  findIdempotencyRecord,
  immediate,
  insertBookingTransitionFull,
  insertIdempotencyRecord,
  replaceScheduleRowsInTransaction,
  updateBookingStatusCancelled,
  updateBookingStatusRejected,
  type AuthDatabase,
} from '../repository.js';
import { readAvailability, validateAvailability } from './index.js';
import {
  computeAffectedBookings,
  computeAvailabilityVersion,
  type AffectedBooking,
} from './preview.js';
import type { createExpertAuth } from '../auth/expert-auth.js';

type Failure =
  | 'invalid_input'
  | 'profile_incomplete'
  | 'stale_version'
  | 'confirmation_required'
  | 'idempotency_conflict';

const idKeySchema = z.string().trim().min(1).max(200);
const bodySchema = z.object({
  weeklyIntervals: z.array(z.unknown()),
  excludedDates: z.array(z.unknown()),
  version: z.string().min(1).max(64),
  confirmAffected: z.boolean().optional(),
});

type UpdateOptions = {
  database: AuthDatabase;
  now: () => number;
  allowedOrigin: string;
  auth: ReturnType<typeof createExpertAuth>;
  cookieToken: (cookie: string | undefined) => string | undefined;
};

function publicError(code: Failure | 'forbidden' | 'unauthenticated', message: string) {
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

// Под блокировкой BEGIN IMMEDIATE: повторно считает список будущих
// организаторских бронирований (расписание ещё не заменено) и непрозрачную
// `version`. Если она не совпала с пришедшей — значит, что-то изменилось:
// либо само расписание, либо появилась новая заявка. В обоих случаях
// возвращаем 409 без побочных эффектов.
function computeFreshVersion(
  database: AuthDatabase,
  expertId: string,
  timezone: string,
  proposedWeekly: { weekday: number; startLocal: string; endLocal: string }[],
  proposedExcluded: string[],
  nowMs: number,
): { version: string; affected: AffectedBooking[] } {
  const { affected, future } = computeAffectedBookings(database, expertId, nowMs, {
    timezone,
    weeklyIntervals: proposedWeekly,
    excludedDates: proposedExcluded,
  });
  const version = computeAvailabilityVersion(
    expertId,
    {
      timezone,
      weeklyIntervals: proposedWeekly,
      excludedDates: proposedExcluded,
    },
    future,
  );
  return { version, affected };
}

// Переводит каждое затронутое бронирование в cancelled/rejected, пишет
// переход и ставит в очередь notify-задачу с дедупликацией по
// notify:<type>:<bookingId>:<scheduleChangeId>. Синхронная транзакция:
// никаких await и сетевых вызовов.
function closeAffectedBookings(
  database: AuthDatabase,
  affected: AffectedBooking[],
  nowMs: number,
  scheduleChangeId: string,
): void {
  for (const row of affected) {
    const booking = database
      .prepare(
        'SELECT id, guestEmail, status FROM bookings WHERE id = ?',
      )
      .get(row.id) as { id: string; guestEmail: string; status: string } | undefined;
    if (!booking) continue;
    if (booking.status !== row.status) continue; // состояние изменилось под блокировкой
    const newStatus = booking.status === 'confirmed' ? 'cancelled' : 'rejected';
    const updated =
      newStatus === 'cancelled'
        ? updateBookingStatusCancelled(database, booking.id, 'schedule_changed', nowMs)
        : updateBookingStatusRejected(database, booking.id, 'schedule_changed', nowMs);
    if (updated === 0) continue;
    insertBookingTransitionFull(database, {
      id: randomUUID(),
      bookingId: booking.id,
      fromStatus: booking.status,
      toStatus: newStatus,
      reason: 'schedule_changed',
      occurredAt: nowMs,
    });
    const jobType =
      newStatus === 'cancelled'
        ? 'notify_guest_meeting_cancelled'
        : 'notify_guest_meeting_rejected';
    enqueueJob(database, {
      id: randomUUID(),
      type: jobType,
      bookingId: booking.id,
      scheduledAt: nowMs,
      recipient: booking.guestEmail,
      deduplicationKey: `notify:${jobType}:${booking.id}:${scheduleChangeId}`,
    });
  }
}

export function registerAvailabilityUpdate(app: FastifyInstance, options: UpdateOptions) {
  app.post('/api/v1/me/availability/preview', async (request, reply) => {
    const current = options.auth.currentSession(options.cookieToken(request.headers.cookie));
    if (!current)
      return reply.code(401).send(publicError('unauthenticated', 'Требуется вход.'));
    if (request.headers.origin !== options.allowedOrigin)
      return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
    if (request.headers['x-csrf-token'] !== current.csrfToken)
      return reply.code(403).send(publicError('forbidden', 'Недопустимый запрос.'));
    if (current.expert.name === null || current.expert.timezone === null) {
      return reply
        .code(403)
        .send(publicError('profile_incomplete', 'Завершите профиль.'));
    }
    const parsedShape = z
      .object({
        weeklyIntervals: z.array(z.unknown()),
        excludedDates: z.array(z.unknown()),
      })
      .safeParse(request.body);
    if (!parsedShape.success) {
      return reply.code(400).send(publicError('invalid_input', 'Проверьте тело запроса.'));
    }
    try {
      validateAvailability(parsedShape.data);
    } catch {
      return reply.code(400).send(publicError('invalid_input', 'Проверьте расписание.'));
    }
    const nowMs = options.now();
    const timezone = current.expert.timezone as string;
    const { version, affected } = computeFreshVersion(
      options.database,
      current.expert.id,
      timezone,
      validateAvailability(parsedShape.data).weeklyIntervals,
      validateAvailability(parsedShape.data).excludedDates,
      nowMs,
    );
    return reply.code(200).send({ version, affectedBookings: affected });
  });

  app.put('/api/v1/me/availability', async (request, reply) => {
    const current = options.auth.currentSession(options.cookieToken(request.headers.cookie));
    if (!current)
      return reply.code(401).send(publicError('unauthenticated', 'Требуется вход.'));
    if (request.headers.origin !== options.allowedOrigin)
      return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
    if (request.headers['x-csrf-token'] !== current.csrfToken)
      return reply.code(403).send(publicError('forbidden', 'Недопустимый запрос.'));
    if (current.expert.name === null || current.expert.timezone === null) {
      return reply
        .code(403)
        .send(publicError('profile_incomplete', 'Завершите профиль.'));
    }
    const idempotencyKey = idKeySchema.safeParse(request.headers['idempotency-key']);
    if (!idempotencyKey.success) {
      return reply.code(400).send(publicError('invalid_input', 'Укажите ключ идемпотентности.'));
    }
    const parsed = bodySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(publicError('invalid_input', 'Проверьте тело запроса.'));
    }
    let schedule;
    try {
      schedule = validateAvailability({
        weeklyIntervals: parsed.data.weeklyIntervals,
        excludedDates: parsed.data.excludedDates,
      });
    } catch {
      return reply.code(400).send(publicError('invalid_input', 'Проверьте расписание.'));
    }
    const nowMs = options.now();
    const submittedVersion = parsed.data.version;
    const confirmAffected = parsed.data.confirmAffected === true;
    const expertId = current.expert.id;
    const timezone = current.expert.timezone as string;

    const result = immediate(options.database, () => {
      const scope = `expert_availability_update:${expertId}`;
      const keyHash = hashPayload(scope, idempotencyKey.data);
      const bodyHash = hashPayload(scope, canonicalizeBody(parsed.data));
      const existing = findIdempotencyRecord(options.database, scope, keyHash);
      if (existing) {
        if (existing.bodyHash === bodyHash) {
          return {
            kind: 'replay' as const,
            status: 200 as const,
            value: JSON.parse(existing.resultJson) as Record<string, unknown>,
          };
        }
        return {
          kind: 'idempotency_conflict' as const,
          status: 422 as const,
        };
      }

      const { version: freshVersion, affected } = computeFreshVersion(
        options.database,
        expertId,
        timezone,
        schedule.weeklyIntervals,
        schedule.excludedDates,
        nowMs,
      );
      if (freshVersion !== submittedVersion) {
        return {
          kind: 'stale_version' as const,
          status: 409 as const,
        };
      }
      if (affected.length > 0 && !confirmAffected) {
        return {
          kind: 'confirmation_required' as const,
          status: 409 as const,
        };
      }
      const scheduleChangeId = randomUUID();
      closeAffectedBookings(options.database, affected, nowMs, scheduleChangeId);
      replaceScheduleRowsInTransaction(
        options.database,
        expertId,
        schedule.weeklyIntervals,
        schedule.excludedDates,
      );
      const response = readAvailability(options.database, expertId);
      insertIdempotencyRecord(options.database, {
        id: randomUUID(),
        scope,
        keyHash,
        bodyHash,
        resultJson: JSON.stringify(response),
        now: nowMs,
      });
      return {
        kind: 'replaced' as const,
        status: 200 as const,
        value: response,
      };
    });

    if (result.kind === 'replay' || result.kind === 'replaced') {
      return reply.code(result.status).send(result.value);
    }
    if (result.kind === 'idempotency_conflict') {
      return reply
        .code(422)
        .send(publicError('idempotency_conflict', 'Ключ идемпотентности использован с другим телом.'));
    }
    if (result.kind === 'confirmation_required') {
      return reply
        .code(409)
        .send(publicError('confirmation_required', 'Подтвердите закрытие затронутых записей.'));
    }
    return reply
      .code(409)
      .send(publicError('stale_version', 'Расписание изменилось. Обновите версию.'));
  });
}
