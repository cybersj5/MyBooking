import Database from 'better-sqlite3';
import { initialMigration } from './migrations/001_initial.js';

const schemaVersion = 1;

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

      if (currentVersion < schemaVersion) {
        database.exec(initialMigration);
        database.pragma(`user_version = ${schemaVersion}`);
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
