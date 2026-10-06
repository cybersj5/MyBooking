// Fastify-роуты для SSE-обновлений (задача 020, docs/specs/updates.md).
// Маршрут GET /api/v1/events — поток событий авторизованного эксперта.
// Маршрут GET /api/v1/bookings/:bookingId/events — поток событий гостя
// конкретной заявки. Сервер передаёт только тип события и (для гостя) bookingId;
// данные клиент перечитывает обычными HTTP-запросами.

import { createHmac } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { createExpertAuth } from '../auth/expert-auth.js';
import type { createGuestAuth } from '../auth/guest-auth.js';
import type { AuthDatabase } from '../repository.js';
import type { Broadcaster } from './broadcaster.js';

const SSE_HEADERS: Record<string, string> = {
  'content-type': 'text/event-stream; charset=utf-8',
  'cache-control': 'no-cache, no-transform',
  'x-accel-buffering': 'no',
  connection: 'keep-alive',
};

function publicError(code: string, message: string) {
  return { code, message };
}

function writeSseFrame(
  raw: NodeJS.WritableStream & {
    write: (chunk: string) => boolean;
    end: () => unknown;
  },
  event: string,
  data: string,
): void {
  // Heartbeat — это SSE-комментарий ": ping", без `event:` строки.
  if (event === 'heartbeat') {
    raw.write(data);
    return;
  }
  raw.write(`event: ${event}\ndata: ${data}\n\n`);
}

function cookieToken(cookie: string | undefined): string | undefined {
  const part = cookie
    ?.split(';')
    .map((item) => item.trim())
    .find((item) => item.startsWith('mybooking_session='));
  return part?.slice('mybooking_session='.length);
}

function bearerToken(authorization: string | undefined): string | undefined {
  if (typeof authorization !== 'string') return undefined;
  const match = /^Bearer\s+([A-Za-z0-9]+)$/.exec(authorization);
  return match?.[1];
}

function digest(secret: string, purpose: string, value: string): string {
  return createHmac('sha256', secret).update(purpose).update('\0').update(value).digest('hex');
}

export type StreamOptions = {
  database: AuthDatabase;
  auth: ReturnType<typeof createExpertAuth>;
  guest: ReturnType<typeof createGuestAuth>;
  broadcaster: Broadcaster;
  hmacSecret: string;
  now: () => number;
};

// Создаёт адаптер записи в SSE поверх reply.raw, скрывая различия между
// HTTP-серверами Fastify. Возвращает функции отправки события/комментария
// и закрытия потока.
type StreamWriter = {
  send: (event: string, data: string) => boolean;
  close: () => void;
};

function attachStream(
  reply: FastifyReply,
  onCleanup: (writer: StreamWriter) => void,
): StreamWriter {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, SSE_HEADERS);
  // Приветственный комментарий: указывает клиенту, что поток открыт, до того,
  // как появится первое событие.
  raw.write(`: open\n\n`);
  let closed = false;
  const writer: StreamWriter = {
    send(event, data) {
      if (closed) return false;
      try {
        writeSseFrame(raw, event, data);
        return true;
      } catch {
        return false;
      }
    },
    close() {
      if (closed) return;
      closed = true;
      try {
        raw.end();
      } catch {
        // уже закрыт
      }
      onCleanup(writer);
    },
  };
  reply.request.raw.on('close', () => writer.close());
  return writer;
}

export function registerUpdatesRoutes(app: FastifyInstance, options: StreamOptions): void {
  app.get('/api/v1/events', (request, reply) => {
    const token = cookieToken(request.headers.cookie);
    if (!token || !/^[a-f0-9]{64}$/.test(token)) {
      void reply.code(401).send(publicError('unauthenticated', 'Требуется вход.'));
      return;
    }
    const current = options.auth.currentSession(token);
    if (!current) {
      void reply.code(401).send(publicError('unauthenticated', 'Требуется вход.'));
      return;
    }
    const writer = attachStream(reply, () => {
      unsubscribeExpert();
    });
    const unsubscribeExpert = options.broadcaster.subscribeExpert({
      sessionId: current.sessionId,
      expertId: current.expert.id,
      send: writer.send,
      close: writer.close,
    });
  });

  app.get<{ Params: { bookingId: string } }>(
    '/api/v1/bookings/:bookingId/events',
    (request, reply) => {
      const token = bearerToken(request.headers.authorization);
      if (!token || !/^[a-f0-9]{64}$/.test(token)) {
        void reply
          .code(401)
          .send(publicError('unauthenticated', 'Требуется токен доступа к заявке.'));
        return;
      }
      const bookingId = request.params.bookingId;
      if (!options.guest.canReadBooking(bookingId, token)) {
        void reply
          .code(401)
          .send(publicError('unauthenticated', 'Требуется токен доступа к заявке.'));
        return;
      }
      const writer = attachStream(reply, () => {
        unsubscribeGuest();
      });
      const unsubscribeGuest = options.broadcaster.subscribeGuest({
        tokenHash: digest(options.hmacSecret, 'guest-access', token),
        bookingId,
        send: writer.send,
        close: writer.close,
      });
    },
  );
}
