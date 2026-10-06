// RED-набор тестов для задачи 012 «Остальные переходы заявки».
// Покрывает AC-05/09, переходы pending->{rejected, withdrawn, expired} и confirmed->cancelled
// по PDR §4.4, §4.5, §5, §10.1, ADR-001 «Семантика времени» (трёхчасовая граница),
// ONTOLOGY §6 «Жизненный цикл заявки», TIME-04/05/06, BOOK-01, NOTIFY-03/04/08.
//
// Пока эндпоинты POST /api/v1/bookings/{id}/reject|withdraw|cancel и
// системный обработчик истечения не реализованы, тесты должны падать с 404 и прочими
// ожидаемыми статусами — это подтверждает фазу RED. После реализации задачи 012
// эти же тесты должны проходить зелёной фазой.
//
// Эти тесты намеренно НЕ создают новых хелперов, а повторяют локально фикстуру из
// `booking-confirm.test.ts`, чтобы не зависеть от ещё не существующих общих модулей.

import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpertAuthApp } from '../src/auth/index.ts';
import { openDatabase } from '../src/repository.ts';

const origin = 'http://localhost:5173';
const consentVersion = 'v1';
const hmacSecret = 'test-only-hmac-secret';
const baseNow = Date.parse('2026-10-05T00:00:00Z');
// Слот 02:00Z — 09:00 Красноярск во вторник, 26 часов после baseNow.
const slotStartMs = Date.parse('2026-10-06T02:00:00.000Z');
const slotEndMs = Date.parse('2026-10-06T02:30:00.000Z');
const threeHoursMs = 3 * 60 * 60_000;

