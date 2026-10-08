import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import type { Action, CommandEnvelope, RoomView, ServerMessage } from '../shared/protocol';
import { createApp } from './app';
import { projectRoom, type Room } from './engine';
import { Store } from './store';

/** Real sockets and separate anonymous browser sessions; fake only the server clock. */
class Peer {
  readonly messages: ServerMessage[] = [];
  private readonly waiters = new Set<() => void>();
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
      const timeout = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error('Expected CPU transport message did not arrive'));
      }, 4000);
      const check = () => {
        const message = this.messages.slice(from).find(predicate);
        if (!message) return;
        clearTimeout(timeout);
        this.waiters.delete(check);
        resolve(message);
      };
      this.waiters.add(check);
      check();
    });
  }

  async viewWhere(predicate: (view: RoomView) => boolean): Promise<void> {
    if (this.view && predicate(this.view)) return;
    await this.wait(message => message.type === 'snapshot' && predicate(message.view), this.messages.length);
  }

  async send(action: Action): Promise<Extract<ServerMessage, { type: 'ack' }>> {
    const command: CommandEnvelope = {
      commandId: randomUUID(), gameId: this.view?.game?.id ?? null,
      phaseId: this.view?.game?.phase.id ?? null, action,
    };
    const from = this.messages.length;
    this.socket.send(JSON.stringify(command));
    const acknowledgement = await this.wait(message => message.type === 'ack' && message.commandId === command.commandId, from);
    await new Promise<void>(resolve => setImmediate(resolve));
    return acknowledgement as Extract<ServerMessage, { type: 'ack' }>;
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
  const directory = mkdtempSync(join(tmpdir(), 'experiment-cpu-transport-'));
  directories.push(directory);
  return join(directory, 'rooms.sqlite');
}

async function server(databasePath: string, now: () => number, timerIntervalMs = 5): Promise<{ app: FastifyInstance; origin: string }> {
  const app = await createApp({ databasePath, now, timerIntervalMs, staticRoot: '/tmp/nonexistent-experiment-static' });
  apps.push(app);
  return { app, origin: await app.listen({ port: 0, host: '127.0.0.1' }) };
}

