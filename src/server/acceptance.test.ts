import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { Action, RoomView, ServerMessage } from '../shared/protocol';

class Subject {
  view!: RoomView;
  private readonly acknowledgements = new Map<string, Extract<ServerMessage, { type: 'ack' }>>();
  constructor(readonly socket: WebSocket) {
    socket.on('message', data => {
      const message = JSON.parse(String(data)) as ServerMessage;
      if (message.type === 'snapshot') this.view = message.view;
      if (message.type === 'ack') this.acknowledgements.set(message.commandId, message);
    });
  }
  async action(action: Action): Promise<void> {
    const commandId = randomUUID();
    this.socket.send(JSON.stringify({ commandId, gameId: this.view.game?.id ?? null, phaseId: this.view.game?.phase.id ?? null, action }));
    await expect.poll(() => this.acknowledgements.has(commandId), { timeout: 5000, interval: 5 }).toBe(true);
    expect(this.acknowledgements.get(commandId)!.ok, JSON.stringify(this.acknowledgements.get(commandId))).toBe(true);
  }
}

const resources: Array<{ app: FastifyInstance; subjects: Subject[] }> = [];
afterEach(async () => {
  for (const { app, subjects } of resources.splice(0)) {
    for (const subject of subjects) subject.socket.terminate();
    await app.close();
  }
});

async function match(rounds: number, count: number) {
  let clock = Date.now();
  const app = await createApp({ databasePath: ':memory:', now: () => clock, timerIntervalMs: 5, staticRoot: '/tmp/experiment-no-static' });
  const origin = await app.listen({ port: 0, host: '127.0.0.1' });
  const subjects: Subject[] = [];
  resources.push({ app, subjects });
  let code = '';
  for (let index = 0; index < count; index++) {
    const response = await app.inject({
      method: 'POST', url: index === 0 ? '/api/rooms' : `/api/rooms/${code}/join`,
      payload: index === 0 ? { nickname: `Subject ${index + 1}`, settings: { rounds, roundCap: rounds <= 15 ? 15 : 20, extensions: false, allowSpectators: true } } : { nickname: `Subject ${index + 1}` },
    });
    expect(response.statusCode).toBe(index === 0 ? 201 : 200);
    code = response.json().code;
    const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/api/rooms/${code}/socket`, { headers: { origin, cookie: String(response.headers['set-cookie']).split(';')[0] } });
    const subject = new Subject(socket);
    subjects.push(subject);
    await expect.poll(() => subject.view !== undefined, { timeout: 5000, interval: 5 }).toBe(true);
  }
  for (const subject of subjects) await subject.action({ type: 'ready', ready: true });
  await expect.poll(() => subjects[0].view.members.filter(m => m.ready).length).toBe(count);
  await subjects[0].action({ type: 'start' });
  await expect.poll(() => subjects.every(s => s.view.game?.phase.type === 'crisis')).toBe(true);

  const reached = new Set<string>();
  for (let guard = 0; guard < 400; guard++) {
    const game = subjects[0].view.game!;
    const phaseId = game.phase.id;
    reached.add(game.phase.type);
    await expect.poll(() => subjects.every(s => s.view.game?.phase.id === phaseId)).toBe(true);
    if (game.phase.type === 'full_reveal') break;
    if (game.phase.type === 'decision') {
      await Promise.all(subjects.map(s => s.action({ type: 'decision', allocation: { medical: 1, security: 1, reserve: 1 } })));
    } else if (game.phase.type === 'vote') {
      await Promise.all(subjects.map(s => s.action({ type: 'vote', targetId: null })));
    } else if (game.phase.type === 'final_interrogation') {
      const speaker = subjects.find(s => s.view.selfId === game.phase.speakerId)!;
      expect(speaker).toBeDefined();
      await speaker.action({ type: 'statement', text: 'The group can survive. I choose cooperation.' });
    } else if (game.phase.type === 'final_choice') {
      await Promise.all(subjects.map(s => s.action({ type: 'final_choice', choice: 'group' })));
    } else {
      expect(game.phase.deadline).not.toBeNull();
      clock = game.phase.deadline! + 1;
    }
    await expect.poll(() => subjects[0].view.game?.phase.id, { timeout: 5000, interval: 5 }).not.toBe(phaseId);
  }
  for (const subject of subjects) {
    const game = subject.view.game!;
    expect(game.phase.type).toBe('full_reveal');
    expect(game.round).toBe(rounds);
    expect(game.totalRounds).toBe(rounds);
    expect(game.outcome).toBe('survived');
    expect(game.results).toHaveLength(count);
    expect(subject.view.me!.requirement).toBe(Math.ceil(1.5 * rounds));
    expect(game.results.every(r => r.qualified === (!r.removed && r.compliance >= r.requirement))).toBe(true);
    expect(game.fullReveal.filter(entry => entry.detail.includes('Directive:')).length).toBe(count * rounds);
    expect(game.results).toEqual(subjects[0].view.game!.results);
    expect(subject.view.me!.dossier.filter(e => e.title === 'Resolution')).toHaveLength(rounds - 1);
    expect(subject.view.me!.dossier.reduce((total, entry) => total + entry.complianceDelta, 0)).toBe(subject.view.me!.compliance);
  }
  expect([...reached]).toEqual(expect.arrayContaining(['crisis', 'directive', 'discussion', 'decision', 'reveal', 'vote', 'consequences', 'dossier', 'final_interrogation', 'final_directive', 'final_choice', 'final_resolution', 'personal_results', 'full_reveal']));
}

describe('complete games through real sockets and persisted timer transitions', () => {
  it.each([3, 5, 7, 10, 15, 20])('completes the %i-round preset including exactly one finale', async rounds => {
    await match(rounds, rounds === 20 ? 8 : 4);
  }, 60000);
});
