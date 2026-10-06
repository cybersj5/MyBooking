import Fastify from 'fastify';
import { Temporal } from '@js-temporal/polyfill';
import { z } from 'zod';
import { readAvailability } from '../availability/index.js';
import { calculatePublicSlots } from '../availability/public-slots.js';
import {
  findExpertByPublicId,
  readConfirmedBusyIntervals,
  readScheduleRows,
} from '../repository.js';
import { createBroadcaster } from '../updates/broadcaster.js';
import { registerUpdatesRoutes } from '../updates/stream.js';
import { createGuestAuth } from './guest-auth.js';
import { registerBookingCancel } from '../bookings/cancel.js';
import { registerBookingConfirm } from '../bookings/confirm.js';
import { registerBookingCreate } from '../bookings/create.js';
import { registerBookingExpire } from '../bookings/expire.js';
import { registerBookingRead } from '../bookings/read.js';
import { registerBookingReject } from '../bookings/reject.js';
import { registerBookingWithdraw } from '../bookings/withdraw.js';
import { registerPrivacyRoutes, type PrivacyOptions } from '../privacy/index.js';
import {
  createExpertAuth,
  expertSessionMaxAgeSeconds,
  originAllowedBy,
  type ExpertAuthOptions,
} from './expert-auth.js';

const challengeSchema = z.object({
  email: z
    .string()
    .trim()
    .pipe(z.email())
    .transform((value) => value.toLowerCase()),
  consentVersion: z.string(),
  consentAccepted: z.literal(true),
});
const verifySchema = z.object({ code: z.string().regex(/^\d{6}$/) });
const profileSchema = z.object({
  name: z.string().trim().min(1).max(120),
  timezone: z.string().min(1),
});

function publicError(code: string, message: string) {
  return { code, message };
}

function validSlotRange(query: {
  from?: string;
  to?: string;
}): query is { from: string; to: string } {
  const { from, to } = query;
  if (
    typeof from !== 'string' ||
    typeof to !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}$/.test(from) ||
    !/^\d{4}-\d{2}-\d{2}$/.test(to)
  )
    return false;
  try {
    const first = Temporal.PlainDate.from(from, { overflow: 'reject' });
    const last = Temporal.PlainDate.from(to, { overflow: 'reject' });
    const days = first.until(last).days;
    return days > 0 && days <= 31;
  } catch {
    return false;
  }
}

function cookieToken(cookie: string | undefined) {
  const part = cookie
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('mybooking_session='));
  return part?.slice('mybooking_session='.length);
}

