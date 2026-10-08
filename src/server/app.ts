import Fastify, { LogController, type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import websocket from '@fastify/websocket';
import staticFiles from '@fastify/static';
import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { WebSocket } from 'ws';
import { commandSchema, DEFAULT_SETTINGS, settingsSchema, type CommandEnvelope, type ServerMessage } from '../shared/protocol';
import { addMember, applyCommand, createRoom, EngineError, isCpuMember, projectRoom, tick, type Room } from './engine';
import { runCpuPlayers } from './cpu';
import { Store, type CommandAck, type Receipt } from './store';

const SESSION_COOKIE = 'experiment_session';
const SESSION_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const HOST_GRACE_MS = 60_000;
const nicknameSchema = z.string().trim().min(1).max(24).refine(value => !/[\p{Cc}\p{Cf}]/u.test(value));
const createSchema = z.object({ nickname: nicknameSchema, settings: settingsSchema.optional() }).strict();
const joinSchema = z.object({ nickname: nicknameSchema }).strict();

interface Connection {
  socket: WebSocket;
  actorId: string;
  code: string;
  alive: boolean;
  lastView: string | null;
  viewVersion: number;
}

interface AppOptions {
  databasePath?: string;
  timerIntervalMs?: number;
  now?: () => number;
  /** Set to the public HTTPS origin when behind a reverse proxy. */
  publicOrigin?: string;
  staticRoot?: string;
}

class HttpError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

function digest(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
}

export async function createApp(options: AppOptions = {}): Promise<FastifyInstance> {
  const now = options.now ?? Date.now;
  const app = Fastify({ logger: { level: 'error' }, logController: new LogController({ disableRequestLogging: true }), bodyLimit: 16_384, trustProxy: process.env.TRUST_PROXY === 'true' });
  const store = new Store(options.databasePath ?? process.env.DATABASE_PATH ?? resolve('data/experiment.sqlite'));
  const degradedRooms = new Set<string>();
  const commit = (room: Room, at: number, event: unknown, receipt?: Receipt): void => {
    try { store.commit(room, at, event, receipt); degradedRooms.delete(room.code); }
    catch (error) {
      if (!degradedRooms.has(room.code)) app.log.error({ event: 'persistence_failure', room: room.code }, 'Room state could not be committed.');
      degradedRooms.add(room.code);
      throw error;
    }
  };
  const rooms = new Map(store.loadRooms().map(room => [room.code, room]));
  const connections = new Map<string, Map<string, Connection>>();
  const queues = new Map<string, Promise<void>>();
  const rateWindows = new Map<string, { start: number; count: number }>();
  const websocketContext = new WeakMap<FastifyRequest, { code: string; actorId: string }>();
  let shuttingDown = false;
  const publicOrigin = options.publicOrigin ?? process.env.PUBLIC_ORIGIN;
  if (publicOrigin && new URL(publicOrigin).origin !== publicOrigin) throw new Error('PUBLIC_ORIGIN must be an origin without a path');

  const rateLimit = (key: string, limit: number, duration: number): boolean => {
    const time = now();
    const current = rateWindows.get(key);
    if (!current || time - current.start >= duration) { rateWindows.set(key, { start: time, count: 1 }); return true; }
    current.count += 1;
    return current.count <= limit;
  };

  const enqueue = <T,>(code: string, work: () => T | Promise<T>): Promise<T> => {
    const previous = queues.get(code) ?? Promise.resolve();
    const result = previous.then(work);
    queues.set(code, result.then(() => undefined, () => undefined));
    return result;
  };

  const online = (code: string): Set<string> => new Set(connections.get(code)?.keys() ?? []);
  const send = (connection: Connection, message: ServerMessage): void => {
    if (connection.socket.readyState === 1) connection.socket.send(JSON.stringify(message));
  };
  const updateHostPresence = (room: Room): void => {
    const existing = store.hostPresence(room.code);
    const hostOnline = online(room.code).has(room.hostId);
    const disconnectedAt = hostOnline ? null : existing && existing.hostId === room.hostId && existing.disconnectedAt !== null ? existing.disconnectedAt : now();
    if (!existing || existing.hostId !== room.hostId || existing.disconnectedAt !== disconnectedAt) store.setHostPresence(room.code, room.hostId, disconnectedAt);
  };
  const broadcast = (code: string): void => {
    const room = rooms.get(code);
    if (!room) return;
    const onlineIds = online(code);
    for (const connection of connections.get(code)?.values() ?? []) {
      const member = room.members.find(candidate => candidate.id === connection.actorId);
      if (!member || member.removed) {
        send(connection, { type: 'error', message: 'You have been removed from this room.' });
        connection.socket.close(4003, 'Membership removed');
        continue;
      }
      const view = projectRoom(room, connection.actorId, onlineIds);
      const serialized = JSON.stringify(view);
      // A hidden-only mutation must never emit a snapshot to another Subject.
      if (connection.lastView === serialized) continue;
      connection.lastView = serialized;
      connection.viewVersion += 1;
      send(connection, { type: 'snapshot', view, serverTime: now(), viewVersion: connection.viewVersion });
    }
    updateHostPresence(room);
  };

  const sessionId = (request: FastifyRequest): string | null => {
    const token = request.cookies[SESSION_COOKIE];
    if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return store.sessionId(digest(token), now());
  };
  const ensureSession = (request: FastifyRequest, reply: FastifyReply): string => {
    const existing = sessionId(request);
    if (existing) return existing;
    const token = randomBytes(32).toString('base64url');
    const id = randomUUID();
    store.createSession(id, digest(token), now() + SESSION_AGE_MS);
    reply.setCookie(SESSION_COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production' || publicOrigin?.startsWith('https://') === true, maxAge: SESSION_AGE_MS / 1000 });
    return id;
  };
  const assertOrigin = (request: FastifyRequest, required: boolean): void => {
    const origin = request.headers.origin;
    if (!origin && !required) return;
    const expected = publicOrigin ?? `${request.protocol}://${request.headers.host}`;
    if (typeof origin !== 'string' || origin !== expected) throw new HttpError(403, 'ORIGIN', 'Use the same website origin to access this room.');
  };
  const roomCode = (request: FastifyRequest): string => {
    const code = (request.params as { code: string }).code.toUpperCase();
    if (!/^[A-Z2-9]{6}$/.test(code)) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Room not found. Check the six-character code.');
    return code;
  };
  const getRoom = (code: string): Room => {
    const room = rooms.get(code);
    if (!room) throw new HttpError(404, 'ROOM_NOT_FOUND', 'Room not found. Check the six-character code.');
    return room;
  };

  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: 16_384 } });
  app.addHook('onSend', async (request, reply) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'same-origin');
    reply.header('Content-Security-Policy', "frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    if (request.url.startsWith('/api/')) reply.header('Cache-Control', 'no-store');
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof HttpError) return reply.code(error.status).send({ error: { code: error.code, message: error.message } });
    if (error instanceof EngineError) return reply.code(409).send({ error: { code: error.code, message: error.message } });
    if (error instanceof z.ZodError) return reply.code(400).send({ error: { code: 'INVALID_REQUEST', message: 'Check the nickname and room settings.' } });
    if (typeof error === 'object' && error !== null && 'statusCode' in error && typeof error.statusCode === 'number' && error.statusCode < 500) return reply.code(error.statusCode).send({ error: { code: 'INVALID_REQUEST', message: 'The request could not be accepted.' } });
    return reply.code(500).send({ error: { code: 'SERVER_ERROR', message: 'The server could not save this action. Please try again.' } });
  });

  app.get('/api/health', async (_request, reply) => reply.code(degradedRooms.size ? 503 : 200).send({ ok: degradedRooms.size === 0 }));
  app.get('/api/session', async request => {
    const id = sessionId(request);
    return { rooms: id ? [...rooms.values()].flatMap(room => {
      const member = room.members.find(candidate => candidate.sessionId === id && !candidate.removed);
      return member ? [{ code: room.code, nickname: member.nickname, role: member.role }] : [];
    }) : [] };
  });

  app.post('/api/rooms', async (request, reply) => {
    assertOrigin(request, false);
    if (!rateLimit(`create:${request.ip}`, 12, 60_000)) throw new HttpError(429, 'RATE_LIMIT', 'Too many rooms created. Please wait a minute.');
    const body = createSchema.parse(request.body);
    const id = ensureSession(request, reply);
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code: string;
    do { code = Array.from({ length: 6 }, () => alphabet[randomInt(alphabet.length)]).join(''); } while (rooms.has(code));
    const memberId = randomUUID();
    const room = createRoom(code, { id: memberId, sessionId: id, nickname: body.nickname }, body.settings ?? DEFAULT_SETTINGS, now());
    commit(room, now(), { type: 'room_created', actorId: memberId });
    rooms.set(code, room);
    updateHostPresence(room);
    return reply.code(201).send({ code, memberId });
  });

  app.post('/api/rooms/:code/join', async (request, reply) => {
    assertOrigin(request, false);
    if (!rateLimit(`join:${request.ip}`, 40, 60_000)) throw new HttpError(429, 'RATE_LIMIT', 'Too many join attempts. Please wait a minute.');
    const code = roomCode(request);
    const body = joinSchema.parse(request.body);
    getRoom(code);
    const id = ensureSession(request, reply);
    return enqueue(code, () => {
      processTimers(code);
      const current = getRoom(code);
      const existing = current.members.find(member => member.sessionId === id);
      if (existing?.removed) throw new HttpError(403, 'REMOVED', 'Your Subject has been removed from this room.');
      if (existing) return { code, memberId: existing.id };
      const room = structuredClone(current);
      const memberId = addMember(room, { id: randomUUID(), sessionId: id, nickname: body.nickname }, now());
      commit(room, now(), { type: 'member_joined', actorId: memberId });
      rooms.set(code, room);
      broadcast(code);
      return { code, memberId };
    });
  });

  const rejectAck = (commandId: string, code: string, message: string): CommandAck => ({ type: 'ack', commandId, ok: false, error: { code, message } });
  const execute = (connection: Connection, command: CommandEnvelope): void => {
    // Recheck inside the serialized queue: a newer tab may have taken control.
    if (connections.get(connection.code)?.get(connection.actorId) !== connection) { send(connection, { type: 'superseded' }); return; }
    // Expiry is authoritative at execution time, even between timer sweeps.
    processTimers(connection.code);
    const room = getRoom(connection.code);
    const member = room.members.find(candidate => candidate.id === connection.actorId);
    if (!member || member.removed) { send(connection, rejectAck(command.commandId, 'REMOVED', 'You no longer have access to this room.')); return; }
    const payloadHash = digest(stableJson(command));
    const previous = store.receipt(connection.actorId, command.commandId);
    if (previous) {
      send(connection, previous.payloadHash === payloadHash ? previous.ack : rejectAck(command.commandId, 'COMMAND_REUSED', 'This command ID was already used for a different action.'));
      return;
    }
    const candidate = structuredClone(room);
    let ack: CommandAck = { type: 'ack', commandId: command.commandId, ok: true };
    try { applyCommand(candidate, connection.actorId, command, now()); }
    catch (error) {
      if (!(error instanceof EngineError)) throw error;
      ack = rejectAck(command.commandId, error.code, error.message);
    }
    const receipt: Receipt = { actorId: connection.actorId, commandId: command.commandId, payloadHash, ack };
    commit(ack.ok ? candidate : room, now(), { type: ack.ok ? 'command_accepted' : 'command_rejected', actorId: connection.actorId, command, errorCode: ack.error?.code ?? null }, receipt);
    if (ack.ok) rooms.set(connection.code, candidate);
    send(connection, ack);
    if (ack.ok) broadcast(connection.code);
  };

  app.get('/api/rooms/:code/socket', {
    websocket: true,
    preValidation: async request => {
      assertOrigin(request, true);
      if (!rateLimit(`connect:${request.ip}`, 80, 60_000)) throw new HttpError(429, 'RATE_LIMIT', 'Too many connection attempts. Please wait a minute.');
      const code = roomCode(request);
      const id = sessionId(request);
      if (!id) throw new HttpError(401, 'SESSION_REQUIRED', 'Join the room before connecting.');
      const member = getRoom(code).members.find(candidate => candidate.sessionId === id && !candidate.removed);
      if (!member) throw new HttpError(403, 'MEMBERSHIP_REQUIRED', 'Join the room before connecting.');
      websocketContext.set(request, { code, actorId: member.id });
    },
  }, (socket, request) => {
    const context = websocketContext.get(request)!;
    const connection: Connection = { socket, ...context, alive: true, lastView: null, viewVersion: 0 };
    const controls = connections.get(context.code) ?? new Map<string, Connection>();
    const old = controls.get(context.actorId);
    controls.set(context.actorId, connection);
    connections.set(context.code, controls);
    if (old) { send(old, { type: 'superseded' }); old.socket.close(4001, 'Another tab controls this Subject'); }
    socket.on('pong', () => { connection.alive = true; });
    socket.on('error', () => { /* Connection errors never contain game or credential logs. */ });
    socket.on('message', (data, binary) => {
      if (shuttingDown) return;
      if (!rateLimit(`command:${connection.actorId}`, 100, 10_000)) { send(connection, { type: 'error', message: 'Too many actions. Wait a moment before trying again.' }); return; }
      let parsed: unknown;
      try { if (binary) throw new Error('Binary commands are not supported'); parsed = JSON.parse(data.toString()); }
      catch { send(connection, { type: 'error', message: 'Send a valid JSON game command.' }); return; }
      const result = commandSchema.safeParse(parsed);
      if (!result.success) {
        const id = typeof parsed === 'object' && parsed !== null && 'commandId' in parsed && typeof parsed.commandId === 'string' && z.string().uuid().safeParse(parsed.commandId).success ? parsed.commandId : null;
        send(connection, id ? rejectAck(id, 'INVALID_COMMAND', 'This action has an invalid format.') : { type: 'error', message: 'This action has an invalid format.' });
        return;
      }
      void enqueue(context.code, () => execute(connection, result.data)).catch(() => {
        send(connection, rejectAck(result.data.commandId, 'SERVER_ERROR', 'This action could not be saved. Reconnect and retry.'));
      });
    });
    socket.on('close', () => {
      if (controls.get(connection.actorId) !== connection) return;
      controls.delete(connection.actorId);
      if (!shuttingDown) void enqueue(context.code, () => broadcast(context.code)).catch(() => undefined);
    });
    void enqueue(context.code, () => broadcast(context.code)).catch(() => { socket.close(1011, 'Room unavailable'); });
  });

  // Recovery and deadlines use precisely the same queue and commit path as commands.
  const processTimers = (code: string): void => {
    const current = getRoom(code);
    let room = structuredClone(current);
    let changed = tick(room, now());
    changed = runCpuPlayers(room, now()) || changed;
    const presence = store.hostPresence(code);
    if (presence && presence.hostId === room.hostId && presence.disconnectedAt !== null && now() - presence.disconnectedAt >= HOST_GRACE_MS && !online(code).has(room.hostId)) {
      const successor = room.members.filter(member => !isCpuMember(member) && member.role === 'subject' && !member.removed && online(code).has(member.id)).sort((a, b) => a.joinedAt - b.joinedAt)[0];
      if (successor) {
        const command: CommandEnvelope = { commandId: randomUUID(), gameId: room.game?.id ?? null, phaseId: room.game?.phase.id ?? null, action: { type: 'transfer_host', targetId: successor.id } };
        try { applyCommand(room, room.hostId, command, now()); changed = true; }
        catch (error) { if (!(error instanceof EngineError)) throw error; }
      }
    }
    if (changed) {
      commit(room, now(), { type: 'server_transition', previousHostId: current.hostId, hostId: room.hostId });
      rooms.set(code, room);
      broadcast(code);
    }
    updateHostPresence(rooms.get(code)!);
  };
  for (const room of rooms.values()) {
    updateHostPresence(room);
    processTimers(room.code);
  }
  const timer = setInterval(() => {
    if (shuttingDown) return;
    for (const code of rooms.keys()) void enqueue(code, () => processTimers(code)).catch(() => {
      if (!degradedRooms.has(code)) app.log.error({ event: 'timer_transition_failure', room: code }, 'Room deadline could not be advanced.');
      degradedRooms.add(code);
    });
    const time = now();
    for (const [key, value] of rateWindows) if (time - value.start > 60_000) rateWindows.delete(key);
  }, options.timerIntervalMs ?? 500);
  timer.unref();
  const heartbeat = setInterval(() => {
    for (const controls of connections.values()) for (const connection of controls.values()) {
      if (!connection.alive) { connection.socket.terminate(); continue; }
      connection.alive = false;
      if (connection.socket.readyState === 1) connection.socket.ping();
    }
  }, 15_000);
  heartbeat.unref();

  const staticRoot = options.staticRoot ?? resolve('dist');
  if (existsSync(resolve(staticRoot, 'index.html'))) {
    await app.register(staticFiles, { root: staticRoot });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'API endpoint not found.' } });
      if (request.method !== 'GET') return reply.code(404).send();
      return reply.sendFile('index.html');
    });
  }
  app.addHook('preClose', async () => {
    shuttingDown = true;
    clearInterval(timer);
    clearInterval(heartbeat);
    for (const controls of connections.values()) for (const connection of controls.values()) connection.socket.close(1001, 'Server restarting');
    await Promise.all(queues.values());
  });
  app.addHook('onClose', async () => { store.close(); });
  await app.ready();
  return app;
}
