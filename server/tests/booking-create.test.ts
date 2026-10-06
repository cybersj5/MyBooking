import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createExpertAuthApp } from '../src/auth/index.ts';
import {
  findExpertByPublicId,
  immediate,
  openDatabase,
  readConfirmedBusyForParticipants,
} from '../src/repository.ts';

const origin = 'http://localhost:5173';
const consentVersion = 'v1';
const baseNow = Date.parse('2026-10-05T00:00:00Z');

type Fixture = {
  app: Awaited<ReturnType<typeof createExpertAuthApp>>;
  database: ReturnType<typeof openDatabase>;
  directory: string;
  sent: Array<{ to: string; code: string }>;
  getNow: () => number;
  setNow: (value: number) => void;
  advance: (ms: number) => void;
};
const fixtures: Fixture[] = [];

async function makeExpert(options: {
  app: Awaited<ReturnType<typeof createExpertAuthApp>>;
  database: ReturnType<typeof openDatabase>;
  email: string;
  publicId: string;
  name: string;
  timezone: string;
  intervals: Array<{ weekday: number; startLocal: string; endLocal: string }>;
  excludedDates?: string[];
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
  if (options.excludedDates) {
    for (const localDate of options.excludedDates) {
      options.database
        .prepare('INSERT INTO excluded_dates (id,expertId,localDate) VALUES (?,?,?)')
        .run(`excluded-${options.publicId}-${localDate}`, expertId, localDate);
    }
  }
  return expertId;
}

async function proveGuest(options: {
  app: Awaited<ReturnType<typeof createExpertAuthApp>>;
  sent: Array<{ to: string; code: string }>;
  publicId: string;
  email: string;
}) {
  const challenge = await options.app.inject({
    method: 'POST',
    url: `/api/v1/experts/${options.publicId}/guest-challenges`,
    headers: { origin },
    payload: { email: options.email, consentVersion, consentAccepted: true },
  });
  expect(challenge.statusCode).toBe(202);
  const code = options.sent.at(-1)?.code;
  if (!code) throw new Error('expected guest code to be sent');
  const verified = await options.app.inject({
    method: 'POST',
    url: `/api/v1/experts/${options.publicId}/guest-challenges/${challenge.json().challengeId}/verify`,
    headers: { origin },
    payload: { code },
  });
  expect(verified.statusCode).toBe(200);
  return verified.json().guestProof as string;
}

function makeBody(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    guestProof: 'placeholder',
    guestName: 'Иван Гость',
    guestTimezone: 'Asia/Krasnoyarsk',
    startAt: '2026-10-06T02:00:00.000Z',
    durationMinutes: 30,
    topic: 'Обсуждение',
    consentVersion,
    consentAccepted: true,
    ...overrides,
  };
}

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-booking-create-'));
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
  const entry: Fixture = { app, database, directory, sent, getNow, setNow, advance };
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

