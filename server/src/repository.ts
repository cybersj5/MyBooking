import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import { initialMigration } from './migrations/001_initial.js';
import { challengeConsentMigration } from './migrations/002_challenge_consent.js';
import { guestAccessEmailMigration } from './migrations/003_guest_access_email.js';

const schemaVersion = 3;

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
      if (currentVersion < 3) {
        database.exec(guestAccessEmailMigration);
        database.pragma('user_version = 3');
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
  immediate(database, () =>
    replaceScheduleRowsInTransaction(database, expertId, weeklyIntervals, excludedDates),
  );
}

// Тот же набор изменений, что и в replaceScheduleRows, но без собственной транзакции.
// Используется в сценариях, когда удаление и вставка должны попасть во внешнюю
// транзакцию, открытую вызывающим кодом (PDR §4.6, ADR-001 §2).
export function replaceScheduleRowsInTransaction(
  database: AuthDatabase,
  expertId: string,
  weeklyIntervals: WeeklyInterval[],
  excludedDates: string[],
) {
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
}

export type GuestChallengeRow = ChallengeRow & {
  expertId: string | null;
  bookingId: string | null;
};

export function findExpertByPublicId(
  database: AuthDatabase,
  publicId: string,
): ExpertRow | undefined {
  return database
    .prepare('SELECT id,email,publicId,name,timezone FROM experts WHERE publicId = ?')
    .get(publicId) as ExpertRow | undefined;
}

export function readConfirmedBusyIntervals(
  database: AuthDatabase,
  expertId: string,
  expertEmail: string,
): { startAtMs: number; endAtMs: number }[] {
  return database
    .prepare(
      "SELECT startUtc AS startAtMs,endUtc AS endAtMs FROM bookings WHERE status = 'confirmed' AND (expertId = ? OR guestEmail = ?)",
    )
    .all(expertId, expertEmail) as { startAtMs: number; endAtMs: number }[];
}

export function guestChallengeLimits(
  database: AuthDatabase,
  email: string,
  ipHash: string,
  since: number,
) {
  const recentEmail = database
    .prepare(
      'SELECT createdAt FROM email_challenges WHERE email = ? ORDER BY createdAt DESC LIMIT 1',
    )
    .get(email) as { createdAt: number } | undefined;
  const emailHour = database
    .prepare('SELECT COUNT(*) AS count FROM email_challenges WHERE email = ? AND createdAt > ?')
    .get(email, since) as { count: number };
  const ipHour = database
    .prepare(
      'SELECT COUNT(*) AS count FROM email_challenges WHERE requestIpHash = ? AND createdAt > ?',
    )
    .get(ipHash, since) as { count: number };
  return { recentEmail: recentEmail?.createdAt, emailHour: emailHour.count, ipHour: ipHour.count };
}

export function replaceGuestChallenges(
  database: AuthDatabase,
  purpose: string,
  email: string,
  now: number,
) {
  database
    .prepare(
      'UPDATE email_challenges SET replacedAt = ? WHERE purpose = ? AND email = ? AND consumedAt IS NULL AND replacedAt IS NULL',
    )
    .run(now, purpose, email);
}

export function insertGuestChallenge(
  database: AuthDatabase,
  challenge: {
    id: string;
    purpose: string;
    email: string;
    ipHash: string;
    codeHash: string;
    expertId?: string | undefined;
    bookingId?: string | undefined;
    now: number;
    expiresAt: number;
    consentVersion: string;
  },
) {
  database
    .prepare(
      'INSERT INTO email_challenges (id,purpose,email,requestIpHash,expertId,bookingId,codeHash,createdAt,expiresAt,consentVersion,consentAcceptedAt) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      challenge.id,
      challenge.purpose,
      challenge.email,
      challenge.ipHash,
      challenge.expertId ?? null,
      challenge.bookingId ?? null,
      challenge.codeHash,
      challenge.now,
      challenge.expiresAt,
      challenge.consentVersion,
      challenge.now,
    );
}

export function getGuestChallenge(
  database: AuthDatabase,
  id: string,
  purpose: string,
): GuestChallengeRow | undefined {
  return database
    .prepare(
      'SELECT id,email,expertId,bookingId,codeHash,attempts,expiresAt,consumedAt,replacedAt,consentVersion,consentAcceptedAt FROM email_challenges WHERE id = ? AND purpose = ?',
    )
    .get(id, purpose) as GuestChallengeRow | undefined;
}

