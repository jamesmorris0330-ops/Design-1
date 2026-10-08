import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Room } from './engine';
import type { ServerMessage } from '../shared/protocol';

export type CommandAck = Extract<ServerMessage, { type: 'ack' }>;
export interface Receipt {
  actorId: string;
  commandId: string;
  payloadHash: string;
  ack: CommandAck;
}

/** Server-only storage. Neither snapshots nor audit rows are client-readable. */
export class Store {
  private readonly database: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.database = new DatabaseSync(path);
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        token_digest TEXT NOT NULL UNIQUE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        snapshot TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS room_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code TEXT NOT NULL REFERENCES rooms(code),
        at INTEGER NOT NULL,
        event TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_receipts (
        actor_id TEXT NOT NULL,
        command_id TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        ack TEXT NOT NULL,
        room_code TEXT NOT NULL REFERENCES rooms(code),
        at INTEGER NOT NULL,
        PRIMARY KEY (actor_id, command_id)
      );
      CREATE TABLE IF NOT EXISTS host_presence (
        room_code TEXT PRIMARY KEY REFERENCES rooms(code),
        host_id TEXT NOT NULL,
        disconnected_at INTEGER
      );
    `);
  }

  loadRooms(): Room[] {
    return this.database.prepare('SELECT snapshot FROM rooms').all().map(row => JSON.parse(String(row.snapshot)) as Room);
  }

  sessionId(tokenDigest: string, now: number): string | null {
    const row = this.database.prepare('SELECT id FROM sessions WHERE token_digest = ? AND expires_at > ?').get(tokenDigest, now);
    return row ? String(row.id) : null;
  }

  createSession(id: string, tokenDigest: string, expiresAt: number): void {
    this.database.prepare('INSERT INTO sessions(id, token_digest, expires_at) VALUES (?, ?, ?)').run(id, tokenDigest, expiresAt);
  }

  receipt(actorId: string, commandId: string): Receipt | null {
    const row = this.database.prepare('SELECT payload_hash, ack FROM command_receipts WHERE actor_id = ? AND command_id = ?').get(actorId, commandId);
    return row ? { actorId, commandId, payloadHash: String(row.payload_hash), ack: JSON.parse(String(row.ack)) as CommandAck } : null;
  }

  /** Snapshot, audit event, and receipt commit together before acknowledgement. */
  commit(room: Room, at: number, event: unknown, receipt?: Receipt): void {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare('INSERT INTO rooms(code, snapshot, updated_at) VALUES (?, ?, ?) ON CONFLICT(code) DO UPDATE SET snapshot = excluded.snapshot, updated_at = excluded.updated_at')
        .run(room.code, JSON.stringify(room), at);
      this.database.prepare('INSERT INTO room_events(room_code, at, event) VALUES (?, ?, ?)').run(room.code, at, JSON.stringify(event));
      if (receipt) {
        this.database.prepare('INSERT INTO command_receipts(actor_id, command_id, payload_hash, ack, room_code, at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(receipt.actorId, receipt.commandId, receipt.payloadHash, JSON.stringify(receipt.ack), room.code, at);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  hostPresence(code: string): { hostId: string; disconnectedAt: number | null } | null {
    const row = this.database.prepare('SELECT host_id, disconnected_at FROM host_presence WHERE room_code = ?').get(code);
    return row ? { hostId: String(row.host_id), disconnectedAt: row.disconnected_at === null ? null : Number(row.disconnected_at) } : null;
  }

  setHostPresence(code: string, hostId: string, disconnectedAt: number | null): void {
    this.database.prepare('INSERT INTO host_presence(room_code, host_id, disconnected_at) VALUES (?, ?, ?) ON CONFLICT(room_code) DO UPDATE SET host_id = excluded.host_id, disconnected_at = excluded.disconnected_at')
      .run(code, hostId, disconnectedAt);
  }

  close(): void { this.database.close(); }
}
