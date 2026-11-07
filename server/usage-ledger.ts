import type { FastifyRequest } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { resolveClientKey, type ProxyHeaders } from './client-ip'

// The durable per-client spend ledger (SQLite) is shared by the image and the
// video generation surfaces: same day-bucket semantics, same atomicity
// argument, different table. The table name is always a literal from our own
// call sites, never user input.

export function todayKey(now: Date): string {
  // Day bucket in the server's local timezone; a calendar day is the natural
  // spend-budget unit for a single-operator site.
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

// cf-connecting-ip / XFF are only trusted when the socket peer is loopback —
// the same trust model as every other rate-limited surface here.
export function resolveUsageClientKey(request: FastifyRequest): string {
  return resolveClientKey(request.headers as ProxyHeaders, request.raw.socket.remoteAddress)
}

export function readUsage(db: DatabaseSync, table: 'imagegen_usage' | 'videogen_usage', clientKey: string, day: string): number {
  const row = db.prepare(`SELECT count FROM ${table} WHERE client_key = ? AND day = ?`).get(clientKey, day) as
    | { count: number }
    | undefined
  return row?.count ?? 0
}

// Counted before the upstream call so a slow or failing upstream cannot be
// used to race the budget; a failed generation still counts, which keeps the
// failure path from being cheaper than the abuse path. The read-check-increment
// runs without an await in between, so on this single-writer SQLite it is
// atomic per event-loop turn.
export function addUsage(db: DatabaseSync, table: 'imagegen_usage' | 'videogen_usage', clientKey: string, day: string, count: number): void {
  db.prepare(
    `INSERT INTO ${table} (client_key, day, count) VALUES (?, ?, ?) ON CONFLICT(client_key, day) DO UPDATE SET count = count + excluded.count`
  ).run(clientKey, day, count)
  // Housekeeping: yesterday's buckets are dead weight once the day rolled.
  db.prepare(`DELETE FROM ${table} WHERE day < ?`).run(day)
}