describe('booking create HTTP command', () => {
  it('creates a pending booking with a verified guest proof and records consent and access', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const guestProof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    const idempotencyKey = 'idem-success-1';

    const response = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': idempotencyKey },
      payload: makeBody({ guestProof }),
    });

    expect(response.statusCode).toBe(201);
    const json = response.json();
    expect(json.status).toBe('pending');
    expect(json.startAt).toBe('2026-10-06T02:00:00.000Z');
    expect(json.endAt).toBe('2026-10-06T02:30:00.000Z');
    expect(json.topic).toBe('Обсуждение');
    expect(json.guestName).toBe('Иван Гость');
    expect(json.guestTimezone).toBe('Asia/Krasnoyarsk');
    expect(json.expertName).toBe('Эксперт');
    expect(json.expertPublicId).toBe(publicId);
    expect(json.completed).toBe(false);
    expect(json).not.toHaveProperty('guestEmail');
    expect(json).not.toHaveProperty('accessToken');
    expect(json.closedReason).toBeUndefined();

    const row = entry.database
      .prepare(
        'SELECT b.id,b.guestEmail,b.guestName,b.guestTimezone,b.startUtc,b.endUtc,b.subject,b.status,b.version,b.createdAt FROM bookings b WHERE b.id = ?',
      )
      .get(json.id) as {
      id: string;
      guestEmail: string;
      guestName: string;
      guestTimezone: string;
      startUtc: number;
      endUtc: number;
      subject: string;
      status: string;
      version: number;
      createdAt: number;
    };
    expect(row.guestEmail).toBe('guest@example.test');
    expect(row.subject).toBe('Обсуждение');
    expect(row.status).toBe('pending');
    expect(row.version).toBe(1);

    const transition = entry.database
      .prepare('SELECT fromStatus,toStatus,reason FROM booking_transitions WHERE bookingId = ?')
      .get(json.id) as { fromStatus: string | null; toStatus: string; reason: string | null };
    expect(transition).toEqual({ fromStatus: null, toStatus: 'pending', reason: null });

    const consent = entry.database
      .prepare(
        "SELECT documentVersion,accepted FROM consent_records WHERE bookingId = ? AND action = 'guest_booking_request'",
      )
      .get(json.id) as { documentVersion: string; accepted: number };
    expect(consent.documentVersion).toBe(consentVersion);
    expect(consent.accepted).toBe(1);

    const access = entry.database
      .prepare('SELECT 1 FROM guest_access WHERE bookingId = ? AND revokedAt IS NULL')
      .get(json.id);
    expect(access).toBeTruthy();

    const idempotency = entry.database
      .prepare('SELECT scope,keyHash,bodyHash,resultJson FROM idempotency_records')
      .get() as { scope: string; keyHash: string; bodyHash: string; resultJson: string };
    expect(idempotency.scope).toBe(`guest_booking:${publicId}`);
    expect(JSON.parse(idempotency.resultJson).id).toBe(json.id);

    const proof = entry.database
      .prepare(
        'SELECT consumedAt FROM guest_proofs WHERE id = (SELECT id FROM guest_proofs LIMIT 1)',
      )
      .get() as { consumedAt: number | null };
    expect(proof.consumedAt).not.toBeNull();
  });

  it('rejects creation when the guest proof does not match the expert', async () => {
    const entry = await fixture();
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert-one@example.test',
      publicId: 'expert-one',
      name: 'Один',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert-two@example.test',
      publicId: 'expert-two',
      name: 'Два',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId: 'expert-one',
      email: 'guest@example.test',
    });
    const before = entry.database.prepare('SELECT COUNT(*) AS count FROM guest_proofs').get() as {
      count: number;
    };

    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/experts/expert-two/bookings',
      headers: { origin, 'idempotency-key': 'idem-mismatch' },
      payload: makeBody({ guestProof: proof }),
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().code).toBe('invalid_input');
    const after = entry.database.prepare('SELECT COUNT(*) AS count FROM guest_proofs').get() as {
      count: number;
    };
    expect(after.count).toBe(before.count);
    const consumed = entry.database.prepare('SELECT consumedAt FROM guest_proofs').get() as {
      consumedAt: number | null;
    };
    expect(consumed.consumedAt).toBeNull();
  });

  it('keeps multiple pending requests on the same slot independent', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const firstProof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'first@example.test',
    });
    const secondProof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'second@example.test',
    });

    const first = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-first' },
      payload: makeBody({ guestProof: firstProof, guestName: 'Первый' }),
    });
    const second = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-second' },
      payload: makeBody({ guestProof: secondProof, guestName: 'Второй' }),
    });

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);
    expect(first.json().id).not.toBe(second.json().id);
    const count = entry.database
      .prepare("SELECT COUNT(*) AS count FROM bookings WHERE status = 'pending'")
      .get() as { count: number };
    expect(count.count).toBe(2);
  });

  it('blocks a pending request that overlaps the expert confirmed interval', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    entry.database
      .prepare(
        'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,status,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'confirmed-existing',
        `expert-${publicId}`,
        'someone@example.test',
        'Кто-то',
        'Asia/Krasnoyarsk',
        Date.parse('2026-10-06T02:00:00.000Z'),
        Date.parse('2026-10-06T02:30:00.000Z'),
        'Подтверждённая встреча',
        'confirmed',
        1,
        baseNow,
      );
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });

    const response = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-conflict' },
      payload: makeBody({ guestProof: proof }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('time_unavailable');
    const consumed = entry.database.prepare('SELECT consumedAt FROM guest_proofs').get() as {
      consumedAt: number | null;
    };
    expect(consumed.consumedAt).toBeNull();
  });

  it('blocks a pending request when the guest email has a confirmed meeting with another expert at the same time', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    const otherExpertId = await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'other@example.test',
      publicId: 'other-expert',
      name: 'Другой',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    entry.database
      .prepare(
        'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,status,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        'confirmed-elsewhere',
        otherExpertId,
        'guest@example.test',
        'Гость',
        'Asia/Krasnoyarsk',
        Date.parse('2026-10-06T02:00:00.000Z'),
        Date.parse('2026-10-06T02:30:00.000Z'),
        'Чужая встреча',
        'confirmed',
        1,
        baseNow,
      );
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });

    const response = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-cross-expert' },
      payload: makeBody({ guestProof: proof }),
    });

    expect(response.statusCode).toBe(409);
    expect(response.json().code).toBe('time_unavailable');
  });

  it('returns the stored booking for a repeated request with the same idempotency key and body', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    const body = makeBody({ guestProof: proof });
    const first = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-replay' },
      payload: body,
    });
    expect(first.statusCode).toBe(201);
    const firstId = first.json().id;

    const second = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-replay' },
      payload: body,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(firstId);
    const count = entry.database.prepare('SELECT COUNT(*) AS count FROM bookings').get() as {
      count: number;
    };
    expect(count.count).toBe(1);
  });

  it('conflicts when the same idempotency key is reused with a different body', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    const body = makeBody({ guestProof: proof });
    const first = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-conflict-body' },
      payload: body,
    });
    expect(first.statusCode).toBe(201);

    const second = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-conflict-body' },
      payload: makeBody({ guestProof: proof, topic: 'Другая тема' }),
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('idempotency_conflict');
  });

  it('returns the stored result for a repeated request even after the guest proof was consumed', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    const body = makeBody({ guestProof: proof });
    const first = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-after-consume' },
      payload: body,
    });
    expect(first.statusCode).toBe(201);

    const second = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-after-consume' },
      payload: body,
    });
    expect(second.statusCode).toBe(201);
    expect(second.json().id).toBe(first.json().id);
  });

  it('rejects an empty topic, oversize topic, and oversize description', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });

    for (const [label, override, expected] of [
      ['empty topic', { topic: '' }, 400],
      ['oversize topic', { topic: 'x'.repeat(121) }, 400],
      ['oversize description', { description: 'x'.repeat(2001) }, 400],
    ] as const) {
      const response = await entry.app.inject({
        method: 'POST',
        url: `/api/v1/experts/${publicId}/bookings`,
        headers: { origin, 'idempotency-key': `idem-text-${label}` },
        payload: makeBody({ guestProof: proof, ...override }),
      });
      expect(response.statusCode, label).toBe(expected);
    }
  });

  it('rejects start moments outside the 24-hour and 30-day window and unaligned starts', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '00:00', endLocal: '24:00' }],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    const cases: Array<[string, string]> = [
      ['just under 24h', '2026-10-05T23:45:00.000Z'],
      ['exactly 30d plus 15m', '2026-11-04T00:15:00.000Z'],
      ['unaligned to 15m', '2026-10-06T00:05:00.000Z'],
    ];
    for (const [label, startAt] of cases) {
      const response = await entry.app.inject({
        method: 'POST',
        url: `/api/v1/experts/${publicId}/bookings`,
        headers: { origin, 'idempotency-key': `idem-${label}` },
        payload: makeBody({ guestProof: proof, startAt }),
      });
      expect(response.statusCode, label).toBe(400);
    }
  });

  it('accepts the exact 24-hour and 30-day starts when they are inside the schedule', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'UTC',
      intervals: [
        { weekday: 2, startLocal: '00:00', endLocal: '24:00' },
        { weekday: 3, startLocal: '00:00', endLocal: '24:00' },
      ],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    entry.setNow(Date.parse('2026-10-05T00:00:00Z'));
    const exact24h = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-24h' },
      payload: makeBody({
        guestProof: proof,
        startAt: '2026-10-06T00:00:00.000Z',
        guestTimezone: 'UTC',
      }),
    });
    expect(exact24h.statusCode).toBe(201);

    entry.setNow(Date.parse('2026-10-05T00:00:00Z'));
    const thirtyDayProof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest-30d@example.test',
    });
    const exact30d = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-30d' },
      payload: makeBody({
        guestProof: thirtyDayProof,
        startAt: '2026-11-04T00:00:00.000Z',
        guestTimezone: 'UTC',
      }),
    });
    expect(exact30d.statusCode).toBe(201);
  });

  it('rejects an unknown public expert', async () => {
    const entry = await fixture();
    const response = await entry.app.inject({
      method: 'POST',
      url: '/api/v1/experts/missing-expert/bookings',
      headers: { origin, 'idempotency-key': 'idem-missing' },
      payload: makeBody({ guestProof: 'a'.repeat(64) }),
    });
    expect(response.statusCode).toBe(404);
  });

  it('rejects a missing or malformed idempotency key', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    const without = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin },
      payload: makeBody({ guestProof: proof }),
    });
    expect(without.statusCode).toBe(400);
    const empty = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': '' },
      payload: makeBody({ guestProof: proof }),
    });
    expect(empty.statusCode).toBe(400);
  });

  it('rejects wrong consent version and an absent consent', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    const wrong = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-wrong-consent' },
      payload: makeBody({ guestProof: proof, consentVersion: 'v0' }),
    });
    expect(wrong.statusCode).toBe(400);
    const absent = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-absent-consent' },
      payload: { ...makeBody({ guestProof: proof }), consentAccepted: false },
    });
    expect(absent.statusCode).toBe(400);
  });

  it('rejects an unknown, consumed, or expired guest proof', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });

    const unknown = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-unknown-proof' },
      payload: makeBody({ guestProof: 'b'.repeat(64) }),
    });
    expect(unknown.statusCode).toBe(400);

    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    const consumed = entry.database
      .prepare('SELECT id FROM guest_proofs WHERE tokenHash IS NOT NULL LIMIT 1')
      .get() as { id: string } | undefined;
    expect(consumed?.id).toBeTruthy();
    entry.database
      .prepare('UPDATE guest_proofs SET consumedAt = ? WHERE id = ?')
      .run(baseNow, consumed!.id);
    const replay = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-consumed-proof' },
      payload: makeBody({ guestProof: proof }),
    });
    expect(replay.statusCode).toBe(400);

    const freshProof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest-fresh@example.test',
    });
    entry.database
      .prepare('UPDATE guest_proofs SET createdAt = ?, expiresAt = ? WHERE tokenHash IS NOT NULL')
      .run(baseNow - 60 * 60_000, baseNow - 1);
    const expired = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-expired-proof' },
      payload: makeBody({ guestProof: freshProof }),
    });
    expect(expired.statusCode).toBe(400);
  });

  it('rejects a start moment outside the expert schedule or on an excluded date', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 3, startLocal: '09:00', endLocal: '12:00' }],
      excludedDates: ['2026-10-07'],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    const wrongDay = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-wrong-day' },
      payload: makeBody({ guestProof: proof, startAt: '2026-10-06T02:00:00.000Z' }),
    });
    expect(wrongDay.statusCode).toBe(400);
    const excluded = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-excluded' },
      payload: makeBody({ guestProof: proof, startAt: '2026-10-07T02:00:00.000Z' }),
    });
    expect(excluded.statusCode).toBe(400);
  });

  it('rejects an unsupported duration and a missing or bad timezone', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    const badDuration = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-bad-duration' },
      payload: makeBody({ guestProof: proof, durationMinutes: 45 }),
    });
    expect(badDuration.statusCode).toBe(400);
    const badTimezone = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin, 'idempotency-key': 'idem-bad-tz' },
      payload: makeBody({ guestProof: proof, guestTimezone: 'Mars/Olympus' }),
    });
    expect(badTimezone.statusCode).toBe(400);
  });

  it('rejects a request without a matching origin', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const proof = await proveGuest({
      app: entry.app,
      sent: entry.sent,
      publicId,
      email: 'guest@example.test',
    });
    const response = await entry.app.inject({
      method: 'POST',
      url: `/api/v1/experts/${publicId}/bookings`,
      headers: { origin: 'https://attacker.example', 'idempotency-key': 'idem-origin' },
      payload: makeBody({ guestProof: proof }),
    });
    expect(response.statusCode).toBe(403);
  });

  it('serializes pending and confirmed via BEGIN IMMEDIATE on separate connections', async () => {
    const entry = await fixture();
    const publicId = 'public-expert';
    await makeExpert({
      app: entry.app,
      database: entry.database,
      email: 'expert@example.test',
      publicId,
      name: 'Эксперт',
      timezone: 'Asia/Krasnoyarsk',
      intervals: [{ weekday: 2, startLocal: '09:00', endLocal: '12:00' }],
    });
    const otherConnection = openDatabase(join(entry.directory, 'test.sqlite'));
    try {
      const writer = otherConnection.transaction(() => {
        otherConnection
          .prepare(
            'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,description,status,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
          )
          .run(
            'confirmed-external',
            `expert-${publicId}`,
            'someone@example.test',
            'Кто-то',
            'Asia/Krasnoyarsk',
            Date.parse('2026-10-06T02:00:00.000Z'),
            Date.parse('2026-10-06T02:30:00.000Z'),
            'Подтверждённая встреча',
            null,
            'confirmed',
            1,
            baseNow,
          );
      });
      const proof = await proveGuest({
        app: entry.app,
        sent: entry.sent,
        publicId,
        email: 'guest@example.test',
      });

      const decision = immediate(entry.database, () => {
        const expert = findExpertByPublicId(entry.database, publicId);
        if (!expert) return 'missing' as const;
        const busy = readConfirmedBusyForParticipants(
          entry.database,
          expert.id,
          'guest@example.test',
        );
        if (busy.length === 0) return 'free' as const;
        return 'busy' as const;
      });

      expect(decision).toBe('free');
      writer.immediate();
      const after = immediate(entry.database, () => {
        const expert = findExpertByPublicId(entry.database, publicId);
        if (!expert) return 'missing' as const;
        const busy = readConfirmedBusyForParticipants(
          entry.database,
          expert.id,
          'guest@example.test',
        );
        if (busy.length === 0) return 'free' as const;
        return 'busy' as const;
      });
      expect(after).toBe('busy');

      const response = await entry.app.inject({
        method: 'POST',
        url: `/api/v1/experts/${publicId}/bookings`,
        headers: { origin, 'idempotency-key': 'idem-after-confirmed' },
        payload: makeBody({ guestProof: proof }),
      });
      expect(response.statusCode).toBe(409);
      expect(response.json().code).toBe('time_unavailable');
    } finally {
      otherConnection.close();
    }
  });
});
