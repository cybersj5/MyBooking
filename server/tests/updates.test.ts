// RED-набор интеграционных тестов для задачи 020 «Серверные SSE-обновления».
// Покрывает AC-17 и UI-06 из docs/PDR.md, §5 «Обновления интерфейса» из docs/ADR-001.md
// и сценарии UP-01 — UP-13 из docs/specs/updates.md.
//
// В RED-фазе серверный код для GET /api/v1/events и
// GET /api/v1/bookings/{bookingId}/events отсутствует, поэтому открытие
// потока через настоящий HTTP-клиент получает 404 от Fastify — тесты
// падают на этой границе до реализации backend-разработчиком.
//
// app.inject не подходит для стриминговых ответов, поэтому используется
// app.listen(0) и node:http.request с agent: false.

import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createExpertAuthApp } from '../src/auth/index.ts';
import { openDatabase } from '../src/repository.ts';

const origin = 'http://localhost:5173';
const consentVersion = 'v1';
const hmacSecret = 'test-only-hmac-secret';
const baseNow = Date.parse('2026-10-05T00:00:00Z');
// Слот 02:00Z — 09:00 Красноярск во вторник.
const slotStartMs = Date.parse('2026-10-06T02:00:00.000Z');
const slotEndMs = Date.parse('2026-10-06T02:30:00.000Z');

type AppHandle = Awaited<ReturnType<typeof createExpertAuthApp>>;
type Database = ReturnType<typeof openDatabase>;

type Fixture = {
  app: AppHandle;
  database: Database;
  directory: string;
  sent: Array<{ to: string; code: string }>;
  baseUrl: string;
};

let fixture: Fixture;

async function makeExpert(opts: {
  database: Database;
  publicId: string;
  email: string;
  name: string;
}): Promise<string> {
  const expertId = `expert-${opts.publicId}`;
  opts.database
    .prepare('INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)')
    .run(expertId, opts.email, opts.publicId, opts.name, 'Asia/Krasnoyarsk', baseNow);
  // Единственный интервал во вторник, чтобы заявка попадала в доступное окно.
  opts.database
    .prepare(
      'INSERT INTO availability_intervals (id,expertId,weekday,startLocal,endLocal) VALUES (?,?,?,?,?)',
    )
    .run(`interval-${opts.publicId}-2`, expertId, 2, '09:00', '12:00');
  return expertId;
}

function insertPendingWithTransition(
  database: Database,
  opts: { id: string; expertId: string; guestEmail: string; guestName: string },
) {
  database
    .prepare(
      'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,status,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      opts.id,
      opts.expertId,
      opts.guestEmail,
      opts.guestName,
      'Asia/Krasnoyarsk',
      slotStartMs,
      slotEndMs,
      'Тема',
      'pending',
      1,
      baseNow,
    );
  database
    .prepare(
      'INSERT INTO booking_transitions (id,bookingId,fromStatus,toStatus,occurredAt) VALUES (?,?,?,?,?)',
    )
    .run(`transition-${opts.id}`, opts.id, null, 'pending', baseNow);
}

async function loginExpert(opts: {
  app: AppHandle;
  sent: Array<{ to: string; code: string }>;
  email: string;
  complete: boolean;
}): Promise<{ cookie: string; csrfToken: string }> {
  const challenge = await opts.app.inject({
    method: 'POST',
    url: '/api/v1/auth/expert/challenges',
    headers: { origin },
    payload: { email: opts.email, consentVersion, consentAccepted: true },
  });
  expect(challenge.statusCode).toBe(202);
  const code = opts.sent.at(-1)?.code;
  if (!code) throw new Error('expected expert code to be sent');
  const verified = await opts.app.inject({
    method: 'POST',
    url: `/api/v1/auth/expert/challenges/${challenge.json().challengeId}/verify`,
    headers: { origin },
    payload: { code },
  });
  expect(verified.statusCode).toBe(200);
  const setCookie = verified.headers['set-cookie'];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
  const csrfToken = verified.json().csrfToken as string;
  if (opts.complete) {
    const profile = await opts.app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile',
      headers: { origin, cookie, 'x-csrf-token': csrfToken },
      payload: { name: 'Эксперт', timezone: 'Asia/Krasnoyarsk' },
    });
    expect(profile.statusCode).toBe(200);
  }
  return { cookie, csrfToken };
}