export function createGuestProof(
  database: AuthDatabase,
  proof: {
    id: string;
    expertId: string;
    email: string;
    tokenHash: string;
    now: number;
    expiresAt: number;
  },
) {
  database
    .prepare(
      'INSERT INTO guest_proofs (id,expertId,email,tokenHash,createdAt,expiresAt) VALUES (?,?,?,?,?,?)',
    )
    .run(proof.id, proof.expertId, proof.email, proof.tokenHash, proof.now, proof.expiresAt);
}

export function findGuestProof(
  database: AuthDatabase,
  tokenHash: string,
  expertId: string,
  now: number,
): { id: string; email: string } | undefined {
  return database
    .prepare(
      'SELECT id,email FROM guest_proofs WHERE tokenHash = ? AND expertId = ? AND consumedAt IS NULL AND expiresAt > ?',
    )
    .get(tokenHash, expertId, now) as { id: string; email: string } | undefined;
}

export function consumeGuestProof(database: AuthDatabase, id: string, now: number) {
  database
    .prepare(
      'UPDATE guest_proofs SET consumedAt = ? WHERE id = ? AND consumedAt IS NULL AND expiresAt > ?',
    )
    .run(now, id, now);
}

export type BookingRow = {
  id: string;
  expertId: string;
  guestEmail: string;
  guestName: string;
  guestTimezone: string;
  startUtc: number;
  endUtc: number;
  subject: string;
  description: string | null;
  status: string;
  reason: string | null;
  expertName: string | null;
  expertPublicId: string;
};

export function findBooking(database: AuthDatabase, id: string): BookingRow | undefined {
  return database
    .prepare(
      'SELECT b.id,b.expertId,b.guestEmail,b.guestName,b.guestTimezone,b.startUtc,b.endUtc,b.subject,b.description,b.status,b.reason,e.name AS expertName,e.publicId AS expertPublicId FROM bookings b JOIN experts e ON e.id = b.expertId WHERE b.id = ?',
    )
    .get(id) as BookingRow | undefined;
}

export function replaceGuestAccess(
  database: AuthDatabase,
  access: {
    id: string;
    bookingId: string;
    tokenHash: string;
    email: string;
    now: number;
    expiresAt: number;
  },
) {
  database
    .prepare('UPDATE guest_access SET revokedAt = ? WHERE bookingId = ? AND revokedAt IS NULL')
    .run(access.now, access.bookingId);
  database
    .prepare(
      'INSERT INTO guest_access (id,bookingId,tokenHash,email,createdAt,expiresAt) VALUES (?,?,?,?,?,?)',
    )
    .run(access.id, access.bookingId, access.tokenHash, access.email, access.now, access.expiresAt);
}

export function hasGuestAccess(
  database: AuthDatabase,
  bookingId: string,
  tokenHash: string,
  now: number,
): boolean {
  return Boolean(
    database
      .prepare(
        'SELECT 1 FROM guest_access WHERE bookingId = ? AND tokenHash = ? AND revokedAt IS NULL AND expiresAt > ?',
      )
      .get(bookingId, tokenHash, now),
  );
}

// Возвращает email, на который был выписан активный токен доступа к заявке.
// Используется для проверки, что вызов делает именно гость этой заявки, а не
// обладатель чужого токена, выписанного на ту же заявку.
export function findGuestAccessEmail(
  database: AuthDatabase,
  bookingId: string,
  tokenHash: string,
  now: number,
): string | undefined {
  const row = database
    .prepare(
      'SELECT email FROM guest_access WHERE bookingId = ? AND tokenHash = ? AND revokedAt IS NULL AND expiresAt > ?',
    )
    .get(bookingId, tokenHash, now) as { email: string } | undefined;
  return row?.email;
}

export type IdempotencyRow = {
  id: string;
  scope: string;
  keyHash: string;
  bodyHash: string;
  resultJson: string;
};

export function findIdempotencyRecord(
  database: AuthDatabase,
  scope: string,
  keyHash: string,
): IdempotencyRow | undefined {
  return database
    .prepare(
      'SELECT id,scope,keyHash,bodyHash,resultJson FROM idempotency_records WHERE scope = ? AND keyHash = ?',
    )
    .get(scope, keyHash) as IdempotencyRow | undefined;
}

export function insertIdempotencyRecord(
  database: AuthDatabase,
  record: {
    id: string;
    scope: string;
    keyHash: string;
    bodyHash: string;
    resultJson: string;
    now: number;
  },
) {
  database
    .prepare(
      'INSERT INTO idempotency_records (id,scope,keyHash,bodyHash,resultJson,createdAt) VALUES (?,?,?,?,?,?)',
    )
    .run(record.id, record.scope, record.keyHash, record.bodyHash, record.resultJson, record.now);
}

