import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Action, type CommandEnvelope } from '../shared/protocol.js';
import { addMember, applyCommand, createRoom, EngineError, isCpuMember, projectRoom, type Room } from './engine.js';

const NOW = 1_000;
const balanced = { medical: 1, security: 1, reserve: 1 };
function command(room: Room, action: Action): CommandEnvelope { return { commandId: randomUUID(), gameId: room.game?.id ?? null, phaseId: room.game?.phase.id ?? null, action }; }
function act(room: Room, actor: string, action: Action): void { applyCommand(room, actor, command(room, action), NOW); }
function lobby(): Room { return createRoom('CPU123', { id: 'human', sessionId: 'human-session', nickname: 'Human' }, { ...DEFAULT_SETTINGS, extensions: false }, NOW); }
function solo(): Room { const room = lobby(); act(room, 'human', { type: 'ready', ready: true }); act(room, 'human', { type: 'start' }); return room; }
function cpuIds(room: Room): string[] { return room.members.filter(m => !m.removed && isCpuMember(m)).map(m => m.id); }
function until(room: Room, phase: string): void {
  for (let n = 0; room.game?.phase.type !== phase && n < 100; n++) act(room, room.hostId, { type: 'advance' });
  expect(room.game?.phase.type).toBe(phase);
}
function ordinaryRound(room: Room): void {
  until(room, 'decision');
  for (const id of [...room.game!.phase.eligibleIds]) act(room, id, { type: 'decision', allocation: balanced });
  until(room, 'vote');
  for (const id of [...room.game!.phase.eligibleIds]) act(room, id, { type: 'vote', targetId: null });
  until(room, 'dossier'); act(room, room.hostId, { type: 'advance' });
}
function finalChoice(room: Room): void { ordinaryRound(room); ordinaryRound(room); until(room, 'final_choice'); }
function join(room: Room, sessionId = 'new-human', nickname = 'New Human'): string { return addMember(room, { id: randomUUID(), sessionId, nickname }, NOW); }
function expectCode(fn: () => unknown, code: string): void {
  try { fn(); throw new Error('Expected rejection.'); } catch (error) { expect(error).toBeInstanceOf(EngineError); expect((error as EngineError).code).toBe(code); }
}