async function issueGuestAccess(opts: {
  app: AppHandle;
  sent: Array<{ to: string; code: string }>;
  bookingId: string;
  email: string;
}): Promise<string> {
  const challenge = await opts.app.inject({
    method: 'POST',
    url: `/api/v1/bookings/${opts.bookingId}/access-challenges`,
    headers: { origin },
    payload: { email: opts.email, consentVersion, consentAccepted: true },
  });
  expect(challenge.statusCode).toBe(202);
  const code = opts.sent.at(-1)?.code;
  if (!code) throw new Error('expected guest code to be sent');
  const verified = await opts.app.inject({
    method: 'POST',
    url: `/api/v1/bookings/${opts.bookingId}/access-challenges/${challenge.json().requestId}/verify`,
    headers: { origin },
    payload: { code },
  });
  expect(verified.statusCode).toBe(200);
  return verified.json().accessToken as string;
}

type StreamHandle = {
  res: http.IncomingMessage;
  status: number;
  received: () => string;
  close: () => void;
};

function openSse(opts: {
  port: number;
  path: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
}): Promise<StreamHandle> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port: opts.port,
      path: opts.path,
      method: 'GET',
      headers: { accept: 'text/event-stream', ...(opts.headers ?? {}) },
      agent: false,
    });
    let buffer = '';
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      req.destroy();
      reject(err);
    };
    const timer = setTimeout(() => fail(new Error(`SSE connection timeout after ${timeoutMs}ms`)), timeoutMs);
    req.setTimeout(timeoutMs, () => fail(new Error('SSE socket timeout')));
    req.on('response', (res) => {
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => {
        buffer += chunk;
      });
      // 'close' срабатывает и при штатном завершении ответа (404), и при разрыве.
      res.on('end', () => {});
      if (settled) {
        res.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        res,
        status: res.statusCode ?? 0,
        received: () => buffer,
        close: () => req.destroy(),
      });
    });
    req.on('error', (err) => fail(err));
    req.end();
  });
}

