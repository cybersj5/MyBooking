import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpertAuthApp } from '../src/auth/index.ts';
import { openDatabase } from '../src/repository.ts';

const fixtures: Array<{
  app: Awaited<ReturnType<typeof createExpertAuthApp>>;
  database: ReturnType<typeof openDatabase>;
  directory: string;
}> = [];

async function fixture(nowMs = Date.parse('2026-10-05T00:00:00Z')) {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-public-slots-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const app = await createExpertAuthApp({
    database,
    sendCode: async () => {},
    now: () => nowMs,
    hmacSecret: 'test-only-hmac-secret',
    allowedOrigin: 'http://localhost:5173',
    consentVersion: 'v1',
    deletionContact: 'owner@example.test',
  });
  fixtures.push({ app, database, directory });
  database
    .prepare(
      'INSERT INTO experts (id, email, publicId, name, timezone, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run('expert-1', 'expert@example.test', 'public-expert', 'Эксперт', 'Asia/Krasnoyarsk', 1);
  database
    .prepare(
      'INSERT INTO availability_intervals (id, expertId, weekday, startLocal, endLocal) VALUES (?, ?, ?, ?, ?)',
    )
    .run('wednesday-morning', 'expert-1', 3, '09:00', '10:00');
  return { app, database };
}

afterEach(async () => {
  for (const entry of fixtures.splice(0)) {
    await entry.app.close();
    entry.database.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe('public slots HTTP read', () => {
  it('keeps a slot visible when a pending request overlaps it', async () => {
    const { app, database } = await fixture();
    database
      .prepare(
        'INSERT INTO bookings (id, expertId, guestEmail, guestName, guestTimezone, startUtc, endUtc, subject, status, version, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        'pending-1',
        'expert-1',
        'guest@example.test',
        'Гость',
        'Asia/Krasnoyarsk',
        Date.parse('2026-10-07T02:15:00Z'),
        Date.parse('2026-10-07T02:45:00Z'),
        'Обсуждение',
        'pending',
        1,
        1,
      );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-10-07&to=2026-10-08&durationMinutes=30',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      timezone: 'Asia/Krasnoyarsk',
      slots: [
        { startAt: '2026-10-07T09:00:00+07:00' },
        { startAt: '2026-10-07T09:15:00+07:00' },
        { startAt: '2026-10-07T09:30:00+07:00' },
      ],
    });
  });

  it('hides confirmed overlaps in either expert role while keeping pending time visible', async () => {
    const { app, database } = await fixture();
    database
      .prepare(
        'INSERT INTO experts (id, email, publicId, name, timezone, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        'expert-2',
        'other@example.test',
        'other-expert',
        'Другой эксперт',
        'Asia/Krasnoyarsk',
        1,
      );
    const insertBooking = database.prepare(
      'INSERT INTO bookings (id, expertId, guestEmail, guestName, guestTimezone, startUtc, endUtc, subject, status, version, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertBooking.run(
      'confirmed-organizer',
      'expert-1',
      'guest@example.test',
      'Гость',
      'Asia/Krasnoyarsk',
      Date.parse('2026-10-07T02:00:00Z'),
      Date.parse('2026-10-07T02:15:00Z'),
      'Встреча',
      'confirmed',
      1,
      1,
    );
    insertBooking.run(
      'pending-middle',
      'expert-1',
      'pending@example.test',
      'Гость',
      'Asia/Krasnoyarsk',
      Date.parse('2026-10-07T02:15:00Z'),
      Date.parse('2026-10-07T02:45:00Z'),
      'Заявка',
      'pending',
      1,
      1,
    );
    insertBooking.run(
      'confirmed-guest',
      'expert-2',
      'expert@example.test',
      'Эксперт',
      'Asia/Krasnoyarsk',
      Date.parse('2026-10-07T02:45:00Z'),
      Date.parse('2026-10-07T03:15:00Z'),
      'Другая встреча',
      'confirmed',
      1,
      1,
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-10-07&to=2026-10-08&durationMinutes=30',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      timezone: 'Asia/Krasnoyarsk',
      slots: [{ startAt: '2026-10-07T09:15:00+07:00' }],
    });
  });

  it('keeps a 60-minute meeting inside one schedule interval across a break', async () => {
    const { app, database } = await fixture();
    database.prepare('DELETE FROM availability_intervals WHERE expertId = ?').run('expert-1');
    const insertInterval = database.prepare(
      'INSERT INTO availability_intervals (id, expertId, weekday, startLocal, endLocal) VALUES (?, ?, ?, ?, ?)',
    );
    insertInterval.run('morning', 'expert-1', 3, '09:00', '12:00');
    insertInterval.run('afternoon', 'expert-1', 3, '14:00', '18:00');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-10-07&to=2026-10-08&durationMinutes=60',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().slots).toHaveLength(22);
    expect(response.json().slots).toContainEqual({ startAt: '2026-10-07T11:00:00+07:00' });
    expect(response.json().slots).toContainEqual({ startAt: '2026-10-07T14:00:00+07:00' });
    expect(response.json().slots).not.toContainEqual({ startAt: '2026-10-07T11:15:00+07:00' });
    expect(response.json().slots).not.toContainEqual({ startAt: '2026-10-07T13:45:00+07:00' });
  });

  it('includes exact 24-hour and 30-day starts but excludes surrounding starts and dates', async () => {
    const { app, database } = await fixture();
    const insertInterval = database.prepare(
      'INSERT INTO availability_intervals (id, expertId, weekday, startLocal, endLocal) VALUES (?, ?, ?, ?, ?)',
    );
    insertInterval.run('tuesday-window', 'expert-1', 2, '06:45', '07:30');
    insertInterval.run('wednesday-window', 'expert-1', 3, '06:45', '07:30');
    database
      .prepare('INSERT INTO excluded_dates (id, expertId, localDate) VALUES (?, ?, ?)')
      .run('excluded-tuesday', 'expert-1', '2026-10-13');

    const lower = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-10-06&to=2026-10-07&durationMinutes=15',
    });
    const upper = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-11-04&to=2026-11-05&durationMinutes=15',
    });
    const excluded = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-10-13&to=2026-10-14&durationMinutes=15',
    });

    expect(lower.statusCode).toBe(200);
    expect(lower.json().slots).toEqual([
      { startAt: '2026-10-06T07:00:00+07:00' },
      { startAt: '2026-10-06T07:15:00+07:00' },
    ]);
    expect(upper.statusCode).toBe(200);
    expect(upper.json().slots).toEqual([
      { startAt: '2026-11-04T06:45:00+07:00' },
      { startAt: '2026-11-04T07:00:00+07:00' },
    ]);
    expect(excluded.statusCode).toBe(200);
    expect(excluded.json().slots).toEqual([]);
  });

  it('rejects a duration outside the public contract', async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-10-07&to=2026-10-08&durationMinutes=45',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_input' });
  });

  it('rejects an impossible local date without exposing an internal error', async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-02-30&to=2026-03-02&durationMinutes=30',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_input' });
  });

  it.each([
    ['reversed', '2026-10-08', '2026-10-07'],
    ['longer than 31 days', '2026-10-07', '2026-11-08'],
  ])('rejects a %s local date range', async (_case, from, to) => {
    const { app } = await fixture();
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/experts/public-expert/slots?from=${from}&to=${to}&durationMinutes=30`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: 'invalid_input' });
  });

  it('does not publish slots for unknown or incomplete experts', async () => {
    const { app, database } = await fixture();
    database
      .prepare(
        'INSERT INTO experts (id, email, publicId, name, timezone, createdAt) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('incomplete', 'incomplete@example.test', 'unpublished', null, 'Asia/Krasnoyarsk', 1);
    for (const publicId of ['missing', 'unpublished']) {
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/experts/${publicId}/slots?from=2026-10-07&to=2026-10-08&durationMinutes=30`,
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: 'not_found' });
    }
  });

  it('omits the first repeated-hour start when its actual end leaves the schedule', async () => {
    const { app, database } = await fixture();
    database
      .prepare('UPDATE experts SET timezone = ? WHERE id = ?')
      .run('America/New_York', 'expert-1');
    database
      .prepare(
        'INSERT INTO availability_intervals (id, expertId, weekday, startLocal, endLocal) VALUES (?, ?, ?, ?, ?)',
      )
      .run('fall-back-window', 'expert-1', 7, '01:45', '02:15');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-11-01&to=2026-11-02&durationMinutes=30',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      timezone: 'America/New_York',
      slots: [{ startAt: '2026-11-01T01:45:00-05:00' }],
    });
  });

  it('skips nonexistent spring starts without shifting them forward', async () => {
    const { app, database } = await fixture(Date.parse('2026-03-05T00:00:00Z'));
    database
      .prepare('UPDATE experts SET timezone = ? WHERE id = ?')
      .run('America/New_York', 'expert-1');
    database
      .prepare(
        'INSERT INTO availability_intervals (id, expertId, weekday, startLocal, endLocal) VALUES (?, ?, ?, ?, ?)',
      )
      .run('spring-window', 'expert-1', 7, '01:00', '04:00');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-03-08&to=2026-03-09&durationMinutes=15',
    });

    expect(response.statusCode).toBe(200);
    const starts = (response.json().slots as Array<{ startAt: string }>).map(
      (slot) => slot.startAt,
    );
    expect(starts).toHaveLength(8);
    expect(starts).toContain('2026-03-08T01:45:00-05:00');
    expect(starts).toContain('2026-03-08T03:00:00-04:00');
    expect(starts.every((start) => !start.includes('T02:'))).toBe(true);
  });

  it('returns both valid repeated-hour starts with distinct offsets', async () => {
    const { app, database } = await fixture();
    database
      .prepare('UPDATE experts SET timezone = ? WHERE id = ?')
      .run('America/New_York', 'expert-1');
    database
      .prepare(
        'INSERT INTO availability_intervals (id, expertId, weekday, startLocal, endLocal) VALUES (?, ?, ?, ?, ?)',
      )
      .run('fall-window', 'expert-1', 7, '01:00', '02:00');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-11-01&to=2026-11-02&durationMinutes=15',
    });

    expect(response.statusCode).toBe(200);
    const starts = (response.json().slots as Array<{ startAt: string }>).map(
      (slot) => slot.startAt,
    );
    expect(starts).toHaveLength(8);
    expect(starts).toContain('2026-11-01T01:00:00-04:00');
    expect(starts).toContain('2026-11-01T01:00:00-05:00');
  });

  it('keeps an early repeated-hour start when its actual interval stays inside the schedule', async () => {
    const { app, database } = await fixture();
    database
      .prepare('UPDATE experts SET timezone = ? WHERE id = ?')
      .run('America/New_York', 'expert-1');
    database
      .prepare(
        'INSERT INTO availability_intervals (id, expertId, weekday, startLocal, endLocal) VALUES (?, ?, ?, ?, ?)',
      )
      .run('fall-hour', 'expert-1', 7, '01:00', '02:00');

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-11-01&to=2026-11-02&durationMinutes=30',
    });

    expect(response.statusCode).toBe(200);
    const starts = (response.json().slots as Array<{ startAt: string }>).map(
      (slot) => slot.startAt,
    );
    expect(starts).toContain('2026-11-01T01:45:00-04:00');
    expect(starts).not.toContain('2026-11-01T01:45:00-05:00');
  });

  it('keeps slots adjacent to confirmed meetings and exposes no booking details', async () => {
    const { app, database } = await fixture();
    const insertBooking = database.prepare(
      'INSERT INTO bookings (id, expertId, guestEmail, guestName, guestTimezone, startUtc, endUtc, subject, status, version, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    insertBooking.run(
      'private-before',
      'expert-1',
      'private-before@example.test',
      'Личное имя',
      'Asia/Krasnoyarsk',
      Date.parse('2026-10-07T01:30:00Z'),
      Date.parse('2026-10-07T02:00:00Z'),
      'Личная тема',
      'confirmed',
      1,
      1,
    );
    insertBooking.run(
      'private-after',
      'expert-1',
      'private-after@example.test',
      'Другое имя',
      'Asia/Krasnoyarsk',
      Date.parse('2026-10-07T03:00:00Z'),
      Date.parse('2026-10-07T03:30:00Z'),
      'Другая тема',
      'confirmed',
      1,
      1,
    );

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/experts/public-expert/slots?from=2026-10-07&to=2026-10-08&durationMinutes=30',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      timezone: 'Asia/Krasnoyarsk',
      slots: [
        { startAt: '2026-10-07T09:00:00+07:00' },
        { startAt: '2026-10-07T09:15:00+07:00' },
        { startAt: '2026-10-07T09:30:00+07:00' },
      ],
    });
    expect(response.body).not.toContain('private-before@example.test');
    expect(response.body).not.toContain('Личная тема');
  });
});
