import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { createExpertAuth } from '../auth/expert-auth.js';
import {
  enqueueJob,
  findBooking,
  findIdempotencyRecord,
  immediate,
  insertBookingTransitionFull,
  insertIdempotencyRecord,
  updateBookingStatusRejected,
  type AuthDatabase,
} from '../repository.js';

const REJECT_DEADLINE_MS = 3 * 60 * 60_000;

const idKey = z.string().trim().min(1).max(200);
const bodySchema = z
  .object({
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

type Failure =
  | 'invalid_input'
  | 'not_found'
  | 'profile_incomplete'
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

function buildRejectResponse(input: {
  id: string;
  startUtc: number;
  endUtc: number;
  subject: string;
  description: string | null;
  guestName: string;
  guestEmail: string;
}) {
  return {
    id: input.id,
    status: 'rejected' as const,
    startAt: new Date(input.startUtc).toISOString(),
    endAt: new Date(input.endUtc).toISOString(),
    topic: input.subject,
    guestName: input.guestName,
    guestEmail: input.guestEmail,
    closedReason: 'manual',
    ...(input.description !== null ? { description: input.description } : {}),
    completed: false,
  };
}

export function registerBookingReject(
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
    '/api/v1/bookings/:bookingId/reject',
    async (request, reply) => {
      const current = options.auth.currentSession(options.cookieToken(request.headers.cookie));
      if (!current) return reply.code(401).send(publicError('unauthenticated', 'Требуется вход.'));
      if (request.headers.origin !== options.allowedOrigin)
        return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
      if (request.headers['x-csrf-token'] !== current.csrfToken)
        return reply.code(403).send(publicError('forbidden', 'Недопустимый запрос.'));
      const idempotencyKey = idKey.safeParse(request.headers['idempotency-key']);
      if (!idempotencyKey.success) {
        return reply
          .code(400)
          .send(publicError('invalid_input', 'Укажите ключ идемпотентности.'));
      }
      const parsedBody = bodySchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send(publicError('invalid_input', 'Проверьте тело запроса.'));
      }
      const booking = findBooking(options.database, request.params.bookingId);
      if (!booking || booking.expertId !== current.expert.id)
        return reply.code(404).send(publicError('not_found', 'Заявка не найдена.'));
      const nowMs = options.now();
      const result = immediate(options.database, () => {
        const scope = `expert_reject:${booking.id}`;
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
        if (nowMs > fresh.startUtc - REJECT_DEADLINE_MS) {
          return {
            kind: 'deadline_exceeded' as const,
            status: 409 as const,
            reason: 'deadline_exceeded' as const,
          };
        }
        const updatedAtMs = nowMs + 1;
        updateBookingStatusRejected(options.database, fresh.id, 'manual', updatedAtMs);
        insertBookingTransitionFull(options.database, {
          id: randomUUID(),
          bookingId: fresh.id,
          fromStatus: 'pending',
          toStatus: 'rejected',
          reason: 'manual',
          occurredAt: nowMs,
        });
        enqueueJob(options.database, {
          id: randomUUID(),
          type: 'notify_guest_meeting_rejected',
          bookingId: fresh.id,
          recipient: fresh.guestEmail,
          scheduledAt: nowMs,
          deduplicationKey: `notify_guest_meeting_rejected:${fresh.id}:manual`,
        });
        const response = buildRejectResponse({
          id: fresh.id,
          startUtc: fresh.startUtc,
          endUtc: fresh.endUtc,
          subject: fresh.subject,
          description: fresh.description,
          guestName: fresh.guestName,
          guestEmail: fresh.guestEmail,
        });
        insertIdempotencyRecord(options.database, {
          id: randomUUID(),
          scope,
          keyHash,
          bodyHash,
          resultJson: JSON.stringify(response),
          now: nowMs,
        });
        return {
          kind: 'rejected' as const,
          status: 200 as const,
          value: response,
        };
      });
      if (result.kind === 'replay' || result.kind === 'rejected') {
        return reply.code(result.status).send(result.value);
      }
      return reply
        .code(result.status)
        .send(publicError(result.reason, 'Не удалось отклонить заявку.'));
    },
  );
}