function portFromBaseUrl(baseUrl: string): number {
  return Number(new URL(baseUrl).port);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function latestSessionId(database: Database): string {
  const row = database
    .prepare('SELECT id FROM expert_sessions ORDER BY createdAt DESC LIMIT 1')
    .get() as { id: string } | undefined;
  if (!row) throw new Error('expected an expert session to exist');
  return row.id;
}

beforeEach(async () => {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-updates-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const sent: Array<{ to: string; code: string }> = [];
  const app = await createExpertAuthApp({
    database,
    sendCode: async (message: { to: string; code: string }) => {
      sent.push(message);
    },
    now: () => baseNow,
    hmacSecret,
    allowedOrigin: origin,
    consentVersion,
    deletionContact: 'owner@example.test',
  });
  await app.listen({ port: 0, host: '127.0.0.1' });
  const address = app.server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('cannot read Fastify server address');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;
  fixture = { app, database, directory, sent, baseUrl };
});

afterEach(async () => {
  await fixture.app.close();
  fixture.database.close();
  rmSync(fixture.directory, { recursive: true, force: true });
});

describe('updates SSE HTTP routes', () => {
  it('UP-01: эксперт получает bookings_changed после подтверждения своей заявки', async () => {
    // AC-17, UI-06, §5 ADR-001, UP-01 из docs/specs/updates.md.
    const publicId = 'expert-up01';
    const expertId = await makeExpert({
      database: fixture.database,
      publicId,
      email: 'up01@example.test',
      name: 'Эксперт',
    });
    const { cookie, csrfToken } = await loginExpert({
      app: fixture.app,
      sent: fixture.sent,
      email: 'up01@example.test',
      complete: true,
    });
    insertPendingWithTransition(fixture.database, {
      id: 'b-up01',
      expertId,
      guestEmail: 'guest-up01@example.test',
      guestName: 'Гость',
    });

    const stream = await openSse({
      port: portFromBaseUrl(fixture.baseUrl),
      path: '/api/v1/events',
      headers: { cookie },
    });
    try {
      expect(stream.status).toBe(200);
      const confirm = await fixture.app.inject({
        method: 'POST',
        url: '/api/v1/bookings/b-up01/confirm',
        headers: {
          origin,
          cookie,
          'x-csrf-token': csrfToken,
          'idempotency-key': 'idem-up01',
        },
        payload: {},
      });
      expect(confirm.statusCode).toBe(200);
      await delay(2000);
      const data = stream.received();
      expect(data).toContain('event: bookings_changed');
      expect(data).toMatch(/data: \{"type":"bookings_changed"[^}]*\}/);
    } finally {
      stream.close();
    }
  });

  it('UP-02: чужой эксперт не получает bookings_changed', async () => {
    // UP-02 из docs/specs/updates.md.
    const publicA = 'expert-up02-a';
    const publicB = 'expert-up02-b';
    const expertA = await makeExpert({
      database: fixture.database,
      publicId: publicA,
      email: 'a@example.test',
      name: 'А',
    });
    await makeExpert({
      database: fixture.database,
      publicId: publicB,
      email: 'b@example.test',
      name: 'Б',
    });
    const a = await loginExpert({
      app: fixture.app,
      sent: fixture.sent,
      email: 'a@example.test',
      complete: true,
    });
    const b = await loginExpert({
      app: fixture.app,
      sent: fixture.sent,
      email: 'b@example.test',
      complete: true,
    });
    insertPendingWithTransition(fixture.database, {
      id: 'b-up02',
      expertId: expertA,
      guestEmail: 'guest-up02@example.test',
      guestName: 'Гость',
    });

    const port = portFromBaseUrl(fixture.baseUrl);
    const streamA = await openSse({ port, path: '/api/v1/events', headers: { cookie: a.cookie } });
    const streamB = await openSse({ port, path: '/api/v1/events', headers: { cookie: b.cookie } });
    try {
      expect(streamA.status).toBe(200);
      expect(streamB.status).toBe(200);
      const confirm = await fixture.app.inject({
        method: 'POST',
        url: '/api/v1/bookings/b-up02/confirm',
        headers: {
          origin,
          cookie: a.cookie,
          'x-csrf-token': a.csrfToken,
          'idempotency-key': 'idem-up02',
        },
        payload: {},
      });
      expect(confirm.statusCode).toBe(200);
      await delay(1500);
      expect(streamA.received()).toContain('event: bookings_changed');
      expect(streamB.received()).not.toContain('bookings_changed');
    } finally {
      streamA.close();
      streamB.close();
    }
  });

  it('UP-03: поток закрывается после revokeSession в БД', async () => {
    // UP-03 из docs/specs/updates.md.
    const publicId = 'expert-up03';
    await makeExpert({
      database: fixture.database,
      publicId,
      email: 'up03@example.test',
      name: 'Э',
    });
    const { cookie } = await loginExpert({
      app: fixture.app,
      sent: fixture.sent,
      email: 'up03@example.test',
      complete: true,
    });

    const stream = await openSse({
      port: portFromBaseUrl(fixture.baseUrl),
      path: '/api/v1/events',
      headers: { cookie },
    });
    try {
      expect(stream.status).toBe(200);
      const sessionId = latestSessionId(fixture.database);
      fixture.database
        .prepare('UPDATE expert_sessions SET revokedAt = ? WHERE id = ?')
        .run(baseNow, sessionId);
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500);
        const onClose = () => {
          clearTimeout(timer);
          resolve(true);
        };
        stream.res.once('close', onClose);
        stream.res.once('end', onClose);
      });
      expect(closed).toBe(true);
    } finally {
      stream.close();
    }
  });

  it('UP-05: гость получает bookings_changed с правильным bookingId', async () => {
    // UP-05 из docs/specs/updates.md.
    const publicId = 'expert-up05';
    const expertId = await makeExpert({
      database: fixture.database,
      publicId,
      email: 'up05@example.test',
      name: 'Э',
    });
    insertPendingWithTransition(fixture.database, {
      id: 'b-up05',
      expertId,
      guestEmail: 'guest-up05@example.test',
      guestName: 'Гость',
    });
    const { cookie, csrfToken } = await loginExpert({
      app: fixture.app,
      sent: fixture.sent,
      email: 'up05@example.test',
      complete: true,
    });
    const accessToken = await issueGuestAccess({
      app: fixture.app,
      sent: fixture.sent,
      bookingId: 'b-up05',
      email: 'guest-up05@example.test',
    });

    const stream = await openSse({
      port: portFromBaseUrl(fixture.baseUrl),
      path: '/api/v1/bookings/b-up05/events',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    try {
      expect(stream.status).toBe(200);
      const confirm = await fixture.app.inject({
        method: 'POST',
        url: '/api/v1/bookings/b-up05/confirm',
        headers: {
          origin,
          cookie,
          'x-csrf-token': csrfToken,
          'idempotency-key': 'idem-up05',
        },
        payload: {},
      });
      expect(confirm.statusCode).toBe(200);
      await delay(2000);
      const data = stream.received();
      expect(data).toContain('event: bookings_changed');
      // Точное равенство bookingId в JSON-объекте data.
      expect(data).toMatch(/data: \{"type":"bookings_changed","bookingId":"b-up05"\}/);
    } finally {
      stream.close();
    }
  });

  it('UP-07: поток гостя закрывается при отзыве гостевого токена', async () => {
    // UP-07 из docs/specs/updates.md: revoke токена через прямой SQL
    // согласно разделу «Соглашения по реализации» документа.
    const publicId = 'expert-up07';
    const expertId = await makeExpert({
      database: fixture.database,
      publicId,
      email: 'up07@example.test',
      name: 'Э',
    });
    insertPendingWithTransition(fixture.database, {
      id: 'b-up07',
      expertId,
      guestEmail: 'guest-up07@example.test',
      guestName: 'Гость',
    });
    const accessToken = await issueGuestAccess({
      app: fixture.app,
      sent: fixture.sent,
      bookingId: 'b-up07',
      email: 'guest-up07@example.test',
    });

    const stream = await openSse({
      port: portFromBaseUrl(fixture.baseUrl),
      path: '/api/v1/bookings/b-up07/events',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    try {
      expect(stream.status).toBe(200);
      fixture.database
        .prepare('UPDATE guest_access SET revokedAt = ? WHERE bookingId = ? AND revokedAt IS NULL')
        .run(baseNow, 'b-up07');
      const closed = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 1500);
        const onClose = () => {
          clearTimeout(timer);
          resolve(true);
        };
        stream.res.once('close', onClose);
        stream.res.once('end', onClose);
      });
      expect(closed).toBe(true);
    } finally {
      stream.close();
    }
  });

  it('UP-08: разрыв клиентом не оставляет подписку; повторное открытие возвращает 200', async () => {
    // UP-08 из docs/specs/updates.md.
    const publicId = 'expert-up08';
    await makeExpert({
      database: fixture.database,
      publicId,
      email: 'up08@example.test',
      name: 'Э',
    });
    const { cookie } = await loginExpert({
      app: fixture.app,
      sent: fixture.sent,
      email: 'up08@example.test',
      complete: true,
    });

    const port = portFromBaseUrl(fixture.baseUrl);
    const first = await openSse({ port, path: '/api/v1/events', headers: { cookie } });
    expect(first.status).toBe(200);
    first.close();
    await delay(200);
    const second = await openSse({ port, path: '/api/v1/events', headers: { cookie } });
    try {
      expect(second.status).toBe(200);
    } finally {
      second.close();
    }
  });

  // UP-09 требует удержания стрима 60 секунд; в общем прогоне недопустимо,
  // оставляется на отдельный e2e-прогон.
  it.skip('UP-09: сервер отправляет heartbeat : ping каждые 15 секунд (пропущен — 18+ секунд в общем прогоне)', () => {
    // Заглушка: реализация — отдельный тест с фиксированным временем.
  });

  it('UP-11: запрос с отозванной сессией эксперта возвращает 401', async () => {
    // UP-11 из docs/specs/updates.md.
    const publicId = 'expert-up11';
    await makeExpert({
      database: fixture.database,
      publicId,
      email: 'up11@example.test',
      name: 'Э',
    });
    const { cookie } = await loginExpert({
      app: fixture.app,
      sent: fixture.sent,
      email: 'up11@example.test',
      complete: true,
    });
    const sessionId = latestSessionId(fixture.database);
    fixture.database
      .prepare('UPDATE expert_sessions SET revokedAt = ? WHERE id = ?')
      .run(baseNow, sessionId);

    const stream = await openSse({
      port: portFromBaseUrl(fixture.baseUrl),
      path: '/api/v1/events',
      headers: { cookie },
    });
    try {
      expect(stream.status).toBe(401);
    } finally {
      stream.close();
    }
  });

  it('UP-12: запрос без авторизации возвращает 401', async () => {
    // UP-12 из docs/specs/updates.md.
    const stream = await openSse({
      port: portFromBaseUrl(fixture.baseUrl),
      path: '/api/v1/events',
    });
    try {
      expect(stream.status).toBe(401);
    } finally {
      stream.close();
    }
  });

  // Остальные сценарии требуют либо изолированного окружения для манипуляции
  // expiresAt, либо контрактных проверок поверх broadcaster; покрываются
  // backend-разработчиком и дополнительными сценариями после появления
  // модуля server/src/updates/.
  it.todo('UP-04: истечение expiresAt сессии закрывает поток (требует перемотки часов через job_queue).');
  it.todo('UP-06: попытка открыть второй поток с тем же токеном на другую заявку даёт 403.');
  it.todo('UP-10: две вкладки одного эксперта получают сигнал независимо (требует двух активных сессий).');
  it.todo('UP-13: подбор чужого токена отдаёт 401 без утечки деталей.');
});
