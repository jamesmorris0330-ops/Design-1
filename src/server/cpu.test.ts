import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Action, type RoomSettings } from '../shared/protocol.js';
import { addMember, applyCommand, createRoom, projectRoom, type Room } from './engine.js';
import { runCpuPlayers } from './cpu.js';

const NOW = 1_000;
function act(room: Room, id: string, action: Action, now = NOW): void {
  applyCommand(room, id, { commandId: randomUUID(), gameId: room.game?.id ?? null, phaseId: room.game?.phase.id ?? null, action }, now);
}
function setup(cpuIds = ['p2', 'p3', 'p4'], settings: Partial<RoomSettings> = {}): Room {
  const room = createRoom('CPUTEST', { id: 'p1', sessionId: 'session1', nickname: 'Human' }, { ...DEFAULT_SETTINGS, extensions: false, ...settings }, NOW);
  for (let n = 2; n <= 4; n++) addMember(room, { id: `p${n}`, sessionId: `session${n}`, nickname: `Subject ${n}` }, NOW);
  for (const member of room.members) act(room, member.id, { type: 'ready', ready: true });
  for (const member of room.members) member.controller = cpuIds.includes(member.id) ? 'cpu' : 'human';
  act(room, 'p1', { type: 'start' });
  return room;
}
function until(room: Room, type: string): void {
  for (let n = 0; room.game!.phase.type !== type && n < 100; n++) act(room, 'p1', { type: 'advance' });
  expect(room.game!.phase.type).toBe(type);
}
function due(room: Room): number { return room.game!.phase.openedAt + 5_001; }
function finishOrdinary(room: Room): void {
  while (!['final_interrogation', 'extension_offer'].includes(room.game!.phase.type)) {
    until(room, 'decision');
    // These preparations exercise the existing rules; the CPU assertions below
    // are made only in the specific phase under test.
    for (const id of [...room.game!.phase.eligibleIds]) act(room, id, { type: 'decision', allocation: { medical: 1, security: 1, reserve: 1 } });
    until(room, 'vote');
    for (const id of [...room.game!.phase.eligibleIds]) act(room, id, { type: 'vote', targetId: null });
    until(room, 'dossier'); act(room, 'p1', { type: 'advance' });
  }
}
function finalChoice(room: Room): void {
  finishOrdinary(room);
  while (room.game!.phase.type === 'final_interrogation') act(room, room.game!.phase.speakerId!, { type: 'statement', text: 'We must survive.' });
  act(room, 'p1', { type: 'advance' });
  expect(room.game!.phase.type).toBe('final_choice');
}