describe('CPU seats and stable handovers', () => {
  it('starts with one ready human and automatically supplies three ready CPU Subjects', () => {
    const room = solo();
    expect(room.members).toHaveLength(4); expect(cpuIds(room)).toHaveLength(3);
    expect(room.members.filter(isCpuMember).every(m => m.ready && m.role === 'subject' && m.sessionId.startsWith('cpu:'))).toBe(true);
    expect(room.game!.startingSubjectCount).toBe(4); expect(room.game!.stabilityTicks).toBe(240);
    expect(Object.values(room.game!.subjects).map(s => s.number)).toEqual([1, 2, 3, 4]);
    const view = projectRoom(room, 'human');
    expect(view.members.filter(m => m.controller === 'cpu').every(m => m.connected)).toBe(true);
    expect(JSON.stringify(view)).not.toContain('sessionId');
  });

  it('checks human readiness before filling seats and keeps existing human and CPU IDs', () => {
    const room = lobby();
    expectCode(() => act(room, 'human', { type: 'start' }), 'NOT_READY');
    expect(room.members).toHaveLength(1);
    act(room, 'human', { type: 'add_cpu' }); const cpu = cpuIds(room)[0]!;
    const second = join(room, 'second-session', 'Second'); expect(second).toBe(cpu);
    act(room, 'human', { type: 'add_cpu' }); const retainedCpu = cpuIds(room)[0]!;
    act(room, 'human', { type: 'ready', ready: true });
    expectCode(() => act(room, 'human', { type: 'start' }), 'NOT_READY');
    act(room, second, { type: 'ready', ready: true }); act(room, 'human', { type: 'start' });
    expect(room.members).toHaveLength(4); expect(room.game!.subjects[retainedCpu]).toBeDefined();
    expect(room.game!.subjects[second]).toBeDefined(); expect(cpuIds(room)).toHaveLength(2);
  });

  it('adds optional CPU seats only in the lobby and never exceeds eight Subjects', () => {
    const room = lobby();
    for (let n = 0; n < 7; n++) act(room, 'human', { type: 'add_cpu' });
    expectCode(() => act(room, 'human', { type: 'add_cpu' }), 'ROOM_FULL');
    act(room, 'human', { type: 'ready', ready: true }); act(room, 'human', { type: 'start' });
    expect(room.game!.startingSubjectCount).toBe(8);
    expectCode(() => act(room, 'human', { type: 'add_cpu' }), 'BAD_STATE');
    act(room, 'human', { type: 'end' }); expectCode(() => act(room, 'human', { type: 'add_cpu' }), 'BAD_STATE');
  });

  it('requires a human Subject and refuses a CPU host or spectator', () => {
    const room = lobby(); act(room, 'human', { type: 'add_cpu' }); const cpu = cpuIds(room)[0]!;
    expectCode(() => act(room, cpu, { type: 'add_cpu' }), 'HOST_ONLY');
    expectCode(() => act(room, 'human', { type: 'transfer_host', targetId: cpu }), 'CPU_HOST');
    expectCode(() => act(room, 'human', { type: 'set_role', targetId: cpu, role: 'spectator' }), 'CPU_ROLE');
    act(room, 'human', { type: 'set_role', targetId: 'human', role: 'spectator' });
    expectCode(() => act(room, 'human', { type: 'start' }), 'PLAYER_COUNT');
    expect(room.hostId).toBe('human'); expect(room.game).toBeNull();
  });

  it('takes over a lobby CPU with the same member ID and requires the incoming human to ready', () => {
    const room = lobby(); act(room, 'human', { type: 'add_cpu' }); const cpu = cpuIds(room)[0]!;
    const id = addMember(room, { id: 'incoming-unused', sessionId: 'new-human', nickname: 'New Human' }, NOW + 500);
    expect(id).toBe(cpu); expect(room.members).toHaveLength(2); expect(cpuIds(room)).toEqual([]);
    expect(room.members.find(m => m.id === cpu)).toMatchObject({ controller: 'human', sessionId: 'new-human', nickname: 'New Human', ready: false, joinedAt: NOW + 500 });
    expect(room.events.at(-1)?.kind).toBe('cpu_takeover');
    expect(room.events.at(-1)?.text).toContain('already locked actions remain');
  });

  it('retains a live CPU Subject’s score, directive, restrictions, history and locked allocation', () => {
    const room = solo(); until(room, 'decision'); const id = cpuIds(room)[0]!;
    const subject = room.game!.subjects[id]!; subject.compliance = 7; subject.pendingRestriction = true;
    act(room, id, { type: 'decision', allocation: balanced });
    const before = structuredClone(subject), phaseId = room.game!.phase.id, oldSession = room.members.find(m => m.id === id)!.sessionId;
    expect(join(room)).toBe(id);
    expect({ ...subject, dossier: before.dossier }).toEqual(before);
    expect(subject.dossier.slice(0, -1)).toEqual(before.dossier);
    expect(room.game!.phase.id).toBe(phaseId); expect(room.game!.startingSubjectCount).toBe(4);
    expect(room.members.some(m => m.sessionId === oldSession)).toBe(false);
    const own = projectRoom(room, id);
    expect(own.me!.decision).toEqual(balanced); expect(own.me!.compliance).toBe(7);
    expect(own.me!.dossier.at(-1)!.title).toBe('CPU seat inherited');
    expectCode(() => act(room, id, { type: 'decision', allocation: { medical: 3, security: 0, reserve: 0 } }), 'ALREADY_LOCKED');
    expect(JSON.stringify(projectRoom(room, 'human'))).not.toContain(subject.directive!.id);
  });

  it('takes over while paused without changing the deadline or advancing the phase', () => {
    const room = solo(); until(room, 'decision'); act(room, 'human', { type: 'pause' });
    const before = structuredClone(room.game!.phase), id = cpuIds(room)[0]!;
    expect(join(room)).toBe(id); expect(room.game!.phase).toEqual(before); expect(room.game!.paused).toBe(true);
    expectCode(() => act(room, id, { type: 'decision', allocation: balanced }), 'PAUSED');
  });

  it('preserves locked public-vote and extension ballots when control changes', () => {
    const room = solo(); until(room, 'decision');
    for (const id of [...room.game!.phase.eligibleIds]) act(room, id, { type: 'decision', allocation: balanced });
    until(room, 'vote'); const id = cpuIds(room)[0]!;
    act(room, id, { type: 'vote', targetId: 'human' }); expect(join(room)).toBe(id);
    expect(room.game!.subjects[id]!.ballot).toBe('human'); expect(room.game!.trial!.votes[id]).toBe('human');
    expectCode(() => act(room, id, { type: 'vote', targetId: null }), 'ALREADY_LOCKED');
    const extRoom = solo(); extRoom.game!.extensionsEnabled = true; ordinaryRound(extRoom); ordinaryRound(extRoom);
    act(extRoom, 'human', { type: 'extension', additionalRounds: 1 }); const extCpu = cpuIds(extRoom)[0]!;
    act(extRoom, extCpu, { type: 'extension_vote', yes: true }); expect(join(extRoom)).toBe(extCpu);
    expect(extRoom.game!.extension!.ballots[extCpu]).toBe(true);
    expectCode(() => act(extRoom, extCpu, { type: 'extension_vote', yes: false }), 'ALREADY_LOCKED');
  });

  it('retains a CPU’s locked final choice and stops takeover after finale resolution', () => {
    const room = solo(); finalChoice(room); const id = cpuIds(room)[0]!;
    act(room, id, { type: 'final_choice', choice: 'group' }); expect(join(room)).toBe(id);
    expect(projectRoom(room, id).me!.finalChoice).toBe('group');
    expectCode(() => act(room, id, { type: 'final_choice', choice: 'self' }), 'ALREADY_LOCKED');
    for (const other of [...room.game!.phase.eligibleIds].filter(other => other !== id)) act(room, other, { type: 'final_choice', choice: 'group' });
    const watcher = join(room, 'watcher-session', 'Watcher');
    expect(room.members.find(m => m.id === watcher)!.role).toBe('spectator');
    expect(projectRoom(room, watcher).me).toBeNull(); expect(cpuIds(room)).toHaveLength(2);
  });

  it('preserves same-session membership instead of replacing another CPU or changing nickname', () => {
    const room = solo(); const id = join(room), events = room.events.length;
    expect(join(room, 'new-human', 'Changed Name')).toBe(id);
    expect(room.events).toHaveLength(events); expect(cpuIds(room)).toHaveLength(2);
    expect(room.members.find(m => m.id === id)!.nickname).toBe('New Human');
    const spectatorRoom = lobby(); act(spectatorRoom, 'human', { type: 'set_role', targetId: 'human', role: 'spectator' });
    act(spectatorRoom, 'human', { type: 'add_cpu' });
    expect(addMember(spectatorRoom, { id: 'unused', sessionId: 'human-session', nickname: 'Changed' }, NOW)).toBe('human');
    expect(cpuIds(spectatorRoom)).toHaveLength(1); expect(spectatorRoom.members[0]!.role).toBe('spectator');
  });

  it('never replaces a disconnected human, removed CPU or withdrawn game Subject', () => {
    const room = solo(); const first = cpuIds(room)[0]!;
    room.game!.subjects[first]!.withdrawn = true;
    const second = cpuIds(room)[1]!; room.members.find(m => m.id === second)!.removed = true;
    const available = cpuIds(room).find(id => id !== first)!;
    expect(join(room)).toBe(available); expect(room.members[0]!.id).toBe('human');
    expect(room.members[0]!.sessionId).toBe('human-session');
    const watcher = join(room, 'later-session', 'Later'); expect(room.members.find(m => m.id === watcher)!.role).toBe('spectator');
  });

  it('keeps CPU chat attribution when a human inherits the seat, including final statements', () => {
    const room = solo(); const id = cpuIds(room)[0]!, nickname = room.members.find(m => m.id === id)!.nickname;
    act(room, id, { type: 'chat', text: 'A CPU message.' }); join(room);
    expect(projectRoom(room, 'human').chat[0]!.nickname).toBe(nickname);
    const statementRoom = solo(); ordinaryRound(statementRoom); ordinaryRound(statementRoom);
    const speaker = cpuIds(statementRoom)[0]!; act(statementRoom, 'human', { type: 'statement', text: 'Human statement.' });
    expect(statementRoom.game!.phase.speakerId).toBe(speaker);
    const originalName = statementRoom.members.find(m => m.id === speaker)!.nickname;
    act(statementRoom, speaker, { type: 'statement', text: 'CPU statement.' }); join(statementRoom);
    expect(projectRoom(statementRoom, 'human').chat.find(m => m.text === 'CPU statement.')!.nickname).toBe(originalName);
  });

  it('refuses postgame takeovers after abort and resets CPU/human readiness for settings and rematches', () => {
    const room = solo(); until(room, 'decision'); const id = cpuIds(room)[0]!, original = structuredClone(room.game!.subjects[id]!);
    act(room, 'human', { type: 'end' }); const watcher = join(room); expect(watcher).not.toBe(id);
    expect(room.members.find(m => m.id === watcher)!.role).toBe('spectator'); expect(projectRoom(room, watcher).me).toBeNull();
    expect(room.game!.subjects[id]!.directive).toEqual(original.directive); expect(room.game!.outcome).toBe('aborted');
    expect(projectRoom(room, 'human').game!.fullReveal).toEqual([]);
    act(room, 'human', { type: 'settings', settings: { ...room.settings, rounds: 5 } });
    expect(room.members.filter(isCpuMember).every(m => m.ready)).toBe(true);
    expect(room.members.filter(m => !isCpuMember(m)).every(m => !m.ready)).toBe(true);
    act(room, 'human', { type: 'rematch' }); expect(room.status).toBe('lobby');
    expect(room.members.filter(isCpuMember).every(m => m.ready)).toBe(true);
    expect(room.members.find(m => m.id === watcher)!.ready).toBe(false);
  });

  it('treats persisted members without controller fields as humans and preserves removed-session bans', () => {
    const room = lobby(); delete room.members[0]!.controller;
    expect(isCpuMember(room.members[0]!)).toBe(false);
    expect(projectRoom(room, 'human').members[0]!.controller).toBe('human');
    act(room, 'human', { type: 'ready', ready: true }); act(room, 'human', { type: 'start' });
    const removed = join(room); act(room, 'human', { type: 'remove', targetId: removed });
    expectCode(() => join(room), 'REMOVED'); expect(cpuIds(room)).toHaveLength(2);
    room.status = 'closed'; expectCode(() => join(room, 'closed-session'), 'ROOM_CLOSED');
  });
});
