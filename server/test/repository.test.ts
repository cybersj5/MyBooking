import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/repository.ts';

const requiredTables = [
  'experts',
  'email_challenges',
  'expert_sessions',
  'guest_proofs',
  'consent_records',
  'availability_intervals',
  'excluded_dates',
  'bookings',
  'booking_transitions',
  'guest_access',
  'idempotency_records',
  'jobs',
];

const temporaryDirectories: string[] = [];

function temporaryDatabasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-storage-'));
  temporaryDirectories.push(directory);
  return join(directory, 'booking.sqlite');
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('SQLite migrations', () => {
  it('creates the MVP schema with connection safeguards and hashed credentials', () => {
    const database = openDatabase(temporaryDatabasePath());
    try {
      const tables = database
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => (row as { name: string }).name);
      expect(tables).toEqual(expect.arrayContaining(requiredTables));
      expect(database.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(database.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(database.pragma('busy_timeout', { simple: true })).toBeGreaterThan(0);

      for (const table of [
        'email_challenges',
        'expert_sessions',
        'guest_proofs',
        'guest_access',
        'idempotency_records',
      ]) {
        const columns = database
          .prepare(`PRAGMA table_info(${table})`)
          .all()
          .map((row) => (row as { name: string }).name.toLowerCase());
        expect(columns).toContain(
          table === 'email_challenges'
            ? 'codehash'
            : table === 'idempotency_records'
              ? 'keyhash'
              : 'tokenhash',
        );
        expect(columns).not.toContain('code');
        expect(columns).not.toContain('token');
        expect(columns).not.toContain('key');
      }
    } finally {
      database.close();
    }
  });

  it('preserves records when opened again', () => {
    const path = temporaryDatabasePath();
    const first = openDatabase(path);
    try {
      first
        .prepare('INSERT INTO experts (id, email, publicId, createdAt) VALUES (?, ?, ?, ?)')
        .run('expert-one', 'one@example.test', 'expert-one', 1_700_000_000_000);
    } finally {
      first.close();
    }

    const second = openDatabase(path);
    try {
      expect(
        second.prepare('SELECT email FROM experts WHERE id = ?').get('expert-one'),
      ).toMatchObject({
        email: 'one@example.test',
      });
      expect(second.prepare('SELECT COUNT(*) AS count FROM experts').get()).toMatchObject({
        count: 1,
      });
    } finally {
      second.close();
    }
  });

  it('enforces foreign keys, unique expert identity, booking states and positive intervals', () => {
    const database = openDatabase(temporaryDatabasePath());
    try {
      const insertExpert = database.prepare(
        'INSERT INTO experts (id, email, publicId, createdAt) VALUES (?, ?, ?, ?)',
      );
      insertExpert.run('expert-one', 'one@example.test', 'expert-one', 1_700_000_000_000);
      expect(() =>
        insertExpert.run('expert-two', 'one@example.test', 'expert-two', 1_700_000_000_000),
      ).toThrow();
      expect(() =>
        insertExpert.run('expert-two', 'two@example.test', 'expert-one', 1_700_000_000_000),
      ).toThrow();

      const insertBooking = database.prepare(`
        INSERT INTO bookings
          (id, expertId, guestEmail, guestName, guestTimezone, startUtc, endUtc,
           subject, status, version, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const booking = (id: string, expertId: string, start: number, end: number, status: string) =>
        insertBooking.run(
          id,
          expertId,
          'guest@example.test',
          'Guest',
          'Asia/Krasnoyarsk',
          start,
          end,
          'Consultation',
          status,
          1,
          1_700_000_000_000,
        );
      expect(() => booking('missing-expert', 'missing', 1000, 2000, 'pending')).toThrow();
      expect(() => booking('zero-length', 'expert-one', 1000, 1000, 'pending')).toThrow();
      expect(() => booking('bad-state', 'expert-one', 1000, 2000, 'completed')).toThrow();
      expect(() => booking('valid', 'expert-one', 1000, 2000, 'pending')).not.toThrow();
    } finally {
      database.close();
    }
  });

  it('rejects text in an expert epoch-millisecond timestamp', () => {
    const database = openDatabase(temporaryDatabasePath());
    try {
      expect(() =>
        database
          .prepare('INSERT INTO experts (id, email, publicId, createdAt) VALUES (?, ?, ?, ?)')
          .run('expert-one', 'one@example.test', 'expert-one', 'not-a-timestamp'),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('rejects text in booking epoch-millisecond boundaries', () => {
    const database = openDatabase(temporaryDatabasePath());
    try {
      database
        .prepare('INSERT INTO experts (id, email, publicId, createdAt) VALUES (?, ?, ?, ?)')
        .run('expert-one', 'one@example.test', 'expert-one', 1_700_000_000_000);
      expect(() =>
        database
          .prepare(
            `
            INSERT INTO bookings
              (id, expertId, guestEmail, guestName, guestTimezone, startUtc, endUtc,
               subject, status, version, createdAt)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          )
          .run(
            'booking-one',
            'expert-one',
            'guest@example.test',
            'Guest',
            'Asia/Krasnoyarsk',
            'abc',
            'zzz',
            'Consultation',
            'pending',
            1,
            1_700_000_000_000,
          ),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it('rolls back all changes when a migration fails after its first table', () => {
    const path = temporaryDatabasePath();
    const seed = new Database(path);
    try {
      seed.exec('CREATE TABLE email_challenges (marker TEXT NOT NULL)');
    } finally {
      seed.close();
    }

    expect(() => openDatabase(path)).toThrow();

    const inspect = new Database(path);
    try {
      expect(inspect.pragma('user_version', { simple: true })).toBe(0);
      expect(
        inspect
          .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'experts'")
          .get(),
      ).toBeUndefined();
      expect(
        inspect
          .prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'email_challenges'",
          )
          .get(),
      ).toMatchObject({ name: 'email_challenges' });
    } finally {
      inspect.close();
    }
  });

  it('refuses a database from a newer schema version without changing it', () => {
    const path = temporaryDatabasePath();
    const first = openDatabase(path);
    try {
      first
        .prepare('INSERT INTO experts (id, email, publicId, createdAt) VALUES (?, ?, ?, ?)')
        .run('expert-one', 'one@example.test', 'expert-one', 1_700_000_000_000);
      first.pragma('user_version = 999');
    } finally {
      first.close();
    }

    expect(() => openDatabase(path)).toThrow(/version/i);

    const inspect = new Database(path);
    try {
      expect(inspect.pragma('user_version', { simple: true })).toBe(999);
      expect(
        inspect.prepare('SELECT email FROM experts WHERE id = ?').get('expert-one'),
      ).toMatchObject({
        email: 'one@example.test',
      });
    } finally {
      inspect.close();
    }
  });

  it('deduplicates persisted jobs and rejects negative attempts', () => {
    const database = openDatabase(temporaryDatabasePath());
    try {
      const insertJob = database.prepare(`
        INSERT INTO jobs
          (id, deduplicationKey, type, recipient, scheduledAt, attempts,
           nextAttemptAt, status, createdAt)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const job = (id: string, key: string, attempts: number) =>
        insertJob.run(
          id,
          key,
          'status_email',
          'guest@example.test',
          1_700_000_000_000,
          attempts,
          1_700_000_000_000,
          'pending',
          1_700_000_000_000,
        );
      job('job-one', 'event-one:guest', 0);
      expect(() => job('job-two', 'event-one:guest', 0)).toThrow();
      expect(() => job('job-three', 'event-two:guest', -1)).toThrow();
    } finally {
      database.close();
    }
  });
});
