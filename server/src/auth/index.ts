import Fastify from 'fastify';
import { z } from 'zod';
import { readAvailability } from '../availability/index.js';
import {
  createExpertAuth,
  expertSessionMaxAgeSeconds,
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

function cookieToken(cookie: string | undefined) {
  const part = cookie
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('mybooking_session='));
  return part?.slice('mybooking_session='.length);
}

export async function createExpertAuthApp(options: ExpertAuthOptions) {
  const app = Fastify({ logger: false, trustProxy: false });
  const auth = createExpertAuth(options);

  function originAllowed(origin: string | undefined) {
    return origin === options.allowedOrigin;
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

  return app;
}
