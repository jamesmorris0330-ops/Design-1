import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Action, CommandEnvelope, RoomView, ServerMessage } from '../shared/protocol';
import { createApp } from './app';
import { Store } from './store';

class Peer {
  readonly messages: ServerMessage[] = [];
  readonly waiters = new Set<() => void>();
  view: RoomView | null = null;
  constructor(readonly socket: WebSocket, readonly cookie: string, readonly memberId: string) {
    socket.on('message', data => {
      const message = JSON.parse(data.toString()) as ServerMessage;
      this.messages.push(message);
      if (message.type === 'snapshot') this.view = message.view;
      this.waiters.forEach(check => check());
    });
  }
  wait(predicate: (message: ServerMessage) => boolean, from = 0): Promise<ServerMessage> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { this.waiters.delete(check); reject(new Error('Expected WebSocket message did not arrive')); }, 4000);
      const check = () => {
        const found = this.messages.slice(from).find(predicate);
        if (found) { clearTimeout(timeout); this.waiters.delete(check); resolve(found); }
      };
      this.waiters.add(check); check();
    });
  }
  async phase(type: string): Promise<void> {
    if (this.view?.game?.phase.type === type) return;
    await this.wait(message => message.type === 'snapshot' && message.view.game?.phase.type === type);
  }
  command(action: Action): CommandEnvelope {
    return { commandId: randomUUID(), gameId: this.view?.game?.id ?? null, phaseId: this.view?.game?.phase.id ?? null, action };
  }
  async send(action: Action, envelope = this.command(action)): Promise<Extract<ServerMessage, { type: 'ack' }>> {
    const from = this.messages.length;
    this.socket.send(JSON.stringify(envelope));
    const ack = await this.wait(message => message.type === 'ack' && message.commandId === envelope.commandId, from);
    // Snapshots are sent immediately after a committed acknowledgement.
    await new Promise<void>(resolve => setImmediate(resolve));
    return ack as Extract<ServerMessage, { type: 'ack' }>;
  }
}

const apps: FastifyInstance[] = [];
const sockets: WebSocket[] = [];
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  sockets.splice(0).forEach(socket => socket.terminate());
  await Promise.all(apps.splice(0).map(app => app.close()));
  directories.splice(0).forEach(directory => rmSync(directory, { recursive: true, force: true }));
});

async function server(databasePath = ':memory:', now = Date.now, timerIntervalMs = 5): Promise<{ app: FastifyInstance; origin: string }> {
  const app = await createApp({ databasePath, timerIntervalMs, now, staticRoot: '/tmp/nonexistent-experiment-static' });
  apps.push(app);
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, origin };
}