type Fixture = {
  app: Awaited<ReturnType<typeof createExpertAuthApp>>;
  database: ReturnType<typeof openDatabase>;
  directory: string;
  sent: Array<{ to: string; code: string }>;
  getNow: () => number;
  setNow: (value: number) => void;
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
    status: 'pending' | 'confirmed' | 'rejected' | 'withdrawn' | 'expired' | 'cancelled';
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

function insertConfirmedWithTransition(
  database: ReturnType<typeof openDatabase>,
  options: {
    id: string;
    expertId: string;
    guestEmail: string;
    guestName: string;
    startMs: number;
    endMs: number;
    createdAt?: number;
  },
) {
  // Одна запись bookings в статусе confirmed, цепочка из двух переходов: null->pending и pending->confirmed.
  const createdAt = options.createdAt ?? baseNow;
  const insertSql =
    'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,description,status,reason,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)';
  database
    .prepare(insertSql)
    .run(
      options.id,
      options.expertId,
      options.guestEmail,
      options.guestName,
      'Asia/Krasnoyarsk',
      options.startMs,
      options.endMs,
      'Тема',
      null,
      'confirmed',
      null,
      2,
      createdAt + 1,
    );
  database
    .prepare(
      'INSERT INTO booking_transitions (id,bookingId,fromStatus,toStatus,occurredAt) VALUES (?,?,?,?,?)',
    )
    .run(`transition-create-${options.id}`, options.id, null, 'pending', createdAt);
  database
    .prepare(
      'INSERT INTO booking_transitions (id,bookingId,fromStatus,toStatus,occurredAt) VALUES (?,?,?,?,?)',
    )
    .run(`transition-confirm-${options.id}`, options.id, 'pending', 'confirmed', createdAt + 1);
}

// Вставляет строку доступа гостя в обход кодового пути: генерирует токен и хеш по тому
// же контракту, что использует auth/guest-auth.ts. Удобно для подготовки к переходам
// pending->withdrawn и confirmed->cancelled от имени гостя.
function issueGuestAccess(
  database: ReturnType<typeof openDatabase>,
  bookingId: string,
  guestEmail: string,
  nowMs: number,
): string {
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHmac('sha256', hmacSecret)
    .update('guest-access')
    .update('\0')
    .update(token)
    .digest('hex');
  database
    .prepare(
      'INSERT INTO guest_access (id,bookingId,tokenHash,email,createdAt,expiresAt) VALUES (?,?,?,?,?,?)',
    )
    .run(randomUUID(), bookingId, tokenHash, guestEmail, nowMs, nowMs + 30 * 24 * 60 * 60_000);
  return token;
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-booking-transitions-'));
  const database = openDatabase(join(directory, 'test.sqlite'));
  const sent: Array<{ to: string; code: string }> = [];
  let nowMs = baseNow;
  const getNow = () => nowMs;
  const setNow = (value: number) => {
    nowMs = value;
  };
  const app = await createExpertAuthApp({
    database,
    sendCode: async (message: { to: string; code: string }) => {
      sent.push(message);
    },
    now: getNow,
    hmacSecret,
    allowedOrigin: origin,
    consentVersion,
    deletionContact: 'owner@example.test',
    systemApiKey: 'test-system-key',
  });
  const entry: Fixture = {
    app,
    database,
    directory,
    sent,
    getNow,
    setNow,
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

// =============================================================================
// A. Ручное отклонение экспертом (PDR §4.4, ONTOLOGY §6: pending->rejected)
// =============================================================================
describe('booking reject HTTP command (expert)', () => {
  it('переводит pending в rejected в одной транзакции и пишет переход с reason=manual', async () => {
    // AC-05, BOOK-01, ONTOLOGY §6, PDR §4.4, NOTIFY-03.
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
      id: 'pending-to-reject',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-to-reject/reject',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-reject-happy',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.status).toBe('rejected');
    expect(json.id).toBe('pending-to-reject');
    expect(json.closedReason).toBe('manual');

    const row = entry.database
      .prepare('SELECT status, reason, version, updatedAt FROM bookings WHERE id = ?')
      .get('pending-to-reject') as {
      status: string;
      reason: string | null;
      version: number;
      updatedAt: number | null;
    };
    expect(row.status).toBe('rejected');
    expect(row.reason).toBe('manual');
    expect(row.version).toBeGreaterThan(1);
    expect(row.updatedAt).not.toBeNull();
    expect(row.updatedAt!).toBeGreaterThan(baseNow);

    const transition = entry.database
      .prepare(
        'SELECT fromStatus, toStatus, reason FROM booking_transitions WHERE bookingId = ? AND toStatus = ?',
      )
      .get('pending-to-reject', 'rejected') as
      | { fromStatus: string; toStatus: string; reason: string | null }
      | undefined;
    expect(transition).toEqual({
      fromStatus: 'pending',
      toStatus: 'rejected',
      reason: 'manual',
    });

    const jobs = entry.database
      .prepare('SELECT type, recipient FROM jobs WHERE bookingId = ? ORDER BY type')
      .all('pending-to-reject') as Array<{ type: string; recipient: string }>;
    expect(jobs.map((j) => j.type)).toEqual(['notify_guest_meeting_rejected']);
  });

  it('возвращает 404 чужому эксперту, который пытается отклонить чужую заявку', async () => {
    // PDR §10.1, AUTH-14/15: чужая заявка неотличима от отсутствующей.
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
      id: 'pending-foreign-reject',
      expertId: ownerExpertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('other@example.test', true);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-foreign-reject/reject',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-foreign-reject',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(404);
    const stillPending = entry.database
      .prepare("SELECT status FROM bookings WHERE id = 'pending-foreign-reject'")
      .get() as { status: string };
    expect(stillPending.status).toBe('pending');
  });

  it('возвращает 409 status_conflict для уже отклонённой, отозванной, истёкшей и подтверждённой заявки', async () => {
    // PDR §5: терминальные состояния и подтверждённая не меняются через reject.
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
      id: 'rejected-already',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
      status: 'rejected',
      reason: 'manual',
    });
    insertBookingRow(entry.database, {
      id: 'withdrawn-already',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
      status: 'withdrawn',
    });
    insertBookingRow(entry.database, {
      id: 'expired-already',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
      status: 'expired',
      reason: 'deadline',
    });
    insertBookingRow(entry.database, {
      id: 'confirmed-already',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
      status: 'confirmed',
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    const headers = {
      origin,
      cookie,
      'x-csrf-token': csrfToken,
    };

    for (const id of ['rejected-already', 'withdrawn-already', 'expired-already', 'confirmed-already']) {
      const response = await entry.app.inject({
        method: 'POST',
        url: `/api/v1/bookings/${id}/reject`,
        headers: { ...headers, 'idempotency-key': `idem-reject-${id}` },
        payload: {},
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('status_conflict');
      const row = entry.database
        .prepare('SELECT status, reason FROM bookings WHERE id = ?')
        .get(id) as { status: string; reason: string | null };
      // Состояние не меняется: для не-rejected статус остаётся прежним,
      // для rejected — остаётся rejected (это её терминальное состояние).
      // Проверяем, что ни одна из записей не «появилась» в rejected через /reject.
      if (id !== 'rejected-already') expect(row.status).not.toBe('rejected');
    }
  });

  it('возвращает 409 deadline_exceeded при отклонении заявки с истёкшим трёхчасовым окном', async () => {
    // AC-05/AC-09, ADR-001 «Семантика времени»: отклонение запрещено ближе чем за 3 часа.
    // Код ошибки в ответе ожидается deadline_exceeded (согласовано с booking-confirm.test.ts).
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
      id: 'pending-late-reject',
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
      url: '/api/v1/bookings/pending-late-reject/reject',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-reject-deadline',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('deadline_exceeded');
    const stillPending = entry.database
      .prepare("SELECT status FROM bookings WHERE id = 'pending-late-reject'")
      .get() as { status: string };
    expect(stillPending.status).toBe('pending');
  });

  it('требует сессию эксперта и возвращает 401 без неё', async () => {
    // PDR §10.1, AUTH-13: права проверяются на каждом объекте.
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
      id: 'pending-no-auth',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-no-auth/reject',
      headers: { origin, 'idempotency-key': 'idem-reject-noauth' },
      payload: {},
    });

    expect([401, 403]).toContain(response.statusCode);
    const stillPending = entry.database
      .prepare("SELECT status FROM bookings WHERE id = 'pending-no-auth'")
      .get() as { status: string };
    expect(stillPending.status).toBe('pending');
  });

  it('возвращает прежний результат при повторе ключа идемпотентности с тем же телом', async () => {
    // BOOK-01, ONTOLOGY §6: повторный вызов с тем же ключом и телом не плодит переходы.
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
      id: 'pending-replay-reject',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    const headers = {
      origin,
      cookie,
      'x-csrf-token': csrfToken,
      'idempotency-key': 'idem-replay-reject',
    };

    const first = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-replay-reject/reject',
      headers,
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    const second = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-replay-reject/reject',
      headers,
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const rejectTransitions = (entry.database
      .prepare(
        "SELECT COUNT(*) AS c FROM booking_transitions WHERE bookingId = ? AND toStatus = 'rejected'",
      )
      .get('pending-replay-reject') as { c: number }).c;
    expect(rejectTransitions).toBe(1);
  });

  it('возвращает 422 idempotency_conflict при другом теле с тем же ключом', async () => {
    // BOOK-01: повтор с другим телом при том же ключе — конфликт без изменения состояния.
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
      id: 'pending-idem-reject',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    const headers = {
      origin,
      cookie,
      'x-csrf-token': csrfToken,
      'idempotency-key': 'idem-reject-body-conflict',
    };

    const first = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-idem-reject/reject',
      headers,
      payload: { reason: 'manual' },
    });
    expect(first.statusCode).toBe(200);

    const second = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-idem-reject/reject',
      headers,
      payload: { reason: 'conflict' },
    });
    expect(second.statusCode).toBe(422);
    expect(second.json().code).toBe('idempotency_conflict');
  });

  it('отклоняет запрос с чужим Origin и не меняет состояние', async () => {
    // PDR §10.1, AUTH-13: Origin обязателен и сверяется.
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
      id: 'pending-csrf-reject',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-csrf-reject/reject',
      headers: {
        origin: 'http://malicious.example',
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-reject-origin',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    const stillPending = entry.database
      .prepare("SELECT status FROM bookings WHERE id = 'pending-csrf-reject'")
      .get() as { status: string };
    expect(stillPending.status).toBe('pending');
  });
});

