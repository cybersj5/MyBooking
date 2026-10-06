import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpertAuthApp } from '../src/auth/index.ts';
import { openDatabase } from '../src/repository.ts';

const origin = 'http://localhost:5173';
const baseNow = Date.parse('2026-10-05T00:00:00Z');

// Локальные моменты для понедельника 19.10.2026 и вторника 20.10.2026 в Красноярске (UTC+7).
// 09:00–10:00 Крс = 02:00–03:00 UTC. 10:00–11:00 Крс = 03:00–04:00 UTC.
const mon900Kras = Date.parse('2026-10-19T02:00:00.000Z');
const mon930Kras = Date.parse('2026-10-19T02:30:00.000Z');
const mon1000Kras = Date.parse('2026-10-19T03:00:00.000Z');
const mon1100Kras = Date.parse('2026-10-19T04:00:00.000Z');
const mon1130Kras = Date.parse('2026-10-19T04:30:00.000Z');
const tue1000Kras = Date.parse('2026-10-20T03:00:00.000Z');
const tue1030Kras = Date.parse('2026-10-20T03:30:00.000Z');
// Прошлая пятница для pending в прошлом (1 час).
const pastMon900Kras = Date.parse('2026-09-28T02:00:00.000Z');
const pastMon930Kras = Date.parse('2026-09-28T02:30:00.000Z');

// Текущее (старое) расписание: Пн 09:00–12:00 и Вт 10:00–11:00.
// Тестовое (новое) расписание: только Пн 09:00–10:00. Вторник исчезает, утренняя часть понедельника остаётся.
const oldIntervals = [
  { weekday: 1, startLocal: '09:00', endLocal: '12:00' },
  { weekday: 2, startLocal: '10:00', endLocal: '11:00' },
];
const newSchedule = {
  weeklyIntervals: [{ weekday: 1, startLocal: '09:00', endLocal: '10:00' }],
  excludedDates: [] as string[],
};

type Fixture = {
  app: Awaited<ReturnType<typeof createExpertAuthApp>>;
  database: ReturnType<typeof openDatabase>;
  directory: string;
  sent: string[];
};

const fixtures: Fixture[] = [];

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-availability-update-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const sent: string[] = [];
  const app = await createExpertAuthApp({
    database,
    sendCode: async ({ code }: { code: string }) => {
      sent.push(code);
    },
    now: () => baseNow,
    hmacSecret: 'test-only-hmac-secret',
    allowedOrigin: origin,
    consentVersion: 'v1',
    deletionContact: 'owner@example.test',
  });
  const entry: Fixture = { app, database, directory, sent };
  fixtures.push(entry);
  return entry;
}

async function loginAsExpert(entry: Fixture, email: string, completeProfile: boolean) {
  const challenge = await entry.app.inject({
    method: 'POST',
    url: '/api/v1/auth/expert/challenges',
    headers: { origin },
    payload: { email, consentVersion: 'v1', consentAccepted: true },
  });
  expect(challenge.statusCode).toBe(202);
  const code = entry.sent.at(-1);
  if (!code) throw new Error('expected code to be sent');
  const verified = await entry.app.inject({
    method: 'POST',
    url: `/api/v1/auth/expert/challenges/${challenge.json().challengeId}/verify`,
    headers: { origin },
    payload: { code },
  });
  expect(verified.statusCode).toBe(200);
  const cookieHeader = verified.headers['set-cookie'];
  const cookie = String(Array.isArray(cookieHeader) ? cookieHeader[0] : cookieHeader).split(';')[0];
  const csrfToken = verified.json().csrfToken as string;
  if (completeProfile) {
    const profile = await entry.app.inject({
      method: 'PUT',
      url: '/api/v1/me/profile',
      headers: { origin, cookie, 'x-csrf-token': csrfToken },
      payload: { name: 'Эксперт', timezone: 'Asia/Krasnoyarsk' },
    });
    expect(profile.statusCode).toBe(200);
  }
  return { cookie, csrfToken };
}