async function connect(origin: string, code: string, cookie: string, memberId: string): Promise<Peer> {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/rooms/${code}/socket`, { headers: { origin, cookie } });
  sockets.push(socket);
  const peer = new Peer(socket, cookie, memberId);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await peer.wait(message => message.type === 'snapshot');
  return peer;
}

async function group(app: FastifyInstance, origin: string, count = 4): Promise<{ code: string; peers: Peer[] }> {
  const created = await app.inject({ method: 'POST', url: '/api/rooms', payload: { nickname: 'Subject One' } });
  expect(created.statusCode).toBe(201);
  const first = created.json() as { code: string; memberId: string };
  const peers = [await connect(origin, first.code, String(created.headers['set-cookie']).split(';')[0]!, first.memberId)];
  for (let index = 1; index < count; index++) {
    const joined = await app.inject({ method: 'POST', url: `/api/rooms/${first.code}/join`, payload: { nickname: `Subject ${index + 1}` } });
    expect(joined.statusCode).toBe(200);
    peers.push(await connect(origin, first.code, String(joined.headers['set-cookie']).split(';')[0]!, joined.json().memberId));
  }
  return { code: first.code, peers };
}

async function begin(peers: Peer[]): Promise<void> {
  for (const peer of peers) expect((await peer.send({ type: 'ready', ready: true })).ok).toBe(true);
  expect((await peers[0]!.send({ type: 'start' })).ok).toBe(true);
  await Promise.all(peers.map(peer => peer.phase('crisis')));
}

async function advanceTo(host: Peer, peers: Peer[], type: string): Promise<void> {
  for (let guard = 0; guard < 12 && host.view?.game?.phase.type !== type; guard++) {
    const previous = host.view!.game!.phase.id;
    expect((await host.send({ type: 'advance' })).ok).toBe(true);
    await host.wait(message => message.type === 'snapshot' && message.view.game?.phase.id !== previous);
  }
  expect(host.view?.game?.phase.type).toBe(type);
  await Promise.all(peers.map(peer => peer.phase(type)));
}

describe('authoritative real-time transport', () => {
  it('expires hard deadlines before processing a late command between timer sweeps', async () => {
    let clock = Date.now();
    const { app, origin } = await server(':memory:', () => clock, 60_000);
    const { peers } = await group(app, origin);
    await begin(peers);
    await advanceTo(peers[0]!, peers, 'decision');
    const owner = peers[1]!;
    const late = owner.command({ type: 'decision', allocation: { medical: 1, security: 1, reserve: 1 } });
    clock = owner.view!.game!.phase.deadline! + 1;
    expect((await owner.send(late.action, late)).error?.code).toBe('STALE_PHASE');
    await owner.wait(message => message.type === 'snapshot' && message.view.game?.phase.type === 'reveal');
    expect(owner.view!.me!.decisionSubmitted).toBe(false);
    expect(owner.view!.game!.allocationTotals).toEqual({ medical: 0, security: 0, reserve: 0 });
  });

  it('reports failed persistence without accepting an action and recovers on a successful retry', async () => {
    const { app, origin } = await server(':memory:', Date.now, 60_000);
    const { peers } = await group(app, origin);
    const owner = peers[1]!;
    const command = owner.command({ type: 'ready', ready: true });
    const failure = vi.spyOn(Store.prototype, 'commit').mockImplementationOnce(() => { throw new Error('Simulated unavailable storage'); });
    expect((await owner.send(command.action, command)).error?.code).toBe('SERVER_ERROR');
    expect(owner.view!.members.find(m => m.id === owner.memberId)!.ready).toBe(false);
    expect((await app.inject('/api/health')).statusCode).toBe(503);
    failure.mockRestore();
    expect((await owner.send(command.action, command)).ok).toBe(true);
    await owner.wait(message => message.type === 'snapshot' && message.view.members.find(m => m.id === owner.memberId)?.ready === true);
    expect((await app.inject('/api/health')).statusCode).toBe(200);
  });

  it('keeps secret decisions private, deduplicates commands, and fences refreshed controllers', async () => {
    const { app, origin } = await server();
    const { code, peers } = await group(app, origin);
    await begin(peers);
    await advanceTo(peers[0]!, peers, 'decision');
    for (const peer of peers) {
      const serialized = JSON.stringify(peer.view);
      expect(serialized).not.toContain('sessionId');
      expect(serialized).not.toContain('token_digest');
      expect(serialized).not.toContain('subjects');
      expect(peer.view?.me?.directive).not.toBeNull();
      expect(peer.view?.members.every(member => !('compliance' in member))).toBe(true);
    }
    const counts = peers.map(peer => peer.messages.filter(message => message.type === 'snapshot').length);
    const owner = peers[1]!;
    const decision: Action = { type: 'decision', allocation: { medical: 1, security: 1, reserve: 1 } };
    const command = owner.command(decision);
    expect((await owner.send(decision, command)).ok).toBe(true);
    await owner.wait(message => message.type === 'snapshot' && message.view.me?.decisionSubmitted === true);
    await new Promise<void>(resolve => setTimeout(resolve, 30));
    for (const [index, peer] of peers.entries()) {
      if (peer === owner) continue;
      expect(peer.messages.filter(message => message.type === 'snapshot').length).toBe(counts[index]);
      expect(peer.view?.me?.decisionSubmitted).toBe(false);
    }
    expect((await owner.send(decision, command)).ok).toBe(true);
    const reused = { ...command, action: { type: 'decision' as const, allocation: { medical: 2, security: 1, reserve: 0 } } };
    expect((await owner.send(reused.action, reused)).error?.code).toBe('COMMAND_REUSED');

    const restored = await connect(origin, code, owner.cookie, owner.memberId);
    await owner.wait(message => message.type === 'superseded');
    expect(restored.view?.selfId).toBe(owner.memberId);
    expect(restored.view?.me?.decision).toEqual({ medical: 1, security: 1, reserve: 1 });
    expect((await restored.send(decision, command)).ok).toBe(true);
    const late = await app.inject({ method: 'POST', url: `/api/rooms/${code}/join`, payload: { nickname: 'Observer' } });
    const spectator = await connect(origin, code, String(late.headers['set-cookie']).split(';')[0]!, late.json().memberId);
    expect(spectator.view?.me).toBeNull();
    expect((await spectator.send(decision)).ok).toBe(false);
    expect((await peers[2]!.send({ type: 'pause' })).error?.code).toBe('HOST_ONLY');
  });

  it('restores private state, paused deadlines, sessions, and durable receipts after restart', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'experiment-server-'));
    directories.push(directory);
    const databasePath = join(directory, 'rooms.sqlite');
    let clock = Date.now();
    const first = await server(databasePath, () => clock);
    const { code, peers } = await group(first.app, first.origin);
    await begin(peers);
    await advanceTo(peers[0]!, peers, 'decision');
    const owner = peers[1]!;
    const decision: Action = { type: 'decision', allocation: { medical: 1, security: 1, reserve: 1 } };
    const command = owner.command(decision);
    expect((await owner.send(decision, command)).ok).toBe(true);
    expect((await peers[0]!.send({ type: 'pause' })).ok).toBe(true);
    await owner.wait(message => message.type === 'snapshot' && message.view.game?.phase.paused === true);
    const priorView = structuredClone(owner.view!);
    peers.forEach(peer => peer.socket.terminate());
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    clock += 120_000;
    const restored = await server(databasePath, () => clock);
    const ownerAgain = await connect(restored.origin, code, owner.cookie, owner.memberId);
    const hostAgain = await connect(restored.origin, code, peers[0]!.cookie, peers[0]!.memberId);
    expect(ownerAgain.view?.game?.phase.id).toBe(priorView.game!.phase.id);
    expect(ownerAgain.view?.game?.phase.paused).toBe(true);
    expect(ownerAgain.view?.game?.phase.remainingMs).toBe(priorView.game!.phase.remainingMs);
    expect(ownerAgain.view?.me).toEqual(priorView.me);
    expect((await ownerAgain.send(decision, command)).ok).toBe(true);
    const sessions = await restored.app.inject({ url: '/api/session', headers: { cookie: owner.cookie } });
    expect(sessions.json().rooms).toEqual([{ code, nickname: 'Subject 2', role: 'subject' }]);
    expect((await hostAgain.send({ type: 'resume' })).ok).toBe(true);
    await ownerAgain.wait(message => message.type === 'snapshot' && message.view.game?.phase.paused === false);
    expect(ownerAgain.view?.game?.phase.deadline).toBe(clock + priorView.game!.phase.remainingMs!);
  });

  it('checks origins and membership, prevents nickname-based reclaim, and transfers an absent host after grace', async () => {
    let clock = Date.now();
    const { app, origin } = await server(':memory:', () => clock);
    const { code, peers } = await group(app, origin);
    const foreign = await app.inject({ method: 'POST', url: '/api/rooms', headers: { origin: 'https://another.example' }, payload: { nickname: 'Intruder' } });
    expect(foreign.statusCode).toBe(403);
    const impostor = await app.inject({ method: 'POST', url: `/api/rooms/${code}/join`, payload: { nickname: 'Subject One' } });
    expect(impostor.json().memberId).not.toBe(peers[0]!.memberId);
    const refused = (cookie: string, requestedOrigin: string) => new Promise<number>((resolve, reject) => {
      const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/rooms/${code}/socket`, { headers: { origin: requestedOrigin, cookie } });
      sockets.push(socket);
      socket.once('unexpected-response', (_request, response) => { response.resume(); resolve(response.statusCode!); });
      socket.once('open', () => { reject(new Error('Unauthorized socket opened')); socket.terminate(); });
      socket.once('error', () => { /* HTTP response rejection is expected. */ });
    });
    expect(await refused(peers[0]!.cookie, 'https://another.example')).toBe(403);
    expect(await refused('', origin)).toBe(401);
    const oldestConnected = peers[1]!;
    peers[0]!.socket.terminate();
    await oldestConnected.wait(message => message.type === 'snapshot' && message.view.members.find(member => member.id === peers[0]!.memberId)?.connected === false);
    clock += 61_000;
    await oldestConnected.wait(message => message.type === 'snapshot' && message.view.hostId === oldestConnected.memberId);
    expect(oldestConnected.view?.hostId).toBe(oldestConnected.memberId);
  });
});