export type BusyIntervalRow = { startAtMs: number; endAtMs: number };

export function readConfirmedBusyForParticipants(
  database: AuthDatabase,
  expertId: string,
  guestEmail: string,
): BusyIntervalRow[] {
  return database
    .prepare(
      "SELECT startUtc AS startAtMs,endUtc AS endAtMs FROM bookings WHERE status = 'confirmed' AND (expertId = ? OR guestEmail = ?)",
    )
    .all(expertId, guestEmail) as BusyIntervalRow[];
}

export function insertBooking(
  database: AuthDatabase,
  booking: {
    id: string;
    expertId: string;
    guestEmail: string;
    guestName: string;
    guestTimezone: string;
    startUtc: number;
    endUtc: number;
    subject: string;
    description: string | null;
    now: number;
  },
) {
  database
    .prepare(
      'INSERT INTO bookings (id,expertId,guestEmail,guestName,guestTimezone,startUtc,endUtc,subject,description,status,version,createdAt) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
    )
    .run(
      booking.id,
      booking.expertId,
      booking.guestEmail,
      booking.guestName,
      booking.guestTimezone,
      booking.startUtc,
      booking.endUtc,
      booking.subject,
      booking.description,
      'pending',
      1,
      booking.now,
    );
}

export function insertBookingTransition(
  database: AuthDatabase,
  transition: { id: string; bookingId: string; fromStatus: string | null; now: number },
) {
  database
    .prepare(
      'INSERT INTO booking_transitions (id,bookingId,fromStatus,toStatus,occurredAt) VALUES (?,?,?,?,?)',
    )
    .run(transition.id, transition.bookingId, transition.fromStatus, 'pending', transition.now);
}

export function recordBookingConsent(
  database: AuthDatabase,
  record: { id: string; bookingId: string; version: string; now: number },
) {
  database
    .prepare(
      'INSERT INTO consent_records (id,bookingId,action,documentVersion,accepted,acceptedAt) VALUES (?,?,?,?,1,?)',
    )
    .run(record.id, record.bookingId, 'guest_booking_request', record.version, record.now);
}

export function updateBookingStatusConfirmed(database: AuthDatabase, id: string, now: number) {
  return database
    .prepare(
      "UPDATE bookings SET status = 'confirmed', version = version + 1, updatedAt = ? WHERE id = ? AND status = 'pending'",
    )
    .run(now, id).changes;
}

export function updateBookingStatusRejected(
  database: AuthDatabase,
  id: string,
  reason: string,
  now: number,
) {
  return database
    .prepare(
      "UPDATE bookings SET status = 'rejected', reason = ?, version = version + 1, updatedAt = ? WHERE id = ? AND status = 'pending'",
    )
    .run(reason, now, id).changes;
}

// Переводит заявку в withdrawn без указания причины (PDR §4.4, ONTOLOGY §6).
export function updateBookingStatusWithdrawn(database: AuthDatabase, id: string, now: number) {
  return database
    .prepare(
      "UPDATE bookings SET status = 'withdrawn', reason = NULL, version = version + 1, updatedAt = ? WHERE id = ? AND status = 'pending'",
    )
    .run(now, id).changes;
}

// Переводит подтверждённую встречу в cancelled, причина необязательна (PDR §4.5, ONTOLOGY §6).
export function updateBookingStatusCancelled(
  database: AuthDatabase,
  id: string,
  reason: string | null,
  now: number,
) {
  return database
    .prepare(
      "UPDATE bookings SET status = 'cancelled', reason = ?, version = version + 1, updatedAt = ? WHERE id = ? AND status = 'confirmed'",
    )
    .run(reason, now, id).changes;
}

// Переводит просроченную заявку в expired, причина 'expired' (PDR §4.4, ONTOLOGY §6).
export function updateBookingStatusExpired(database: AuthDatabase, id: string, now: number) {
  return database
    .prepare(
      "UPDATE bookings SET status = 'expired', reason = 'expired', version = version + 1, updatedAt = ? WHERE id = ? AND status = 'pending'",
    )
    .run(now, id).changes;
}

// Возвращает идентификаторы pending-заявок, до начала которых осталось меньше deadlineMs.
// Используется фоновой задачей истечения (PDR §4.4, ONTOLOGY §6).
export function findOverduePendingBookings(
  database: AuthDatabase,
  now: number,
  deadlineMs: number,
): { id: string; startUtc: number; expertId: string; guestEmail: string }[] {
  return database
    .prepare(
      "SELECT id, startUtc, expertId, guestEmail FROM bookings WHERE status = 'pending' AND startUtc - ? < ?",
    )
    .all(now, deadlineMs) as {
    id: string;
    startUtc: number;
    expertId: string;
    guestEmail: string;
  }[];
}