// =============================================================================
// B. Отзыв гостем (PDR §4.4, ONTOLOGY §6: pending->withdrawn)
// =============================================================================
describe('booking withdraw HTTP command (guest)', () => {
  it('переводит pending в withdrawn с reason=null и пишет переход', async () => {
    // AC-05, BOOK-01, ONTOLOGY §6, PDR §4.4, NOTIFY-08.
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
      id: 'pending-to-withdraw',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const accessToken = issueGuestAccess(
      entry.database,
      'pending-to-withdraw',
      'guest@example.test',
      baseNow,
    );

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-to-withdraw/withdraw',
      headers: {
        origin,
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-withdraw-happy',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.status).toBe('withdrawn');
    expect(json.id).toBe('pending-to-withdraw');
    expect(json.closedReason).toBeUndefined();

    const row = entry.database
      .prepare('SELECT status, reason, version, updatedAt FROM bookings WHERE id = ?')
      .get('pending-to-withdraw') as {
      status: string;
      reason: string | null;
      version: number;
      updatedAt: number | null;
    };
    expect(row.status).toBe('withdrawn');
    expect(row.reason).toBeNull();
    expect(row.version).toBeGreaterThan(1);
    expect(row.updatedAt).not.toBeNull();

    const transition = entry.database
      .prepare(
        'SELECT fromStatus, toStatus, reason FROM booking_transitions WHERE bookingId = ? AND toStatus = ?',
      )
      .get('pending-to-withdraw', 'withdrawn') as
      | { fromStatus: string; toStatus: string; reason: string | null }
      | undefined;
    expect(transition).toEqual({
      fromStatus: 'pending',
      toStatus: 'withdrawn',
      reason: null,
    });

    const jobs = entry.database
      .prepare('SELECT type, recipient FROM jobs WHERE bookingId = ? ORDER BY type')
      .all('pending-to-withdraw') as Array<{ type: string; recipient: string }>;
    expect(jobs.map((j) => j.type)).toEqual(['notify_expert_meeting_withdrawn']);
  });

  it('требует гостевой токен доступа и возвращает 401/403 без него', async () => {
    // PDR §10.1, AUTH-13.
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
      id: 'pending-no-token',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-no-token/withdraw',
      headers: { origin, 'idempotency-key': 'idem-withdraw-noauth' },
      payload: {},
    });

    expect([401, 403]).toContain(response.statusCode);
    const stillPending = entry.database
      .prepare("SELECT status FROM bookings WHERE id = 'pending-no-token'")
      .get() as { status: string };
    expect(stillPending.status).toBe('pending');
  });

  it('отвергает токен чужого гостя или чужой заявки', async () => {
    // Токен доступа выдан на другую заявку — отзыв не должен пройти.
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
      id: 'pending-withdraw-target',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    insertPendingWithTransition(entry.database, {
      id: 'pending-other-booking',
      expertId,
      guestEmail: 'other@example.test',
      guestName: 'Другой',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    // Токен выписан на чужую заявку, а не на ту, которую пытаемся отозвать.
    const foreignToken = issueGuestAccess(
      entry.database,
      'pending-other-booking',
      'other@example.test',
      baseNow,
    );

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-withdraw-target/withdraw',
      headers: {
        origin,
        authorization: `Bearer ${foreignToken}`,
        'idempotency-key': 'idem-withdraw-foreign',
      },
      payload: {},
    });

    expect([403, 404]).toContain(response.statusCode);
    const stillPending = entry.database
      .prepare("SELECT status FROM bookings WHERE id = 'pending-withdraw-target'")
      .get() as { status: string };
    expect(stillPending.status).toBe('pending');
  });

  it('возвращает 409 status_conflict для не-pending записей и повторного отзыва', async () => {
    // PDR §5: терминальные и подтверждённая не отзываются; повторный withdraw — конфликт.
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
      id: 'confirmed-no-withdraw',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
      status: 'confirmed',
    });
    insertPendingWithTransition(entry.database, {
      id: 'pending-double-withdraw',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const tokenForConfirmed = issueGuestAccess(
      entry.database,
      'confirmed-no-withdraw',
      'guest@example.test',
      baseNow,
    );
    const tokenForDouble = issueGuestAccess(
      entry.database,
      'pending-double-withdraw',
      'guest@example.test',
      baseNow,
    );

    const confirmedResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-no-withdraw/withdraw',
      headers: {
        origin,
        authorization: `Bearer ${tokenForConfirmed}`,
        'idempotency-key': 'idem-withdraw-confirmed',
      },
      payload: {},
    });
    expect(confirmedResponse.statusCode).toBe(409);
    expect(confirmedResponse.json().code).toBe('status_conflict');

    const firstWithdraw = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-double-withdraw/withdraw',
      headers: {
        origin,
        authorization: `Bearer ${tokenForDouble}`,
        'idempotency-key': 'idem-withdraw-first',
      },
      payload: {},
    });
    expect(firstWithdraw.statusCode).toBe(200);

    const secondWithdraw = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-double-withdraw/withdraw',
      headers: {
        origin,
        authorization: `Bearer ${tokenForDouble}`,
        'idempotency-key': 'idem-withdraw-second',
      },
      payload: {},
    });
    expect(secondWithdraw.statusCode).toBe(409);
    expect(secondWithdraw.json().code).toBe('status_conflict');
  });

  it('разрешает отзыв ровно за 3 часа до начала и запрещает на 1 мс позже', async () => {
    // AC-05/AC-09, ADR-001 «Семантика времени», ONTOLOGY §6: граница трёх часов.
    // Гость может отозвать pending пока до начала остаётся >= 3 часа.
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

    // Ровно 3 часа до начала — должно быть разрешено.
    insertPendingWithTransition(entry.database, {
      id: 'pending-edge-ok',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const tokenEdgeOk = issueGuestAccess(
      entry.database,
      'pending-edge-ok',
      'guest@example.test',
      baseNow,
    );
    entry.setNow(slotStartMs - threeHoursMs);
    const okResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-edge-ok/withdraw',
      headers: {
        origin,
        authorization: `Bearer ${tokenEdgeOk}`,
        'idempotency-key': 'idem-withdraw-edge-ok',
      },
      payload: {},
    });
    expect(okResponse.statusCode).toBe(200);
    expect(okResponse.json().status).toBe('withdrawn');

    // 3 часа минус 1 мс — должно быть запрещено.
    insertPendingWithTransition(entry.database, {
      id: 'pending-edge-fail',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const tokenEdgeFail = issueGuestAccess(
      entry.database,
      'pending-edge-fail',
      'guest@example.test',
      baseNow,
    );
    entry.setNow(slotStartMs - threeHoursMs + 1);
    const failResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-edge-fail/withdraw',
      headers: {
        origin,
        authorization: `Bearer ${tokenEdgeFail}`,
        'idempotency-key': 'idem-withdraw-edge-fail',
      },
      payload: {},
    });
    expect(failResponse.statusCode).toBe(409);
    expect(failResponse.json().code).toBe('deadline_exceeded');
    const stillPending = entry.database
      .prepare("SELECT status FROM bookings WHERE id = 'pending-edge-fail'")
      .get() as { status: string };
    expect(stillPending.status).toBe('pending');
  });

  it('повтор с тем же ключом идемпотентности и телом не плодит переходов', async () => {
    // BOOK-01, ONTOLOGY §6: повторный withdraw не создаёт вторую запись.
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
      id: 'pending-replay-withdraw',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const accessToken = issueGuestAccess(
      entry.database,
      'pending-replay-withdraw',
      'guest@example.test',
      baseNow,
    );
    const headers = {
      origin,
      authorization: `Bearer ${accessToken}`,
      'idempotency-key': 'idem-replay-withdraw',
    };

    const first = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-replay-withdraw/withdraw',
      headers,
      payload: {},
    });
    expect(first.statusCode).toBe(200);

    const second = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-replay-withdraw/withdraw',
      headers,
      payload: {},
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const withdrawTransitions = (entry.database
      .prepare(
        "SELECT COUNT(*) AS c FROM booking_transitions WHERE bookingId = ? AND toStatus = 'withdrawn'",
      )
      .get('pending-replay-withdraw') as { c: number }).c;
    expect(withdrawTransitions).toBe(1);
  });

  it('отвергает запрос с чужим Origin', async () => {
    // PDR §10.1, AUTH-13.
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
      id: 'pending-origin-withdraw',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const accessToken = issueGuestAccess(
      entry.database,
      'pending-origin-withdraw',
      'guest@example.test',
      baseNow,
    );

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-origin-withdraw/withdraw',
      headers: {
        origin: 'http://malicious.example',
        authorization: `Bearer ${accessToken}`,
        'idempotency-key': 'idem-withdraw-origin',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    const stillPending = entry.database
      .prepare("SELECT status FROM bookings WHERE id = 'pending-origin-withdraw'")
      .get() as { status: string };
    expect(stillPending.status).toBe('pending');
  });
});

