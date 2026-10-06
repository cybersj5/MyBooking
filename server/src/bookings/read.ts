import type { FastifyInstance } from 'fastify';
import type { createExpertAuth } from '../auth/expert-auth.js';
import type { createGuestAuth } from '../auth/guest-auth.js';
import { findBooking, type AuthDatabase } from '../repository.js';

export function registerBookingRead(
  app: FastifyInstance,
  options: {
    database: AuthDatabase;
    now: () => number;
    guest: ReturnType<typeof createGuestAuth>;
    auth: ReturnType<typeof createExpertAuth>;
    cookieToken: (cookie: string | undefined) => string | undefined;
  },
) {
  app.get<{ Params: { bookingId: string } }>(
    '/api/v1/bookings/:bookingId',
    async (request, reply) => {
      const token = request.headers.authorization?.match(/^Bearer ([a-f0-9]{64})$/)?.[1];
      const current = token
        ? undefined
        : options.auth.currentSession(options.cookieToken(request.headers.cookie));
      if (!token && !current)
        return reply.code(401).send({ code: 'unauthenticated', message: 'Требуется вход.' });
      if (current && (current.expert.name === null || current.expert.timezone === null))
        return reply.code(403).send({
          code: 'profile_incomplete',
          message: 'Сначала заполните профиль.',
        });
      const booking = findBooking(options.database, request.params.bookingId);
      if (
        !booking ||
        (!(token && options.guest.canReadBooking(booking.id, token)) &&
          current?.expert.id !== booking.expertId)
      )
        return reply.code(404).send({ code: 'not_found', message: 'Не найдено.' });
      const detail = {
        id: booking.id,
        status: booking.status,
        startAt: new Date(booking.startUtc).toISOString(),
        endAt: new Date(booking.endUtc).toISOString(),
        topic: booking.subject,
        ...(booking.description === null ? {} : { description: booking.description }),
        guestName: booking.guestName,
        guestTimezone: booking.guestTimezone,
        expertName: booking.expertName ?? '',
        expertPublicId: booking.expertPublicId,
        ...(booking.reason === null ? {} : { closedReason: booking.reason }),
        completed: booking.status === 'confirmed' && booking.endUtc <= options.now(),
      };
      return reply.send(
        current?.expert.id === booking.expertId
          ? { ...detail, guestEmail: booking.guestEmail }
          : detail,
      );
    },
  );
}
