// RED-набор тестов для задачи 011 «Подтверждение и конфликты».
// Покрывает AC-05/07/08, конкурентные SQLite-проверки и инварианты ONTOLOGY §5.2/§6.
// Пока эндпоинт POST /api/v1/bookings/{bookingId}/confirm не реализован,
// эти тесты должны падать с 404 и прочими провалами, что и подтверждает фазу RED.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { createExpertAuthApp } from '../src/auth/index.ts';
import { openDatabase } from '../src/repository.ts';

const origin = 'http://localhost:5173';
const consentVersion = 'v1';
const baseNow = Date.parse('2026-10-05T00:00:00Z');
// Слот 02:00Z — 09:00 Красноярск во вторник, 26 часов после baseNow.
const slotStartMs = Date.parse('2026-10-06T02:00:00.000Z');
const slotEndMs = Date.parse('2026-10-06T02:30:00.000Z');

type Fixture = {
  app: Awaited<ReturnType<typeof createExpertAuthApp>>;
  database: ReturnType<typeof openDatabase>;
  directory: string;
  sent: Array<{ to: string; code: string }>;
  getNow: () => number;
  setNow: (value: number) => void;
  advance: (ms: number) => void;
  loginExpert: (email: string, complete: boolean) => Promise<{ cookie: string; csrfToken: string }>;
};
const fixtures: Fixture[] = [];

async function makeExpert(options: {
  database: ReturnType<typeof openDatabase>;
  email: string;
  publicId: string;
  name: string;
  timezone: string;
  intervals: Array<{ weekday: number; startLocal: string; endLocal: string }>;
}) {
  const expertId = `expert-${options.publicId}`;
  options.database
    .prepare('INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)')
    .run(expertId, options.email, options.publicId, options.name, options.timezone, baseNow);
  for (const interval of options.intervals) {
    options.database
      .prepare(
        'INSERT INTO availability_intervals (id,expertId,weekday,startLocal,endLocal) VALUES (?,?,?,?,?)',
      )
      .run(
        `interval-${options.publicId}-${interval.weekday}`,
        expertId,
        interval.weekday,
        interval.startLocal,
        interval.endLocal,
      );
  }
  return expertId;
}

function insertBookingRow(
  database: ReturnType<typeof openDatabase>,
  options: {
    id: string;
    expertId: string;
    guestEmail: string;
    guestName: string;
    startMs: number;
    endMs: number;
    status: 'pending' | 'confirmed' | 'rejected';
    reason?: string | null;
    subject?: string;
    createdAt?: number;
  },
) {
  const createdAt = options.createdAt ?? baseNow;
  database
    .prepare(
      'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,description,status,reason,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      options.id,
      options.expertId,
      options.guestEmail,
      options.guestName,
      'Asia/Krasnoyarsk',
      options.startMs,
      options.endMs,
      options.subject ?? 'Тема',
      null,
      options.status,
      options.reason ?? null,
      1,
      createdAt,
    );
}

function insertPendingWithTransition(
  database: ReturnType<typeof openDatabase>,
  options: {
    id: string;
    expertId: string;
    guestEmail: string;
    guestName: string;
    startMs: number;
    endMs: number;
  },
) {
  insertBookingRow(database, { ...options, status: 'pending' });
  database
    .prepare(
      'INSERT INTO booking_transitions (id,bookingId,fromStatus,toStatus,occurredAt) VALUES (?,?,?,?,?)',
    )
    .run(`transition-create-${options.id}`, options.id, null, 'pending', baseNow);
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-booking-confirm-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const sent: Array<{ to: string; code: string }> = [];
  let nowMs = baseNow;
  const getNow = () => nowMs;
  const setNow = (value: number) => {
    nowMs = value;
  };
  const advance = (ms: number) => {
    nowMs += ms;
  };
  const app = await createExpertAuthApp({
    database,
    sendCode: async (message: { to: string; code: string }) => {
      sent.push(message);
    },
    now: getNow,
    hmacSecret: 'test-only-hmac-secret',
    allowedOrigin: origin,
    consentVersion,
    deletionContact: 'owner@example.test',
  });
  const entry: Fixture = {
    app,
    database,
    directory,
    sent,
    getNow,
    setNow,
    advance,
    loginExpert: async (email: string, complete: boolean) => {
      const challenge = await app.inject({
        method: 'POST',
        url: '/api/v1/auth/expert/challenges',
        headers: { origin },
        payload: { email, consentVersion, consentAccepted: true },
      });
      expect(challenge.statusCode).toBe(202);
      const sentCode = sent.at(-1)?.code;
      if (!sentCode) throw new Error('expected expert code to be sent');
      const verified = await app.inject({
        method: 'POST',
        url: `/api/v1/auth/expert/challenges/${challenge.json().challengeId}/verify`,
        headers: { origin },
        payload: { code: sentCode },
      });
      expect(verified.statusCode).toBe(200);
      const setCookie = verified.headers['set-cookie'];
      const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(';')[0];
      const csrfToken = verified.json().csrfToken as string;
      if (complete) {
        const profile = await app.inject({
          method: 'PUT',
          url: '/api/v1/me/profile',
          headers: { origin, cookie, 'x-csrf-token': csrfToken },
          payload: { name: 'Эксперт', timezone: 'Asia/Krasnoyarsk' },
        });
        expect(profile.statusCode).toBe(200);
      }
      return { cookie, csrfToken };
    },
  };
  fixtures.push(entry);
  return entry;
}

