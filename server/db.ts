import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface UserRow {
  id: string
  username: string
  email: string
  password_hash: string
  salt: string
  nickname: string
  avatar_color: string
  created_at: number
  updated_at: number
}

export interface SessionRow {
  token: string
  user_id: string
  expires_at: number
  created_at: number
}

export interface CloudProjectRow {
  id: string
  user_id: string
  title: string
  original_filename: string
  dimensions_width: number
  dimensions_height: number
  thumbnail_data: string
  state_json: string
  created_at: number
  updated_at: number
}

export interface AppDatabase {
  db: DatabaseSync
  close: () => void
}

export function initDatabase(dbPath?: string): AppDatabase {
  const targetPath = dbPath ?? process.env.ONEIMAGE_DB_PATH ?? resolve(process.cwd(), 'data/oneimage.db')

  if (targetPath !== ':memory:') {
    mkdirSync(dirname(targetPath), { recursive: true })
  }

  const db = new DatabaseSync(targetPath)

  // Production keeps this file on an NFS mount, where SQLite's WAL mode is
  // unsupported: the -shm index is shared memory mapped over a network
  // filesystem, so its bookkeeping can silently diverge from the log. A
  // rollback journal needs no shared memory and stays safe for the single
  // writer process this server runs. Set ONEIMAGE_DB_JOURNAL=WAL only when the
  // database lives on a local disk.
  const journalMode = (process.env.ONEIMAGE_DB_JOURNAL ?? 'TRUNCATE').toUpperCase()
  const journalModes = ['DELETE', 'TRUNCATE', 'PERSIST', 'WAL']
  db.exec(`PRAGMA journal_mode = ${journalModes.includes(journalMode) ? journalMode : 'TRUNCATE'};`)
  // FULL keeps each commit durable on the network filesystem.
  db.exec('PRAGMA synchronous = FULL;')
  db.exec('PRAGMA foreign_keys = ON;')

  // Create tables
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      salt TEXT NOT NULL,
      nickname TEXT NOT NULL,
      avatar_color TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cloud_projects (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      original_filename TEXT NOT NULL,
      dimensions_width INTEGER NOT NULL,
      dimensions_height INTEGER NOT NULL,
      thumbnail_data TEXT NOT NULL,
      state_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS email_verifications (
      email TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL,
      attempts INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_sent_at INTEGER NOT NULL,
      sent_count INTEGER NOT NULL,
      window_start INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS imagegen_usage (
      client_key TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (client_key, day)
    );

    CREATE TABLE IF NOT EXISTS videogen_usage (
      client_key TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (client_key, day)
    );

    CREATE TABLE IF NOT EXISTS smarterase_usage (
      client_key TEXT NOT NULL,
      day TEXT NOT NULL,
      count INTEGER NOT NULL,
      PRIMARY KEY (client_key, day)
    );

    CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_cloud_projects_user_id ON cloud_projects(user_id);
  `)

  return {
    db,
    close: () => db.close(),
  }
}
