import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { initialMigration } from './migrations/001_initial.js';
import { challengeConsentMigration } from './migrations/002_challenge_consent.js';

const schemaVersion = 2;

export function openDatabase(path: string): Database.Database {
  const database = new Database(path);

  try {
    database.pragma('foreign_keys = ON');
    database.pragma('journal_mode = WAL');
    database.pragma('busy_timeout = 5000');

    database.exec('BEGIN IMMEDIATE');
    try {
      const currentVersion = database.pragma('user_version', { simple: true }) as number;
      if (currentVersion > schemaVersion) {
        throw new Error(`Unsupported database schema version: ${currentVersion}`);
      }

      if (currentVersion < 1) {
        database.exec(initialMigration);
        database.pragma('user_version = 1');
      }
      if (currentVersion < 2) {
        database.exec(challengeConsentMigration);
        database.pragma('user_version = 2');
      }
      database.exec('COMMIT');
    } catch (error) {
      if (database.inTransaction) {
        database.exec('ROLLBACK');
      }
      throw error;
    }

    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export type AuthDatabase = Database.Database;

export type ExpertRow = {
  id: string;
  email: string;
  publicId: string;
  name: string | null;
  timezone: string | null;
};

export type ChallengeRow = {
  id: string;
  email: string;
  codeHash: string;
  attempts: number;
  expiresAt: number;
  consumedAt: number | null;
  replacedAt: number | null;
  consentVersion: string | null;
  consentAcceptedAt: number | null;
};

export function immediate<T>(database: AuthDatabase, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    if (database.inTransaction) database.exec('ROLLBACK');
    throw error;
  }
}

export function challengeLimits(
  database: AuthDatabase,
  email: string,
  ipHash: string,
  since: number,
) {
  const recentEmail = database
    .prepare(
      'SELECT createdAt FROM email_challenges WHERE purpose = ? AND email = ? ORDER BY createdAt DESC LIMIT 1',
    )
    .get('expert_login', email) as { createdAt: number } | undefined;
  const emailHour = database
    .prepare(
      'SELECT COUNT(*) AS count FROM email_challenges WHERE purpose = ? AND email = ? AND createdAt > ?',
    )
    .get('expert_login', email, since) as { count: number };
  const ipHour = database
    .prepare(
      'SELECT COUNT(*) AS count FROM email_challenges WHERE requestIpHash = ? AND createdAt > ?',
    )
    .get(ipHash, since) as { count: number };
  return { recentEmail: recentEmail?.createdAt, emailHour: emailHour.count, ipHour: ipHour.count };
}

export function replaceChallenges(database: AuthDatabase, email: string, now: number) {
  database
    .prepare(
      'UPDATE email_challenges SET replacedAt = ? WHERE purpose = ? AND email = ? AND consumedAt IS NULL AND replacedAt IS NULL',
    )
    .run(now, 'expert_login', email);
}

export function insertChallenge(
  database: AuthDatabase,
  challenge: {
    id: string;
    email: string;
    ipHash: string;
    codeHash: string;
    now: number;
    expiresAt: number;
    consentVersion: string;
    consentAcceptedAt: number;
  },
) {
  database
    .prepare(
      'INSERT INTO email_challenges (id,purpose,email,requestIpHash,codeHash,createdAt,expiresAt,consentVersion,consentAcceptedAt) VALUES (?,?,?,?,?,?,?,?,?)',
    )
    .run(
      challenge.id,
      'expert_login',
      challenge.email,
      challenge.ipHash,
      challenge.codeHash,
      challenge.now,
      challenge.expiresAt,
      challenge.consentVersion,
      challenge.consentAcceptedAt,
    );
}

export function invalidateChallenge(database: AuthDatabase, id: string, now: number) {
  database
    .prepare('UPDATE email_challenges SET replacedAt = ? WHERE id = ? AND consumedAt IS NULL')
    .run(now, id);
}

export function getChallenge(database: AuthDatabase, id: string): ChallengeRow | undefined {
  return database
    .prepare(
      'SELECT id,email,codeHash,attempts,expiresAt,consumedAt,replacedAt,consentVersion,consentAcceptedAt FROM email_challenges WHERE id = ? AND purpose = ?',
    )
    .get(id, 'expert_login') as ChallengeRow | undefined;
}

export function failChallenge(database: AuthDatabase, id: string) {
  database
    .prepare('UPDATE email_challenges SET attempts = attempts + 1 WHERE id = ? AND attempts < 5')
    .run(id);
}

export function consumeChallenge(database: AuthDatabase, id: string, now: number) {
  database.prepare('UPDATE email_challenges SET consumedAt = ? WHERE id = ?').run(now, id);
}

export function findExpertByEmail(database: AuthDatabase, email: string): ExpertRow | undefined {
  return database
    .prepare('SELECT id,email,publicId,name,timezone FROM experts WHERE email = ?')
    .get(email) as ExpertRow | undefined;
}

export function findExpertById(database: AuthDatabase, id: string): ExpertRow | undefined {
  return database
    .prepare('SELECT id,email,publicId,name,timezone FROM experts WHERE id = ?')
    .get(id) as ExpertRow | undefined;
}

export function createExpert(
  database: AuthDatabase,
  expert: { id: string; email: string; publicId: string; now: number },
) {
  database
    .prepare('INSERT INTO experts (id,email,publicId,createdAt) VALUES (?,?,?,?)')
    .run(expert.id, expert.email, expert.publicId, expert.now);
}

export function recordExpertConsent(
  database: AuthDatabase,
  record: { id: string; expertId: string; version: string; now: number },
) {
  database
    .prepare(
      'INSERT INTO consent_records (id,expertId,action,documentVersion,accepted,acceptedAt) VALUES (?,?,?,?,1,?)',
    )
    .run(record.id, record.expertId, 'expert_login', record.version, record.now);
}

export function createExpertSession(
  database: AuthDatabase,
  session: {
    id: string;
    expertId: string;
    tokenHash: string;
    now: number;
    expiresAt: number;
  },
) {
  database
    .prepare(
      'INSERT INTO expert_sessions (id,expertId,tokenHash,createdAt,expiresAt) VALUES (?,?,?,?,?)',
    )
    .run(session.id, session.expertId, session.tokenHash, session.now, session.expiresAt);
}

export function findActiveSession(
  database: AuthDatabase,
  tokenHash: string,
  now: number,
): { id: string; expertId: string } | undefined {
  return database
    .prepare(
      'SELECT id,expertId FROM expert_sessions WHERE tokenHash = ? AND revokedAt IS NULL AND expiresAt > ?',
    )
    .get(tokenHash, now) as { id: string; expertId: string } | undefined;
}

export function revokeSession(database: AuthDatabase, id: string, now: number) {
  database
    .prepare('UPDATE expert_sessions SET revokedAt = ? WHERE id = ? AND revokedAt IS NULL')
    .run(now, id);
}

export function updateExpertProfile(
  database: AuthDatabase,
  id: string,
  name: string,
  timezone: string,
) {
  database
    .prepare('UPDATE experts SET name = ?, timezone = ? WHERE id = ?')
    .run(name, timezone, id);
}

export type WeeklyInterval = { weekday: number; startLocal: string; endLocal: string };

export function readScheduleRows(database: AuthDatabase, expertId: string) {
  const expert = findExpertById(database, expertId);
  if (!expert) throw new Error('Unknown schedule owner');
  const weeklyIntervals = database
    .prepare(
      'SELECT weekday,startLocal,endLocal FROM availability_intervals WHERE expertId = ? ORDER BY weekday,startLocal,endLocal',
    )
    .all(expertId) as WeeklyInterval[];
  const dates = database
    .prepare('SELECT localDate FROM excluded_dates WHERE expertId = ? ORDER BY localDate')
    .all(expertId) as { localDate: string }[];
  return {
    timezone: expert.timezone,
    weeklyIntervals,
    excludedDates: dates.map((row) => row.localDate),
  };
}

export function replaceScheduleRows(
  database: AuthDatabase,
  expertId: string,
  weeklyIntervals: WeeklyInterval[],
  excludedDates: string[],
) {
  immediate(database, () => {
    if (!findExpertById(database, expertId)) throw new Error('Unknown schedule owner');
    database.prepare('DELETE FROM availability_intervals WHERE expertId = ?').run(expertId);
    database.prepare('DELETE FROM excluded_dates WHERE expertId = ?').run(expertId);
    const insertInterval = database.prepare(
      'INSERT INTO availability_intervals (id,expertId,weekday,startLocal,endLocal) VALUES (?,?,?,?,?)',
    );
    const insertDate = database.prepare(
      'INSERT INTO excluded_dates (id,expertId,localDate) VALUES (?,?,?)',
    );
    for (const interval of weeklyIntervals) {
      insertInterval.run(
        randomUUID(),
        expertId,
        interval.weekday,
        interval.startLocal,
        interval.endLocal,
      );
    }
    for (const date of excludedDates) insertDate.run(randomUUID(), expertId, date);
  });
}
