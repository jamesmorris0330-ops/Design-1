import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { Action, CommandEnvelope, RoomView, ServerMessage } from '../shared/protocol';
import { createApp } from './app';
import { applyCommand, createRoom, projectRoom } from './engine';
import { DEFAULT_SETTINGS } from '../shared/protocol';
import { Store } from './store';

type Ack = Extract<ServerMessage, { type: 'ack' }>;
class Peer {
  view: RoomView | null = null;
  messages: ServerMessage[] = [];
  listeners = new Set<() => void>();
  constructor(readonly socket: WebSocket, readonly cookie: string, readonly memberId: string) {
    socket.on('message', data => {
      const message = JSON.parse(String(data)) as ServerMessage;
      this.messages.push(message);
      if (message.type === 'snapshot') this.view = message.view;
      this.listeners.forEach(listener => listener());
    });
  }
  wait(predicate: (message: ServerMessage) => boolean, from = 0): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.listeners.delete(check); reject(new Error('Missing survival socket message')); }, 4000);
      const check = () => {
        const message = this.messages.slice(from).find(predicate);
        if (message) { clearTimeout(timeout); this.listeners.delete(check); resolve(message); }
      };
      this.listeners.add(check); check();
    });
  }
  command(action: Action): CommandEnvelope { return { commandId: randomUUID(), gameId: this.view?.survival?.id ?? this.view?.game?.id ?? null, phaseId: this.view?.game?.phase.id ?? null, action }; }
  async send(action: Action, command = this.command(action)): Promise<Ack> {
    const from = this.messages.length;
    this.socket.send(JSON.stringify(command));
    const ack = await this.wait(message => message.type === 'ack' && message.commandId === command.commandId, from);
    await new Promise<void>(resolve => setImmediate(resolve));
    return ack as Ack;
  }
}
const apps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
const directories: string[] = [];
afterEach(async () => {
  sockets.splice(0).forEach(socket => socket.terminate());
  await Promise.all(apps.splice(0).map(app => app.close()));
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});
function database(): string {
  const directory = mkdtempSync(join(tmpdir(), 'experiment-survival-transport-'));
  directories.push(directory); return join(directory, 'room.sqlite');
}
async function server(databasePath: string, now: () => number): Promise<{ app: FastifyInstance; origin: string }> {
  const app = await createApp({ databasePath, now, timerIntervalMs: 60_000, staticRoot: '/tmp/no-survival-static' });
  apps.push(app); return { app, origin: await app.listen({ host: '127.0.0.1', port: 0 }) };
}
async function connect(origin: string, code: string, cookie: string, memberId: string): Promise<Peer> {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/rooms/${code}/socket`, { headers: { origin, cookie } });
  sockets.push(socket); const peer = new Peer(socket, cookie, memberId);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await peer.wait(message => message.type === 'snapshot'); return peer;
}
async function group(app: FastifyInstance, origin: string, count = 1): Promise<{ code: string; peers: Peer[] }> {
  const created = await app.inject({ method: 'POST', url: '/api/rooms', payload: { nickname: 'Lead Survivor' } });
  const { code, memberId } = created.json();
  const peers = [await connect(origin, code, String(created.headers['set-cookie']).split(';')[0]!, memberId)];
  for (let i = 1; i < count; i++) {
    const joined = await app.inject({ method: 'POST', url: `/api/rooms/${code}/join`, payload: { nickname: `Survivor ${i + 1}` } });
    peers.push(await connect(origin, code, String(joined.headers['set-cookie']).split(';')[0]!, joined.json().memberId));
  }
  return { code, peers };
}
async function start(peers: Peer[]): Promise<void> {
  for (const peer of peers) expect((await peer.send({ type: 'ready', ready: true })).ok).toBe(true);
  expect((await peers[0]!.send({ type: 'survival_start', shelterType: 'ranger_station', dayLengthMinutes: 120 })).ok).toBe(true);
}

describe('continuous authoritative survival transport', () => {
  it('runs the default real-time simulation and stops movement and world time when the last human disconnects', async () => {
    const db = database(); const app = await createApp({ databasePath: db, staticRoot: '/tmp/no-survival-static' });
    apps.push(app); const origin = await app.listen({ host: '127.0.0.1', port: 0 });
    const { code, peers } = await group(app, origin); const host = peers[0]!; await start(peers);
    expect(host.view!.survival!.players).toHaveLength(1);
    const startElapsed = host.view!.survival!.elapsedMs;
    const startX = host.view!.survival!.players[0]!.x;
    expect((await host.send({ type: 'survival_input', moveX: 1, moveY: 0, aim: 0, fire: false })).ok).toBe(true);
    await host.wait(message => message.type === 'snapshot' && (message.view.survival?.elapsedMs ?? 0) >= startElapsed + 220, host.messages.length);
    expect(host.view!.survival!.players[0]!.x).toBeGreaterThan(startX);
    host.socket.terminate(); await new Promise<void>(resolve => setTimeout(resolve, 50));
    const reader = new Store(db); const disconnected = reader.loadRooms()[0]!.survival!;
    expect(disconnected.players[host.memberId]!.input.fire).toBe(false);
    expect(disconnected.players[host.memberId]!.input.moveX).toBe(0);
    await new Promise<void>(resolve => setTimeout(resolve, 350));
    expect(reader.loadRooms()[0]!.survival!.elapsedMs).toBe(disconnected.elapsedMs); reader.close();
    const again = await connect(origin, code, host.cookie, host.memberId);
    expect(again.view!.survival!.elapsedMs).toBe(disconnected.elapsedMs);
    expect(again.view!.survival!.players[0]!.x).toBe(disconnected.players[host.memberId]!.x);
  });

  it('starts with human survivors, integrates intent on the server and keeps inventories private', async () => {
    let clock = Date.now(); const { app, origin } = await server(database(), () => clock);
    const { peers } = await group(app, origin, 2); const host = peers[0]!; const other = peers[1]!;
    expect((await host.send({ type: 'survival_start', shelterType: 'bunker', dayLengthMinutes: 60 })).error?.code).toBe('NOT_READY');
    await start(peers);
    expect(host.view?.game).toBeNull(); expect(host.view?.me).toBeNull();
    expect(host.view?.survival?.players).toHaveLength(2);
    expect(host.view?.survivorMe?.weapons[0]?.id).toBe('pistol');
    for (const player of other.view!.survival!.players) {
      expect(player).not.toHaveProperty('inventory'); expect(player).not.toHaveProperty('input'); expect(player).not.toHaveProperty('stats');
    }
    expect(JSON.stringify(other.view!.survival)).not.toContain('contents');
    // Separate module rejections must stay ordinary persisted socket ACKs.
    const invalid = host.command({ type: 'survival_craft', recipeId: 'unknown-recipe' });
    const rejected = await host.send(invalid.action, invalid);
    expect(rejected.ok).toBe(false); expect(rejected.error?.code).toBe('survival_recipe');
    expect(await host.send(invalid.action, invalid)).toEqual(rejected);
    expect((await other.send({ type: 'survival_ballot', electionId: 'missing', candidateId: host.memberId })).error?.code).toBe('ELECTION_CLOSED');
    expect((await other.send({ type: 'survival_withdraw', item: 'wood', amount: 1 })).error?.code).toBe('INSUFFICIENT_SUPPLIES');

    const beforeX = host.view!.survival!.players.find(player => player.id === host.memberId)!.x;
    const input: Action = { type: 'survival_input', moveX: 1, moveY: 0, aim: 0, fire: false };
    expect((await host.send(input)).ok).toBe(true);
    clock += 200;
    expect((await host.send({ ...input, moveX: 0 })).ok).toBe(true);
    expect(host.view!.survival!.players.find(player => player.id === host.memberId)!.x).toBeGreaterThan(beforeX);
    expect((await other.send({ type: 'survival_pause', paused: true })).error?.code).toBe('HOST_ONLY');
    expect((await host.send(input, { ...host.command(input), gameId: randomUUID() })).error?.code).toBe('STALE_WORLD');
    expect((await host.send({ type: 'decision', allocation: { medical: 1, security: 1, reserve: 1 } })).error?.code).toBe('SURVIVAL_MODE');
  });

  it('hands CPU supplies and position to distinct human arrivals, then admits observers only after eight seats', async () => {
    const clock = Date.now(); const db = database(); const { app, origin } = await server(db, () => clock);
    const { code, peers } = await group(app, origin);
    for (let i = 0; i < 3; i++) expect((await peers[0]!.send({ type: 'add_cpu' })).ok).toBe(true);
    await start(peers);
    const saved = new Store(db); const room = saved.loadRooms()[0]!;
    const cpuIds = room.members.filter(member => member.controller === 'cpu').map(member => member.id);
    const expected = projectRoom(room, cpuIds[0]!).survivorMe; saved.close();
    const arrivals = await Promise.all(['New One', 'New Two'].map(nickname => app.inject({ method: 'POST', url: `/api/rooms/${code}/join`, payload: { nickname } })));
    const ids = arrivals.map(response => response.json().memberId);
    expect(new Set(ids).size).toBe(2); expect(ids.every(id => cpuIds.includes(id))).toBe(true);
    const first = arrivals.find(response => response.json().memberId === cpuIds[0])!;
    const replacement = await connect(origin, code, String(first.headers['set-cookie']).split(';')[0]!, first.json().memberId);
    expect(replacement.view!.survivorMe).toEqual(expected);
    expect(replacement.view!.survival!.players.find(player => player.id === replacement.memberId)).toEqual(peers[0]!.view!.survival!.players.find(player => player.id === replacement.memberId));
    for (let i = 0; i < 5; i++) expect((await app.inject({ method: 'POST', url: `/api/rooms/${code}/join`, payload: { nickname: `Late ${i}` } })).statusCode).toBe(200);
    const observer = await app.inject({ method: 'POST', url: `/api/rooms/${code}/join`, payload: { nickname: 'Observer' } });
    const spectator = await connect(origin, code, String(observer.headers['set-cookie']).split(';')[0]!, observer.json().memberId);
    expect(spectator.view!.members.find(member => member.id === spectator.memberId)!.role).toBe('spectator');
    expect(spectator.view!.survivorMe).toBeNull();
    expect((await spectator.send({ type: 'survival_input', moveX: 1, moveY: 0, aim: 0, fire: true })).error?.code).toBe('SURVIVOR_ONLY');
  });

  it('restores world time and economic receipts across downtime and pauses without offline advancement', async () => {
    let clock = Date.now(); const db = database(); const first = await server(db, () => clock);
    const { code, peers } = await group(first.app, first.origin); const host = peers[0]!; await start(peers);
    const craft: Action = { type: 'survival_craft', recipeId: 'ammo' }; const command = host.command(craft);
    expect((await host.send(craft, command)).ok).toBe(true);
    expect(host.view!.survival!.jobs).toHaveLength(1);
    const supplies = structuredClone(host.view!.survivorMe!.inventory);
    expect((await host.send({ type: 'survival_pause', paused: true })).ok).toBe(true);
    const elapsed = host.view!.survival!.elapsedMs;
    host.socket.terminate(); await first.app.close(); apps.splice(apps.indexOf(first.app), 1);
    clock += 24 * 60 * 60 * 1000;
    const restored = await server(db, () => clock);
    const again = await connect(restored.origin, code, host.cookie, host.memberId);
    expect(again.view!.survival!.elapsedMs).toBe(elapsed); expect(again.view!.survival!.paused).toBe(true);
    expect(again.view!.survivorMe!.inventory).toEqual(supplies);
    expect((await again.send(craft, command)).ok).toBe(true); expect(again.view!.survival!.jobs).toHaveLength(1);
    expect((await again.send({ type: 'survival_pause', paused: false })).ok).toBe(true);
    const resumedElapsed = again.view!.survival!.elapsedMs;
    again.socket.terminate(); await new Promise<void>(resolve => setTimeout(resolve, 20));
    clock += 60 * 60 * 1000;
    await restored.app.inject({ method: 'POST', url: `/api/rooms/${code}/join`, payload: { nickname: 'Fresh Human' } });
    const finalStore = new Store(db); expect(finalStore.loadRooms()[0]!.survival!.elapsedMs).toBe(resumedElapsed); finalStore.close();
  });

  it('lets an observer host administer the world without giving them a private inventory or combat controls', async () => {
    const clock = Date.now(); const { app, origin } = await server(database(), () => clock);
    const { peers } = await group(app, origin, 2); const host = peers[0]!; const survivor = peers[1]!;
    expect((await host.send({ type: 'set_role', targetId: host.memberId, role: 'spectator' })).ok).toBe(true);
    expect((await survivor.send({ type: 'ready', ready: true })).ok).toBe(true);
    expect((await host.send({ type: 'survival_start', shelterType: 'warehouse', dayLengthMinutes: 240 })).ok).toBe(true);
    expect(host.view!.survivorMe).toBeNull(); expect(host.view!.survival!.players).toHaveLength(1);
    expect((await host.send({ type: 'survival_pause', paused: true })).ok).toBe(true);
    expect((await host.send({ type: 'survival_input', moveX: 1, moveY: 0, aim: 0, fire: true })).error?.code).toBe('SURVIVOR_ONLY');
    expect((await survivor.send({ type: 'survival_reload' })).error?.code).toBe('PAUSED');
    expect((await host.send({ type: 'transfer_host', targetId: survivor.memberId })).ok).toBe(true);
    expect((await survivor.send({ type: 'survival_pause', paused: false })).ok).toBe(true);
    expect((await survivor.send({ type: 'end' })).ok).toBe(true);
    expect(survivor.view!.status).toBe('postgame');
    expect((await survivor.send({ type: 'rematch' })).ok).toBe(true);
    expect(survivor.view!.status).toBe('lobby'); expect(survivor.view!.survival).toBeUndefined();
  });

  it('bounds continuous tick audits and intent receipts while retaining economic command deduplication', () => {
    const db = database(); const store = new Store(db); const actorId = randomUUID();
    const room = createRoom('SURV22', { id: actorId, sessionId: 'human', nickname: 'Survivor' }, DEFAULT_SETTINGS, 1000);
    const ready: CommandEnvelope = { commandId: randomUUID(), gameId: null, phaseId: null, action: { type: 'ready', ready: true } };
    applyCommand(room, actorId, ready, 1000);
    applyCommand(room, actorId, { ...ready, commandId: randomUUID(), action: { type: 'survival_start', shelterType: 'farmhouse', dayLengthMinutes: 120 } }, 1000);
    const economicId = randomUUID(); const economicAck: Ack = { type: 'ack', commandId: economicId, ok: true };
    store.commit(room, 1000, { type: 'survival_craft' }, { actorId, commandId: economicId, payloadHash: 'economic', ack: economicAck });
    const inputIds: string[] = [];
    for (let i = 0; i < 2300; i++) {
      const commandId = randomUUID(); inputIds.push(commandId);
      store.commit(room, 1001 + i, { type: 'server_transition' }, { actorId, commandId, payloadHash: String(i), ack: { type: 'ack', commandId, ok: true }, volatile: true });
    }
    expect(store.receipt(actorId, economicId)?.ack).toEqual(economicAck);
    expect(store.receipt(actorId, inputIds[0]!)).toBeNull(); expect(store.receipt(actorId, inputIds.at(-1)!)?.ack.ok).toBe(true);
    store.close(); const query = new DatabaseSync(db);
    expect(Number(query.prepare('SELECT COUNT(*) AS count FROM command_receipts WHERE volatile = 1').get()!.count)).toBe(300);
    expect(Number(query.prepare('SELECT COUNT(*) AS count FROM room_events').get()!.count)).toBeLessThanOrEqual(2199);
    query.close(); const reopened = new Store(db); expect(reopened.receipt(actorId, economicId)?.payloadHash).toBe('economic'); reopened.close();
  });
});