describe('server CPU Subjects', () => {
  it('waits for its deterministic phase delay, submits a real valid allocation, and never re-locks it', () => {
    const room = setup(); until(room, 'decision');
    const opened = room.game!.phase.openedAt;
    expect(runCpuPlayers(room, opened + 1_999)).toBe(false);
    expect(Object.values(room.game!.subjects).every(subject => subject.allocation === null)).toBe(true);
    expect(runCpuPlayers(room, due(room))).toBe(true);
    expect(room.game!.subjects.p1!.allocation).toBeNull();
    for (const id of ['p2', 'p3', 'p4']) {
      const allocation = room.game!.subjects[id]!.allocation!;
      expect(allocation.medical + allocation.security + allocation.reserve).toBe(3);
      expect(Object.values(allocation).every(value => Number.isInteger(value) && value >= 0)).toBe(true);
    }
    const locked = structuredClone(room.game!.subjects.p2!.allocation);
    expect(runCpuPlayers(room, due(room) + 1_000)).toBe(false);
    expect(room.game!.subjects.p2!.allocation).toEqual(locked);
    const restored: Room = JSON.parse(JSON.stringify(room));
    expect(runCpuPlayers(restored, due(restored) + 2_000)).toBe(false);
  });

  it('stops while paused and immediately stops controlling a reclaimed Subject', () => {
    const room = setup(['p2']); until(room, 'decision');
    act(room, 'p1', { type: 'pause' });
    expect(runCpuPlayers(room, due(room))).toBe(false);
    expect(room.game!.subjects.p2!.allocation).toBeNull();
    act(room, 'p1', { type: 'resume' });
    room.members.find(member => member.id === 'p2')!.controller = 'human';
    expect(runCpuPlayers(room, due(room))).toBe(false);
    expect(room.game!.subjects.p2!.allocation).toBeNull();
  });

  it('uses public survival risk and its own restriction rather than inventing invalid or zero-resource responses', () => {
    const room = setup(['p2']); until(room, 'decision');
    room.game!.stabilityTicks = 40 * room.game!.startingSubjectCount;
    const subject = room.game!.subjects.p2!;
    subject.medicalMinimum = 1;
    subject.directive = { id: randomUUID(), kind: 'reserve3', title: 'Retention', instruction: 'Keep all 3 units in Reserve.', reward: 3 };
    expect(runCpuPlayers(room, due(room))).toBe(true);
    expect(subject.allocation).toEqual({ medical: 1, security: 1, reserve: 1 });
  });

  it('obeys Medical restrictions even when its own directive rewards keeping resources back', () => {
    const room = setup(['p2']); until(room, 'decision');
    room.game!.stabilityTicks = 100 * room.game!.startingSubjectCount;
    const subject = room.game!.subjects.p2!;
    subject.medicalMinimum = 1;
    subject.directive = { id: randomUUID(), kind: 'reserve2', title: 'Reserve', instruction: 'Keep at least 2 units in Reserve.', reward: 3 };
    expect(runCpuPlayers(room, due(room))).toBe(true);
    expect(subject.allocation!.medical).toBeGreaterThanOrEqual(1);
    expect(Object.values(subject.allocation!).reduce((sum, value) => sum + value, 0)).toBe(3);
  });

  it('never acts for removed, spectator, or ineligible CPU memberships', () => {
    const room = setup(); until(room, 'decision');
    room.members.find(member => member.id === 'p2')!.removed = true;
    room.members.find(member => member.id === 'p3')!.role = 'spectator';
    room.game!.phase.eligibleIds = ['p1', 'p2', 'p3'];
    expect(runCpuPlayers(room, due(room))).toBe(false);
    expect(Object.values(room.game!.subjects).every(subject => subject.allocation === null)).toBe(true);
  });

  it('cannot see other Subjects secret directives, scores, histories, or locked decisions', () => {
    const room = setup(['p2']); until(room, 'decision');
    const changed = structuredClone(room);
    for (const id of ['p1', 'p3', 'p4']) {
      const other = changed.game!.subjects[id]!;
      other.compliance = 999; other.requirement = 1;
      other.directive = { id: `secret-${id}`, kind: 'reserve3', title: 'Secret', instruction: 'Keep all 3 units in Reserve.', reward: 3 };
      other.allocation = { medical: 0, security: 0, reserve: 3 };
      other.dossier.push({ id: `private-${id}`, round: 1, kind: 'secret', text: 'UNAVAILABLE TO CPU', at: NOW });
    }
    expect(projectRoom(changed, 'p2')).toEqual(projectRoom(room, 'p2'));
    runCpuPlayers(room, due(room)); runCpuPlayers(changed, due(changed));
    expect(changed.game!.subjects.p2!.allocation).toEqual(room.game!.subjects.p2!.allocation);
  });

  it('sends at most one discussion message per phase across restarts and chat truncation', () => {
    const room = setup(['p2']); until(room, 'discussion');
    expect(runCpuPlayers(room, due(room))).toBe(true);
    expect(room.chat.filter(message => message.senderId === 'p2')).toHaveLength(1);
    const restored: Room = JSON.parse(JSON.stringify(room));
    expect(runCpuPlayers(restored, due(restored) + 1_000)).toBe(false);
    restored.chat = [];
    expect(runCpuPlayers(restored, due(restored) + 2_000)).toBe(false);
    expect(JSON.stringify(projectRoom(restored, 'p1'))).not.toContain('cpuLastDiscussionPhase');
  });

  it('respects public chat mute and makes no actions in passive phases or expired ordinary phases', () => {
    const room = setup();
    expect(runCpuPlayers(room, due(room))).toBe(false);
    until(room, 'discussion'); room.chatMuted = true;
    expect(runCpuPlayers(room, due(room))).toBe(false); expect(room.chat).toHaveLength(0);
    until(room, 'decision');
    expect(runCpuPlayers(room, room.game!.phase.deadline!)).toBe(false);
    expect(Object.values(room.game!.subjects).every(subject => subject.allocation === null)).toBe(true);
  });

  it('casts non-self ballots using public records and does not react to other private state', () => {
    const room = setup(['p2']); until(room, 'vote');
    const changed = structuredClone(room);
    changed.game!.subjects.p3!.compliance = 999;
    changed.game!.subjects.p3!.directive = { id: 'private', kind: 'reserve3', title: 'Private', instruction: 'Keep all 3 units in Reserve.', reward: 3 };
    runCpuPlayers(room, due(room)); runCpuPlayers(changed, due(changed));
    const ballot = room.game!.subjects.p2!.ballot;
    expect(ballot).not.toBe('p2'); expect(room.game!.phase.eligibleIds).toContain(ballot);
    expect(changed.game!.subjects.p2!.ballot).toBe(ballot);
    expect(runCpuPlayers(room, due(room) + 1_000)).toBe(false);
  });

  it('votes on extensions without changing targets or bypassing the existing majority rule', () => {
    const room = setup(['p2', 'p3', 'p4'], { extensions: true }); finishOrdinary(room);
    const requirements = Object.values(room.game!.subjects).map(subject => subject.requirement);
    for (const id of ['p2', 'p3', 'p4']) room.game!.subjects[id]!.compliance = 0;
    act(room, 'p1', { type: 'extension', additionalRounds: 1 });
    expect(runCpuPlayers(room, due(room))).toBe(true);
    expect(room.game!.plannedTotalRounds).toBe(3); // human ballot still awaited
    expect(Object.values(room.game!.extension!.ballots)).toEqual([true, true, true]);
    act(room, 'p1', { type: 'extension_vote', yes: false }, due(room));
    expect(room.game!.plannedTotalRounds).toBe(4);
    expect(Object.values(room.game!.subjects).map(subject => subject.requirement)).toEqual(requirements);
  });

  it('delivers its final statement only on its turn and stops when the next phase opens', () => {
    const room = setup(); finishOrdinary(room);
    expect(runCpuPlayers(room, due(room))).toBe(false);
    act(room, 'p1', { type: 'statement', text: 'Protect the group.' });
    const oldPhase = room.game!.phase.id;
    expect(runCpuPlayers(room, due(room))).toBe(true);
    expect(room.game!.phase.id).not.toBe(oldPhase);
    expect(room.game!.subjects.p2!.statement).toBeTruthy();
    expect(room.game!.subjects.p3!.statement).toBeNull();
    expect(room.game!.phase.speakerId).toBe('p3');
    expect(runCpuPlayers(room, room.game!.phase.openedAt + 1_999)).toBe(false);
  });

  it('makes real final choices after the warning deadline and uses its own directive and shared Stability', () => {
    const room = setup(); finalChoice(room);
    room.game!.stabilityTicks = 100 * room.game!.startingSubjectCount;
    room.game!.subjects.p2!.directive = { id: 'self', kind: 'self', title: 'Self', instruction: 'Choose Protect Yourself.', reward: 3 };
    room.game!.subjects.p2!.compliance = 0;
    room.game!.subjects.p3!.directive = { id: 'group', kind: 'group', title: 'Group', instruction: 'Choose Protect the Group.', reward: 3 };
    room.game!.subjects.p4!.directive = { id: 'self-qualified', kind: 'self', title: 'Self', instruction: 'Choose Protect Yourself.', reward: 3 };
    room.game!.subjects.p4!.compliance = room.game!.subjects.p4!.requirement;
    expect(runCpuPlayers(room, room.game!.phase.deadline! + 1_000)).toBe(true);
    expect(room.game!.subjects.p2!.finalChoice).toBe('self');
    expect(room.game!.subjects.p3!.finalChoice).toBe('group');
    expect(room.game!.subjects.p4!.finalChoice).toBe('group');
    expect(room.game!.phase.type).toBe('final_choice');
    act(room, 'p1', { type: 'final_choice', choice: 'group' }, room.game!.phase.deadline! + 1_000);
    expect(room.game!.phase.type).toBe('final_resolution');
    expect(room.game!.finalCounts).toMatchObject({ group: 3, self: 1, delta: 0 });
    expect(runCpuPlayers(room, due(room))).toBe(false);
  });
});
