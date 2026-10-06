// Проверяем основные маршруты, которые сервер экспонирует после задачи 020:
// GET /api/v1/privacy доступен всегда, защищённые маршруты возвращают 401/403.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createExpertAuthApp } from '../src/auth/index.ts';
import { openDatabase } from '../src/repository.ts';

const origin = 'http://127.0.0.1:5173';
const hmacSecret = 'test-only-hmac';
const deletionContact = 'owner@example.test';
const consentVersion = 'v1';

type SentCode = { to: string; code: string };
type AppHandle = Awaited<ReturnType<typeof createExpertAuthApp>>;
type Database = ReturnType<typeof openDatabase>;

const directories: string[] = [];
const databases: Database[] = [];
const apps: AppHandle[] = [];

afterEach(async () => {
  while (apps.length > 0) await apps.pop()?.close();
  while (databases.length > 0) databases.pop()?.close();
  while (directories.length > 0) {
    const dir = directories.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

async function makeApp(sent: SentCode[]): Promise<AppHandle> {
  const dir = mkdtempSync(join(tmpdir(), 'mybooking-routes-'));
  directories.push(dir);
  const database = openDatabase(join(dir, 'app.db'));
  databases.push(database);
  const app = await createExpertAuthApp({
    database,
    sendCode: async (message) => {
      sent.push(message);
    },
    now: () => Date.parse('2026-10-05T00:00:00.000Z'),
    hmacSecret,
    allowedOrigin: origin,
    allowedOrigins: [origin],
    consentVersion,
    deletionContact,
  });
  apps.push(app);
  return app;
}

async function login(app: AppHandle, sent: SentCode[], email: string) {
  const challenge = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/expert/challenges',
    headers: { origin, 'x-forwarded-for': '192.0.2.1' },
    remoteAddress: '192.0.2.1',
    payload: { email, consentVersion, consentAccepted: true },
  });
  expect(challenge.statusCode).toBe(202);
  const code = sent.at(-1)?.code;
  expect(code).toBeTruthy();
  const verified = await app.inject({
    method: 'POST',
    url: `/api/v1/auth/expert/challenges/${challenge.json().challengeId}/verify`,
    headers: { origin },
    payload: { code },
  });
  expect(verified.statusCode).toBe(200);
  const setCookie = verified.headers['set-cookie'];
  const cookie = Array.isArray(setCookie) ? String(setCookie[0]) : String(setCookie);
  return { cookie: cookie.split(';')[0], csrfToken: verified.json().csrfToken as string };
}

it('GET /api/v1/privacy возвращает consentVersion и deletionContact', async () => {
  const sent: SentCode[] = [];
  const app = await makeApp(sent);
  const response = await app.inject({ method: 'GET', url: '/api/v1/privacy' });
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.consentVersion).toBe(consentVersion);
  expect(body.deletionContact).toBe(deletionContact);
  expect(typeof body.document).toBe('string');
  expect(typeof body.cookieNotice).toBe('string');
  expect(sent).toEqual([]);
});

it('GET /api/v1/me без cookie возвращает 401', async () => {
  const sent: SentCode[] = [];
  const app = await makeApp(sent);
  const response = await app.inject({ method: 'GET', url: '/api/v1/me' });
  expect(response.statusCode).toBe(401);
  expect(response.json().code).toBe('unauthenticated');
});

it('POST /api/v1/auth/logout без csrf с активной сессией возвращает 403', async () => {
  const sent: SentCode[] = [];
  const app = await makeApp(sent);
  const { cookie } = await login(app, sent, 'expert-logout-csrf@example.test');
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { origin, cookie, 'x-csrf-token': 'wrong' },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json().code).toBe('forbidden');
});

it('POST /api/v1/auth/logout с активной сессией без origin возвращает 403', async () => {
  const sent: SentCode[] = [];
  const app = await makeApp(sent);
  const { cookie, csrfToken } = await login(app, sent, 'expert-logout-origin@example.test');
  const response = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/logout',
    headers: { cookie, 'x-csrf-token': csrfToken },
  });
  expect(response.statusCode).toBe(403);
  expect(response.json().code).toBe('forbidden');
});
