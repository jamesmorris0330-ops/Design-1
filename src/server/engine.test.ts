import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type Action, type CommandEnvelope, type RoomSettings } from '../shared/protocol.js';
import { addMember, applyCommand, createRoom, EngineError, projectRoom, tick, type Room } from './engine.js';

const NOW = 1_000;
const balanced = { medical: 1, security: 1, reserve: 1 };
function envelope(room: Room, action: Action): CommandEnvelope { return { commandId: randomUUID(), gameId: room.game?.id ?? null, phaseId: room.game?.phase.id ?? null, action }; }
function act(room: Room, actor: string, action: Action, now = NOW): void { applyCommand(room, actor, envelope(room, action), now); }
function setup(count = 4, settings: Partial<RoomSettings> = {}): Room {
  const room = createRoom('ABC123', { id: 'p1', sessionId: 's1', nickname: 'Alpha' }, { ...DEFAULT_SETTINGS, extensions: false, ...settings }, NOW);
  for (let n = 2; n <= count; n++) addMember(room, { id: `p${n}`, sessionId: `s${n}`, nickname: `Player ${n}` }, NOW);
  for (const m of room.members) act(room, m.id, { type: 'ready', ready: true });
  act(room, 'p1', { type: 'start' }); return room;
}
function until(room: Room, type: string): void {
  for (let n = 0; room.game?.phase.type !== type && n < 100; n++) act(room, room.hostId, { type: 'advance' });
  expect(room.game?.phase.type).toBe(type);
}
function resolveBalancedRound(room: Room): void {
  until(room, 'decision');
  for (const id of [...room.game!.phase.eligibleIds]) if (!room.game!.subjects[id]!.withdrawn) act(room, id, { type: 'decision', allocation: balanced });
  until(room, 'vote');
  for (const id of [...room.game!.phase.eligibleIds]) act(room, id, { type: 'vote', targetId: id === 'p1' ? 'p2' : 'p1' });
  until(room, 'dossier');
  act(room, room.hostId, { type: 'advance' });
}
function finishOrdinary(room: Room): void { while (room.game!.round < room.game!.plannedTotalRounds - 1 || !['final_interrogation', 'extension_offer'].includes(room.game!.phase.type)) { resolveBalancedRound(room); if (room.game!.phase.type === 'final_interrogation' || room.game!.phase.type === 'extension_offer') break; } }
function enterFinalChoice(room: Room): void {
  until(room, 'final_interrogation');
  while (room.game!.phase.type === 'final_interrogation') {
    const speaker = room.game!.phase.speakerId!;
    act(room, speaker, { type: 'statement', text: `Statement from ${speaker}` });
  }
  expect(room.game!.phase.type).toBe('final_directive');
  act(room, room.hostId, { type: 'advance' });
}
function finishAllGroup(room: Room): void {
  enterFinalChoice(room);
  for (const id of [...room.game!.phase.eligibleIds]) act(room, id, { type: 'final_choice', choice: 'group' });
  expect(room.game!.phase.type).toBe('final_resolution');
  until(room, 'full_reveal');
}
function expectCode(fn: () => unknown, code: string): void {
  try { fn(); throw new Error('Expected engine rejection.'); } catch (error) { expect(error).toBeInstanceOf(EngineError); expect((error as EngineError).code).toBe(code); }
}