async function connect(origin: string, code: string, cookie: string, memberId: string): Promise<Peer> {
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/rooms/${code}/socket`, { headers: { origin, cookie } });
  sockets.push(socket);
  const peer = new Peer(socket, cookie, memberId);
  await new Promise<void>((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  await peer.wait(message => message.type === 'snapshot');
  return peer;
}

async function solo(app: FastifyInstance, origin: string): Promise<{ code: string; host: Peer }> {
  const created = await app.inject({ method: 'POST', url: '/api/rooms', payload: { nickname: 'Human Host' } });
  expect(created.statusCode).toBe(201);
  const identity = created.json() as { code: string; memberId: string };
  return {
    code: identity.code,
    host: await connect(origin, identity.code, String(created.headers['set-cookie']).split(';')[0]!, identity.memberId),
  };
}

async function joinHuman(app: FastifyInstance, origin: string, code: string, nickname: string): Promise<Peer> {
  const joined = await app.inject({ method: 'POST', url: `/api/rooms/${code}/join`, payload: { nickname } });
  expect(joined.statusCode).toBe(200);
  return connect(origin, code, String(joined.headers['set-cookie']).split(';')[0]!, joined.json().memberId);
}

function persisted(databasePath: string, code: string): Room {
  const store = new Store(databasePath);
  try {
    const room = store.loadRooms().find(candidate => candidate.code === code);
    expect(room).toBeDefined();
    return room!;
  } finally { store.close(); }
}

async function until(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Expected persisted CPU response did not arrive');
    await new Promise<void>(resolve => setTimeout(resolve, 5));
  }
}

async function start(host: Peer): Promise<void> {
  expect((await host.send({ type: 'ready', ready: true })).ok).toBe(true);
  expect((await host.send({ type: 'start' })).ok).toBe(true);
  await host.viewWhere(view => view.game?.phase.type === 'crisis');
}

async function advance(host: Peer, phase: string): Promise<void> {
  for (let guard = 0; guard < 12 && host.view?.game?.phase.type !== phase; guard++) {
    const phaseId = host.view!.game!.phase.id;
    expect((await host.send({ type: 'advance' })).ok).toBe(true);
    await host.viewWhere(view => view.game?.phase.id !== phaseId);
  }
  expect(host.view?.game?.phase.type).toBe(phase);
}

function cpuIds(room: Room): string[] {
  return room.members.filter(member => member.controller === 'cpu' && member.role === 'subject' && !member.removed).map(member => member.id);
}

describe('CPU seats over real authoritative transport', () => {
  it('expires hard deadlines before joining and admits a post-collapse visitor as a spectator', async () => {
    let clock = Date.now();
    const databasePath = database();
    const { app, origin } = await server(databasePath, () => clock, 60_000);
    const { code, host } = await solo(app, origin);
    await start(host);
    await advance(host, 'decision');
    const initial = persisted(databasePath, code);
    const subjects = Object.keys(initial.game!.subjects);
    const bots = cpuIds(initial);
    expect(subjects).toHaveLength(4);
    expect(Object.values(initial.game!.subjects).every(subject => subject.allocation === null)).toBe(true);

    clock = host.view!.game!.phase.deadline!;
    const firstVisitor = await joinHuman(app, origin, code, 'Before Collapse');
    await host.viewWhere(view => view.game?.phase.type === 'reveal');
    expect(bots).toContain(firstVisitor.memberId);
    expect(firstVisitor.view?.me).not.toBeNull();
    expect(firstVisitor.view?.game?.stability).toBe(30);
    const firstResolution = persisted(databasePath, code);
    expect(firstResolution.game!.publicEvents.filter(event => event.kind === 'resource_resolution')).toHaveLength(1);
    expect(firstResolution.game!.trial!.totals).toEqual({ medical: 0, security: 0, reserve: 0 });

    // No real time passes between phase advances, so no CPU response is due.
    await advance(host, 'decision');
    expect(host.view?.game?.round).toBe(2);
    expect(Object.values(persisted(databasePath, code).game!.subjects).every(subject => subject.allocation === null)).toBe(true);
    clock = host.view!.game!.phase.deadline!;
    const finalVisitor = await joinHuman(app, origin, code, 'After Collapse');
    await host.viewWhere(view => view.game?.outcome === 'failed');
    const collapsed = persisted(databasePath, code);
    expect(collapsed.game!.outcome).toBe('failed');
    expect(collapsed.game!.stabilityTicks).toBe(0);
    expect(collapsed.game!.startingSubjectCount).toBe(4);
    expect(Object.keys(collapsed.game!.subjects)).toEqual(subjects);
    expect(collapsed.game!.publicEvents.filter(event => event.kind === 'resource_resolution')).toHaveLength(2);
    expect(finalVisitor.memberId).not.toBe(firstVisitor.memberId);
    expect(bots).not.toContain(finalVisitor.memberId);
    expect(finalVisitor.view?.members.find(member => member.id === finalVisitor.memberId)?.role).toBe('spectator');
    expect(finalVisitor.view?.me).toBeNull();
    expect(collapsed.game!.subjects[finalVisitor.memberId]).toBeUndefined();
    expect(collapsed.game!.results).toHaveLength(4);
    expect(collapsed.game!.results.every(result => result.qualified === false)).toBe(true);
  });

  it('plays a complete solo game with CPU decisions, votes, interrogation, finale, and same-room rematch', async () => {
    let clock = Date.now();
    const databasePath = database();
    const { app, origin } = await server(databasePath, () => clock);
    const { code, host } = await solo(app, origin);
    await start(host);
    const bots = cpuIds(persisted(databasePath, code));
    expect(bots).toHaveLength(3);
    expect(host.view?.members.filter(member => member.role === 'subject')).toHaveLength(4);
    expect(host.view?.hostId).toBe(host.memberId);
    expect(host.view?.members.find(member => member.id === host.memberId)?.controller).toBe('human');

    for (let round = 1; round <= 2; round++) {
      await advance(host, 'decision');
      const snapshotCount = host.messages.filter(message => message.type === 'snapshot').length;
      clock += 6000;
      await until(() => bots.every(id => persisted(databasePath, code).game!.subjects[id]!.allocation !== null));
      expect(host.view?.game?.phase.type).toBe('decision');
      expect(host.view?.game?.allocationTotals).toBeNull();
      expect(host.view?.me?.decisionSubmitted).toBe(false);
      expect(host.messages.filter(message => message.type === 'snapshot')).toHaveLength(snapshotCount);
      expect((await host.send({ type: 'decision', allocation: { medical: 1, security: 1, reserve: 1 } })).ok).toBe(true);
      await host.viewWhere(view => view.game?.phase.type === 'reveal');
      await advance(host, 'vote');
      clock += 6000;
      await until(() => bots.every(id => persisted(databasePath, code).game!.subjects[id]!.ballot !== undefined));
      expect(host.view?.me?.voteSubmitted).toBe(false);
      expect((await host.send({ type: 'vote', targetId: null })).ok).toBe(true);
      await host.viewWhere(view => view.game?.phase.type === 'consequences');
      const record = persisted(databasePath, code);
      expect(Object.keys(record.game!.trial!.votes)).toHaveLength(4);
      expect(bots.every(id => record.game!.subjects[id]!.history.some(entry => entry.round === round))).toBe(true);
      await advance(host, round === 1 ? 'crisis' : 'extension_offer');
    }

    expect((await host.send({ type: 'continue' })).ok).toBe(true);
    await host.viewWhere(view => view.game?.phase.type === 'final_interrogation' && view.game.phase.speakerId === host.memberId);
    expect((await host.send({ type: 'statement', text: 'I am protecting the group.' })).ok).toBe(true);
    for (const bot of bots) {
      await host.viewWhere(view => view.game?.phase.type === 'final_interrogation' && view.game.phase.speakerId === bot);
      const previousPhase = host.view!.game!.phase.id;
      clock += 6000;
      await host.viewWhere(view => view.game?.phase.id !== previousPhase);
    }
    expect(host.view?.game?.phase.type).toBe('final_directive');
    expect(host.view?.chat.filter(message => message.type === 'statement' && bots.includes(message.senderId))).toHaveLength(3);
    await advance(host, 'final_choice');
    clock += 6000;
    await until(() => bots.every(id => persisted(databasePath, code).game!.subjects[id]!.finalChoice !== null));
    expect(host.view?.game?.results).toEqual([]);
    expect(host.view?.me?.finalChoice).toBeNull();
    expect((await host.send({ type: 'final_choice', choice: 'group' })).ok).toBe(true);
    await host.viewWhere(view => view.game?.phase.type === 'final_resolution');
    await advance(host, 'full_reveal');
    expect(host.view?.status).toBe('postgame');
    expect(host.view?.game?.round).toBe(3);
    expect(host.view?.game?.results).toHaveLength(4);
    expect(host.view?.game?.fullReveal.length).toBeGreaterThan(0);
    const completedGameId = host.view!.game!.id;
    expect((await host.send({ type: 'rematch' })).ok).toBe(true);
    await host.viewWhere(view => view.status === 'lobby');
    expect(host.view?.code).toBe(code);
    expect(host.view?.members.filter(member => member.controller === 'cpu')).toHaveLength(3);
    await start(host);
    expect(host.view?.game?.id).not.toBe(completedGameId);
  });

  it('atomically reserves distinct CPU seats for concurrent humans and preserves their locked private state on reconnect', async () => {
    let clock = Date.now();
    const databasePath = database();
    const { app, origin } = await server(databasePath, () => clock);
    const { code, host } = await solo(app, origin);
    await start(host);
    await advance(host, 'decision');
    clock += 6000;
    await until(() => cpuIds(persisted(databasePath, code)).every(id => persisted(databasePath, code).game!.subjects[id]!.allocation !== null));
    const before = persisted(databasePath, code);
    const bots = cpuIds(before);
    const newHumans = await Promise.all(['New Human One', 'New Human Two', 'New Human Three'].map(name => joinHuman(app, origin, code, name)));
    expect(new Set(newHumans.map(peer => peer.memberId))).toEqual(new Set(bots));
    await host.viewWhere(view => view.members.every(member => member.controller === 'human'));
    const after = persisted(databasePath, code);
    expect(after.hostId).toBe(host.memberId);
    expect(after.game!.phase.id).toBe(before.game!.phase.id);
    expect(cpuIds(after)).toEqual([]);
    expect(after.members.filter(member => member.role === 'subject')).toHaveLength(4);
    for (const newcomer of newHumans) {
      const inherited = projectRoom(before, newcomer.memberId).me!;
      expect(newcomer.view?.selfId).toBe(newcomer.memberId);
      expect(newcomer.view?.me).toEqual({ ...inherited, dossier: newcomer.view!.me!.dossier });
      expect(newcomer.view?.me?.dossier.slice(0, inherited.dossier.length)).toEqual(inherited.dossier);
      expect(newcomer.view?.me?.dossier.slice(inherited.dossier.length)).toHaveLength(1);
      expect(newcomer.view?.me?.dossier.at(-1)?.complianceDelta).toBe(0);
      expect(newcomer.view?.members.find(member => member.id === newcomer.memberId)?.subjectNumber).toBe(before.game!.subjects[newcomer.memberId]!.number);
      expect(JSON.stringify(newcomer.view)).not.toContain('subjects');
      expect(newcomer.view?.members.every(member => !('compliance' in member) && !('directive' in member) && !('sessionId' in member))).toBe(true);
      expect(after.game!.subjects[newcomer.memberId]).toEqual({
        ...before.game!.subjects[newcomer.memberId]!, dossier: after.game!.subjects[newcomer.memberId]!.dossier,
      });
      expect(after.game!.subjects[newcomer.memberId]!.dossier.slice(0, before.game!.subjects[newcomer.memberId]!.dossier.length))
        .toEqual(before.game!.subjects[newcomer.memberId]!.dossier);
    }
    const newcomer = newHumans[0]!;
    const rejoined = await app.inject({ method: 'POST', url: `/api/rooms/${code}/join`, headers: { cookie: newcomer.cookie }, payload: { nickname: 'Ignored Reconnect Name' } });
    expect(rejoined.json().memberId).toBe(newcomer.memberId);
    const restored = await connect(origin, code, newcomer.cookie, newcomer.memberId);
    await newcomer.wait(message => message.type === 'superseded');
    expect(restored.view?.me).toEqual(newcomer.view?.me);
    expect(restored.view?.members.find(member => member.id === restored.memberId)?.nickname).toBe('New Human One');
    const spectator = await joinHuman(app, origin, code, 'Observer');
    expect(spectator.view?.me).toBeNull();
    expect(spectator.view?.members.find(member => member.id === spectator.memberId)?.role).toBe('spectator');
    clock += 6000;
    await app.inject('/api/health');
    expect(persisted(databasePath, code).game!.subjects).toEqual(after.game!.subjects);
    expect((await host.send({ type: 'decision', allocation: { medical: 1, security: 1, reserve: 1 } })).ok).toBe(true);
    await host.viewWhere(view => view.game?.phase.type === 'reveal');
  });

  it('keeps the eight-seat cap, prevents CPU hosting, and cancels pending CPU actions when humans take control', async () => {
    let clock = Date.now();
    const databasePath = database();
    const { app, origin } = await server(databasePath, () => clock);
    const { code, host } = await solo(app, origin);
    for (let count = 0; count < 7; count++) expect((await host.send({ type: 'add_cpu' })).ok).toBe(true);
    expect((await host.send({ type: 'add_cpu' })).ok).toBe(false);
    const bots = cpuIds(persisted(databasePath, code));
    expect(bots).toHaveLength(7);
    expect((await host.send({ type: 'transfer_host', targetId: bots[0]! })).ok).toBe(false);
    expect(host.view?.hostId).toBe(host.memberId);
    await start(host);
    await advance(host, 'decision');
    const humans = await Promise.all(bots.map((_id, index) => joinHuman(app, origin, code, `Human ${index + 2}`)));
    expect(new Set(humans.map(peer => peer.memberId))).toEqual(new Set(bots));
    const observer = await joinHuman(app, origin, code, 'Ninth Visitor');
    expect(observer.view?.me).toBeNull();
    expect(observer.view?.members.filter(member => member.role === 'subject')).toHaveLength(8);
    clock += 6000;
    // An actual accepted command runs the timer queue before its mutation.
    expect((await host.send({ type: 'chat', text: 'Humans now control every Subject.' })).ok).toBe(true);
    const record = persisted(databasePath, code);
    expect(cpuIds(record)).toEqual([]);
    expect(Object.values(record.game!.subjects).every(subject => subject.allocation === null)).toBe(true);
    expect(record.game!.phase.type).toBe('decision');
    host.socket.terminate();
    await humans[0]!.viewWhere(view => view.members.find(member => member.id === host.memberId)?.connected === false);
    clock += 61_000;
    await humans[0]!.viewWhere(view => view.hostId !== host.memberId);
    expect(humans[0]!.view?.members.find(member => member.id === humans[0]!.view!.hostId)?.controller).toBe('human');
  });

  it('persists CPU seats through restart, suppresses their actions while paused, and resumes due decisions', async () => {
    let clock = Date.now();
    const databasePath = database();
    const first = await server(databasePath, () => clock);
    const { code, host } = await solo(first.app, first.origin);
    await start(host);
    await advance(host, 'decision');
    const bots = cpuIds(persisted(databasePath, code));
    expect((await host.send({ type: 'decision', allocation: { medical: 1, security: 1, reserve: 1 } })).ok).toBe(true);
    expect((await host.send({ type: 'pause' })).ok).toBe(true);
    await host.viewWhere(view => view.game?.phase.paused === true);
    const priorView = structuredClone(host.view!);
    const before = persisted(databasePath, code);
    expect(bots.every(id => before.game!.subjects[id]!.allocation === null)).toBe(true);
    host.socket.terminate();
    await first.app.close();
    apps.splice(apps.indexOf(first.app), 1);
    clock += 120_000;
    const second = await server(databasePath, () => clock);
    const restored = await connect(second.origin, code, host.cookie, host.memberId);
    expect(restored.view?.me).toEqual(priorView.me);
    expect(restored.view?.game?.phase.id).toBe(priorView.game!.phase.id);
    expect(restored.view?.game?.phase.paused).toBe(true);
    expect(cpuIds(persisted(databasePath, code))).toEqual(bots);
    clock += 6000;
    expect((await restored.send({ type: 'chat', text: 'The pause persists across a server restart.' })).ok).toBe(true);
    expect(bots.every(id => persisted(databasePath, code).game!.subjects[id]!.allocation === null)).toBe(true);
    expect((await restored.send({ type: 'resume' })).ok).toBe(true);
    clock += 6000;
    await restored.viewWhere(view => view.game?.phase.type === 'reveal');
    const after = persisted(databasePath, code);
    expect(bots.every(id => after.game!.subjects[id]!.allocation !== null)).toBe(true);
    expect(after.game!.subjects[host.memberId]!.allocation).toEqual({ medical: 1, security: 1, reserve: 1 });
    expect(after.game!.subjects[host.memberId]!.dossier.length).toBeGreaterThan(before.game!.subjects[host.memberId]!.dossier.length);
    expect(restored.view?.hostId).toBe(host.memberId);
    expect(restored.view?.members.find(member => member.id === host.memberId)?.controller).toBe('human');
  });
});