function insertInterval(
  entry: Fixture,
  expertId: string,
  weekday: number,
  startLocal: string,
  endLocal: string,
  id = `interval-${expertId}-${weekday}-${startLocal}`,
) {
  entry.database
    .prepare(
      'INSERT INTO availability_intervals (id,expertId,weekday,startLocal,endLocal) VALUES (?,?,?,?,?)',
    )
    .run(id, expertId, weekday, startLocal, endLocal);
}

function seedOldSchedule(entry: Fixture, expertId: string) {
  for (const interval of oldIntervals) {
    insertInterval(entry, expertId, interval.weekday, interval.startLocal, interval.endLocal);
  }
}

type SeededBooking = {
  id: string;
  expertId: string;
  guestEmail: string;
  startUtc: number;
  endUtc: number;
  status: 'pending' | 'confirmed';
  version: number;
};

function insertBooking(entry: Fixture, booking: SeededBooking) {
  entry.database
    .prepare(
      'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,status,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      booking.id,
      booking.expertId,
      booking.guestEmail,
      'Гость',
      'Asia/Krasnoyarsk',
      booking.startUtc,
      booking.endUtc,
      'Тема',
      booking.status,
      booking.version,
      baseNow,
    );
}

afterEach(async () => {
  for (const entry of fixtures.splice(0)) {
    await entry.app.close();
    entry.database.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe('availability update preview HTTP', () => {
  it('возвращает 200 с версией и затронутыми будущими записями организатора', async () => {
    const entry = await fixture();
    const expertId = 'expert-self';
    entry.database
      .prepare(
        'INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)',
      )
      .run(expertId, 'self@example.test', 'self', 'Эксперт', 'Asia/Krasnoyarsk', baseNow);
    seedOldSchedule(entry, expertId);
    // Будущее подтверждённое в новом окне (попадает в оба расписания) — не затронуто.
    insertBooking(entry, {
      id: 'b-in-window',
      expertId,
      guestEmail: 'guest-a@example.test',
      startUtc: mon930Kras,
      endUtc: mon1000Kras,
      status: 'confirmed',
      version: 1,
    });
    // Будущее подтверждённое вне нового окна (попадает только в старое) — затронуто.
    insertBooking(entry, {
      id: 'b-out-confirmed',
      expertId,
      guestEmail: 'guest-b@example.test',
      startUtc: mon1100Kras,
      endUtc: mon1130Kras,
      status: 'confirmed',
      version: 1,
    });
    // Будущее pending вне нового окна (вторник исчезает) — затронуто.
    insertBooking(entry, {
      id: 'b-out-pending',
      expertId,
      guestEmail: 'guest-c@example.test',
      startUtc: tue1000Kras,
      endUtc: tue1030Kras,
      status: 'pending',
      version: 1,
    });
    // Прошлая pending — вне окна «будущих», не возвращается и не считается затронутой.
    insertBooking(entry, {
      id: 'b-past-pending',
      expertId,
      guestEmail: 'guest-d@example.test',
      startUtc: pastMon900Kras,
      endUtc: pastMon930Kras,
      status: 'pending',
      version: 1,
    });
    // Запись, где этот эксперт — гость у другого эксперта, не должна попадать в список.
    entry.database
      .prepare(
        'INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)',
      )
      .run('expert-other', 'other@example.test', 'other', 'Другой', 'Asia/Krasnoyarsk', baseNow);
    insertBooking(entry, {
      id: 'b-as-guest',
      expertId: 'expert-other',
      guestEmail: 'self@example.test',
      startUtc: mon930Kras,
      endUtc: mon1000Kras,
      status: 'confirmed',
      version: 1,
    });
    const { cookie, csrfToken } = await loginAsExpert(entry, 'self@example.test', true);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/me/availability/preview',
      headers: { origin, cookie, 'x-csrf-token': csrfToken },
      payload: newSchedule,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
    const ids = body.affectedBookings.map((row: { id: string }) => row.id).sort();
    expect(ids).toEqual(['b-out-confirmed', 'b-out-pending']);
    const byId = Object.fromEntries(
      body.affectedBookings.map((row: { id: string; status: string }) => [row.id, row.status]),
    );
    expect(byId['b-out-confirmed']).toBe('confirmed');
    expect(byId['b-out-pending']).toBe('pending');
  });

  it('требует сессию, Origin, CSRF и завершённый профиль', async () => {
    const entry = await fixture();
    const { cookie, csrfToken } = await loginAsExpert(entry, 'self@example.test', true);
    const otherCookie = cookie;
    const otherCsrf = csrfToken;

    const noSession = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/me/availability/preview',
      headers: { origin },
      payload: newSchedule,
    });
    expect(noSession.statusCode).toBe(401);

    const noOrigin = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/me/availability/preview',
      headers: { cookie: otherCookie, 'x-csrf-token': otherCsrf },
      payload: newSchedule,
    });
    expect(noOrigin.statusCode).toBe(403);

    const noCsrf = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/me/availability/preview',
      headers: { origin, cookie: otherCookie },
      payload: newSchedule,
    });
    expect(noCsrf.statusCode).toBe(403);

    // Без завершённого профиля — 403 profile_incomplete.
    const incompleteLogin = await loginAsExpert(entry, 'incomplete@example.test', false);
    const incompleteCookie = incompleteLogin.cookie;
    const incompleteCsrf = incompleteLogin.csrfToken;
    const incomplete = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/me/availability/preview',
      headers: { origin, cookie: incompleteCookie, 'x-csrf-token': incompleteCsrf },
      payload: newSchedule,
    });
    expect(incomplete.statusCode).toBe(403);
    expect(incomplete.json().code).toBe('profile_incomplete');
  });

  it('не показывает заявки другого эксперта, где этот — гость', async () => {
    const entry = await fixture();
    const expertId = 'expert-self';
    entry.database
      .prepare(
        'INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)',
      )
      .run(expertId, 'self@example.test', 'self', 'Эксперт', 'Asia/Krasnoyarsk', baseNow);
    seedOldSchedule(entry, expertId);
    // Другой эксперт с подтверждённой встречей, где self — гость.
    entry.database
      .prepare(
        'INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)',
      )
      .run('expert-other', 'other@example.test', 'other', 'Другой', 'Asia/Krasnoyarsk', baseNow);
    insertBooking(entry, {
      id: 'foreign',
      expertId: 'expert-other',
      guestEmail: 'self@example.test',
      startUtc: mon930Kras,
      endUtc: mon1000Kras,
      status: 'confirmed',
      version: 1,
    });
    const { cookie, csrfToken } = await loginAsExpert(entry, 'self@example.test', true);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/me/availability/preview',
      headers: { origin, cookie, 'x-csrf-token': csrfToken },
      payload: newSchedule,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().affectedBookings).toEqual([]);
  });

  it('без заявок возвращает пустой список и непрозрачную версию', async () => {
    const entry = await fixture();
    const expertId = 'expert-self';
    entry.database
      .prepare(
        'INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)',
      )
      .run(expertId, 'self@example.test', 'self', 'Эксперт', 'Asia/Krasnoyarsk', baseNow);
    seedOldSchedule(entry, expertId);
    const { cookie, csrfToken } = await loginAsExpert(entry, 'self@example.test', true);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/me/availability/preview',
      headers: { origin, cookie, 'x-csrf-token': csrfToken },
      payload: newSchedule,
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.affectedBookings).toEqual([]);
    expect(typeof body.version).toBe('string');
    expect(body.version.length).toBeGreaterThan(0);
  });
});

