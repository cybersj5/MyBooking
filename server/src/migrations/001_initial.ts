export const initialMigration = `
CREATE TABLE experts (
  id TEXT PRIMARY KEY NOT NULL CHECK (length(id) > 0),
  email TEXT NOT NULL UNIQUE CHECK (email = lower(trim(email)) AND length(email) > 0),
  publicId TEXT NOT NULL UNIQUE CHECK (length(publicId) > 0),
  name TEXT CHECK (name IS NULL OR length(trim(name)) > 0),
  timezone TEXT CHECK (timezone IS NULL OR length(timezone) > 0),
  theme TEXT,
  createdAt INTEGER NOT NULL
) STRICT;

CREATE TABLE email_challenges (
  id TEXT PRIMARY KEY NOT NULL,
  purpose TEXT NOT NULL CHECK (length(purpose) > 0),
  email TEXT NOT NULL CHECK (email = lower(trim(email)) AND length(email) > 0),
  requestIpHash TEXT NOT NULL CHECK (length(requestIpHash) > 0),
  expertId TEXT REFERENCES experts(id),
  bookingId TEXT REFERENCES bookings(id),
  codeHash TEXT NOT NULL CHECK (length(codeHash) > 0),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL CHECK (expiresAt > createdAt),
  consumedAt INTEGER,
  replacedAt INTEGER
) STRICT;

CREATE INDEX email_challenges_lookup ON email_challenges(email, purpose, createdAt);
CREATE INDEX email_challenges_ip_limit ON email_challenges(requestIpHash, createdAt);

CREATE TABLE expert_sessions (
  id TEXT PRIMARY KEY NOT NULL,
  expertId TEXT NOT NULL REFERENCES experts(id),
  tokenHash TEXT NOT NULL UNIQUE CHECK (length(tokenHash) > 0),
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL CHECK (expiresAt > createdAt),
  revokedAt INTEGER
) STRICT;

CREATE TABLE guest_proofs (
  id TEXT PRIMARY KEY NOT NULL,
  expertId TEXT NOT NULL REFERENCES experts(id),
  email TEXT NOT NULL CHECK (email = lower(trim(email)) AND length(email) > 0),
  tokenHash TEXT NOT NULL UNIQUE CHECK (length(tokenHash) > 0),
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL CHECK (expiresAt > createdAt),
  consumedAt INTEGER
) STRICT;

CREATE TABLE consent_records (
  id TEXT PRIMARY KEY NOT NULL,
  expertId TEXT REFERENCES experts(id),
  bookingId TEXT REFERENCES bookings(id),
  action TEXT NOT NULL CHECK (length(action) > 0),
  documentVersion TEXT NOT NULL CHECK (length(documentVersion) > 0),
  accepted INTEGER NOT NULL CHECK (accepted = 1),
  acceptedAt INTEGER NOT NULL,
  CHECK ((expertId IS NOT NULL) <> (bookingId IS NOT NULL))
) STRICT;

CREATE TABLE availability_intervals (
  id TEXT PRIMARY KEY NOT NULL,
  expertId TEXT NOT NULL REFERENCES experts(id),
  weekday INTEGER NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  startLocal TEXT NOT NULL,
  endLocal TEXT NOT NULL,
  CHECK (startLocal GLOB '[0-2][0-9]:[0-5][0-9]' AND startLocal < '24:00'),
  CHECK (endLocal GLOB '[0-2][0-9]:[0-5][0-9]' AND endLocal <= '24:00'),
  CHECK (startLocal < endLocal),
  CHECK (substr(startLocal, 4, 2) IN ('00', '15', '30', '45')),
  CHECK (substr(endLocal, 4, 2) IN ('00', '15', '30', '45')),
  UNIQUE (expertId, weekday, startLocal, endLocal)
) STRICT;

CREATE TABLE excluded_dates (
  id TEXT PRIMARY KEY NOT NULL,
  expertId TEXT NOT NULL REFERENCES experts(id),
  localDate TEXT NOT NULL CHECK (localDate GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  UNIQUE (expertId, localDate)
) STRICT;

CREATE TABLE bookings (
  id TEXT PRIMARY KEY NOT NULL,
  expertId TEXT NOT NULL REFERENCES experts(id),
  guestEmail TEXT NOT NULL CHECK (guestEmail = lower(trim(guestEmail)) AND length(guestEmail) > 0),
  guestName TEXT NOT NULL CHECK (length(trim(guestName)) > 0),
  guestTimezone TEXT NOT NULL CHECK (length(guestTimezone) > 0),
  startUtc INTEGER NOT NULL,
  endUtc INTEGER NOT NULL,
  subject TEXT NOT NULL CHECK (length(trim(subject)) BETWEEN 1 AND 120),
  description TEXT CHECK (description IS NULL OR length(description) <= 2000),
  status TEXT NOT NULL CHECK (status IN ('pending', 'confirmed', 'rejected', 'withdrawn', 'expired', 'cancelled')),
  reason TEXT,
  actorType TEXT,
  actorId TEXT REFERENCES experts(id),
  version INTEGER NOT NULL CHECK (version > 0),
  createdAt INTEGER NOT NULL,
  updatedAt INTEGER,
  CHECK (startUtc < endUtc)
) STRICT;

CREATE INDEX bookings_expert_interval ON bookings(expertId, status, startUtc, endUtc);
CREATE INDEX bookings_guest_interval ON bookings(guestEmail, status, startUtc, endUtc);

CREATE TABLE booking_transitions (
  id TEXT PRIMARY KEY NOT NULL,
  bookingId TEXT NOT NULL REFERENCES bookings(id),
  fromStatus TEXT CHECK (fromStatus IS NULL OR fromStatus IN ('pending', 'confirmed', 'rejected', 'withdrawn', 'expired', 'cancelled')),
  toStatus TEXT NOT NULL CHECK (toStatus IN ('pending', 'confirmed', 'rejected', 'withdrawn', 'expired', 'cancelled')),
  reason TEXT,
  actorType TEXT,
  actorId TEXT REFERENCES experts(id),
  occurredAt INTEGER NOT NULL
) STRICT;

CREATE INDEX booking_transitions_booking ON booking_transitions(bookingId, occurredAt);

CREATE TABLE guest_access (
  id TEXT PRIMARY KEY NOT NULL,
  bookingId TEXT NOT NULL REFERENCES bookings(id),
  tokenHash TEXT NOT NULL UNIQUE CHECK (length(tokenHash) > 0),
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER NOT NULL CHECK (expiresAt > createdAt),
  revokedAt INTEGER
) STRICT;

CREATE TABLE idempotency_records (
  id TEXT PRIMARY KEY NOT NULL,
  scope TEXT NOT NULL CHECK (length(scope) > 0),
  keyHash TEXT NOT NULL CHECK (length(keyHash) > 0),
  bodyHash TEXT NOT NULL CHECK (length(bodyHash) > 0),
  resultJson TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  expiresAt INTEGER,
  UNIQUE (scope, keyHash)
) STRICT;

CREATE TABLE jobs (
  id TEXT PRIMARY KEY NOT NULL,
  deduplicationKey TEXT NOT NULL UNIQUE CHECK (length(deduplicationKey) > 0),
  type TEXT NOT NULL CHECK (length(type) > 0),
  bookingId TEXT REFERENCES bookings(id),
  eventRef TEXT,
  recipient TEXT NOT NULL CHECK (length(recipient) > 0),
  scheduledAt INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  nextAttemptAt INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (length(status) > 0),
  leaseUntil INTEGER,
  diagnosticMessage TEXT,
  createdAt INTEGER NOT NULL
) STRICT;

CREATE INDEX jobs_ready ON jobs(status, nextAttemptAt);
`;