export function insertBookingTransitionFull(
  database: AuthDatabase,
  transition: {
    id: string;
    bookingId: string;
    fromStatus: string;
    toStatus: string;
    reason?: string | null;
    occurredAt: number;
  },
) {
  database
    .prepare(
      'INSERT INTO booking_transitions (id,bookingId,fromStatus,toStatus,reason,occurredAt) VALUES (?,?,?,?,?,?)',
    )
    .run(
      transition.id,
      transition.bookingId,
      transition.fromStatus,
      transition.toStatus,
      transition.reason ?? null,
      transition.occurredAt,
    );
}

export type OverlappingPendingRow = {
  id: string;
  expertId: string;
  guestEmail: string;
  startUtc: number;
  endUtc: number;
};

export function readOverlappingPendingForParticipants(
  database: AuthDatabase,
  expertId: string,
  guestEmail: string,
  startUtc: number,
  endUtc: number,
  excludeId?: string,
): OverlappingPendingRow[] {
  const rows = database
    .prepare(
      "SELECT id, expertId, guestEmail, startUtc, endUtc FROM bookings WHERE status = 'pending' AND (expertId = ? OR guestEmail = ?) AND startUtc < ? AND endUtc > ? AND (? IS NULL OR id <> ?) ORDER BY startUtc",
    )
    .all(
      expertId,
      guestEmail,
      endUtc,
      startUtc,
      excludeId ?? null,
      excludeId ?? null,
    ) as OverlappingPendingRow[];
  return rows;
}

export function enqueueJob(
  database: AuthDatabase,
  job: {
    id: string;
    type: string;
    bookingId: string;
    eventRef?: string | null;
    recipient: string;
    scheduledAt: number;
    deduplicationKey: string;
  },
) {
  database
    .prepare(
      'INSERT INTO jobs (id, deduplicationKey, type, bookingId, eventRef, recipient, scheduledAt, attempts, nextAttemptAt, status, createdAt) VALUES (?,?,?,?,?,?,?,0,?,?,?)',
    )
    .run(
      job.id,
      job.deduplicationKey,
      job.type,
      job.bookingId,
      job.eventRef ?? null,
      job.recipient,
      job.scheduledAt,
      job.scheduledAt,
      'pending',
      job.scheduledAt,
    );
}

// Будущие активные заявки и встречи, где эксперт — организатор.
// «Будущие» — startUtc > nowMs; «активные» — pending или confirmed.
// Используется для расчёта affectedBookings (PDR §4.6, ONTOLOGY §5.3).
export type FutureOrganizerBookingRow = {
  id: string;
  status: string;
  startUtc: number;
  endUtc: number;
};

export function findFutureOrganizerBookings(
  database: AuthDatabase,
  expertId: string,
  nowMs: number,
): FutureOrganizerBookingRow[] {
  return database
    .prepare(
      "SELECT id, status, startUtc, endUtc FROM bookings WHERE expertId = ? AND status IN ('pending','confirmed') AND startUtc > ? ORDER BY startUtc, id",
    )
    .all(expertId, nowMs) as FutureOrganizerBookingRow[];
// Возвращает true, если сессия с указанным id существует, не отозвана и не
// истекла. Используется бродкастером SSE для отслеживания отзыва сессии
// без обращения к HMAC-токену (PDR §7 UI-06, задача 020).
export function isSessionActive(database: AuthDatabase, sessionId: string, now: number): boolean {
  const row = database
    .prepare('SELECT revokedAt, expiresAt FROM expert_sessions WHERE id = ?')
    .get(sessionId) as { revokedAt: number | null; expiresAt: number } | undefined;
  return Boolean(row && row.revokedAt === null && row.expiresAt > now);
}

// Возвращает true, если гостевой токен существует, не отозван и не истёк.
// Используется бродкастером SSE для отслеживания отзыва токена (UP-07).
export function isGuestAccessActive(
  database: AuthDatabase,
  tokenHash: string,
  now: number,
): boolean {
  const row = database
    .prepare('SELECT revokedAt, expiresAt FROM guest_access WHERE tokenHash = ?')
    .get(tokenHash) as { revokedAt: number | null; expiresAt: number } | undefined;
  return Boolean(row && row.revokedAt === null && row.expiresAt > now);
}