describe('availability update PUT HTTP', () => {
  async function setupExpertWithBookings(entry: Fixture) {
    const expertId = 'expert-self';
    entry.database
      .prepare(
        'INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)',
      )
      .run(expertId, 'self@example.test', 'self', 'Эксперт', 'Asia/Krasnoyarsk', baseNow);
    seedOldSchedule(entry, expertId);
    insertBooking(entry, {
      id: 'b-in-window',
      expertId,
      guestEmail: 'guest-a@example.test',
      startUtc: mon930Kras,
      endUtc: mon1000Kras,
      status: 'confirmed',
      version: 1,
    });
    insertBooking(entry, {
      id: 'b-out-confirmed',
      expertId,
      guestEmail: 'guest-b@example.test',
      startUtc: mon1100Kras,
      endUtc: mon1130Kras,
      status: 'confirmed',
      version: 1,
    });
    insertBooking(entry, {
      id: 'b-out-pending',
      expertId,
      guestEmail: 'guest-c@example.test',
      startUtc: tue1000Kras,
      endUtc: tue1030Kras,
      status: 'pending',
      version: 1,
    });
    insertBooking(entry, {
      id: 'b-past-pending',
      expertId,
      guestEmail: 'guest-d@example.test',
      startUtc: pastMon900Kras,
      endUtc: pastMon930Kras,
      status: 'pending',
      version: 1,
    });
    entry.database
      .prepare(
        'INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)',
      )
      .run('expert-other', 'other@example.test', 'other', 'Другой', 'Asia/Krasnoyarsk', baseNow);
    insertBooking(entry, {
      id: 'b-as-guest',
      expertId: 'expert-other',
      guestEmail: 'self@example.test',
      startUtc: mon930Kras,
      endUtc: mon1000Kras,
      status: 'confirmed',
      version: 1,
    });
    const login = await loginAsExpert(entry, 'self@example.test', true);
    return { expertId, login };
  }

  async function preview(entry: Fixture, cookie: string, csrfToken: string) {
    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/me/availability/preview',
      headers: { origin, cookie, 'x-csrf-token': csrfToken },
      payload: newSchedule,
    });
    expect(response.statusCode).toBe(200);
    return response.json() as {
      version: string;
      affectedBookings: Array<{ id: string; status: string }>;
    };
  }

  it('с актуальной версией и confirmAffected=true сохраняет новое расписание и закрывает затронутые', async () => {
    const entry = await fixture();
    const { login } = await setupExpertWithBookings(entry);
    const snapshot = await preview(entry, login.cookie, login.csrfToken);

    const response = await entry.app.inject({
      method: 'PUT',
      url: '/api/v1/me/availability',
      headers: {
        origin,
        cookie: login.cookie,
        'x-csrf-token': login.csrfToken,
        'idempotency-key': 'put-success-1',
      },
      payload: { ...newSchedule, version: snapshot.version, confirmAffected: true },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      timezone: 'Asia/Krasnoyarsk',
      weeklyIntervals: newSchedule.weeklyIntervals,
      excludedDates: [],
    });
    expect(typeof response.json().version).toBe('string');

    const intervals = entry.database
      .prepare(
        'SELECT weekday, startLocal, endLocal FROM availability_intervals WHERE expertId = ? ORDER BY weekday, startLocal',
      )
      .all('expert-self') as Array<{ weekday: number; startLocal: string; endLocal: string }>;
    expect(intervals).toEqual([{ weekday: 1, startLocal: '09:00', endLocal: '10:00' }]);

    const affected = entry.database
      .prepare('SELECT id, status, reason FROM bookings WHERE id IN (?, ?) ORDER BY id')
      .all('b-out-confirmed', 'b-out-pending') as Array<{
      id: string;
      status: string;
      reason: string | null;
    }>;
    expect(affected).toEqual([
      { id: 'b-out-confirmed', status: 'cancelled', reason: 'schedule_changed' },
      { id: 'b-out-pending', status: 'rejected', reason: 'schedule_changed' },
    ]);

    const unchanged = entry.database
      .prepare('SELECT id, status, reason FROM bookings WHERE id IN (?, ?, ?) ORDER BY id')
      .all('b-in-window', 'b-past-pending', 'b-as-guest') as Array<{
      id: string;
      status: string;
      reason: string | null;
    }>;
    expect(unchanged).toEqual([
      { id: 'b-as-guest', status: 'confirmed', reason: null },
      { id: 'b-in-window', status: 'confirmed', reason: null },
      { id: 'b-past-pending', status: 'pending', reason: null },
    ]);
  });

  it('без подтверждения при непустом affectedBookings возвращает 409 без изменений', async () => {
    const entry = await fixture();
    const { login } = await setupExpertWithBookings(entry);
    const snapshot = await preview(entry, login.cookie, login.csrfToken);
    expect(snapshot.affectedBookings.length).toBeGreaterThan(0);

    const intervalsBefore = entry.database
      .prepare('SELECT COUNT(*) AS count FROM availability_intervals WHERE expertId = ?')
      .get('expert-self') as { count: number };
    const bookingsBefore = entry.database
      .prepare('SELECT id, status FROM bookings ORDER BY id')
      .all() as Array<{ id: string; status: string }>;
    const transitionsBefore = entry.database
      .prepare('SELECT COUNT(*) AS count FROM booking_transitions')
      .get() as { count: number };
    const jobsBefore = entry.database.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
      count: number;
    };

    const response = await entry.app.inject({
      method: 'PUT',
      url: '/api/v1/me/availability',
      headers: {
        origin,
        cookie: login.cookie,
        'x-csrf-token': login.csrfToken,
        'idempotency-key': 'put-no-confirm',
      },
      payload: { ...newSchedule, version: snapshot.version, confirmAffected: false },
    });

    expect(response.statusCode).toBe(409);

    const intervalsAfter = entry.database
      .prepare('SELECT COUNT(*) AS count FROM availability_intervals WHERE expertId = ?')
      .get('expert-self') as { count: number };
    const bookingsAfter = entry.database
      .prepare('SELECT id, status FROM bookings ORDER BY id')
      .all() as Array<{ id: string; status: string }>;
    const transitionsAfter = entry.database
      .prepare('SELECT COUNT(*) AS count FROM booking_transitions')
      .get() as { count: number };
    const jobsAfter = entry.database.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
      count: number;
    };

    expect(intervalsAfter.count).toBe(intervalsBefore.count);
    expect(bookingsAfter).toEqual(bookingsBefore);
    expect(transitionsAfter.count).toBe(transitionsBefore.count);
    expect(jobsAfter.count).toBe(jobsBefore.count);
  });

  it('с устаревшей версией возвращает 409 без изменений', async () => {
    const entry = await fixture();
    const { login } = await setupExpertWithBookings(entry);

    const intervalsBefore = entry.database
      .prepare('SELECT COUNT(*) AS count FROM availability_intervals WHERE expertId = ?')
      .get('expert-self') as { count: number };

    const response = await entry.app.inject({
      method: 'PUT',
      url: '/api/v1/me/availability',
      headers: {
        origin,
        cookie: login.cookie,
        'x-csrf-token': login.csrfToken,
        'idempotency-key': 'put-stale',
      },
      payload: { ...newSchedule, version: 'stale-version', confirmAffected: true },
    });

    expect(response.statusCode).toBe(409);

    const intervalsAfter = entry.database
      .prepare('SELECT COUNT(*) AS count FROM availability_intervals WHERE expertId = ?')
      .get('expert-self') as { count: number };
    expect(intervalsAfter.count).toBe(intervalsBefore.count);
  });

  it('отклоняет PUT 409 без частичного закрытия, если между preview и commit появилась новая pending', async () => {
    const entry = await fixture();
    const { login, expertId } = await setupExpertWithBookings(entry);
    const snapshot = await preview(entry, login.cookie, login.csrfToken);

    // Параллельная транзакция добавляет новую pending в окне нового расписания.
    const otherDatabase = openDatabase(join(entry.directory, 'test.sqlite'));
    try {
      otherDatabase
        .transaction(() => {
          otherDatabase
            .prepare(
              'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,status,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
            )
            .run(
              'b-new-pending',
              expertId,
              'guest-new@example.test',
              'Гость',
              'Asia/Krasnoyarsk',
              mon900Kras,
              mon930Kras,
              'Тема',
              'pending',
              1,
              baseNow,
            );
        })
        .immediate();
    } finally {
      otherDatabase.close();
    }

    const bookingsBefore = entry.database
      .prepare('SELECT id, status FROM bookings WHERE expertId = ? ORDER BY id')
      .all(expertId) as Array<{ id: string; status: string }>;
    const transitionsBefore = entry.database
      .prepare('SELECT COUNT(*) AS count FROM booking_transitions')
      .get() as { count: number };
    const jobsBefore = entry.database.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
      count: number;
    };

    const response = await entry.app.inject({
      method: 'PUT',
      url: '/api/v1/me/availability',
      headers: {
        origin,
        cookie: login.cookie,
        'x-csrf-token': login.csrfToken,
        'idempotency-key': 'put-race',
      },
      payload: { ...newSchedule, version: snapshot.version, confirmAffected: true },
    });

    expect(response.statusCode).toBe(409);

    const bookingsAfter = entry.database
      .prepare('SELECT id, status FROM bookings WHERE expertId = ? ORDER BY id')
      .all(expertId) as Array<{ id: string; status: string }>;
    expect(bookingsAfter).toEqual(bookingsBefore);
    const transitionsAfter = entry.database
      .prepare('SELECT COUNT(*) AS count FROM booking_transitions')
      .get() as { count: number };
    expect(transitionsAfter.count).toBe(transitionsBefore.count);
    const jobsAfter = entry.database.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
      count: number;
    };
    expect(jobsAfter.count).toBe(jobsBefore.count);
  });

  it('ключ идемпотентности обязателен, повтор с тем же телом возвращает прежний результат', async () => {
    const entry = await fixture();
    const { login } = await setupExpertWithBookings(entry);
    const snapshot = await preview(entry, login.cookie, login.csrfToken);

    const headers = {
      origin,
      cookie: login.cookie,
      'x-csrf-token': login.csrfToken,
      'idempotency-key': 'put-idem-same',
    };

    const first = await entry.app.inject({
      method: 'PUT',
      url: '/api/v1/me/availability',
      headers,
      payload: { ...newSchedule, version: snapshot.version, confirmAffected: true },
    });
    expect(first.statusCode).toBe(200);

    const replay = await entry.app.inject({
      method: 'PUT',
      url: '/api/v1/me/availability',
      headers,
      payload: { ...newSchedule, version: snapshot.version, confirmAffected: true },
    });
    expect(replay.statusCode).toBe(200);
    expect(replay.body).toBe(first.body);

    const diverging = await entry.app.inject({
      method: 'PUT',
      url: '/api/v1/me/availability',
      headers,
      payload: {
        weeklyIntervals: [{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }],
        excludedDates: [],
        version: snapshot.version,
        confirmAffected: true,
      },
    });
    expect(diverging.statusCode).toBe(422);
    expect(diverging.json().code).toBe('idempotency_conflict');

    const noHeader = await entry.app.inject({
      method: 'PUT',
      url: '/api/v1/me/availability',
      headers: { origin, cookie: login.cookie, 'x-csrf-token': login.csrfToken },
      payload: { ...newSchedule, version: snapshot.version, confirmAffected: true },
    });
    expect(noHeader.statusCode).toBe(400);
  });

  it('закрытые записи пишут booking_transitions и задачи notify_* у адресатов', async () => {
    const entry = await fixture();
    const { login } = await setupExpertWithBookings(entry);
    const snapshot = await preview(entry, login.cookie, login.csrfToken);

    const response = await entry.app.inject({
      method: 'PUT',
      url: '/api/v1/me/availability',
      headers: {
        origin,
        cookie: login.cookie,
        'x-csrf-token': login.csrfToken,
        'idempotency-key': 'put-jobs',
      },
      payload: { ...newSchedule, version: snapshot.version, confirmAffected: true },
    });
    expect(response.statusCode).toBe(200);

    const transitions = entry.database
      .prepare(
        "SELECT bookingId, fromStatus, toStatus, reason FROM booking_transitions WHERE bookingId IN ('b-out-confirmed','b-out-pending') ORDER BY bookingId, occurredAt",
      )
      .all() as Array<{
      bookingId: string;
      fromStatus: string;
      toStatus: string;
      reason: string | null;
    }>;
    expect(transitions).toEqual([
      {
        bookingId: 'b-out-confirmed',
        fromStatus: 'confirmed',
        toStatus: 'cancelled',
        reason: 'schedule_changed',
      },
      {
        bookingId: 'b-out-pending',
        fromStatus: 'pending',
        toStatus: 'rejected',
        reason: 'schedule_changed',
      },
    ]);

    const jobs = entry.database
      .prepare(
        "SELECT bookingId, type, recipient FROM jobs WHERE bookingId IN ('b-out-confirmed','b-out-pending') ORDER BY bookingId, type",
      )
      .all() as Array<{ bookingId: string; type: string; recipient: string }>;
    const byBooking = new Map<string, Array<{ type: string; recipient: string }>>();
    for (const row of jobs) {
      const list = byBooking.get(row.bookingId) ?? [];
      list.push({ type: row.type, recipient: row.recipient });
      byBooking.set(row.bookingId, list);
    }
    expect(
      byBooking
        .get('b-out-confirmed')
        ?.some((job) => job.type.startsWith('notify_') && job.recipient === 'guest-b@example.test'),
    ).toBe(true);
    expect(
      byBooking
        .get('b-out-pending')
        ?.some((job) => job.type.startsWith('notify_') && job.recipient === 'guest-c@example.test'),
    ).toBe(true);
  });

  it('атомарно откатывает замену при сбое одной из вставок', async () => {
    const entry = await fixture();
    const { login, expertId } = await setupExpertWithBookings(entry);
    const snapshot = await preview(entry, login.cookie, login.csrfToken);

    // Триггер отклоняет вставку excluded_date '2026-10-30' ровно для этого эксперта.
    entry.database.exec(
      `CREATE TRIGGER reject_excluded_date BEFORE INSERT ON excluded_dates
        WHEN NEW.expertId = '${expertId}' AND NEW.localDate = '2026-10-30'
        BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`,
    );

    const intervalsBefore = entry.database
      .prepare('SELECT COUNT(*) AS count FROM availability_intervals WHERE expertId = ?')
      .get(expertId) as { count: number };
    const bookingsBefore = entry.database
      .prepare('SELECT id, status, reason FROM bookings WHERE expertId = ? ORDER BY id')
      .all(expertId) as Array<{ id: string; status: string; reason: string | null }>;
    const transitionsBefore = entry.database
      .prepare('SELECT COUNT(*) AS count FROM booking_transitions')
      .get() as { count: number };
    const jobsBefore = entry.database.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
      count: number;
    };

    const response = await entry.app.inject({
      method: 'PUT',
      url: '/api/v1/me/availability',
      headers: {
        origin,
        cookie: login.cookie,
        'x-csrf-token': login.csrfToken,
        'idempotency-key': 'put-atomic',
      },
      payload: {
        weeklyIntervals: newSchedule.weeklyIntervals,
        excludedDates: ['2026-10-30'],
        version: snapshot.version,
        confirmAffected: true,
      },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    const intervalsAfter = entry.database
      .prepare('SELECT COUNT(*) AS count FROM availability_intervals WHERE expertId = ?')
      .get(expertId) as { count: number };
    const bookingsAfter = entry.database
      .prepare('SELECT id, status, reason FROM bookings WHERE expertId = ? ORDER BY id')
      .all(expertId) as Array<{ id: string; status: string; reason: string | null }>;
    const transitionsAfter = entry.database
      .prepare('SELECT COUNT(*) AS count FROM booking_transitions')
      .get() as { count: number };
    const jobsAfter = entry.database.prepare('SELECT COUNT(*) AS count FROM jobs').get() as {
      count: number;
    };

    expect(intervalsAfter.count).toBe(intervalsBefore.count);
    expect(bookingsAfter).toEqual(bookingsBefore);
    expect(transitionsAfter.count).toBe(transitionsBefore.count);
    expect(jobsAfter.count).toBe(jobsBefore.count);
  });
});

// Suppress unused variable lint for the mon9-12 helper kept for clarity.
void mon900Kras;
void mon1000Kras;