// =============================================================================
// C. Истечение заявки (PDR §4.4, ONTOLOGY §6: pending->expired, системный процесс).
// =============================================================================
// Реализация фоновоq задачи относится к задаче 014, но сам переход pending->expired
// (атомарная запись и обновление статуса) — это ответственность 012, поэтому тесты
// проверяют именно функцию перехода. Если к моменту тестов нет системного эндпоинта,
// достаточно проверить прямой вызов экспортируемой функции.
describe('booking expiration (system)', () => {
  it('переводит просроченную pending в expired и пишет переход с reason=expired', async () => {
    // AC-05, ONTOLOGY §6, PDR §4.4, NOTIFY-03.
    // Ожидаемое падение до реализации задачи 012: системный обработчик или
    // экспортируемая функция `expireOverdueBookings`/`expireBooking` ещё не существует.
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
      id: 'pending-overdue',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    // Время уже после трёхчасовой границы: 2 часа 59 минут до начала.
    entry.setNow(slotStartMs - 2 * 60 * 60_000 - 59 * 60_000);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-overdue/expire',
      headers: { origin, 'x-system-key': 'test-system-key' },
      payload: {},
    });

    // Ожидаемое падение до реализации задачи 012: маршрут отсутствует (404),
    // поэтому фактический статус ниже будет 404. Здесь зафиксировано требуемое
    // поведение, чтобы тест стал зелёным после появления системного обработчика.
    expect([200, 204]).toContain(response.statusCode);
    if (response.statusCode === 200) {
      const json = response.json();
      expect(json.status).toBe('expired');
      expect(json.closedReason).toBe('expired');
    }
    const row = entry.database
      .prepare('SELECT status, reason FROM bookings WHERE id = ?')
      .get('pending-overdue') as { status: string; reason: string | null };
    expect(row.status).toBe('expired');
    expect(row.reason).toBe('expired');

    const transition = entry.database
      .prepare(
        'SELECT fromStatus, toStatus, reason FROM booking_transitions WHERE bookingId = ? AND toStatus = ?',
      )
      .get('pending-overdue', 'expired') as
      | { fromStatus: string; toStatus: string; reason: string | null }
      | undefined;
    expect(transition).toEqual({
      fromStatus: 'pending',
      toStatus: 'expired',
      reason: 'expired',
    });
  });

  it('не истекает заявку, у которой до начала остаётся >= 3 часа', async () => {
    // ONTOLOGY §6: pending переходит в expired только после трёхчасовой границы.
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
      id: 'pending-not-overdue',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    // Ровно 3 часа до начала — граница, истечения нет.
    entry.setNow(slotStartMs - threeHoursMs);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-not-overdue/expire',
      headers: { origin, 'x-system-key': 'test-system-key' },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('not_overdue');
    const stillPending = entry.database
      .prepare("SELECT status FROM bookings WHERE id = 'pending-not-overdue'")
      .get() as { status: string };
    expect(stillPending.status).toBe('pending');
  });

  it('не истекает заявки в не-pending состояниях', async () => {
    // ONTOLOGY §6: истекать может только pending.
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
      id: 'confirmed-no-expire',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
      status: 'confirmed',
    });
    entry.setNow(slotStartMs + 60_000);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-no-expire/expire',
      headers: { origin, 'x-system-key': 'test-system-key' },
      payload: {},
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('status_conflict');
    const row = entry.database
      .prepare('SELECT status FROM bookings WHERE id = ?')
      .get('confirmed-no-expire') as { status: string };
    expect(row.status).toBe('confirmed');
  });

  it('повторное истечение не создаёт вторую запись в booking_transitions', async () => {
    // ONTOLOGY §6, BOOK-01: идемпотентность истечения.
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
      id: 'pending-double-expire',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    entry.setNow(slotStartMs - 60_000);

    const headers = { origin, 'x-system-key': 'test-system-key' };
    const first = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-double-expire/expire',
      headers,
      payload: {},
    });
    expect([200, 204]).toContain(first.statusCode);

    const second = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-double-expire/expire',
      headers,
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('status_conflict');

    const expiredTransitions = (entry.database
      .prepare(
        "SELECT COUNT(*) AS c FROM booking_transitions WHERE bookingId = ? AND toStatus = 'expired'",
      )
      .get('pending-double-expire') as { c: number }).c;
    expect(expiredTransitions).toBe(1);
  });
});