describe('server-authoritative engine', () => {
  it('requires human readiness and preserves session identity on repeated joins', () => {
    const room = createRoom('ABC123', { id: 'p1', sessionId: 's1', nickname: 'Alpha' }, DEFAULT_SETTINGS, NOW);
    expectCode(() => act(room, 'p1', { type: 'start' }), 'NOT_READY');
    for (let n = 2; n <= 4; n++) addMember(room, { id: `p${n}`, sessionId: `s${n}`, nickname: `Player ${n}` }, NOW);
    expectCode(() => act(room, 'p1', { type: 'start' }), 'NOT_READY');
    addMember(room, { id: 'different-id', sessionId: 's2', nickname: 'Imposter' }, NOW);
    expect(room.members).toHaveLength(4); expect(room.members[1]!.nickname).toBe('Player 2');
    expectCode(() => createRoom('BAD', { id: 'p', sessionId: 's', nickname: 'A' }, { ...DEFAULT_SETTINGS, rounds: 20, roundCap: 15 }, NOW), 'BAD_SETTINGS');
  });

  it('keeps directives, decisions, ballots, credentials, and canonical revisions out of other projections', () => {
    const room = setup(); until(room, 'decision');
    const before = projectRoom(room, 'p2');
    act(room, 'p1', { type: 'decision', allocation: { medical: 0, security: 0, reserve: 3 } });
    expect(projectRoom(room, 'p2')).toEqual(before);
    expect(projectRoom(room, 'p1').me!.decisionSubmitted).toBe(true);
    const serialized = JSON.stringify(projectRoom(room, 'p2'));
    expect(serialized).not.toContain('sessionId'); expect(serialized).not.toContain('s1');
    expect(serialized).not.toContain(room.game!.subjects.p1!.directive!.id);
    expect(serialized).not.toContain('stabilityTicks'); expect(serialized).not.toContain('subjects');
    expect(projectRoom(room, 'p1').game!.results).toEqual([]);
    for (const id of ['p2', 'p3', 'p4']) act(room, id, { type: 'decision', allocation: balanced });
    until(room, 'vote');
    const publicBefore = projectRoom(room, 'p2');
    act(room, 'p1', { type: 'vote', targetId: 'p2' });
    expect(projectRoom(room, 'p2')).toEqual(publicBefore);
    expect(projectRoom(room, 'p1').me!.voteSubmitted).toBe(true);
  });

  it('admits late arrivals as spectators without private state and promotes them only between matches', () => {
    const room = setup();
    addMember(room, { id: 'watcher', sessionId: 'watch-session', nickname: 'Watcher' }, NOW);
    const view = projectRoom(room, 'watcher'); expect(view.me).toBeNull();
    expect(view.members.find(m => m.id === 'watcher')!.role).toBe('spectator');
    expectCode(() => act(room, 'watcher', { type: 'decision', allocation: balanced }), 'SUBJECT_ONLY');
    expectCode(() => act(room, 'p1', { type: 'set_role', targetId: 'watcher', role: 'subject' }), 'BAD_STATE');
    act(room, 'p1', { type: 'end' }); act(room, 'p1', { type: 'set_role', targetId: 'watcher', role: 'subject' });
    expect(room.members.find(m => m.id === 'watcher')!.role).toBe('subject');
  });

  it('serializes all locked allocations atomically, rejects stale phases and duplicate decisions, and applies exact thresholds', () => {
    const room = setup(); until(room, 'decision');
    const late = envelope(room, { type: 'decision', allocation: balanced });
    act(room, 'p1', { type: 'decision', allocation: balanced });
    expectCode(() => act(room, 'p1', { type: 'decision', allocation: balanced }), 'ALREADY_LOCKED');
    expect(room.game!.stabilityTicks).toBe(240);
    for (const id of ['p2', 'p3', 'p4']) act(room, id, { type: 'decision', allocation: balanced });
    expect(room.game!.phase.type).toBe('reveal'); expect(room.game!.stabilityTicks).toBe(320);
    expect(room.game!.trial!.totals).toEqual({ medical: 4, security: 4, reserve: 4 });
    expectCode(() => applyCommand(room, 'p2', late, NOW), 'STALE_PHASE');
    expectCode(() => act(room, 'p1', { type: 'decision', allocation: { medical: 3, security: 3, reserve: 3 } }), 'BAD_PHASE');
  });

  it('times out ordinary missing responses with zero contribution and no invented reward', () => {
    const room = setup(); until(room, 'decision');
    const s = room.game!.subjects.p1!;
    s.directive = { id: 'zero-medical', kind: 'medical0', title: 'Withhold', instruction: 'Allocate no Medical.', reward: 3 };
    const deadline = room.game!.phase.deadline!;
    expect(tick(room, deadline - 1)).toBe(false); expect(tick(room, deadline)).toBe(true);
    expect(s.compliance).toBe(0); expect(s.history[0]!.allocation).toBeNull(); expect(s.history[0]!.completed).toBe(false);
    expect(room.game!.stabilityTicks).toBe(120);
    expect(room.game!.trial!.totals).toEqual({ medical: 0, security: 0, reserve: 0 });
  });

  it('publishes Exposure only after voting resolves and honors ballot ties without scoring', () => {
    const room = setup(); until(room, 'decision');
    for (const id of ['p1', 'p2', 'p3', 'p4']) act(room, id, { type: 'decision', allocation: balanced });
    until(room, 'vote'); const exposed = room.game!.subjects.p2!.directive!;
    act(room, 'p1', { type: 'vote', targetId: 'p2' });
    expect(projectRoom(room, 'p3').events.some(e => e.detail.includes(exposed.instruction))).toBe(false);
    act(room, 'p2', { type: 'vote', targetId: 'p1' }); act(room, 'p3', { type: 'vote', targetId: 'p2' }); act(room, 'p4', { type: 'vote', targetId: 'p2' });
    expect(projectRoom(room, 'p3').events.some(e => e.detail.includes(`Exposed directive: ${exposed.instruction}`))).toBe(true);
    until(room, 'decision'); for (const id of ['p1', 'p2', 'p3', 'p4']) act(room, id, { type: 'decision', allocation: balanced });
    until(room, 'vote'); const scores = Object.values(room.game!.subjects).map(s => s.compliance);
    for (const [actor, target] of [['p1', 'p2'], ['p2', 'p1'], ['p3', 'p1'], ['p4', 'p2']]) act(room, actor!, { type: 'vote', targetId: target! });
    expect(room.game!.trial!.voteTied).toBe(true); expect(room.game!.trial!.voteWinner).toBeNull();
    expect(Object.values(room.game!.subjects).map(s => s.compliance)).toEqual(scores);
    expect(room.game!.subjects.p1!.trustVotes).toBe(2); expect(room.game!.subjects.p2!.trustVotes).toBe(2);
  });

  it('enforces a next-Trial Medical restriction and never assigns an impossible restricted directive', () => {
    const room = setup(4, { rounds: 5 });
    resolveBalancedRound(room); until(room, 'decision');
    for (const id of ['p1', 'p2', 'p3', 'p4']) act(room, id, { type: 'decision', allocation: balanced });
    until(room, 'vote'); expect(room.game!.trial!.voteType).toBe('restriction');
    for (const id of ['p1', 'p2', 'p3', 'p4']) act(room, id, { type: 'vote', targetId: id === 'p2' ? 'p1' : 'p2' });
    until(room, 'decision'); const subject = room.game!.subjects.p2!;
    expect(subject.medicalMinimum).toBe(1); expect(['medical0', 'reserve3']).not.toContain(subject.directive!.kind);
    expectCode(() => act(room, 'p2', { type: 'decision', allocation: { medical: 0, security: 3, reserve: 0 } }), 'BAD_ALLOCATION');
    act(room, 'p2', { type: 'decision', allocation: { medical: 1, security: 0, reserve: 2 } });
  });

  it('supports majority-consented extensions without leaking consent, altering scores, or raising initial targets', () => {
    const room = setup(4, { extensions: true }); finishOrdinary(room);
    expect(room.game!.phase.type).toBe('extension_offer');
    const oldId = room.game!.id, scores = Object.values(room.game!.subjects).map(s => s.compliance);
    act(room, 'p1', { type: 'extension', additionalRounds: 2 });
    const before = projectRoom(room, 'p2'); act(room, 'p1', { type: 'extension_vote', yes: true });
    expect(projectRoom(room, 'p2')).toEqual(before);
    for (const id of ['p2', 'p3']) act(room, id, { type: 'extension_vote', yes: true });
    expect(room.game!.plannedTotalRounds).toBe(3);
    act(room, 'p4', { type: 'extension_vote', yes: false });
    expect(room.game!.id).toBe(oldId); expect(room.game!.plannedTotalRounds).toBe(5); expect(room.game!.round).toBe(3);
    expect(Object.values(room.game!.subjects).map(s => s.compliance)).toEqual(scores);
    expect(Object.values(room.game!.subjects).every(s => s.requirement === 5)).toBe(true);
    expect(room.game!.extensionHistory[0]).toMatchObject({ yes: 3, no: 1, accepted: true });
    finishOrdinary(room); expect(room.game!.phase.type).toBe('extension_offer');
    act(room, 'p1', { type: 'continue' }); expect(room.game!.round).toBe(5);
    expectCode(() => act(room, 'p1', { type: 'extension', additionalRounds: 1 }), 'BAD_PHASE');
  });

  it('counts missing continuation ballots as no and retains the frozen denominator after removal', () => {
    const room = setup(5, { extensions: true }); finishOrdinary(room);
    act(room, 'p1', { type: 'extension', additionalRounds: 1 });
    act(room, 'p1', { type: 'extension_vote', yes: true }); act(room, 'p2', { type: 'extension_vote', yes: true });
    act(room, 'p3', { type: 'extension_vote', yes: false }); act(room, 'p4', { type: 'extension_vote', yes: false });
    act(room, 'p1', { type: 'remove', targetId: 'p5' });
    expect(room.game!.phase.type).toBe('final_interrogation'); expect(room.game!.plannedTotalRounds).toBe(3);
    expect(room.game!.extensionHistory[0]).toMatchObject({ yes: 2, no: 3, accepted: false });
  });

  it('bounds repeated extension checkpoints at the frozen cap and commits each accepted proposal once', () => {
    const room = setup(8, { extensions: true, roundCap: 15 });
    for (const extra of [5, 5, 2] as const) {
      finishOrdinary(room); expect(room.game!.phase.type).toBe('extension_offer');
      if (room.game!.plannedTotalRounds === 13) expectCode(() => act(room, 'p1', { type: 'extension', additionalRounds: 5 }), 'BAD_EXTENSION');
      const proposed = envelope(room, { type: 'extension', additionalRounds: extra });
      applyCommand(room, 'p1', proposed, NOW);
      expectCode(() => applyCommand(room, 'p1', proposed, NOW), 'STALE_PHASE');
      for (const id of ['p1', 'p2', 'p3', 'p4', 'p5']) act(room, id, { type: 'extension_vote', yes: true });
      expect(room.game!.phase.type).toBe('extension_vote'); // Pending submissions remain undisclosed.
      expect(tick(room, room.game!.phase.deadline!)).toBe(true);
    }
    expect(room.game!.plannedTotalRounds).toBe(15); expect(room.game!.initialRoundCount).toBe(3);
    expect(room.game!.extensionHistory).toHaveLength(3); expect(room.game!.extensionHistory.every(e => e.yes === 5 && e.no === 3)).toBe(true);
    expect(Object.values(room.game!.subjects).every(s => s.requirement === 5)).toBe(true);
    finishOrdinary(room); expect(room.game!.phase.type).toBe('final_interrogation');
    finishAllGroup(room); expect(room.game!.round).toBe(15); expect(room.game!.publicEvents.filter(e => e.kind === 'final_resolution')).toHaveLength(1);
  });

  it('retains complete private allocation history and reconciles every dossier score change through the finale', () => {
    const room = setup(4, { rounds: 5 }); finishOrdinary(room); finishAllGroup(room);
    for (const id of ['p1', 'p2', 'p3', 'p4']) {
      const own = projectRoom(room, id).me!;
      expect(own.dossier.reduce((sum, entry) => sum + entry.complianceDelta, 0)).toBe(own.compliance);
      const resolutions = own.dossier.filter(entry => entry.title === 'Resolution');
      expect(resolutions).toHaveLength(4);
      expect(resolutions.every(entry => entry.text.includes('Medical 1, Security 1, Reserve 1') && entry.text.includes('Group Stability:'))).toBe(true);
      expect(own.dossier.find(entry => entry.title === 'Final Resolution')!.text).toContain('Protect the Group');
    }
  });

  it('restores authoritative deadlines and pauses after JSON persistence without resolving a phase twice', () => {
    const room = setup(); until(room, 'decision');
    const resumed: Room = JSON.parse(JSON.stringify(room));
    const deadline = resumed.game!.phase.deadline!;
    expect(tick(resumed, deadline)).toBe(true); expect(tick(resumed, deadline)).toBe(false);
    expect(resumed.game!.publicEvents.filter(e => e.kind === 'resource_resolution')).toHaveLength(1);
    act(resumed, 'p1', { type: 'pause' }, deadline + 1_000);
    const paused: Room = JSON.parse(JSON.stringify(resumed));
    expect(tick(paused, deadline + 1_000_000)).toBe(false); expect(paused.game!.paused).toBe(true);
    act(paused, 'p1', { type: 'resume' }, deadline + 1_000_000);
    expect(paused.game!.phase.deadline).toBe(deadline + 1_011_000);
  });

  it('preserves frozen resource thresholds and committed inputs when a Subject is removed', () => {
    const room = setup(5); until(room, 'decision');
    act(room, 'p5', { type: 'decision', allocation: balanced }); act(room, 'p1', { type: 'remove', targetId: 'p5' });
    expect(room.game!.trial!.threshold).toBe(5); expect(room.game!.paused).toBe(false);
    for (const id of ['p1', 'p2', 'p3', 'p4']) act(room, id, { type: 'decision', allocation: balanced });
    expect(room.game!.trial!.totals).toEqual({ medical: 5, security: 5, reserve: 5 });
    expectCode(() => act(room, 'p5', { type: 'chat', text: 'Still here' }), 'NOT_MEMBER');
  });

  it('freezes timers while paused and pauses below four Subjects without permitting a partial resume', () => {
    const room = setup(); until(room, 'discussion');
    const deadline = room.game!.phase.deadline!;
    act(room, 'p1', { type: 'pause' }, 2_000); expect(tick(room, deadline + 10_000)).toBe(false);
    expectCode(() => act(room, 'p1', { type: 'advance' }), 'PAUSED');
    act(room, 'p1', { type: 'resume' }, 100_000); expect(room.game!.phase.deadline).toBe(100_000 + deadline - 2_000);
    act(room, 'p1', { type: 'remove', targetId: 'p4' });
    expect(room.game!.paused).toBe(true); expect(projectRoom(room, 'p1').game!.phase.pauseReason).toContain('Fewer than four');
    expectCode(() => act(room, 'p1', { type: 'resume' }), 'PLAYER_COUNT');
    act(room, 'p1', { type: 'end' }); expect(room.game!.outcome).toBe('aborted');
  });

  it('lets only the current host control phases, transfers host even while paused, and keeps score authority on the server', () => {
    const room = setup();
    expectCode(() => act(room, 'p2', { type: 'advance' }), 'HOST_ONLY');
    act(room, 'p1', { type: 'pause' }); act(room, 'p1', { type: 'transfer_host', targetId: 'p2' });
    expect(room.hostId).toBe('p2'); expectCode(() => act(room, 'p1', { type: 'resume' }), 'HOST_ONLY');
    act(room, 'p2', { type: 'resume' }); expect(room.game!.paused).toBe(false);
    expectCode(() => act(room, 'p2', { type: 'settings', settings: { ...DEFAULT_SETTINGS, rounds: 20 } }), 'BAD_STATE');
  });

  it('enforces one final statement turn per Subject and treats the choice deadline as a warning only', () => {
    const room = setup(); finishOrdinary(room);
    expect(room.game!.phase.speakerId).toBe('p1');
    expectCode(() => act(room, 'p2', { type: 'statement', text: 'Jump queue' }), 'NOT_YOUR_TURN');
    act(room, 'p1', { type: 'statement', text: 'I protect the group.' }); expect(room.game!.phase.speakerId).toBe('p2');
    const deadline = room.game!.phase.deadline!; expect(tick(room, deadline)).toBe(true); expect(room.game!.phase.speakerId).toBe('p3');
    until(room, 'final_choice');
    expect(tick(room, room.game!.phase.deadline! + 1_000_000)).toBe(false);
    expect(room.game!.phase.type).toBe('final_choice');
    expectCode(() => act(room, 'p1', { type: 'advance' }), 'FINALE_WAITING');
    expect(Object.values(room.game!.subjects).every(s => s.finalChoice === null)).toBe(true);
  });

  it('resolves the finale simultaneously with exact integer ticks and requires both survival and Compliance', () => {
    const room = setup(); finishOrdinary(room); enterFinalChoice(room);
    room.game!.stabilityTicks = 160; // Stability 40, two protectors / two selfish choices -> exactly zero.
    for (const s of Object.values(room.game!.subjects)) s.compliance = s.requirement;
    const phaseId = room.game!.phase.id;
    for (const [id, choice] of [['p1', 'group'], ['p2', 'group'], ['p3', 'self']] as const) act(room, id, { type: 'final_choice', choice });
    expect(room.game!.stabilityTicks).toBe(160); expect(room.game!.phase.id).toBe(phaseId);
    act(room, 'p4', { type: 'final_choice', choice: 'self' });
    expect(room.game!.stabilityTicks).toBe(0); expect(room.game!.outcome).toBe('failed');
    expect(room.game!.results.every(r => !r.qualified)).toBe(true);
    const score = room.game!.subjects.p4!.compliance;
    expectCode(() => act(room, 'p4', { type: 'final_choice', choice: 'self' }), 'BAD_PHASE');
    expect(room.game!.subjects.p4!.compliance).toBe(score);
  });

  it('reveals own qualification before full results, permits multiple winners and tied Trust ranks, and resets a rematch', () => {
    const room = setup(); finishOrdinary(room); enterFinalChoice(room);
    for (const [id, s] of Object.entries(room.game!.subjects)) { s.compliance = id === 'p4' ? 0 : s.requirement; s.directive = { id: randomUUID(), kind: 'group', title: 'Loyal', instruction: 'Choose Protect the Group.', reward: 3 }; }
    room.game!.subjects.p1!.trustVotes = 2; room.game!.subjects.p2!.trustVotes = 2; room.game!.subjects.p3!.trustVotes = 0; room.game!.subjects.p4!.trustVotes = 0;
    for (const id of ['p1', 'p2', 'p3', 'p4']) act(room, id, { type: 'final_choice', choice: 'group' });
    expect(projectRoom(room, 'p1').me!.result).toBeNull();
    act(room, 'p1', { type: 'advance' });
    const own = projectRoom(room, 'p1'); expect(own.me!.result!.qualified).toBe(true); expect(own.game!.results).toEqual([]); expect(own.game!.fullReveal).toEqual([]);
    act(room, 'p1', { type: 'advance' }); const full = projectRoom(room, 'p1');
    expect(full.game!.results.filter(r => r.qualified)).toHaveLength(3);
    expect(full.game!.results.filter(r => r.trustVotes === 2).every(r => r.trustRank === 1)).toBe(true);
    expect(full.game!.fullReveal).toHaveLength(12); expect(JSON.stringify(full)).not.toContain('sessionId');
    const oldId = room.game!.id; act(room, 'p1', { type: 'rematch' });
    expect(projectRoom(room, 'p1').game).toBeNull(); expect(room.pastGames[0]!.id).toBe(oldId);
    for (const m of room.members) act(room, m.id, { type: 'ready', ready: true }); act(room, 'p1', { type: 'start' });
    expect(room.game!.id).not.toBe(oldId); expect(Object.values(room.game!.subjects).every(s => s.compliance === 0 && s.dossier.length === 0)).toBe(true);
  });

  it('opens Full Reveal after early collapse but preserves unrevealed secrets on host abort', () => {
    const room = setup(); until(room, 'decision'); room.game!.stabilityTicks = 120;
    for (const id of ['p1', 'p2', 'p3', 'p4']) act(room, id, { type: 'decision', allocation: { medical: 0, security: 0, reserve: 3 } });
    expect(room.game!.phase.type).toBe('personal_results'); expect(room.game!.outcome).toBe('failed');
    act(room, 'p1', { type: 'advance' }); expect(projectRoom(room, 'p1').game!.fullReveal).toHaveLength(4);
    const aborted = setup(); until(aborted, 'decision'); const otherSecret = aborted.game!.subjects.p2!.directive!.id;
    act(aborted, 'p1', { type: 'end' }); const view = projectRoom(aborted, 'p1');
    expect(view.game!.phase.type).toBe('aborted'); expect(view.game!.results).toEqual([]); expect(view.game!.fullReveal).toEqual([]);
    expect(JSON.stringify(view)).not.toContain(otherSecret); expect(view.me!.dossier.length).toBeGreaterThan(0);
  });

  it.each([3, 4, 5, 7, 10, 15, 20])('plays a complete eight-Subject %i-round match with stable scoring and one finale', rounds => {
    const room = setup(8, { rounds }); finishOrdinary(room); finishAllGroup(room);
    expect(room.status).toBe('postgame'); expect(room.game!.round).toBe(rounds); expect(room.game!.outcome).toBe('survived');
    expect(Object.values(room.game!.subjects).every(s => s.history.length === rounds && s.requirement === Math.ceil(rounds * 1.5))).toBe(true);
    expect(room.game!.stabilityTicks).toBe(800);
    expect(room.game!.publicEvents.filter(e => e.kind === 'final_resolution')).toHaveLength(1);
    expect(room.game!.publicEvents.filter(e => e.kind === 'crisis')).toHaveLength(rounds - 1);
  });
});
