import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  enqueueJob,
  findBooking,
  findExpertById,
  findOverduePendingBookings,
  immediate,
  insertBookingTransitionFull,
  updateBookingStatusExpired,
  type AuthDatabase,
} from '../repository.js';

const EXPIRE_DEADLINE_MS = 3 * 60 * 60_000;

const bodySchema = z
  .object({
    reason: z.string().trim().max(2000).optional(),
  })
  .strict();

type Failure = 'invalid_input' | 'not_found' | 'not_overdue' | 'status_conflict';

function publicError(code: Failure | 'forbidden' | 'unauthenticated', message: string) {
  return { code, message };
}

function buildExpireResponse(input: {
  id: string;
  startUtc: number;
  endUtc: number;
  subject: string;
  description: string | null;
  guestName: string;
}) {
  return {
    id: input.id,
    status: 'expired' as const,
    startAt: new Date(input.startUtc).toISOString(),
    endAt: new Date(input.endUtc).toISOString(),
    topic: input.subject,
    guestName: input.guestName,
    closedReason: 'expired',
    ...(input.description !== null ? { description: input.description } : {}),
    completed: false,
  };
}

// Прямой вызов перехода pending->expired для конкретной заявки. Используется системным
// обработчиком и экспортируется для фоновой задачи 014.
export function expireBooking(
  database: AuthDatabase,
  bookingId: string,
  now: number,
):
  | { kind: 'expired'; response: Record<string, unknown> }
  | { kind: 'not_overdue' }
  | { kind: 'status_conflict' }
  | { kind: 'not_found' } {
  return immediate(database, () => {
    const fresh = findBooking(database, bookingId);
    if (!fresh) return { kind: 'not_found' as const };
    if (fresh.status !== 'pending') return { kind: 'status_conflict' as const };
    if (now <= fresh.startUtc - EXPIRE_DEADLINE_MS) return { kind: 'not_overdue' as const };
    const updatedAtMs = now + 1;
    updateBookingStatusExpired(database, fresh.id, updatedAtMs);
    insertBookingTransitionFull(database, {
      id: randomUUID(),
      bookingId: fresh.id,
      fromStatus: 'pending',
      toStatus: 'expired',
      reason: 'expired',
      occurredAt: now,
    });
    enqueueJob(database, {
      id: randomUUID(),
      type: 'notify_guest_meeting_expired',
      bookingId: fresh.id,
      recipient: fresh.guestEmail,
      scheduledAt: now,
      deduplicationKey: `notify_guest_meeting_expired:${fresh.id}`,
    });
    return {
      kind: 'expired' as const,
      response: buildExpireResponse({
        id: fresh.id,
        startUtc: fresh.startUtc,
        endUtc: fresh.endUtc,
        subject: fresh.subject,
        description: fresh.description,
        guestName: fresh.guestName,
      }),
    };
  });
}

// Пакетная обработка просроченных pending. Возвращает количество успешно истёкших заявок.
export function expireOverdueBookings(
  database: AuthDatabase,
  options: { now: () => number; deadlineMs?: number },
): { expired: number } {
  const deadlineMs = options.deadlineMs ?? EXPIRE_DEADLINE_MS;
  const now = options.now();
  const candidates = findOverduePendingBookings(database, now, deadlineMs);
  let expired = 0;
  for (const row of candidates) {
    const result = expireBooking(database, row.id, now);
    if (result.kind === 'expired') expired += 1;
  }
  return { expired };
}

export function registerBookingExpire(
  app: FastifyInstance,
  options: {
    database: AuthDatabase;
    now: () => number;
    allowedOrigin: string;
    systemApiKey: string;
  },
) {
  app.post<{ Params: { bookingId: string } }>(
    '/api/v1/bookings/:bookingId/expire',
    async (request, reply) => {
      if (request.headers.origin !== options.allowedOrigin)
        return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
      const provided = request.headers['x-system-key'];
      if (
        typeof provided !== 'string' ||
        provided.length === 0 ||
        provided !== options.systemApiKey
      ) {
        return reply
          .code(401)
          .send(publicError('unauthenticated', 'Требуется системный ключ.'));
      }
      const parsedBody = bodySchema.safeParse(request.body ?? {});
      if (!parsedBody.success) {
        return reply.code(400).send(publicError('invalid_input', 'Проверьте тело запроса.'));
      }
      const booking = findBooking(options.database, request.params.bookingId);
      if (!booking)
        return reply.code(404).send(publicError('not_found', 'Заявка не найдена.'));
      const nowMs = options.now();
      const result = immediate(options.database, () => {
        // Идемпотентность системного истечения обеспечивается статусом самой заявки:
        // повторный вызов для уже истёкшей заявки возвращает 409 status_conflict.
        // Idempotency-records здесь не используются, чтобы не маскировать конфликт.
        const fresh = findBooking(options.database, booking.id);
        if (!fresh) {
          return { kind: 'not_found' as const, status: 404 as const, reason: 'not_found' as const };
        }
        if (fresh.status !== 'pending') {
          return {
            kind: 'status_conflict' as const,
            status: 409 as const,
            reason: 'status_conflict' as const,
          };
        }
        if (nowMs <= fresh.startUtc - EXPIRE_DEADLINE_MS) {
          return {
            kind: 'not_overdue' as const,
            status: 409 as const,
            reason: 'not_overdue' as const,
          };
        }
        const updatedAtMs = nowMs + 1;
        updateBookingStatusExpired(options.database, fresh.id, updatedAtMs);
        insertBookingTransitionFull(options.database, {
          id: randomUUID(),
          bookingId: fresh.id,
          fromStatus: 'pending',
          toStatus: 'expired',
          reason: 'expired',
          occurredAt: nowMs,
        });
        enqueueJob(options.database, {
          id: randomUUID(),
          type: 'notify_guest_meeting_expired',
          bookingId: fresh.id,
          recipient: fresh.guestEmail,
          scheduledAt: nowMs,
          deduplicationKey: `notify_guest_meeting_expired:${fresh.id}:system`,
        });
        const expert = findExpertById(options.database, fresh.expertId);
        if (expert) {
          enqueueJob(options.database, {
            id: randomUUID(),
            type: 'notify_expert_meeting_expired',
            bookingId: fresh.id,
            recipient: expert.email,
            scheduledAt: nowMs,
            deduplicationKey: `notify_expert_meeting_expired:${fresh.id}:system`,
          });
        }
        const response = buildExpireResponse({
          id: fresh.id,
          startUtc: fresh.startUtc,
          endUtc: fresh.endUtc,
          subject: fresh.subject,
          description: fresh.description,
          guestName: fresh.guestName,
        });
        return {
          kind: 'expired' as const,
          status: 200 as const,
          value: response,
        };
      });
      if (result.kind === 'expired') {
        return reply.code(result.status).send(result.value);
      }
      if (result.kind === 'not_found') {
        return reply.code(result.status).send(publicError('not_found', 'Заявка не найдена.'));
      }
      return reply
        .code(result.status)
        .send(publicError(result.reason, 'Не удалось истечь заявку.'));
    },
  );
}