// =============================================================================
// D. Отмена подтверждённой встречи (PDR §4.5, ONTOLOGY §6: confirmed->cancelled)
// =============================================================================
describe('booking cancel HTTP command (confirmed->cancelled)', () => {
  it('отменяет подтверждённую встречу экспертом-организатором в любой момент до начала', async () => {
    // AC-09, TIME-06, ONTOLOGY §6, PDR §4.5, NOTIFY-04.
    // Эксперт может отменить встречу в любой момент до начала.
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
    insertConfirmedWithTransition(entry.database, {
      id: 'confirmed-expert-cancel',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    // 5 минут до начала — для гостя уже поздно, для эксперта — допустимо.
    entry.setNow(slotStartMs - 5 * 60_000);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-expert-cancel/cancel',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-cancel-expert-late',
      },
      payload: { reason: 'эксперт отменил' },
    });

    expect(response.statusCode).toBe(200);
    const json = response.json();
    expect(json.status).toBe('cancelled');
    expect(json.id).toBe('confirmed-expert-cancel');
    expect(json.closedReason).toBe('эксперт отменил');

    const row = entry.database
      .prepare('SELECT status, reason FROM bookings WHERE id = ?')
      .get('confirmed-expert-cancel') as { status: string; reason: string | null };
    expect(row.status).toBe('cancelled');
    expect(row.reason).toBe('эксперт отменил');

    const transition = entry.database
      .prepare(
        'SELECT fromStatus, toStatus FROM booking_transitions WHERE bookingId = ? AND toStatus = ?',
      )
      .get('confirmed-expert-cancel', 'cancelled') as
      | { fromStatus: string; toStatus: string }
      | undefined;
    expect(transition).toEqual({ fromStatus: 'confirmed', toStatus: 'cancelled' });
  });

  it('разрешает гостю отменить ровно за 3 часа и запрещает на 1 мс позже', async () => {
    // TIME-06: гость отменяет встречу не позднее чем за 3 часа до начала.
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

    // Ровно 3 часа — должно быть разрешено.
    insertConfirmedWithTransition(entry.database, {
      id: 'confirmed-guest-edge-ok',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const tokenOk = issueGuestAccess(
      entry.database,
      'confirmed-guest-edge-ok',
      'guest@example.test',
      baseNow,
    );
    entry.setNow(slotStartMs - threeHoursMs);
    const okResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-guest-edge-ok/cancel',
      headers: {
        origin,
        authorization: `Bearer ${tokenOk}`,
        'idempotency-key': 'idem-cancel-guest-ok',
      },
      payload: {},
    });
    expect(okResponse.statusCode).toBe(200);
    expect(okResponse.json().status).toBe('cancelled');

    // 3 часа минус 1 мс — должно быть запрещено для гостя.
    insertConfirmedWithTransition(entry.database, {
      id: 'confirmed-guest-edge-fail',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const tokenFail = issueGuestAccess(
      entry.database,
      'confirmed-guest-edge-fail',
      'guest@example.test',
      baseNow,
    );
    entry.setNow(slotStartMs - threeHoursMs + 1);
    const failResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-guest-edge-fail/cancel',
      headers: {
        origin,
        authorization: `Bearer ${tokenFail}`,
        'idempotency-key': 'idem-cancel-guest-fail',
      },
      payload: {},
    });
    expect(failResponse.statusCode).toBe(409);
    expect(failResponse.json().code).toBe('deadline_exceeded');
    const row = entry.database
      .prepare('SELECT status FROM bookings WHERE id = ?')
      .get('confirmed-guest-edge-fail') as { status: string };
    expect(row.status).toBe('confirmed');
  });

  it('не разрешает гостю отменять чужую встречу и чужому эксперту — чужую', async () => {
    // PDR §10.1, AUTH-14/15.
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
    insertConfirmedWithTransition(entry.database, {
      id: 'confirmed-foreign-cancel',
      expertId: ownerExpertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    // Токен чужого гостя, выписанный на чужую заявку.
    const foreignGuestToken = issueGuestAccess(
      entry.database,
      'confirmed-foreign-cancel',
      'intruder@example.test',
      baseNow,
    );
    entry.setNow(slotStartMs - 24 * 60 * 60_000);
    const guestResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-foreign-cancel/cancel',
      headers: {
        origin,
        authorization: `Bearer ${foreignGuestToken}`,
        'idempotency-key': 'idem-cancel-foreign-guest',
      },
      payload: {},
    });
    expect([403, 404]).toContain(guestResponse.statusCode);
    const rowAfterGuest = entry.database
      .prepare('SELECT status FROM bookings WHERE id = ?')
      .get('confirmed-foreign-cancel') as { status: string };
    expect(rowAfterGuest.status).toBe('confirmed');

    // Чужой эксперт — также не имеет доступа.
    const { cookie, csrfToken } = await entry.loginExpert('other@example.test', true);
    const expertResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-foreign-cancel/cancel',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-cancel-foreign-expert',
      },
      payload: {},
    });
    expect(expertResponse.statusCode).toBe(404);
    const rowAfterExpert = entry.database
      .prepare('SELECT status FROM bookings WHERE id = ?')
      .get('confirmed-foreign-cancel') as { status: string };
    expect(rowAfterExpert.status).toBe('confirmed');
  });

  it('возвращает 409 status_conflict для не-confirmed записей и повторной отмены', async () => {
    // PDR §5: только confirmed->cancelled; остальные — конфликт.
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
      id: 'pending-no-cancel',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    insertBookingRow(entry.database, {
      id: 'already-cancelled',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
      status: 'cancelled',
      reason: 'manual',
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    entry.setNow(slotStartMs - 24 * 60 * 60_000);

    const pendingResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/pending-no-cancel/cancel',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-cancel-pending',
      },
      payload: {},
    });
    expect(pendingResponse.statusCode).toBe(409);
    expect(pendingResponse.json().code).toBe('status_conflict');

    const cancelledResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/already-cancelled/cancel',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-cancel-double',
      },
      payload: {},
    });
    expect(cancelledResponse.statusCode).toBe(409);
    expect(cancelledResponse.json().code).toBe('status_conflict');
  });

  it('запрещает отмену уже начавшейся встречи для обеих ролей', async () => {
    // PDR §5: отменять можно только до начала.
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
    insertConfirmedWithTransition(entry.database, {
      id: 'confirmed-already-started',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const token = issueGuestAccess(
      entry.database,
      'confirmed-already-started',
      'guest@example.test',
      baseNow,
    );
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    // Время уже после начала.
    entry.setNow(slotStartMs + 60_000);

    const guestResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-already-started/cancel',
      headers: {
        origin,
        authorization: `Bearer ${token}`,
        'idempotency-key': 'idem-cancel-started-guest',
      },
      payload: {},
    });
    expect(guestResponse.statusCode).toBe(409);
    expect(guestResponse.json().code).toBe('already_started');

    const expertResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-already-started/cancel',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-cancel-started-expert',
      },
      payload: {},
    });
    expect(expertResponse.statusCode).toBe(409);
    expect(expertResponse.json().code).toBe('already_started');

    const row = entry.database
      .prepare('SELECT status FROM bookings WHERE id = ?')
      .get('confirmed-already-started') as { status: string };
    expect(row.status).toBe('confirmed');
  });

  it('повтор с тем же ключом идемпотентности не плодит переходов; с другим телом — 422', async () => {
    // BOOK-01.
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
    insertConfirmedWithTransition(entry.database, {
      id: 'confirmed-replay-cancel',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    entry.setNow(slotStartMs - 24 * 60 * 60_000);
    const headers = {
      origin,
      cookie,
      'x-csrf-token': csrfToken,
      'idempotency-key': 'idem-cancel-replay',
    };

    const first = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-replay-cancel/cancel',
      headers,
      payload: { reason: 'первая' },
    });
    expect(first.statusCode).toBe(200);

    const second = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-replay-cancel/cancel',
      headers,
      payload: { reason: 'первая' },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);

    const third = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-replay-cancel/cancel',
      headers,
      payload: { reason: 'другая' },
    });
    expect(third.statusCode).toBe(422);
    expect(third.json().code).toBe('idempotency_conflict');

    const cancelTransitions = (entry.database
      .prepare(
        "SELECT COUNT(*) AS c FROM booking_transitions WHERE bookingId = ? AND toStatus = 'cancelled'",
      )
      .get('confirmed-replay-cancel') as { c: number }).c;
    expect(cancelTransitions).toBe(1);
  });

  it('отвергает запрос с чужим Origin', async () => {
    // PDR §10.1, AUTH-13.
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
    insertConfirmedWithTransition(entry.database, {
      id: 'confirmed-csrf-cancel',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    entry.setNow(slotStartMs - 24 * 60 * 60_000);

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-csrf-cancel/cancel',
      headers: {
        origin: 'http://malicious.example',
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-cancel-csrf',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(403);
    const row = entry.database
      .prepare('SELECT status FROM bookings WHERE id = ?')
      .get('confirmed-csrf-cancel') as { status: string };
    expect(row.status).toBe('confirmed');
  });
});

// =============================================================================
// E. Перенос через новую заявку (PDR §4.5: отмена + новая заявка)
// =============================================================================
describe('booking reschedule via new request (PDR §4.5)', () => {
  it('после отмены гостем старой встречи можно создать новую заявку на другой слот', async () => {
    // AC-09, PDR §4.5: перенос реализован отменой и новой заявкой с повторным подтверждением.
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
    // Старая подтверждённая встреча.
    insertConfirmedWithTransition(entry.database, {
      id: 'confirmed-old',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const oldToken = issueGuestAccess(
      entry.database,
      'confirmed-old',
      'guest@example.test',
      baseNow,
    );
    // Гость отменяет старую встречу (ровно за 3 часа — допустимо).
    // Чтобы новая заявка на тот же день прошла 24-часовое окно, сдвигаем время назад
    // на 25 часов до начала старого слота: до новой заявки останется >= 24 часа.
    entry.setNow(slotStartMs - 25 * 60 * 60_000);
    const cancelResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-old/cancel',
      headers: {
        origin,
        authorization: `Bearer ${oldToken}`,
        'idempotency-key': 'idem-cancel-old',
      },
      payload: { reason: 'перенос' },
    });
    expect(cancelResponse.statusCode).toBe(200);
    expect(cancelResponse.json().status).toBe('cancelled');

    // Новая заявка на другой слот: 10:30 Красноярск = 03:30Z (через 30 минут после старого).
    const newStart = slotStartMs + 30 * 60_000;
    const newEnd = newStart + 30 * 60_000;
    // Гостю нужно заново пройти challenge для нового бронирования.
    const challenge = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/guest-challenges`,
      headers: { origin },
      payload: { email: 'guest@example.test', consentVersion, consentAccepted: true },
    });
    expect(challenge.statusCode).toBe(202);
    const code = entry.sent.at(-1)?.code;
    if (!code) throw new Error('expected guest code to be sent');
    const verify = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/guest-challenges/${challenge.json().challengeId}/verify`,
      headers: { origin },
      payload: { code },
    });
    expect(verify.statusCode).toBe(200);
    const guestProof = verify.json().guestProof as string;

    // Создаём новую заявку.
    const createResponse = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-new-after-cancel' },
      payload: {
        guestProof,
        guestName: 'Гость',
        guestTimezone: 'Asia/Krasnoyarsk',
        startAt: new Date(newStart).toISOString(),
        durationMinutes: 30,
        topic: 'Перенос',
        consentVersion,
        consentAccepted: true,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().status).toBe('pending');

    // Старая запись — cancelled, новая — pending, и старый слот не блокирует новый.
    const oldRow = entry.database
      .prepare('SELECT status FROM bookings WHERE id = ?')
      .get('confirmed-old') as { status: string };
    expect(oldRow.status).toBe('cancelled');
    const newRow = entry.database
      .prepare('SELECT status, startUtc FROM bookings WHERE id = ?')
      .get(createResponse.json().id) as { status: string; startUtc: number };
    expect(newRow.status).toBe('pending');
    expect(newRow.startUtc).toBe(newStart);
  });

  it('после отмены нельзя сразу создать заявку на тот же слот, если осталось < 24 часов', async () => {
    // AC-09, TIME-04: новая заявка не ближе 24 часов. Слот старой встречи, к которой
    // осталось меньше 24 часов, остаётся занятым старой cancelled-записью? На самом
    // деле правило 24 часов применяется ко времени начала, а не к наличию записей.
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
    insertConfirmedWithTransition(entry.database, {
      id: 'confirmed-24h',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const oldToken = issueGuestAccess(
      entry.database,
      'confirmed-24h',
      'guest@example.test',
      baseNow,
    );
    // Гость отменяет встречу, до начала 4 часа — попадает в окно TIME-06.
    entry.setNow(slotStartMs - 4 * 60 * 60_000);
    const cancelResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-24h/cancel',
      headers: {
        origin,
        authorization: `Bearer ${oldToken}`,
        'idempotency-key': 'idem-cancel-24h',
      },
      payload: {},
    });
    expect(cancelResponse.statusCode).toBe(200);

    // Сразу пытаемся создать новую заявку на тот же слот. До начала меньше 24 часов —
    // должно быть отказано по правилу минимум 24 часа.
    const challenge = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/guest-challenges`,
      headers: { origin },
      payload: { email: 'guest@example.test', consentVersion, consentAccepted: true },
    });
    expect(challenge.statusCode).toBe(202);
    const code = entry.sent.at(-1)?.code;
    if (!code) throw new Error('expected guest code to be sent');
    const verify = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/guest-challenges/${challenge.json().challengeId}/verify`,
      headers: { origin },
      payload: { code },
    });
    expect(verify.statusCode).toBe(200);
    const guestProof = verify.json().guestProof as string;

    const createResponse = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-rebook-too-soon' },
      payload: {
        guestProof,
        guestName: 'Гость',
        guestTimezone: 'Asia/Krasnoyarsk',
        startAt: new Date(slotStartMs).toISOString(),
        durationMinutes: 30,
        topic: 'Сразу после отмены',
        consentVersion,
        consentAccepted: true,
      },
    });
    // 24-часовое окно подачи заявки нарушено (до начала меньше 24 часов).
    // create.ts возвращает 400 invalid_input — согласуем тест с реальной реализацией 010.
    expect(createResponse.statusCode).toBe(400);
    expect(createResponse.json().code).toBe('invalid_input');
  });

  it('если эксперт отменяет встречу, гость может подать новую заявку на тот же слот при 24-часовом окне', async () => {
    // PDR §4.5: после отмены слот освобождается у обоих и доступен при остальных правилах,
    // включая минимум 24 часа. Здесь эксперт отменяет за 26 часов до начала.
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
    insertConfirmedWithTransition(entry.database, {
      id: 'confirmed-by-expert-cancel',
      expertId,
      guestEmail: 'guest@example.test',
      guestName: 'Гость',
      startMs: slotStartMs,
      endMs: slotEndMs,
    });
    const { cookie, csrfToken } = await entry.loginExpert('expert@example.test', true);
    // 26 часов до начала — эксперт может отменить в любой момент до начала.
    entry.setNow(slotStartMs - 26 * 60 * 60_000);
    const cancelResponse = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/bookings/confirmed-by-expert-cancel/cancel',
      headers: {
        origin,
        cookie,
        'x-csrf-token': csrfToken,
        'idempotency-key': 'idem-cancel-by-expert',
      },
      payload: { reason: 'отменено экспертом' },
    });
    expect(cancelResponse.statusCode).toBe(200);

    // Гость получает возможность создать новую заявку на тот же слот:
    // до начала всё ещё >= 24 часа, других подтверждённых встреч нет.
    const challenge = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/guest-challenges`,
      headers: { origin },
      payload: { email: 'guest@example.test', consentVersion, consentAccepted: true },
    });
    expect(challenge.statusCode).toBe(202);
    const code = entry.sent.at(-1)?.code;
    if (!code) throw new Error('expected guest code to be sent');
    const verify = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/guest-challenges/${challenge.json().challengeId}/verify`,
      headers: { origin },
      payload: { code },
    });
    expect(verify.statusCode).toBe(200);
    const guestProof = verify.json().guestProof as string;

    const createResponse = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-rebook-after-expert' },
      payload: {
        guestProof,
        guestName: 'Гость',
        guestTimezone: 'Asia/Krasnoyarsk',
        startAt: new Date(slotStartMs).toISOString(),
        durationMinutes: 30,
        topic: 'После отмены экспертом',
        consentVersion,
        consentAccepted: true,
      },
    });
    expect(createResponse.statusCode).toBe(201);
    expect(createResponse.json().status).toBe('pending');
  });
});
