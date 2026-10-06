import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { createExpertAuth } from '../auth/expert-auth.js';
import {
  enqueueJob,
  findBooking,
  findExpertById,
  findIdempotencyRecord,
  immediate,
  insertBookingTransitionFull,
  insertIdempotencyRecord,
  readConfirmedBusyForParticipants,
  readOverlappingPendingForParticipants,
  updateBookingStatusConfirmed,
  updateBookingStatusRejected,
  type AuthDatabase,
} from '../repository.js';
import { overlaps, type TimeInterval } from '../time/index.js';

const CONFIRM_DEADLINE_MS = 3 * 60 * 60_000;
const REMINDER_24H_MS = 24 * 60 * 60_000;
const REMINDER_1H_MS = 60 * 60_000;

const idKey = z.string().trim().min(1).max(200);
const bodySchema = z.unknown();

type Failure =
  | 'invalid_input'
  | 'not_found'
  | 'profile_incomplete'
  | 'time_unavailable'
  | 'idempotency_conflict'
  | 'status_conflict'
  | 'deadline_exceeded';

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

export function registerBookingConfirm(
  app: FastifyInstance,
  options: {
    database: AuthDatabase;
    now: () => number;
    allowedOrigin: string;
    auth: ReturnType<typeof createExpertAuth>;
    cookieToken: (cookie: string | undefined) => string | undefined;
  },
) {
  app.post<{ Params: { bookingId: string } }>(
    '/api/v1/bookings/:bookingId/confirm',
    async (request, reply) => {
      const current = options.auth.currentSession(options.cookieToken(request.headers.cookie));
      if (!current) return reply.code(401).send(publicError('unauthenticated', 'Требуется вход.'));
      if (request.headers.origin !== options.allowedOrigin)
        return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
      if (request.headers['x-csrf-token'] !== current.csrfToken)
        return reply.code(403).send(publicError('forbidden', 'Недопустимый запрос.'));
      const idempotencyKey = idKey.safeParse(request.headers['idempotency-key']);
      if (!idempotencyKey.success) {
        return reply.code(400).send(publicError('invalid_input', 'Укажите ключ идемпотентности.'));
      }
      const parsedBody = bodySchema.safeParse(request.body);
      if (!parsedBody.success) {
        return reply.code(400).send(publicError('invalid_input', 'Проверьте тело запроса.'));
      }
      const booking = findBooking(options.database, request.params.bookingId);
      if (!booking || booking.expertId !== current.expert.id)
        return reply.code(404).send(publicError('not_found', 'Заявка не найдена.'));
      if (current.expert.name === null || current.expert.timezone === null)
        return reply
          .code(403)
          .send(publicError('profile_incomplete', 'Сначала заполните профиль.'));
      const nowMs = options.now();
      const result = immediate(options.database, () => {
        const scope = `expert_confirm:${booking.id}`;
        const keyHash = hashPayload(scope, idempotencyKey.data);
        const bodyHash = hashPayload(scope, canonicalizeBody(parsedBody.data));
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
            reason: 'idempotency_conflict' as const,
          };
        }
        const fresh = findBooking(options.database, booking.id);
        if (!fresh || fresh.expertId !== current.expert.id || fresh.status !== 'pending') {
          return {
            kind: 'status_conflict' as const,
            status: 409 as const,
            reason: 'status_conflict' as const,
          };
        }
        if (nowMs > fresh.startUtc - CONFIRM_DEADLINE_MS)
          return {
            kind: 'deadline_exceeded' as const,
            status: 409 as const,
            reason: 'deadline_exceeded' as const,
          };
        const busy = readConfirmedBusyForParticipants(
          options.database,
          fresh.expertId,
          fresh.guestEmail,
        );
        const candidate: TimeInterval = { startAtMs: fresh.startUtc, endAtMs: fresh.endUtc };
        if (busy.some((interval) => overlaps(candidate, interval))) {
          return {
            kind: 'time_unavailable' as const,
            status: 409 as const,
            reason: 'time_unavailable' as const,
          };
        }
        const overlapping = readOverlappingPendingForParticipants(
          options.database,
          fresh.expertId,
          fresh.guestEmail,
          fresh.startUtc,
          fresh.endUtc,
          fresh.id,
        );
        const expert = findExpertById(options.database, fresh.expertId);
        if (!expert)
          return {
            kind: 'not_found' as const,
            status: 404 as const,
            reason: 'not_found' as const,
          };
        for (const row of overlapping) {
          updateBookingStatusRejected(options.database, row.id, 'conflict', nowMs);
          insertBookingTransitionFull(options.database, {
            id: randomUUID(),
            bookingId: row.id,
            fromStatus: 'pending',
            toStatus: 'rejected',
            reason: 'conflict',
            occurredAt: nowMs,
          });
          enqueueJob(options.database, {
            id: randomUUID(),
            type: 'notify_guest_meeting_rejected',
            bookingId: row.id,
            recipient: row.guestEmail,
            scheduledAt: nowMs,
            deduplicationKey: `notify_guest_meeting_rejected:${row.id}`,
          });
        }
        const updatedAtMs = nowMs + 1;
        updateBookingStatusConfirmed(options.database, fresh.id, updatedAtMs);
        insertBookingTransitionFull(options.database, {
          id: randomUUID(),
          bookingId: fresh.id,
          fromStatus: 'pending',
          toStatus: 'confirmed',
          occurredAt: nowMs,
        });
        enqueueJob(options.database, {
          id: randomUUID(),
          type: 'notify_expert_meeting_confirmed',
          bookingId: fresh.id,
          recipient: expert.email,
          scheduledAt: nowMs,
          deduplicationKey: `notify_expert_meeting_confirmed:${fresh.id}`,
        });
        enqueueJob(options.database, {
          id: randomUUID(),
          type: 'notify_guest_meeting_confirmed',
          bookingId: fresh.id,
          recipient: fresh.guestEmail,
          scheduledAt: nowMs,
          deduplicationKey: `notify_guest_meeting_confirmed:${fresh.id}`,
        });
        const reminder24At = Math.max(nowMs, fresh.startUtc - REMINDER_24H_MS);
        enqueueJob(options.database, {
          id: randomUUID(),
          type: 'reminder_24h',
          bookingId: fresh.id,
          recipient: fresh.guestEmail,
          scheduledAt: reminder24At,
          deduplicationKey: `reminder_24h:${fresh.id}`,
        });
        const reminder1At = Math.max(nowMs, fresh.startUtc - REMINDER_1H_MS);
        enqueueJob(options.database, {
          id: randomUUID(),
          type: 'reminder_1h',
          bookingId: fresh.id,
          recipient: fresh.guestEmail,
          scheduledAt: reminder1At,
          deduplicationKey: `reminder_1h:${fresh.id}`,
        });
        const response: {
          id: string;
          status: 'confirmed';
          startAt: string;
          endAt: string;
          topic: string;
          description?: string;
          guestName: string;
          guestTimezone: string;
          expertName: string;
          expertPublicId: string;
          guestEmail: string;
          completed: false;
        } = {
          id: fresh.id,
          status: 'confirmed',
          startAt: new Date(fresh.startUtc).toISOString(),
          endAt: new Date(fresh.endUtc).toISOString(),
          topic: fresh.subject,
          guestName: fresh.guestName,
          guestTimezone: fresh.guestTimezone,
          expertName: expert.name ?? '',
          expertPublicId: fresh.expertPublicId,
          guestEmail: fresh.guestEmail,
          completed: false,
        };
        if (fresh.description !== null) response.description = fresh.description;
        insertIdempotencyRecord(options.database, {
          id: randomUUID(),
          scope,
          keyHash,
          bodyHash,
          resultJson: JSON.stringify(response),
          now: nowMs,
        });
        return {
          kind: 'confirmed' as const,
          status: 200 as const,
          value: response,
        };
      });
      if (result.kind === 'replay' || result.kind === 'confirmed') {
        return reply.code(result.status).send(result.value);
      }
      return reply
        .code(result.status)
        .send(publicError(result.reason, 'Не удалось подтвердить заявку.'));
    },
  );
}