export async function createExpertAuthApp(
  options: ExpertAuthOptions & Pick<PrivacyOptions, 'deletionContact'>,
) {
  const app = Fastify({ logger: false, trustProxy: false });
  registerPrivacyRoutes(app, {
    consentVersion: options.consentVersion,
    deletionContact: options.deletionContact,
  });
  const auth = createExpertAuth(options);
  const guest = createGuestAuth(options);
  // Бродкастер живёт в одном процессе с приложением; задача 020 не
  // масштабируется на несколько инстансов, синхронизация через Redis отложена.
  const broadcaster = createBroadcaster(options.database, options.now);

  function originAllowed(origin: string | undefined) {
    if (options.allowedOrigins !== undefined && options.allowedOrigins.length > 0) {
      return originAllowedBy(origin, { allowedOrigin: options.allowedOrigin, allowedOrigins: options.allowedOrigins });
    }
    return originAllowedBy(origin, { allowedOrigin: options.allowedOrigin });
  }

  app.post('/api/v1/auth/expert/challenges', async (request, reply) => {
    if (!originAllowed(request.headers.origin)) {
      return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
    }
    const parsed = challengeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send(publicError('invalid_input', 'Проверьте адрес и согласие.'));
    }
    const result = await auth.requestChallenge(
      parsed.data.email,
      parsed.data.consentVersion,
      request.ip,
    );
    if (!result.ok) {
      if (result.reason === 'consent_outdated')
        return reply
          .code(400)
          .send(publicError('consent_outdated', 'Требуется актуальное согласие.'));
      if (result.reason === 'rate_limited')
        return reply
          .header('Retry-After', '60')
          .code(429)
          .send(publicError('rate_limited', 'Повторите запрос позже.'));
      return reply
        .code(503)
        .send(publicError('mail_unavailable', 'Сейчас не удалось отправить код.'));
    }
    return reply.code(202).send(result.value);
  });

  app.post<{ Params: { challengeId: string } }>(
    '/api/v1/auth/expert/challenges/:challengeId/verify',
    async (request, reply) => {
      if (!originAllowed(request.headers.origin)) {
        return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
      }
      const parsed = verifySchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send(publicError('invalid_input', 'Проверьте код.'));
      const result = auth.verifyChallenge(request.params.challengeId, parsed.data.code);
      if (!result.ok)
        return reply.code(400).send(publicError('invalid_challenge', 'Код недействителен.'));
      const cookie = `mybooking_session=${result.value.token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${expertSessionMaxAgeSeconds}${options.secureCookies ? '; Secure' : ''}`;
      return reply.header('Set-Cookie', cookie).send({
        profileComplete: result.value.profileComplete,
        csrfToken: result.value.csrfToken,
      });
    },
  );

  app.get('/api/v1/me', async (request, reply) => {
    const current = auth.currentSession(cookieToken(request.headers.cookie));
    if (!current) return reply.code(401).send(publicError('unauthenticated', 'Требуется вход.'));
    return reply.send(auth.getProfile(current.expert, current.csrfToken));
  });

  app.get('/api/v1/me/availability', async (request, reply) => {
    const current = auth.currentSession(cookieToken(request.headers.cookie));
    if (!current) return reply.code(401).send(publicError('unauthenticated', 'Требуется вход.'));
    if (current.expert.name === null || current.expert.timezone === null) {
      return reply.code(403).send(publicError('profile_incomplete', 'Завершите профиль.'));
    }
    return reply.send(readAvailability(options.database, current.expert.id));
  });

  app.get<{
    Params: { publicId: string };
    Querystring: { from?: string; to?: string; durationMinutes?: string };
  }>('/api/v1/experts/:publicId/slots', async (request, reply) => {
    const expert = findExpertByPublicId(options.database, request.params.publicId);
    if (!expert || !expert.timezone || !expert.name)
      return reply.code(404).send(publicError('not_found', 'Не найдено.'));
    const { durationMinutes } = request.query;
    if (
      !validSlotRange(request.query) ||
      (durationMinutes !== '15' && durationMinutes !== '30' && durationMinutes !== '60')
    )
      return reply.code(400).send(publicError('invalid_input', 'Проверьте параметры запроса.'));
    const { from, to } = request.query;
    const schedule = readScheduleRows(options.database, expert.id);
    const slots = calculatePublicSlots({
      timezone: expert.timezone,
      weeklyIntervals: schedule.weeklyIntervals,
      excludedDates: schedule.excludedDates,
      from,
      to,
      durationMinutes: Number(durationMinutes) as 15 | 30 | 60,
      nowMs: options.now(),
      busyIntervals: readConfirmedBusyIntervals(options.database, expert.id, expert.email),
    });
    return reply.send({ timezone: expert.timezone, slots });
  });

  app.put('/api/v1/me/profile', async (request, reply) => {
    const current = auth.currentSession(cookieToken(request.headers.cookie));
    if (!current) return reply.code(401).send(publicError('unauthenticated', 'Требуется вход.'));
    if (
      !originAllowed(request.headers.origin) ||
      request.headers['x-csrf-token'] !== current.csrfToken
    ) {
      return reply.code(403).send(publicError('forbidden', 'Недопустимый запрос.'));
    }
    const parsed = profileSchema.safeParse(request.body);
    if (!parsed.success)
      return reply.code(400).send(publicError('invalid_input', 'Проверьте имя и часовой пояс.'));
    const profile = auth.updateProfile(current.expert.id, parsed.data.name, parsed.data.timezone);
    if (!profile)
      return reply.code(400).send(publicError('invalid_input', 'Проверьте имя и часовой пояс.'));
    return reply.send(profile);
  });

  app.post('/api/v1/auth/logout', async (request, reply) => {
    const current = auth.currentSession(cookieToken(request.headers.cookie));
    if (!current) return reply.code(401).send(publicError('unauthenticated', 'Требуется вход.'));
    if (
      !originAllowed(request.headers.origin) ||
      request.headers['x-csrf-token'] !== current.csrfToken
    ) {
      return reply.code(403).send(publicError('forbidden', 'Недопустимый запрос.'));
    }
    auth.logout(current.sessionId);
    return reply
      .header('Set-Cookie', 'mybooking_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0')
      .code(204)
      .send();
  });

  app.post<{ Params: { publicId: string } }>(
    '/api/v1/experts/:publicId/guest-challenges',
    async (request, reply) => {
      if (!originAllowed(request.headers.origin))
        return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
      const parsed = challengeSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send(publicError('invalid_input', 'Проверьте адрес и согласие.'));
      const result = await guest.issue(
        'guest_booking',
        request.params.publicId,
        parsed.data.email,
        parsed.data.consentVersion,
        request.ip,
      );
      if (!result.ok) {
        if (result.reason === 'consent_outdated')
          return reply
            .code(400)
            .send(publicError('consent_outdated', 'Требуется актуальное согласие.'));
        if (result.reason === 'rate_limited')
          return reply
            .header('Retry-After', '60')
            .code(429)
            .send(publicError('rate_limited', 'Повторите запрос позже.'));
        if (result.reason === 'not_found')
          return reply.code(404).send(publicError('not_found', 'Не найдено.'));
        return reply
          .code(503)
          .send(publicError('mail_unavailable', 'Сейчас не удалось отправить код.'));
      }
      return reply
        .code(202)
        .send({ challengeId: result.value.id, expiresAt: result.value.expiresAt });
    },
  );

  app.post<{ Params: { publicId: string; challengeId: string } }>(
    '/api/v1/experts/:publicId/guest-challenges/:challengeId/verify',
    async (request, reply) => {
      if (!originAllowed(request.headers.origin))
        return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
      const parsed = verifySchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send(publicError('invalid_input', 'Проверьте код.'));
      const result = guest.verify(
        'guest_booking',
        request.params.publicId,
        request.params.challengeId,
        parsed.data.code,
      );
      if (!result.ok)
        return reply.code(400).send(publicError('invalid_challenge', 'Код недействителен.'));
      return reply.send({ guestProof: result.value.token, expiresAt: result.value.expiresAt });
    },
  );

  app.post<{ Params: { bookingId: string } }>(
    '/api/v1/bookings/:bookingId/access-challenges',
    async (request, reply) => {
      if (!originAllowed(request.headers.origin))
        return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
      const parsed = challengeSchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send(publicError('invalid_input', 'Проверьте адрес и согласие.'));
      const result = await guest.issue(
        'booking_access',
        request.params.bookingId,
        parsed.data.email,
        parsed.data.consentVersion,
        request.ip,
      );
      if (!result.ok) {
        if (result.reason === 'consent_outdated')
          return reply
            .code(400)
            .send(publicError('consent_outdated', 'Требуется актуальное согласие.'));
        if (result.reason === 'rate_limited')
          return reply
            .header('Retry-After', '60')
            .code(429)
            .send(publicError('rate_limited', 'Повторите запрос позже.'));
        return reply
          .code(503)
          .send(publicError('mail_unavailable', 'Сейчас не удалось отправить код.'));
      }
      return reply.code(202).send({ requestId: result.value.id });
    },
  );

  app.post<{ Params: { bookingId: string; requestId: string } }>(
    '/api/v1/bookings/:bookingId/access-challenges/:requestId/verify',
    async (request, reply) => {
      if (!originAllowed(request.headers.origin))
        return reply.code(403).send(publicError('forbidden', 'Недопустимый источник запроса.'));
      const parsed = verifySchema.safeParse(request.body);
      if (!parsed.success)
        return reply.code(400).send(publicError('invalid_input', 'Проверьте код.'));
      const result = guest.verify(
        'booking_access',
        request.params.bookingId,
        request.params.requestId,
        parsed.data.code,
      );
      if (!result.ok)
        return reply.code(400).send(publicError('invalid_challenge', 'Код недействителен.'));
      return reply.send({ accessToken: result.value.token, expiresAt: result.value.expiresAt });
    },
  );

  registerBookingRead(app, {
    database: options.database,
    now: options.now,
    guest,
    auth,
    cookieToken,
  });
  registerBookingCreate(app, {
    database: options.database,
    now: options.now,
    consentVersion: options.consentVersion,
    allowedOrigin: options.allowedOrigin,
    guest,
    broadcaster,
  });
  registerBookingConfirm(app, {
    database: options.database,
    now: options.now,
    allowedOrigin: options.allowedOrigin,
    auth,
    cookieToken,
    broadcaster,
  });
  registerBookingReject(app, {
    database: options.database,
    now: options.now,
    allowedOrigin: options.allowedOrigin,
    auth,
    cookieToken,
    broadcaster,
  });
  registerBookingWithdraw(app, {
    database: options.database,
    now: options.now,
    allowedOrigin: options.allowedOrigin,
    hmacSecret: options.hmacSecret,
    guest,
    auth,
    cookieToken,
    broadcaster,
  });
  registerBookingCancel(app, {
    database: options.database,
    now: options.now,
    allowedOrigin: options.allowedOrigin,
    hmacSecret: options.hmacSecret,
    auth,
    guest,
    cookieToken,
    broadcaster,
  });
  registerBookingExpire(app, {
    database: options.database,
    now: options.now,
    allowedOrigin: options.allowedOrigin,
    systemApiKey: options.systemApiKey ?? '',
    broadcaster,
  });
  registerUpdatesRoutes(app, {
    database: options.database,
    auth,
    guest,
    broadcaster,
    hmacSecret: options.hmacSecret,
    now: options.now,
  });

  // Останавливаем таймер бродкастера при закрытии приложения, чтобы
  // процесс не удерживался setInterval в Vitest.
  app.addHook('onClose', async () => {
    broadcaster.shutdown();
  });

  return app;
}
