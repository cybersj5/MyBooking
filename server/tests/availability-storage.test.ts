import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/repository.ts';

const directories: string[] = [];
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'mybooking-availability-storage-'));
  directories.push(directory);
  const database = openDatabase(join(directory, 'test.sqlite'));
  for (const [id, email] of [
    ['first', 'first@example.test'],
    ['second', 'second@example.test'],
  ]) {
    database
      .prepare(
        'INSERT INTO experts (id,email,publicId,name,timezone,createdAt) VALUES (?,?,?,?,?,?)',
      )
      .run(id, email, id, 'Эксперт', 'Asia/Krasnoyarsk', 1);
  }
  return database;
}

const initial = {
  weeklyIntervals: [{ weekday: 1, startLocal: '09:00', endLocal: '12:00' }],
  excludedDates: ['2026-10-12'],
};

afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

describe('availability storage command', () => {
  it('replaces both arrays for one owner and leaves the other owner untouched', async () => {
    const database = fixture();
    try {
      const { readAvailability, replaceAvailability } =
        await import('../src/availability/index.ts');
      replaceAvailability(database, 'first', initial);
      replaceAvailability(database, 'second', {
        weeklyIntervals: [{ weekday: 2, startLocal: '14:00', endLocal: '18:00' }],
        excludedDates: [],
      });
      replaceAvailability(database, 'first', { weeklyIntervals: [], excludedDates: [] });
      expect(readAvailability(database, 'first')).toMatchObject({
        weeklyIntervals: [],
        excludedDates: [],
      });
      expect(readAvailability(database, 'second')).toMatchObject({
        weeklyIntervals: [{ weekday: 2, startLocal: '14:00', endLocal: '18:00' }],
        excludedDates: [],
      });
    } finally {
      database.close();
    }
  });

  it.each([
    [{ weekday: 0, startLocal: '09:00', endLocal: '12:00' }],
    [{ weekday: 1, startLocal: '09:10', endLocal: '12:00' }],
    [{ weekday: 1, startLocal: '12:00', endLocal: '09:00' }],
    [{ weekday: 1, startLocal: '09:00', endLocal: '24:15' }],
    [
      { weekday: 1, startLocal: '09:00', endLocal: '12:00' },
      { weekday: 1, startLocal: '11:45', endLocal: '13:00' },
    ],
  ])(
    'rejects invalid or overlapping weekly intervals without changing stored schedule',
    async (...weeklyIntervals) => {
      const database = fixture();
      try {
        const { readAvailability, replaceAvailability } =
          await import('../src/availability/index.ts');
        replaceAvailability(database, 'first', initial);
        expect(() =>
          replaceAvailability(database, 'first', { weeklyIntervals, excludedDates: [] }),
        ).toThrow();
        expect(readAvailability(database, 'first')).toMatchObject(initial);
      } finally {
        database.close();
      }
    },
  );

  it('rejects impossible dates and unknown owners without changing rows', async () => {
    const database = fixture();
    try {
      const { readAvailability, replaceAvailability } =
        await import('../src/availability/index.ts');
      replaceAvailability(database, 'first', initial);
      expect(() =>
        replaceAvailability(database, 'first', {
          weeklyIntervals: [],
          excludedDates: ['2026-02-30'],
        }),
      ).toThrow();
      expect(() => replaceAvailability(database, 'missing', initial)).toThrow();
      expect(readAvailability(database, 'first')).toMatchObject(initial);
    } finally {
      database.close();
    }
  });

  it('rolls back deleted rows and partial inserts when SQLite rejects a replacement', async () => {
    const database = fixture();
    try {
      const { readAvailability, replaceAvailability } =
        await import('../src/availability/index.ts');
      replaceAvailability(database, 'first', initial);
      database.exec(`CREATE TRIGGER reject_second_interval BEFORE INSERT ON availability_intervals
        WHEN NEW.expertId = 'first' AND NEW.startLocal = '14:00'
        BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`);
      expect(() =>
        replaceAvailability(database, 'first', {
          weeklyIntervals: [
            { weekday: 1, startLocal: '08:00', endLocal: '10:00' },
            { weekday: 1, startLocal: '14:00', endLocal: '18:00' },
          ],
          excludedDates: ['2026-10-13'],
        }),
      ).toThrow('injected insert failure');
      expect(readAvailability(database, 'first')).toMatchObject(initial);
    } finally {
      database.close();
    }
  });
});