afterEach(async () => {
  for (const entry of fixtures.splice(0)) {
    await entry.app.close();
    entry.database.close();
    rmSync(entry.directory, { recursive: true, force: true });
  }
});

describe('booking confirm HTTP command', () => {
  it('переводит pending в confirmed в одной транзакции и пишет задачи уведомлений и напоминаний', async () => {
    // AC-05 граница, AC-07 happy path, BOOK-01, NOTIFY-02/06, PDR §4.3, ONTOLOGY §6
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    insertPendingWithTransition(entry.database, {
      id: 'pending-1',
      expertId: `expert-${publicId}`,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-1/confirm',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-confirm-happy',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.status).toBe('confirmed');
    expect(json.id).toBe('pending-1');
    expect(json.startAt).toBe('2026-10-06T02:00:00.000Z');
    expect(json.endAt).toBe('2026-10-06T02:30:00.000Z');
    expect(json.guestEmail).toBe('guest@example.test');
    expect(json).not.toHaveProperty('accessToken');

    const row = entry.database
      .prepare('SELECT status, version, updatedAt FROM bookings WHERE id = ?')
      .get('pending-1') as { status: string; version: number; updatedAt: number | null };
    expect(row.status).toBe('confirmed');
    expect(row.version).toBeGreaterThan(1);
    expect(row.updatedAt).not.toBeNull();
    expect(row.updatedAt!).toBeGreaterThan(baseNow);

    const transitions = entry.database
      .prepare(
        'SELECT fromStatus, toStatus FROM booking_transitions WHERE bookingId = ? ORDER BY occurredAt',
      )
      .all('pending-1') as Array<{ fromStatus: string | null; toStatus: string }>;
    expect(transitions).toEqual([
      { fromStatus: null, toStatus: 'pending' },
      { fromStatus: 'pending', toStatus: 'confirmed' },
    ]);

    const jobs = entry.database
      .prepare('SELECT type FROM jobs WHERE bookingId = ? ORDER BY scheduledAt, type')
      .all('pending-1') as Array<{ type: string }>;
    const types = jobs.map((j) => j.type);
    expect(types).toEqual(
      expect.arrayContaining([
        'notify_expert_meeting_confirmed',
        'notify_guest_meeting_confirmed',
        'reminder_24h',
        'reminder_1h',
      ]),
    );
    expect(jobs.length).toBe(4);
  });

  it('атомарно отклоняет пересекающуюся заявку того же эксперта с причиной conflict', async () => {
    // AC-07, TIME-09/10, ONTOLOGY §5.2, NOTIFY-05
    const entry = await fixture();
    const publicId = 'public-expert';
    const expertId = await makeExpert({
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    insertPendingWithTransition(entry.database, {
      id: 'pending-a',
      expertId,
      guestEmail: 'first@example.test',
      guestName: 'Первый',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    insertPendingWithTransition(entry.database, {
      id: 'pending-b',
      expertId,
      guestEmail: 'second@example.test',
      guestName: 'Второй',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-a/confirm',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-conflict-expert',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);

    const confirmed = entry.database
      .prepare('SELECT status, version FROM bookings WHERE id = ?')
      .get('pending-a') as { status: string; version: number };
    expect(confirmed.status).toBe('confirmed');
    expect(confirmed.version).toBeGreaterThan(1);

    const rejected = entry.database
      .prepare('SELECT status, reason FROM bookings WHERE id = ?')
      .get('pending-b') as { status: string; reason: string | null };
    expect(rejected.status).toBe('rejected');
    expect(rejected.reason).toBe('conflict');

    const rejectTransition = entry.database
      .prepare(
        'SELECT fromStatus, toStatus, reason FROM booking_transitions WHERE bookingId = ? AND toStatus = ?',
      )
      .get('pending-b', 'rejected') as
      | { fromStatus: string; toStatus: string; reason: string | null }
      | undefined;
    expect(rejectTransition).toEqual({
      fromStatus: 'pending',
      toStatus: 'rejected',
      reason: 'conflict',
    });

    const rejectionJobs = entry.database
      .prepare('SELECT type, recipient, deduplicationKey FROM jobs WHERE bookingId = ?')
      .all('pending-b') as Array<{ type: string; recipient: string; deduplicationKey: string }>;
    expect(rejectionJobs).toHaveLength(1);
    expect(rejectionJobs[0].type).toBe('notify_guest_meeting_rejected');
    expect(rejectionJobs[0].recipient).toBe('second@example.test');
    expect(rejectionJobs[0].deduplicationKey).toBe(
      `notify_guest_meeting_rejected:pending-b`,
    );
  });

  it('атомарно отклоняет пересекающуюся заявку того же гостя у другого эксперта', async () => {
    // AC-07, TIME-07/08/10, ONTOLOGY §5.2: подтверждение Борисом у Виктора закрывает
    // пересекающуюся заявку того же email у Анны.
    const entry = await fixture();
    const firstExpertId = await makeExpert({
      database: entry.database,
      email: 'first@example.test',
      publicId: 'first-expert',
      name: 'Первый',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const secondExpertId = await makeExpert({
      database: entry.database,
      email: 'second@example.test',
      publicId: 'second-expert',
      name: 'Второй',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const sharedGuestEmail = 'shared@example.test';
    insertPendingWithTransition(entry.database, {
      id: 'pending-first',
      expertId: firstExpertId,
      guestEmail: sharedGuestEmail,
      guestName: 'Общий гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    insertPendingWithTransition(entry.database, {
      id: 'pending-second',
      expertId: secondExpertId,
      guestEmail: sharedGuestEmail,
      guestName: 'Общий гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('first@example.test', true);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-first/confirm',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-conflict-guest',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);

    const other = entry.database
      .prepare('SELECT status, reason FROM bookings WHERE id = ?')
      .get('pending-second') as { status: string; reason: string | null };
    expect(other.status).toBe('rejected');
    expect(other.reason).toBe('conflict');
  });

  it('сериализует параллельные подтверждения одного слота через BEGIN IMMEDIATE', async () => {
    // AC-08, ADR-001 §2 «SQLite и конкурентные изменения».
    // Проверяет, что одновременные транзакции на двух подключениях не оставляют
    // две подтверждённые встречи по общему слоту.
    const entry = await fixture();
    const publicId = 'public-expert';
    const expertId = await makeExpert({
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    insertPendingWithTransition(entry.database, {
      id: 'concurrent-a',
      expertId,
      guestEmail: 'alpha@example.test',
      guestName: 'Альфа',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    insertPendingWithTransition(entry.database, {
      id: 'concurrent-b',
      expertId,
      guestEmail: 'beta@example.test',
      guestName: 'Бета',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const databasePath = join(entry.directory, 'test.sqlite');

    const runConfirm = (connection: Database.Database, bookingId: string) => {
      connection.exec('BEGIN IMMEDIATE');
      try {
        const row = connection
          .prepare(
            "SELECT id, status, expertId, guestEmail, startUtc, endUtc FROM bookings WHERE id = ?",
          )
          .get(bookingId) as
          | {
              id: string;
              status: string;
              expertId: string;
              guestEmail: string;
              startUtc: number;
              endUtc: number;
            }
          | undefined;
        if (!row || row.status !== 'pending') {
          connection.exec('ROLLBACK');
          return 'skipped' as const;
        }
        const conflict = connection
          .prepare(
            "SELECT id FROM bookings WHERE expertId = ? AND status = 'confirmed' AND startUtc < ? AND endUtc > ?",
          )
          .get(row.expertId, row.endUtc, row.startUtc) as { id: string } | undefined;
        if (conflict) {
          connection
            .prepare(
              "UPDATE bookings SET status = 'rejected', reason = 'conflict', version = version + 1, updatedAt = ? WHERE id = ?",
            )
            .run(baseNow, bookingId);
          connection
            .prepare(
              "INSERT INTO booking_transitions (id,bookingId,fromStatus,toStatus,reason,occurredAt) VALUES (?,?,?,?,?,?)",
            )
            .run(
              `transition-concurrent-reject-${bookingId}`,
              bookingId,
              'pending',
              'rejected',
              'conflict',
              baseNow,
            );
          connection.exec('COMMIT');
          return 'rejected' as const;
        }
        connection
          .prepare(
            "UPDATE bookings SET status = 'confirmed', version = version + 1, updatedAt = ? WHERE id = ?",
          )
          .run(baseNow, bookingId);
        connection
          .prepare(
            "INSERT INTO booking_transitions (id,bookingId,fromStatus,toStatus,occurredAt) VALUES (?,?,?,?,?)",
          )
          .run(
            `transition-concurrent-confirm-${bookingId}`,
            bookingId,
            'pending',
            'confirmed',
            baseNow,
          );
        connection.exec('COMMIT');
        return 'confirmed' as const;
      } catch (error) {
        if (connection.inTransaction) connection.exec('ROLLBACK');
        throw error;
      }
    };

    const first = new Database(databasePath);
    const second = new Database(databasePath);
    first.pragma('foreign_keys = ON');
    second.pragma('foreign_keys = ON');
    first.pragma('busy_timeout = 5000');
    second.pragma('busy_timeout = 5000');
    try {
      const [aResult, bResult] = await Promise.all([
        Promise.resolve().then(() => runConfirm(first, 'concurrent-a')),
        Promise.resolve().then(() => runConfirm(second, 'concurrent-b')),
      ]);
      expect([aResult, bResult].sort()).toEqual(['confirmed', 'rejected']);
    } finally {
      first.close();
      second.close();
    }

    const reader = openDatabase(databasePath);
    try {
      const confirmedCount = (reader
        .prepare("SELECT COUNT(*) AS c FROM bookings WHERE id IN ('concurrent-a', 'concurrent-b') AND status = 'confirmed'")
        .get() as { c: number }).c;
      const rejectedCount = (reader
        .prepare("SELECT COUNT(*) AS c FROM bookings WHERE id IN ('concurrent-a', 'concurrent-b') AND status = 'rejected' AND reason = 'conflict'")
        .get() as { c: number }).c;
      expect(confirmedCount).toBe(1);
      expect(rejectedCount).toBe(1);
    } finally {
      reader.close();
    }
  });

  it('возвращает 409 time_unavailable при пересечении с подтверждённой встречей гостя', async () => {
    // AC-06, TIME-07/08
    const entry = await fixture();
    const publicId = 'public-expert';
    const expertId = await makeExpert({
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const otherExpertId = await makeExpert({
      database: entry.database,
      email: 'other@example.test',
      publicId: 'other-expert',
      name: 'Другой',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    insertBookingRow(entry.database, {
      id: 'confirmed-elsewhere',
      expertId: otherExpertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
      status: 'confirmed',
    });
    insertPendingWithTransition(entry.database, {
      id: 'pending-blocked',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-blocked/confirm',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-conflict-guest-confirmed',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('time_unavailable');
    const stillPending = entry.database
      .prepare("SELECT status FROM bookings WHERE id = 'pending-blocked'")
      .get() as { status: string };
    expect(stillPending.status).toBe('pending');
  });

  it('возвращает 404 для чужой заявки от другого эксперта', async () => {
    // PDR §10.1, AUTH-14/AUTH-15: чужая заявка неотличима от отсутствующей.
    const entry = await fixture();
    const ownerExpertId = await makeExpert({
      database: entry.database,
      email: 'owner@example.test',
      publicId: 'owner-expert',
      name: 'Владелец',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    await makeExpert({
      database: entry.database,
      email: 'other@example.test',
      publicId: 'other-expert',
      name: 'Другой',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    insertPendingWithTransition(entry.database, {
      id: 'pending-foreign',
      expertId: ownerExpertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('other@example.test', true);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-foreign/confirm',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-foreign',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
  });

  it('возвращает 409 status_conflict для уже подтверждённой заявки', async () => {
    // PDR §5: терминальные и не-p состояния не подтверждаются повторно.
    const entry = await fixture();
    const publicId = 'public-expert';
    const expertId = await makeExpert({
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    insertBookingRow(entry.database, {
      id: 'already-confirmed',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
      status: 'confirmed',
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/already-confirmed/confirm',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-double-confirm',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('status_conflict');
  });

  it('возвращает 409 status_conflict для отклонённой заявки', async () => {
    // PDR §5: терминальные состояния не подтверждаются.
    const entry = await fixture();
    const publicId = 'public-expert';
    const expertId = await makeExpert({
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    insertBookingRow(entry.database, {
      id: 'already-rejected',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
      status: 'rejected',
      reason: 'manual',
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/already-rejected/confirm',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-rejected',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('status_conflict');
  });

  it('возвращает 409 deadline_exceeded за пределами трёхчасового окна', async () => {
    // AC-05, TIME-05: подтверждение позже startUtc - 3 часов запрещено.
    const entry = await fixture();
    const publicId = 'public-expert';
    const expertId = await makeExpert({
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    insertPendingWithTransition(entry.database, {
      id: 'pending-late',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    // 30 минут позже границы: startUtc - 2 часа 30 минут.
    entry.setNow(slotStartMs - 2 * 60 * 60_000 - 30 * 60_000);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-late/confirm',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-deadline',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('deadline_exceeded');
    const stillPending = entry.database
      .prepare("SELECT status FROM bookings WHERE id = 'pending-late'")
      .get() as { status: string };
    expect(stillPending.status).toBe('pending');
  });

  it('возвращает прежний результат при повторе ключа идемпотентности', async () => {
    // BOOK-01, ONTOLOGY §6: повтор не создаёт второго перехода.
    const entry = await fixture();
    const publicId = 'public-expert';
    const expertId = await makeExpert({
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    insertPendingWithTransition(entry.database, {
      id: 'pending-replay',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    const idemKey = 'idem-replay-confirm';
    const headers = {
      origin,
      cookie,
      'x-csrf-token': csrfToken,
      'idempotency-key': idemKey,
    };

    const first = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-replay/confirm',
      headers,
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    const second = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-replay/confirm',
      headers,
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const confirmTransitions = (entry.database
      .prepare(
        "SELECT COUNT(*) AS c FROM booking_transitions WHERE bookingId = ? AND toStatus = 'confirmed'",
      )
      .get('pending-replay') as { c: number }).c;
    expect(confirmTransitions).toBe(1);
  });

  it('возвращает 422 idempotency_conflict при другом теле с тем же ключом', async () => {
    // BOOK-01: повтор с другим телом при том же ключе — конфликт.
    const entry = await fixture();
    const publicId = 'public-expert';
    const expertId = await makeExpert({
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    insertPendingWithTransition(entry.database, {
      id: 'pending-idem',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    const idemKey = 'idem-conflict-body';
    const headers = {
      origin,
      cookie,
      'x-csrf-token': csrfToken,
      'idempotency-key': idemKey,
    };

    const first = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-idem/confirm',
      headers,
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    const second = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-idem/confirm',
      headers,
      payload: { extra: 'different' },
    });
    expect(second.statusCode).toBe(422);
    expect(second.json().code).toBe('idempotency_conflict');
  });

  it('требует заголовки Origin и X-CSRF-Token', async () => {
    // PDR §10.1, AUTH-13: проверка прав на каждый объект, Origin и CSRF-токен.
    const entry = await fixture();
    const publicId = 'public-expert';
    const expertId = await makeExpert({
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    insertPendingWithTransition(entry.database, {
      id: 'pending-csrf',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);

    const withoutOrigin = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-csrf/confirm',
      headers: {
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-no-origin',
      },
      payload: {},
    });
    expect(withoutOrigin.statusCode).toBe(403);

    const withoutCsrf = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-csrf/confirm',
      headers: {
        origin,
        cookie,
        'idempotency-key': 'idem-no-csrf',
      },
      payload: {},
    });
    expect(withoutCsrf.statusCode).toBe(403);
  });
});
