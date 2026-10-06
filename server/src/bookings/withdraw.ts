import { createHash, createHmac, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { createExpertAuth } from '../auth/expert-auth.js';
import type { createGuestAuth } from '../auth/guest-auth.js';
import {
  enqueueJob,
  findBooking,
  findExpertById,
  findGuestAccessEmail,
  findIdempotencyRecord,
  immediate,
  insertBookingTransitionFull,
  insertIdempotencyRecord,
  updateBookingStatusWithdrawn,
  type AuthDatabase,
} from '../repository.js';

const WITHDRAW_DEADLINE_MS = 3 * 60 * 60_000;

const idKey = z.string().trim().min(1).max(200);
const bodySchema = z
  .object({
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

type Failure =
  | 'invalid_input'
  | 'not_found'
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

function digest(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(purpose).update('\0').update(value).digest('hex');
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (typeof authorization !== 'string') return undefined;
  const match = /^Bearer\s+([A-Za-z0-9]+)$/.exec(authorization);
  return match?.[1];
}

function buildWithdrawResponse(input: {
  id: string;
  startUtc: number;
  endUtc: number;
  subject: string;
  description: string | null;
  guestName: string;
  expertName: string | null;
}) {
  return {
    id: input.id,
    status: 'withdrawn' as const,
    startAt: new Date(input.startUtc).toISOString(),
    endAt: new Date(input.endUtc).toISOString(),
    topic: input.subject,
    guestName: input.guestName,
    ...(input.expertName !== null ? { expertName: input.expertName } : {}),
    ...(input.description !== null ? { description: input.description } : {}),
    completed: false,
  };
}

export function registerBookingWithdraw(
  app: FastifyInstance,
  options: {
    database: AuthDatabase;
    now: () => number;
    allowedOrigin: string;
    hmacSecret: string;
    guest: ReturnType<typeof createGuestAuth>;
    auth: ReturnType<typeof createExpertAuth>;
    cookieToken: (cookie: string | undefined) => string | undefined;
  },
) {
  app.post<{ Params: { bookingId: string } }>(
    '/api/v1/bookings/:bookingId/withdraw',
    async (request, reply) => {
      if (request.headers.origin !== options.allowedOrigin)
        return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
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
      const token = bearerToken(request.headers.authorization);
      if (!token || !/^[a-f0-9]{64}$/.test(token)) {
        return reply
          .code(401)
          .send(publicError('unauthenticated', 'Требуется токен доступа к заявке.'));
      }
      if (!options.guest.canReadBooking(request.params.bookingId, token)) {
        return reply.code(404).send(publicError('not_found', 'Заявка не найдена.'));
      }
      const booking = findBooking(options.database, request.params.bookingId);
      if (!booking) {
        return reply.code(404).send(publicError('not_found', 'Заявка не найдена.'));
      }
      const nowMs = options.now();
      // Дополнительная проверка, что токен выписан именно на этого гостя.
      const tokenHash = digest(options.hmacSecret, 'guest-access', token);
      const accessEmail = findGuestAccessEmail(
        options.database,
        request.params.bookingId,
        tokenHash,
        nowMs,
      );
      if (!accessEmail || accessEmail !== booking.guestEmail) {
        return reply.code(404).send(publicError('not_found', 'Заявка не найдена.'));
      }
      const result = immediate(options.database, () => {
        const scope = `guest_withdraw:${booking.id}`;
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
        if (!fresh || fresh.status !== 'pending') {
          return {
            kind: 'status_conflict' as const,
            status: 409 as const,
            reason: 'status_conflict' as const,
          };
        }
        if (nowMs > fresh.startUtc - WITHDRAW_DEADLINE_MS) {
          return {
            kind: 'deadline_exceeded' as const,
            status: 409 as const,
            reason: 'deadline_exceeded' as const,
          };
        }
        const updatedAtMs = nowMs + 1;
        updateBookingStatusWithdrawn(options.database, fresh.id, updatedAtMs);
        insertBookingTransitionFull(options.database, {
          id: randomUUID(),
          bookingId: fresh.id,
          fromStatus: 'pending',
          toStatus: 'withdrawn',
          reason: null,
          occurredAt: nowMs,
        });
        const expert = findExpertById(options.database, fresh.expertId);
        enqueueJob(options.database, {
          id: randomUUID(),
          type: 'notify_expert_meeting_withdrawn',
          bookingId: fresh.id,
          recipient: expert?.email ?? '',
          scheduledAt: nowMs,
          deduplicationKey: `notify_expert_meeting_withdrawn:${fresh.id}`,
        });
        const response = buildWithdrawResponse({
          id: fresh.id,
          startUtc: fresh.startUtc,
          endUtc: fresh.endUtc,
          subject: fresh.subject,
          description: fresh.description,
          guestName: fresh.guestName,
          expertName: expert?.name ?? null,
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
          kind: 'withdrawn' as const,
          status: 200 as const,
          value: response,
        };
      });
      if (result.kind === 'replay' || result.kind === 'withdrawn') {
        return reply.code(result.status).send(result.value);
      }
      return reply
        .code(result.status)
        .send(publicError(result.reason, 'Не удалось отозвать заявку.'));
    },
  );
}
