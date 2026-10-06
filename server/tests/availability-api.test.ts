import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpertAuthApp } from '../src/auth/index.ts';
import { openDatabase } from '../src/repository.ts';

const origin = 'http://localhost:5173';
const fixtures: Array<{
  app: Awaited<ReturnType<typeof createExpertAuthApp>>;
  database: ReturnType<typeof openDatabase>;
  directory: string;
}> = [];

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-availability-api-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const sent: string[] = [];
  const app = await createExpertAuthApp({
    database,
    sendCode: async ({ code }) => {
      sent.push(code);
    },
    now: () => Date.parse('2026-10-05T00:00:00Z'),
    hmacSecret: 'test-only-hmac-secret',
    allowedOrigin: origin,
    consentVersion: 'v1',
    deletionContact: 'owner@example.test',
  });
  fixtures.push({ app, database, directory });
  async function login(email: string, complete: boolean) {
    const challenge = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/expert/challenges',
      headers: { origin },
      payload: { email, consentVersion: 'v1', consentAccepted: true },
    });
    expect(challenge.statusCode).toBe(202);
    const verified = await app.inject({
      method: 'POST',
      url: `/api/v1/auth/expert/challenges/${challenge.json().challengeId}/verify`,
      headers: { origin },
      payload: { code: sent.at(-1) },
    });
    expect(verified.statusCode).toBe(200);
    const setCookie = verified.headers['set-cookie'];
    const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
    if (complete) {
      const profile = await app.inject({
        method: 'PUT',
        url: '/api/v1/me/profile',
        headers: { origin, cookie, 'x-csrf-token': verified.json().csrfToken },
        payload: { name: 'Эксперт', timezone: 'Asia/Krasnoyarsk' },
      });
      expect(profile.statusCode).toBe(200);
    }
    return { cookie, csrfToken: verified.json().csrfToken as string };
  }
  return { app, database, login };
}

afterEach(async () => {
  for (const entry of fixtures.splice(0)) {
    await entry.app.close();
    entry.database.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe('own availability HTTP read', () => {
  it('requires a completed expert session', async () => {
    const { app, login } = await fixture();
    expect((await app.inject({ method: 'GET', url: '/api/v1/me/availability' })).statusCode).toBe(
      401,
    );
    const incomplete = await login('incomplete@example.test', false);
    const denied = await app.inject({
      method: 'GET',
      url: '/api/v1/me/availability',
      headers: { cookie: incomplete.cookie },
    });
    expect(denied.statusCode).toBe(403);
    expect(denied.json().code).toBe('profile_incomplete');
  });

  it('reads only the owner schedule and returns an opaque version', async () => {
    const { app, database, login } = await fixture();
    const first = await login('first@example.test', true);
    const second = await login('second@example.test', true);
    const firstId = (
      database.prepare('SELECT id FROM experts WHERE email = ?').get('first@example.test') as {
        id: string;
      }
    ).id;
    database
      .prepare(
        'INSERT INTO availability_intervals (id, expertId, weekday, startLocal, endLocal) VALUES (?, ?, ?, ?, ?)',
      )
      .run('first-interval', firstId, 1, '09:00', '12:00');
    database
      .prepare('INSERT INTO excluded_dates (id, expertId, localDate) VALUES (?, ?, ?)')
      .run('first-exclusion', firstId, '2026-10-12');
    const mine = await app.inject({
      method: 'GET',
      url: '/api/v1/me/availability',
      headers: { cookie: first.cookie },
    });
    expect(mine.statusCode).toBe(200);
    expect(mine.json()).toMatchObject({
      timezone: 'Asia/Krasnoyarsk',
      weeklyIntervals: [{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }],
      excludedDates: ['2026-10-12'],
      version: expect.any(String),
    });
    const other = await app.inject({
      method: 'GET',
      url: '/api/v1/me/availability',
      headers: { cookie: second.cookie },
    });
    expect(other.statusCode).toBe(200);
    expect(other.json()).toMatchObject({ weeklyIntervals: [], excludedDates: [] });
    expect(other.body).not.toContain('2026-10-12');
  });

  it('preserves stored local schedule and UTC bookings when the profile timezone changes', async () => {
    const { app, database, login } = await fixture();
    const first = await login('first@example.test', true);
    const firstId = (
      database.prepare('SELECT id FROM experts WHERE email = ?').get('first@example.test') as {
        id: string;
      }
    ).id;
    database
      .prepare(
        'INSERT INTO availability_intervals (id, expertId, weekday, startLocal, endLocal) VALUES (?, ?, ?, ?, ?)',
      )
      .run('morning', firstId, 1, '09:00', '12:00');
    database
      .prepare('INSERT INTO excluded_dates (id, expertId, localDate) VALUES (?, ?, ?)')
      .run('holiday', firstId, '2026-10-12');
    const startUtc = Date.parse('2026-10-19T02:00:00Z');
    const endUtc = startUtc + 60 * 60_000;
    database
      .prepare(
        'INSERT INTO bookings (id, expertId, guestEmail, guestName, guestTimezone, startUtc, endUtc, subject, status, version, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'booking',
        firstId,
        'guest@example.test',
        'Гость',
        'UTC',
        startUtc,
        endUtc,
        'Встреча',
        'confirmed',
        1,
        1,
      );
    const changed = await app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile',
      headers: { origin, cookie: first.cookie, 'x-csrf-token': first.csrfToken },
      payload: { name: 'Эксперт', timezone: 'Europe/Berlin' },
    });
    expect(changed.statusCode).toBe(200);
    const schedule = await app.inject({
      method: 'GET',
      url: '/api/v1/me/availability',
      headers: { cookie: first.cookie },
    });
    expect(schedule.statusCode).toBe(200);
    expect(schedule.json()).toMatchObject({
      timezone: 'Europe/Berlin',
      weeklyIntervals: [{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }],
      excludedDates: ['2026-10-12'],
    });
    expect(
      database.prepare('SELECT startUtc, endUtc, status FROM bookings WHERE id = ?').get('booking'),
    ).toEqual({ startUtc, endUtc, status: 'confirmed' });
  });
});
