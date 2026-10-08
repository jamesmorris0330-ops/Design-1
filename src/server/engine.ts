import { randomUUID, randomInt } from 'node:crypto';
import type { CommandEnvelope, RoomSettings, RoomView, PersonalResult, RevealEntry } from '../shared/protocol.js';
import type { SurvivalAction, SurvivalWorld } from '../shared/survival.js';
import { addSurvivalPlayer, applySurvivalAction, createSurvivalWorld, projectSurvivalPlayer, projectSurvivalWorld, SurvivalError } from './survival.js';

/** Canonical records are server-only. projectRoom is the sole client boundary. */
export class EngineError extends Error {
  constructor(public code: string, message: string) { super(message); this.name = 'EngineError'; }
}
type PhaseType = 'crisis' | 'directive' | 'discussion' | 'decision' | 'reveal' | 'vote' | 'consequences' | 'dossier' | 'extension_offer' | 'extension_vote' | 'final_interrogation' | 'final_directive' | 'final_choice' | 'final_resolution' | 'personal_results' | 'full_reveal' | 'aborted';
type VoteType = 'exposure' | 'restriction' | 'trust';
type FinalChoice = 'group' | 'self';
type Allocation = { medical: number; security: number; reserve: number };
type Member = { id: string; sessionId: string; nickname: string; joinedAt: number; role: 'subject' | 'spectator'; ready: boolean; removed: boolean; controller?: 'human' | 'cpu'; cpuLastDiscussionPhase?: string; cpuReplyState?: { phaseId: string; repliedIds: string[]; count: number } };
type DirectiveKind = 'medical2' | 'security2' | 'reserve2' | 'medical0' | 'security0' | 'reserve3' | 'balanced' | 'both' | 'group' | 'self';
type Directive = { id: string; kind: DirectiveKind; title: string; instruction: string; reward: number };
type DossierEntry = { id: string; round: number; kind: string; text: string; at: number; data?: Record<string, unknown> };
type History = { round: number; directive: Directive; allocation: Allocation | null; completed: boolean; complianceAfter: number; medicalMinimum: number; finalChoice?: FinalChoice };
type Subject = { id: string; number: number; compliance: number; requirement: number; completedDirectives: number; trustVotes: number; withdrawn: boolean; pendingRestriction: boolean; medicalMinimum: number; directive: Directive | null; allocation: Allocation | null; ballot: string | null | undefined; finalChoice: FinalChoice | null; dossier: DossierEntry[]; history: History[]; statement: string | null };
type PublicEvent = { id: string; round: number; kind: string; text: string; at: number; data?: Record<string, unknown> };
type CanonicalEvent = PublicEvent & { visibility: 'public' | 'private'; ownerId?: string };
type Phase = { id: string; type: PhaseType; openedAt: number; deadline: number | null; eligibleIds: string[]; remainingMs: number | null; speakerId: string | null };
type Trial = { id: string; title: string; description: string; threshold: number; voteType: VoteType; totals: Allocation | null; delta: number | null; met: { medical: boolean; security: boolean } | null; votes: Record<string, string | null>; voteWinner: string | null; voteTied: boolean; voteResolved: boolean; exposure: { playerId: string; directive: Directive } | null };
type Extension = { id: string; addedRounds: number; fromRounds: number; toRounds: number; eligibleIds: string[]; ballots: Record<string, boolean>; yes: number | null; no: number | null; accepted: boolean | null };
type Result = { playerId: string; subjectNumber: number; compliance: number; requirement: number; qualified: boolean; completedDirectives: number; trustVotes: number; trustRank: number; classification: string; withdrawn: boolean };
export type Game = { id: string; initialRoundCount: number; plannedTotalRounds: number; maxRounds: number; extensionsEnabled: boolean; round: number; startingSubjectCount: number; stabilityTicks: number; phase: Phase; paused: boolean; pauseReason: string | null; subjects: Record<string, Subject>; trial: Trial | null; extension: Extension | null; extensionHistory: Extension[]; outcome: 'survived' | 'failed' | 'aborted' | null; results: Result[]; finalCounts: { group: number; self: number; delta: number } | null; publicEvents: PublicEvent[] };
export type Room = { id: string; code: string; hostId: string; settings: RoomSettings; status: 'lobby' | 'running' | 'postgame' | 'closed'; members: Member[]; game: Game | null; survival?: SurvivalWorld; pastGames: Game[]; chat: { id: string; senderId: string; nickname?: string; text: string; at: number; type: 'chat' | 'statement' }[]; events: CanonicalEvent[]; chatMuted: boolean };

const PHASE_DURATION: Partial<Record<PhaseType, number>> = { crisis: 8_000, directive: 15_000, discussion: 45_000, decision: 30_000, reveal: 12_000, vote: 30_000, consequences: 8_000, dossier: 15_000, extension_offer: 20_000, extension_vote: 30_000, final_directive: 15_000, final_choice: 30_000, final_resolution: 8_000, personal_results: 15_000 };
const CRISES = [
  { title: 'Containment Breach', description: 'The medical wing is losing pressure. Reinforce Medical and Security before the breach spreads.' },
  { title: 'Blackout Protocol', description: 'Emergency power is scarce. Medical support and secure infrastructure each need the group’s resources.' },
  { title: 'Quarantine Threshold', description: 'Protect the patients and secure the perimeter. Resources held in Reserve cannot prevent this crisis.' },
  { title: 'Oxygen Debt', description: 'Medical ventilation and Security containment compete for the remaining emergency supplies.' },
  { title: 'Signal Failure', description: 'Restore Medical monitoring and Security relays. Both systems must reach the required threshold.' },
  { title: 'Pressure Test', description: 'Medical and Security systems are close to failure. The Experiment is watching what you keep back.' },
];
const DIRECTIVES: Omit<Directive, 'id'>[] = [
  { kind: 'medical2', title: 'Medical Priority', instruction: 'Allocate at least 2 units to Medical.', reward: 2 },
  { kind: 'security2', title: 'Containment Order', instruction: 'Allocate at least 2 units to Security.', reward: 2 },
  { kind: 'reserve2', title: 'Personal Reserve', instruction: 'Keep at least 2 units in Reserve.', reward: 3 },
  { kind: 'medical0', title: 'Withhold Treatment', instruction: 'Allocate no units to Medical.', reward: 3 },
  { kind: 'security0', title: 'Open Perimeter', instruction: 'Allocate no units to Security.', reward: 3 },
  { kind: 'reserve3', title: 'Total Retention', instruction: 'Keep all 3 units in Reserve.', reward: 3 },
  { kind: 'balanced', title: 'Equal Distribution', instruction: 'Allocate exactly 1 unit to each system.', reward: 2 },
  { kind: 'both', title: 'Group Benchmark', instruction: 'Submit an allocation and have both Medical and Security reach their thresholds.', reward: 2 },
];

function fail(code: string, message: string): never { throw new EngineError(code, message); }
/** Missing controller fields belong to human members from releases before CPU support. */
export function isCpuMember(m: Pick<Room['members'][number], 'controller'>): boolean { return m.controller === 'cpu'; }
function member(room: Room, id: string): Member { return room.members.find(m => m.id === id && !m.removed) ?? fail('NOT_MEMBER', 'This membership is unavailable.'); }
function host(room: Room, id: string): void { if (room.hostId !== id) fail('HOST_ONLY', 'Only the current host can do that.'); }
function game(room: Room): Game { return room.game ?? fail('NO_GAME', 'There is no current Experiment.'); }
function subject(room: Room, id: string): Subject { const s = game(room).subjects[id]; if (!s || s.withdrawn) fail('SUBJECT_ONLY', 'Only an active Subject can do that.'); return s; }
function activeIds(g: Game): string[] { return Object.values(g.subjects).filter(s => !s.withdrawn).map(s => s.id); }
function publish(room: Room, kind: string, text: string, now: number, data?: Record<string, unknown>): void {
  const event: PublicEvent = { id: randomUUID(), round: room.game?.round ?? 0, kind, text, at: now, ...(data ? { data } : {}) };
  room.events.push({ ...event, visibility: 'public' });
  room.game?.publicEvents.push(event);
}
function dossier(room: Room, s: Subject, kind: string, text: string, now: number, data?: Record<string, unknown>): void {
  const entry: DossierEntry = { id: randomUUID(), round: game(room).round, kind, text, at: now, ...(data ? { data } : {}) };
  s.dossier.push(entry);
  room.events.push({ ...entry, visibility: 'private', ownerId: s.id });
}
function phase(room: Room, type: PhaseType, now: number, eligibleIds = activeIds(game(room))): void {
  const g = game(room);
  const duration = type === 'final_interrogation' ? 20_000 : PHASE_DURATION[type];
  g.phase = { id: randomUUID(), type, openedAt: now, deadline: duration == null ? null : now + duration, eligibleIds: [...eligibleIds], remainingMs: null, speakerId: type === 'final_interrogation' ? eligibleIds[0] ?? null : null };
  if (g.paused) { g.phase.remainingMs = duration ?? null; g.phase.deadline = null; }
}
function validSettings(settings: RoomSettings): void {
  const s = settings;
  if (!Number.isInteger(s.rounds) || s.rounds < 3 || s.rounds > 20 || ![15, 20].includes(s.roundCap) || s.rounds > s.roundCap) fail('BAD_SETTINGS', 'Choose 3–20 rounds within a cap of 15 or 20.');
}
export function createRoom(code: string, initial: { id: string; sessionId: string; nickname: string }, settings: RoomSettings, now: number): Room {
  validSettings(settings);
  return { id: randomUUID(), code, hostId: initial.id, settings: structuredClone(settings), status: 'lobby', members: [{ ...initial, joinedAt: now, role: 'subject', ready: false, removed: false, controller: 'human' }], game: null, pastGames: [], chat: [], events: [], chatMuted: false };
}
export function addMember(room: Room, joining: { id: string; sessionId: string; nickname: string }, now: number): string {
  if (room.status === 'closed') fail('ROOM_CLOSED', 'This room is closed.');
  const previous = room.members.find(m => m.sessionId === joining.sessionId);
  if (previous && !previous.removed) return previous.id;
  if (previous?.removed) fail('REMOVED', 'This session has been removed from the room.');
  const availableCpu = room.members.find(m => !m.removed && m.role === 'subject' && isCpuMember(m) && (room.status === 'lobby' || room.status === 'running' && (room.survival?.active && room.survival.players[m.id] || room.game && !room.game.outcome && room.game.subjects[m.id] && !room.game.subjects[m.id]!.withdrawn)));
  if (availableCpu) {
    const previousNickname = availableCpu.nickname;
    availableCpu.controller = 'human'; availableCpu.sessionId = joining.sessionId; availableCpu.nickname = joining.nickname; availableCpu.ready = false; availableCpu.joinedAt = now;
    const survivalPlayer = room.survival?.players[availableCpu.id];
    if (survivalPlayer) survivalPlayer.input = { moveX: 0, moveY: 0, aim: survivalPlayer.aim, fire: false, receivedAt: now };
    publish(room, 'cpu_takeover', room.survival ? `${joining.nickname} replaced ${previousNickname}. Position, equipment, supplies and progress are retained.` : `${joining.nickname} replaced ${previousNickname}. The same Subject, score and dossier are retained. Any already locked actions remain in force.`, now, { playerId: availableCpu.id, previousNickname, nickname: joining.nickname });
    const inheritedSubject = room.game?.subjects[availableCpu.id];
    if (inheritedSubject) dossier(room, inheritedSubject, 'cpu_seat_inherited', `You now control ${previousNickname}'s Subject. You inherit its private directive, score and dossier. Already locked choices remain locked; this handover does not change game mechanics.`, now);
    return availableCpu.id;
  }
  const settings = room.settings as unknown as { allowSpectators: boolean };
  const count = room.members.filter(m => !m.removed && m.role === 'subject').length;
  const isSpectator = count >= 8 || room.status !== 'lobby' && !(room.status === 'running' && room.survival?.active);
  if (isSpectator && !settings.allowSpectators) fail('SPECTATORS_DISABLED', 'Spectator admission is disabled.');
  room.members.push({ ...joining, joinedAt: now, role: isSpectator ? 'spectator' : 'subject', ready: false, removed: false, controller: 'human' });
  if (!isSpectator && room.survival) addSurvivalPlayer(room.survival, joining.id, now);
  publish(room, 'joined', `${joining.nickname} joined as ${isSpectator ? 'a spectator' : 'a Subject'}.`, now);
  return joining.id;
}
function addCpuMember(room: Room, now: number): Member {
  const count = room.members.filter(m => !m.removed && m.role === 'subject').length;
  if (count >= 8) fail('ROOM_FULL', 'At most 8 Subjects can participate.');
  let number = 1;
  while (room.members.some(m => !m.removed && m.nickname === `CPU ${number.toString().padStart(2, '0')}`)) number++;
  const cpu: Member = { id: randomUUID(), sessionId: `cpu:${randomUUID()}`, nickname: `CPU ${number.toString().padStart(2, '0')}`, joinedAt: now, role: 'subject', ready: true, removed: false, controller: 'cpu' };
  room.members.push(cpu);
  publish(room, 'cpu_added', `${cpu.nickname} joined as a CPU Subject. A joining player can take over this seat.`, now, { playerId: cpu.id });
  return cpu;
}
function shuffle<T>(items: T[]): T[] {
  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) { const j = randomInt(i + 1); [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]; }
  return shuffled;
}
function ballotFor(round: number, planned: number): VoteType {
  if (round === planned - 1) return 'trust';
  if (planned === 3) return 'exposure';
  if (planned === 5) return (['exposure', 'restriction', 'exposure', 'trust'] as VoteType[])[round - 1]!;
  if (planned === 7) return (['exposure', 'restriction', 'trust', 'restriction', 'exposure', 'trust'] as VoteType[])[round - 1]!;
  return (['exposure', 'restriction', 'trust'] as VoteType[])[(round - 1) % 3]!;
}
function startTrial(room: Room, now: number): void {
  const g = game(room);
  const ids = activeIds(g);
  const content = CRISES[(g.round - 1) % CRISES.length]!;
  g.trial = { id: randomUUID(), ...content, threshold: ids.length, voteType: ballotFor(g.round, g.plannedTotalRounds), totals: null, delta: null, met: null, votes: {}, voteWinner: null, voteTied: false, voteResolved: false, exposure: null };
  g.extension = null;
  for (const id of ids) {
    const s = g.subjects[id]!;
    s.medicalMinimum = s.pendingRestriction ? 1 : 0;
    s.pendingRestriction = false;
    s.directive = null; s.allocation = null; s.ballot = undefined;
  }
  phase(room, 'crisis', now, ids);
  publish(room, 'crisis', `Trial ${g.round}: ${content.title}`, now, { threshold: ids.length, voteType: g.trial.voteType });
}
function begin(room: Room, now: number): void {
  if (room.status !== 'lobby') fail('BAD_STATE', 'Return to the lobby before starting an Experiment.');
  validSettings(room.settings);
  const players = room.members.filter(m => !m.removed && m.role === 'subject');
  const humans = players.filter(m => !isCpuMember(m));
  if (!humans.length || players.length > 8) fail('PLAYER_COUNT', 'An Experiment requires at least one human Subject, with 4–8 total Subjects including CPUs.');
  if (humans.some(m => !m.ready)) fail('NOT_READY', 'Every human Subject must be ready.');
  while (players.length < 4) players.push(addCpuMember(room, now));
  players.forEach(m => { if (isCpuMember(m)) m.ready = true; });
  const settings = room.settings;
  const subjects: Record<string, Subject> = {};
  players.forEach((m, i) => { subjects[m.id] = { id: m.id, number: i + 1, compliance: 0, requirement: Math.ceil(settings.rounds * 1.5), completedDirectives: 0, trustVotes: 0, withdrawn: false, pendingRestriction: false, medicalMinimum: 0, directive: null, allocation: null, ballot: undefined, finalChoice: null, dossier: [], history: [], statement: null }; });
  room.game = { id: randomUUID(), initialRoundCount: settings.rounds, plannedTotalRounds: settings.rounds, maxRounds: settings.roundCap, extensionsEnabled: settings.extensions, round: 1, startingSubjectCount: players.length, stabilityTicks: 60 * players.length, phase: { id: '', type: 'crisis', openedAt: now, deadline: null, eligibleIds: [], remainingMs: null, speakerId: null }, paused: false, pauseReason: null, subjects, trial: null, extension: null, extensionHistory: [], outcome: null, results: [], finalCounts: null, publicEvents: [] };
  room.status = 'running';
  publish(room, 'started', 'THE EXPERIMENT has begun. There is no designated villain.', now);
  startTrial(room, now);
}
function assignDirectives(room: Room, now: number): void {
  const g = game(room);
  const bundle = shuffle(DIRECTIVES);
  for (const [index, id] of shuffle(activeIds(g)).entries()) {
    const s = g.subjects[id]!;
    let d = bundle[index % bundle.length]!;
    if (s.medicalMinimum > 0 && (d.kind === 'medical0' || d.kind === 'reserve3')) d = DIRECTIVES.find(x => x.kind === 'security0')!;
    s.directive = { ...d, id: randomUUID() };
    dossier(room, s, 'directive', d.instruction, now, { directive: s.directive });
  }
  phase(room, 'directive', now, g.phase.eligibleIds);
}
function completes(d: Directive, a: Allocation, met: { medical: boolean; security: boolean }): boolean {
  switch (d.kind) {
    case 'medical2': return a.medical >= 2;
    case 'security2': return a.security >= 2;
    case 'reserve2': return a.reserve >= 2;
    case 'medical0': return a.medical === 0;
    case 'security0': return a.security === 0;
    case 'reserve3': return a.reserve === 3;
    case 'balanced': return a.medical === 1 && a.security === 1 && a.reserve === 1;
    case 'both': return met.medical && met.security;
    default: return false;
  }
}
function finishResource(room: Room, now: number): void {
  const g = game(room), t = g.trial!;
  const totals = { medical: 0, security: 0, reserve: 0 };
  for (const id of g.phase.eligibleIds) { const a = g.subjects[id]!.allocation; if (a) { totals.medical += a.medical; totals.security += a.security; totals.reserve += a.reserve; } }
  const met = { medical: totals.medical >= t.threshold, security: totals.security >= t.threshold };
  const delta = (met.medical ? 10 : -15) + (met.security ? 10 : -15);
  t.totals = totals; t.met = met; t.delta = delta;
  const beforeStability = g.stabilityTicks / g.startingSubjectCount;
  g.stabilityTicks = Math.max(0, Math.min(100 * g.startingSubjectCount, g.stabilityTicks + delta * g.startingSubjectCount));
  for (const id of g.phase.eligibleIds) {
    const s = g.subjects[id]!;
    const completed = s.allocation != null && s.directive != null && completes(s.directive, s.allocation, met);
    if (completed) { s.compliance += s.directive!.reward; s.completedDirectives++; }
    if (s.directive) s.history.push({ round: g.round, directive: structuredClone(s.directive), allocation: s.allocation ? { ...s.allocation } : null, completed, complianceAfter: s.compliance, medicalMinimum: s.medicalMinimum });
    const responseText = s.allocation ? `Your allocation: Medical ${s.allocation.medical}, Security ${s.allocation.security}, Reserve ${s.allocation.reserve}. ${completed ? `Directive complete: +${s.directive!.reward} Compliance.` : 'Directive incomplete: no Compliance earned.'}` : 'No response: zero resources contributed, no Compliance earned.';
    dossier(room, s, 'resolution', `${responseText} Group Stability: ${beforeStability} → ${g.stabilityTicks / g.startingSubjectCount} (crisis rule ${delta >= 0 ? '+' : ''}${delta}, maximum 100).`, now, { allocation: s.allocation, completed, compliance: s.compliance, stabilityDelta: delta, complianceDelta: completed ? s.directive!.reward : 0 });
  }
  publish(room, 'resource_resolution', `Medical ${totals.medical}/${t.threshold}; Security ${totals.security}/${t.threshold}. Stability ${delta >= 0 ? '+' : ''}${delta}.`, now, { totals, met, delta });
  if (g.stabilityTicks <= 0) { finishGame(room, 'failed', now); return; }
  phase(room, 'reveal', now);
}
function finishVote(room: Room, now: number): void {
  const g = game(room), t = g.trial!;
  // Missing responses are public abstentions after resolution, not invented locked ballots.
  for (const voter of g.phase.eligibleIds) if (!Object.hasOwn(t.votes, voter)) t.votes[voter] = null;
  const counts: Record<string, number> = {};
  for (const target of Object.values(t.votes)) if (target) counts[target] = (counts[target] ?? 0) + 1;
  const best = Math.max(0, ...Object.values(counts));
  const leaders = Object.keys(counts).filter(id => counts[id] === best);
  const winner = leaders.length === 1 ? leaders[0]! : null;
  t.voteWinner = winner; t.voteTied = leaders.length > 1; t.voteResolved = true;
  if (t.voteType === 'trust') for (const [id, count] of Object.entries(counts)) g.subjects[id]!.trustVotes += count;
  if (winner && !g.subjects[winner]!.withdrawn) {
    const s = g.subjects[winner]!;
    if (t.voteType === 'trust') { s.compliance++; dossier(room, s, 'trust', 'Trust vote awarded +1 Compliance.', now, { compliance: s.compliance, complianceDelta: 1 }); }
    if (t.voteType === 'restriction') { s.pendingRestriction = true; dossier(room, s, 'restriction', 'Next ordinary Trial: allocate at least 1 unit to Medical.', now); }
  }
  if (winner && t.voteType === 'exposure' && g.subjects[winner]!.directive) t.exposure = { playerId: winner, directive: structuredClone(g.subjects[winner]!.directive!) };
  const outcomeText = winner ? `${t.voteType.toUpperCase()} selected Subject ${g.subjects[winner]!.number.toString().padStart(2, '0')}${g.subjects[winner]!.withdrawn ? ' (removed; no future reward or restriction)' : ''}.` : 'The ballot has no unique winner. No mechanical effect.';
  const ballotText = Object.entries(t.votes).map(([voter, target]) => `Subject ${g.subjects[voter]!.number.toString().padStart(2, '0')} → ${target ? `Subject ${g.subjects[target]!.number.toString().padStart(2, '0')}` : 'abstain'}`).join('; ');
  const countsText = Object.entries(counts).map(([id, count]) => `Subject ${g.subjects[id]!.number.toString().padStart(2, '0')}: ${count}`).join('; ');
  const exposureText = t.exposure ? ` Exposed directive: ${t.exposure.directive.instruction} (${t.exposure.directive.reward} Compliance).` : '';
  publish(room, 'vote_resolution', `${outcomeText}${exposureText} Ballots: ${ballotText}. Totals: ${countsText || 'no target received votes'}.`, now, { voteType: t.voteType, votes: { ...t.votes }, counts, winner, tied: t.voteTied, ...(t.exposure ? { exposure: t.exposure } : {}) });
  phase(room, 'consequences', now);
}
function beginFinale(room: Room, now: number): void {
  const g = game(room);
  g.round = g.plannedTotalRounds; g.trial = null; g.extension = null;
  for (const s of Object.values(g.subjects)) { s.directive = null; s.finalChoice = null; s.statement = null; s.allocation = null; s.ballot = undefined; s.medicalMinimum = 0; }
  phase(room, 'final_interrogation', now);
  publish(room, 'finale', 'Final Interrogation. Make your final statement before the private Final Directive.', now);
}
function assignFinalDirectives(room: Room, now: number): void {
  const g = game(room), shuffled = shuffle(activeIds(g));
  for (const [i, id] of shuffled.entries()) {
    const s = g.subjects[id]!, kind = i % 2 === 0 ? 'group' : 'self';
    s.directive = { id: randomUUID(), kind, title: kind === 'group' ? 'Final Loyalty' : 'Final Self-Preservation', instruction: kind === 'group' ? 'Choose Protect the Group.' : 'Choose Protect Yourself.', reward: 3 };
    dossier(room, s, 'final_directive', s.directive.instruction, now, { directive: s.directive });
  }
  phase(room, 'final_directive', now);
}
function advanceInterrogation(room: Room, now: number): void {
  const g = game(room), old = g.phase;
  const index = old.eligibleIds.indexOf(old.speakerId ?? '');
  const next = old.eligibleIds.slice(index + 1).find(id => !g.subjects[id]!.withdrawn);
  if (!next) { assignFinalDirectives(room, now); return; }
  phase(room, 'final_interrogation', now, old.eligibleIds);
  g.phase.speakerId = next;
}
function finishFinalChoices(room: Room, now: number): void {
  const g = game(room);
  const protectors = Object.values(g.subjects).filter(s => s.finalChoice === 'group').length;
  const selfProtectors = Object.values(g.subjects).filter(s => s.finalChoice === 'self').length;
  const deltaTicks = 40 * protectors - 120 * selfProtectors;
  const beforeStability = g.stabilityTicks / g.startingSubjectCount;
  const afterTicks = Math.max(0, Math.min(g.startingSubjectCount * 100, g.stabilityTicks + deltaTicks));
  for (const s of Object.values(g.subjects)) {
    if (!s.finalChoice) continue;
    const completed = s.directive?.kind === s.finalChoice;
    if (completed) { s.compliance += 3; s.completedDirectives++; }
    if (s.directive) s.history.push({ round: g.round, directive: structuredClone(s.directive), allocation: null, completed, complianceAfter: s.compliance, medicalMinimum: 0, finalChoice: s.finalChoice });
    dossier(room, s, 'final_resolution', `You chose ${s.finalChoice === 'group' ? 'Protect the Group' : 'Protect Yourself'}. ${completed ? '+3 Compliance.' : 'Final Directive incomplete.'} Group Stability: ${beforeStability} → ${afterTicks / g.startingSubjectCount}.`, now, { finalChoice: s.finalChoice, completed, compliance: s.compliance, complianceDelta: completed ? 3 : 0 });
  }
  g.stabilityTicks = afterTicks;
  g.finalCounts = { group: protectors, self: selfProtectors, delta: deltaTicks / g.startingSubjectCount };
  g.outcome = g.stabilityTicks > 0 ? 'survived' : 'failed';
  makeResults(g);
  publish(room, 'final_resolution', `Protect the Group: ${protectors}. Protect Yourself: ${selfProtectors}. Group ${g.outcome.toUpperCase()}.`, now, { ...g.finalCounts, outcome: g.outcome });
  phase(room, 'final_resolution', now);
}
function makeResults(g: Game): void {
  const scores = Object.values(g.subjects).map(s => s.trustVotes);
  g.results = Object.values(g.subjects).map(s => ({ playerId: s.id, subjectNumber: s.number, compliance: s.compliance, requirement: s.requirement, qualified: g.outcome === 'survived' && !s.withdrawn && s.compliance >= s.requirement, completedDirectives: s.completedDirectives, trustVotes: s.trustVotes, trustRank: 1 + scores.filter(n => n > s.trustVotes).length, classification: s.withdrawn ? 'WITHDRAWN' : s.finalChoice === 'self' && s.trustVotes > 0 ? 'LOYAL OPPORTUNIST' : s.finalChoice === 'self' ? 'SELF-PRESERVATIONIST' : s.trustVotes > 0 ? 'TRUSTED GUARDIAN' : 'GROUP PROTECTOR', withdrawn: s.withdrawn }));
}
function finishGame(room: Room, outcome: 'failed' | 'aborted', now: number): void {
  const g = game(room);
  g.outcome = outcome; g.paused = false; g.pauseReason = null;
  makeResults(g);
  publish(room, outcome, outcome === 'aborted' ? 'The host ended this Experiment. No winners; unrevealed secrets remain private.' : 'Group Stability has collapsed. No Subject qualifies.', now);
  if (outcome === 'aborted') { phase(room, 'aborted', now); room.status = 'postgame'; }
  else phase(room, 'personal_results', now);
}
function checkpoint(room: Room, now: number): void {
  const g = game(room);
  if (g.extensionsEnabled && g.plannedTotalRounds < g.maxRounds) phase(room, 'extension_offer', now);
  else beginFinale(room, now);
}
function finishExtension(room: Room, now: number): void {
  const g = game(room), ext = g.extension!;
  const yes = Object.values(ext.ballots).filter(Boolean).length;
  const no = ext.eligibleIds.length - yes;
  const accepted = yes > ext.eligibleIds.length / 2;
  ext.yes = yes; ext.no = no; ext.accepted = accepted;
  g.extensionHistory.push(structuredClone(ext));
  publish(room, 'extension_resolution', `Extra Trials ${accepted ? 'approved' : 'declined'}: ${yes} yes, ${no} no.`, now, { yes, no, accepted, addedRounds: ext.addedRounds });
  if (accepted) { g.plannedTotalRounds = ext.toRounds; g.round++; startTrial(room, now); }
  else beginFinale(room, now);
}
function advance(room: Room, now: number): void {
  const g = game(room);
  switch (g.phase.type) {
    case 'crisis': assignDirectives(room, now); break;
    case 'directive': phase(room, 'discussion', now, g.phase.eligibleIds); break;
    case 'discussion': phase(room, 'decision', now, g.phase.eligibleIds); break;
    case 'decision': finishResource(room, now); break;
    case 'reveal': phase(room, 'vote', now); break;
    case 'vote': finishVote(room, now); break;
    case 'consequences': phase(room, 'dossier', now); break;
    case 'dossier': if (g.round < g.plannedTotalRounds - 1) { g.round++; startTrial(room, now); } else checkpoint(room, now); break;
    case 'extension_offer': beginFinale(room, now); break;
    case 'extension_vote': finishExtension(room, now); break;
    case 'final_interrogation': advanceInterrogation(room, now); break;
    case 'final_directive': phase(room, 'final_choice', now); break;
    case 'final_choice': {
      if (g.phase.eligibleIds.every(id => g.subjects[id]!.finalChoice !== null || g.subjects[id]!.withdrawn)) finishFinalChoices(room, now);
      else fail('FINALE_WAITING', 'Final choices require every eligible Subject to lock in. Reconnect, pause, remove an absent Subject, or end the Experiment.');
      break;
    }
    case 'final_resolution': phase(room, 'personal_results', now); break;
    case 'personal_results': phase(room, 'full_reveal', now); room.status = 'postgame'; publish(room, 'full_reveal', 'The Experiment’s hidden record is now open.', now); break;
    case 'aborted':
    case 'full_reveal': fail('FINISHED', 'This Experiment has finished.');
  }
}
export function tick(room: Room, now: number): boolean {
  const g = room.game;
  if (room.status !== 'running' || !g || g.paused || g.phase.deadline === null || now < g.phase.deadline || g.phase.type === 'final_choice') return false;
  advance(room, now); return true;
}

/** Validated commands are fenced again here, even for direct engine callers. */
export function applyCommand(room: Room, actorId: string, command: CommandEnvelope, now: number): void {
  const actor = member(room, actorId);
  const envelope = { gameId: command.gameId, phaseId: command.phaseId, type: command.action.type as string };
  const payload = command.action as unknown as Record<string, unknown>;
  if (envelope.type.startsWith('survival_')) {
    if (envelope.type === 'survival_start') {
      host(room, actorId);
      if (room.status !== 'lobby' || room.survival) fail('BAD_STATE', 'Return to the lobby before starting a new survival world.');
      if (envelope.gameId !== null || envelope.phaseId !== null) fail('STALE_WORLD', 'This start command belongs to an earlier world.');
      const players = room.members.filter(m => !m.removed && m.role === 'subject');
      const humans = players.filter(m => !isCpuMember(m));
      if (!humans.length || players.length > 8) fail('PLAYER_COUNT', 'A survival world needs at least one human survivor and supports up to eight players.');
      if (humans.some(m => !m.ready)) fail('NOT_READY', 'Every human survivor must be ready.');
      const action = command.action as Extract<SurvivalAction, { type: 'survival_start' }>;
      room.game = null;
      room.survival = createSurvivalWorld(players.map(m => m.id), action.shelterType, action.dayLengthMinutes, now);
      room.status = 'running';
      publish(room, 'survival_started', 'The survival world is open. Scavenge, rescue survivors, improve your shelter and defend against the infected.', now);
      return;
    }
    const world = room.survival;
    if (!world || room.status !== 'running') fail('BAD_STATE', 'There is no active survival world.');
    if (envelope.gameId !== world.id || envelope.phaseId !== null) fail('STALE_WORLD', 'This action belongs to an earlier survival world. Refresh your room state.');
    if (envelope.type === 'survival_pause') host(room, actorId);
    else if (actor.role !== 'subject' || !world.players[actorId]) fail('SURVIVOR_ONLY', 'Only a survivor in this world can do that.');
    try { applySurvivalAction(world, actorId, command.action as SurvivalAction, now, room.hostId, new Set(room.members.filter(m => !m.removed && m.role === 'subject').map(m => m.id))); }
    catch (error) { if (error instanceof SurvivalError) fail(error.code, error.message); throw error; }
    return;
  }
  if (room.survival && room.status === 'running') {
    if (['transfer_host', 'remove', 'mute_chat', 'pause', 'resume', 'end'].includes(envelope.type) && (envelope.gameId !== room.survival.id || envelope.phaseId !== null)) fail('STALE_WORLD', 'This host action belongs to an earlier survival world.');
    if (['pause', 'resume'].includes(envelope.type)) {
      host(room, actorId);
      try { applySurvivalAction(room.survival, actorId, { type: 'survival_pause', paused: envelope.type === 'pause' }, now, room.hostId); }
      catch (error) { if (error instanceof SurvivalError) fail(error.code, error.message); throw error; }
      return;
    }
    if (envelope.type === 'end') {
      host(room, actorId); room.survival.active = false; room.status = 'postgame';
      publish(room, 'survival_ended', 'The host ended this survival world. Its final state is retained until a new world is started.', now); return;
    }
    if (['start', 'decision', 'vote', 'final_choice', 'statement', 'extension', 'extension_vote', 'continue', 'advance'].includes(envelope.type)) fail('SURVIVAL_MODE', 'This world uses continuous survival, with rounds only for infected hordes.');
  }
  const g = room.game;
  const gameCommands = ['decision', 'vote', 'final_choice', 'statement', 'extension', 'extension_vote', 'continue', 'pause', 'resume', 'advance', 'end'];
  if (gameCommands.includes(envelope.type)) {
    if (!g || room.status !== 'running') fail('BAD_STATE', 'There is no active Experiment.');
    if (envelope.gameId !== g.id || envelope.phaseId !== g.phase.id) fail('STALE_PHASE', 'This action belongs to an earlier game or phase. Refresh your room state.');
  }
  if (room.status === 'running' && g && ['transfer_host', 'remove', 'mute_chat'].includes(envelope.type) && (envelope.gameId !== g.id || envelope.phaseId !== g.phase.id)) fail('STALE_PHASE', 'This host action belongs to an earlier game or phase.');
  const actions = ['decision', 'vote', 'final_choice', 'statement', 'extension', 'extension_vote', 'continue', 'advance'];
  if (g?.paused && actions.includes(envelope.type)) fail('PAUSED', 'The Experiment is paused.');
  switch (envelope.type) {
    case 'ready': {
      if (room.status !== 'lobby' || actor.role !== 'subject') fail('BAD_STATE', 'Ready is available to Subjects in the lobby.');
      actor.ready = Boolean(payload.ready); break;
    }
    case 'settings': {
      host(room, actorId);
      if (room.status !== 'lobby' && room.status !== 'postgame') fail('BAD_STATE', 'Settings cannot change during an Experiment.');
      const next = payload.settings as unknown as RoomSettings; validSettings(next);
      room.settings = structuredClone(next); room.members.forEach(m => { m.ready = isCpuMember(m); }); break;
    }
    case 'add_cpu': {
      host(room, actorId);
      if (room.status !== 'lobby') fail('BAD_STATE', 'CPU Subjects can be added in the lobby.');
      addCpuMember(room, now); break;
    }
    case 'start': host(room, actorId); begin(room, now); break;
    case 'rematch': {
      host(room, actorId);
      if (room.status !== 'postgame') fail('BAD_STATE', 'Finish the current Experiment before a rematch.');
      if (room.game) (room.pastGames ??= []).push(structuredClone(room.game));
      room.game = null; delete room.survival; room.status = 'lobby'; room.members.forEach(m => { m.ready = isCpuMember(m); }); publish(room, 'rematch', 'The room is ready for a fresh Experiment.', now); break;
    }
    case 'set_role': {
      host(room, actorId);
      if (room.status !== 'lobby' && room.status !== 'postgame') fail('BAD_STATE', 'Membership roles can change between games.');
      const target = member(room, String(payload.targetId));
      if (payload.role !== 'subject' && payload.role !== 'spectator') fail('BAD_ROLE', 'Unknown membership role.');
      if (isCpuMember(target) && payload.role === 'spectator') fail('CPU_ROLE', 'CPU players remain Subjects. Remove their seat to make space.');
      if (payload.role === 'subject' && target.role !== 'subject' && room.members.filter(m => !m.removed && m.role === 'subject').length >= 8) fail('ROOM_FULL', 'At most 8 Subjects can participate.');
      target.role = payload.role; target.ready = isCpuMember(target); break;
    }
    case 'chat': {
      if (room.chatMuted && actorId !== room.hostId) fail('CHAT_MUTED', 'The host has muted public chat.');
      const text = String(payload.text ?? '').trim();
      if (!text || text.length > 500) fail('BAD_CHAT', 'Chat messages must contain 1–500 characters.');
      room.chat.push({ id: randomUUID(), senderId: actorId, nickname: actor.nickname, text, at: now, type: 'chat' }); if (room.chat.length > 200) room.chat.shift(); break;
    }
    case 'transfer_host': {
      host(room, actorId); const target = member(room, String(payload.targetId));
      if (isCpuMember(target)) fail('CPU_HOST', 'Only a human player can host the room.');
      room.hostId = target.id; publish(room, 'host_transfer', `${target.nickname} is now the host.`, now); break;
    }
    case 'mute_chat': host(room, actorId); room.chatMuted = Boolean(payload.muted); break;
    case 'remove': {
      host(room, actorId);
      const target = member(room, String(payload.targetId));
      if (target.id === actorId) fail('SELF_REMOVE', 'Transfer host before leaving your room.');
      target.removed = true; target.ready = false;
      const survivor = room.survival?.players[target.id];
      if (survivor) survivor.input = { moveX: 0, moveY: 0, aim: survivor.aim, fire: false, receivedAt: now };
      if (g?.subjects[target.id] && !g.outcome) g.subjects[target.id]!.withdrawn = true;
      publish(room, 'removed', `${target.nickname} was removed by the host. Committed history is retained.`, now);
      if (room.status === 'running' && g && !g.outcome) {
        if (activeIds(g).length < 4) { if (!g.paused) pauseGame(g, now); g.pauseReason = 'Fewer than four Subjects remain. End this Experiment and restart with a full group.'; }
        else if (g.phase.type === 'final_interrogation' && g.phase.speakerId === target.id) advanceInterrogation(room, now);
        else checkAllLocked(room, now);
      }
      break;
    }
    case 'pause': host(room, actorId); if (g!.paused) fail('ALREADY_PAUSED', 'The Experiment is already paused.'); pauseGame(g!, now); break;
    case 'resume': {
      host(room, actorId); if (!g!.paused) fail('NOT_PAUSED', 'The Experiment is not paused.');
      if (activeIds(g!).length < 4) fail('PLAYER_COUNT', 'Fewer than four Subjects remain. End and restart the Experiment.');
      g!.paused = false; g!.pauseReason = null; g!.phase.deadline = g!.phase.remainingMs === null ? null : now + g!.phase.remainingMs; g!.phase.remainingMs = null; break;
    }
    case 'advance': { host(room, actorId); const priorPhase = g!.phase.type; advance(room, now); publish(room, 'host_advance', `The host advanced ${priorPhase} using the documented timeout rules.`, now); break; }
    case 'end': host(room, actorId); finishGame(room, 'aborted', now); break;
    case 'decision': {
      const s = subject(room, actorId);
      if (g!.phase.type !== 'decision' || !g!.phase.eligibleIds.includes(actorId)) fail('BAD_PHASE', 'Resource allocation is unavailable in this phase.');
      if (s.allocation) fail('ALREADY_LOCKED', 'Your decision is already locked.');
      const a = payload.allocation as unknown as Allocation;
      if (!a || ![a.medical, a.security, a.reserve].every(n => Number.isInteger(n) && n >= 0 && n <= 3) || a.medical + a.security + a.reserve !== 3 || a.medical < s.medicalMinimum) fail('BAD_ALLOCATION', `Allocate exactly 3 units, including at least ${s.medicalMinimum} Medical.`);
      s.allocation = { medical: a.medical, security: a.security, reserve: a.reserve }; checkAllLocked(room, now); break;
    }
    case 'vote': {
      const s = subject(room, actorId);
      if (g!.phase.type !== 'vote' || !g!.phase.eligibleIds.includes(actorId)) fail('BAD_PHASE', 'Voting is unavailable in this phase.');
      if (s.ballot !== undefined) fail('ALREADY_LOCKED', 'Your ballot is already locked.');
      const target = payload.targetId == null ? null : String(payload.targetId);
      if (target === actorId || target && !g!.phase.eligibleIds.includes(target)) fail('BAD_TARGET', 'Select another eligible Subject or abstain.');
      s.ballot = target; g!.trial!.votes[actorId] = target; checkAllLocked(room, now); break;
    }
    case 'statement': {
      const s = subject(room, actorId);
      if (g!.phase.type !== 'final_interrogation') fail('BAD_PHASE', 'Final statements are unavailable in this phase.');
      if (g!.phase.speakerId !== actorId) fail('NOT_YOUR_TURN', 'Wait for your 20-second final statement turn.');
      if (s.statement !== null) fail('ALREADY_LOCKED', 'Your final statement is already recorded.');
      const text = String(payload.text ?? '').trim();
      if (!text || text.length > 500) fail('BAD_STATEMENT', 'A final statement must contain 1–500 characters.');
      s.statement = text;
      room.chat.push({ id: randomUUID(), senderId: actorId, nickname: actor.nickname, text, at: now, type: 'statement' }); if (room.chat.length > 200) room.chat.shift();
      publish(room, 'final_statement', text, now, { playerId: actorId }); advanceInterrogation(room, now); break;
    }
    case 'final_choice': {
      const s = subject(room, actorId);
      if (g!.phase.type !== 'final_choice' || !g!.phase.eligibleIds.includes(actorId)) fail('BAD_PHASE', 'Final choices are unavailable in this phase.');
      if (s.finalChoice !== null) fail('ALREADY_LOCKED', 'Your final choice is already locked.');
      if (payload.choice !== 'group' && payload.choice !== 'self') fail('BAD_CHOICE', 'Choose Protect the Group or Protect Yourself.');
      s.finalChoice = payload.choice; checkAllLocked(room, now); break;
    }
    case 'extension': {
      host(room, actorId);
      if (g!.phase.type !== 'extension_offer') fail('BAD_PHASE', 'Additional rounds can only be proposed before the finale.');
      const added = Number(payload.additionalRounds);
      if (![1, 2, 3, 5].includes(added) || g!.plannedTotalRounds + added > g!.maxRounds) fail('BAD_EXTENSION', 'Choose an allowed addition within this game’s cap.');
      const ids = activeIds(g!);
      g!.extension = { id: randomUUID(), addedRounds: added, fromRounds: g!.plannedTotalRounds, toRounds: g!.plannedTotalRounds + added, eligibleIds: [...ids], ballots: {}, yes: null, no: null, accepted: null };
      phase(room, 'extension_vote', now, ids); publish(room, 'extension_proposal', `The host proposes ${added} additional ordinary Trial${added === 1 ? '' : 's'}, for ${g!.extension.toRounds} total rounds including the finale.`, now); break;
    }
    case 'extension_vote': {
      subject(room, actorId);
      if (g!.phase.type !== 'extension_vote' || !g!.extension!.eligibleIds.includes(actorId)) fail('BAD_PHASE', 'Continuation voting is unavailable.');
      if (Object.hasOwn(g!.extension!.ballots, actorId)) fail('ALREADY_LOCKED', 'Your consent ballot is already locked.');
      if (typeof payload.yes !== 'boolean') fail('BAD_BALLOT', 'Choose yes or no.');
      g!.extension!.ballots[actorId] = payload.yes; checkAllLocked(room, now); break;
    }
    case 'continue': host(room, actorId); if (g!.phase.type !== 'extension_offer') fail('BAD_PHASE', 'This checkpoint has already closed.'); beginFinale(room, now); break;
    default: fail('UNKNOWN_COMMAND', 'Unknown command.');
  }
}
function pauseGame(g: Game, now: number): void { g.paused = true; g.pauseReason = 'Paused by the host.'; g.phase.remainingMs = g.phase.deadline === null ? null : Math.max(0, g.phase.deadline - now); g.phase.deadline = null; }
function checkAllLocked(room: Room, now: number): void {
  const g = game(room);
  if (g.paused) return;
  const ids = g.phase.eligibleIds;
  if (g.phase.type === 'decision' && ids.every(id => g.subjects[id]!.allocation !== null || g.subjects[id]!.withdrawn)) finishResource(room, now);
  else if (g.phase.type === 'vote' && ids.every(id => g.subjects[id]!.ballot !== undefined || g.subjects[id]!.withdrawn)) finishVote(room, now);
  else if (g.phase.type === 'extension_vote' && g.extension!.eligibleIds.every(id => Object.hasOwn(g.extension!.ballots, id) || g.subjects[id]!.withdrawn)) finishExtension(room, now);
  else if (g.phase.type === 'final_choice' && ids.every(id => g.subjects[id]!.finalChoice !== null || g.subjects[id]!.withdrawn)) finishFinalChoices(room, now);
}

function resultView(room: Room, result: Result): PersonalResult {
  return { memberId: result.playerId, nickname: room.members.find(m => m.id === result.playerId)?.nickname ?? 'Removed Subject', subjectNumber: result.subjectNumber, compliance: result.compliance, requirement: result.requirement, qualified: result.qualified, directivesCompleted: result.completedDirectives, trustVotes: result.trustVotes, trustRank: result.trustRank, classification: result.classification, removed: result.withdrawn };
}
function directiveView(d: Directive | null) { return d ? { id: d.id, text: d.instruction, reward: d.reward } : null; }
function titleOf(kind: string): string { return kind === 'cpu_seat_inherited' ? 'CPU seat inherited' : kind.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()); }

export function projectRoom(room: Room, viewerId: string, onlineIds: Set<string> = new Set()): RoomView {
  member(room, viewerId);
  if (room.status === 'closed') fail('ROOM_CLOSED', 'This room is closed.');
  const g = room.game;
  const self = g?.subjects[viewerId];
  const showFull = g?.phase.type === 'full_reveal' && g.outcome !== 'aborted';
  const showPersonal = g && ['personal_results', 'full_reveal', 'aborted'].includes(g.phase.type);
  const ownResult = showPersonal ? g.results.find(r => r.playerId === viewerId) ?? null : null;
  const fullReveal: RevealEntry[] = [];
  if (g && showFull) {
    for (const s of Object.values(g.subjects)) {
      for (const h of s.history) {
        const choice = h.finalChoice ? (h.finalChoice === 'group' ? 'Protect the Group' : 'Protect Yourself') : h.allocation ? `Medical ${h.allocation.medical}, Security ${h.allocation.security}, Reserve ${h.allocation.reserve}` : 'No response';
        fullReveal.push({ id: `${s.id}:${h.round}`, round: h.round, memberId: s.id, title: `Subject ${s.number.toString().padStart(2, '0')} — ${h.directive.title}`, detail: `Directive: ${h.directive.instruction} (${h.directive.reward} Compliance). Decision: ${choice}. ${h.completed ? 'Completed' : 'Not completed'}. Compliance after decision: ${h.complianceAfter}.` });
      }
      // A collapse can occur before a directive's decision resolves; disclose it only at the authorized Full Reveal.
      if (s.directive && !s.history.some(h => h.directive.id === s.directive!.id)) fullReveal.push({ id: `${s.id}:unfinished`, round: g.round, memberId: s.id, title: `Subject ${s.number.toString().padStart(2, '0')} — unfinished directive`, detail: s.directive.instruction });
    }
  }
  const privateDirective = self?.directive ?? null;
  const isFinal = privateDirective?.kind === 'group' || privateDirective?.kind === 'self';
  const survival = room.survival ? projectSurvivalWorld(room.survival) : null;
  if (survival) survival.players = survival.players.filter(player => room.members.some(m => m.id === player.id && !m.removed && m.role === 'subject'));
  const viewer = room.members.find(m => m.id === viewerId)!;
  const survivorNumbers = room.survival ? Object.keys(room.survival.players) : [];
  return {
    id: room.id, code: room.code, hostId: room.hostId, settings: { ...room.settings }, status: room.status, chatMuted: room.chatMuted,
    selfId: viewerId,
    members: room.members.map(m => ({ id: m.id, nickname: m.nickname, role: m.role, ready: m.ready, removed: m.removed, controller: isCpuMember(m) ? 'cpu' : 'human', connected: !m.removed && (isCpuMember(m) || onlineIds.has(m.id)), subjectNumber: g?.subjects[m.id]?.number ?? (survivorNumbers.includes(m.id) ? survivorNumbers.indexOf(m.id) + 1 : null) })),
    chat: room.chat.map(m => ({ id: m.id, senderId: m.senderId, nickname: m.nickname ?? room.members.find(p => p.id === m.senderId)?.nickname ?? 'Removed Subject', text: m.text, at: m.at, type: m.type ?? 'chat' })),
    events: (g ? g.publicEvents : room.events.filter(e => e.visibility === 'public')).map(e => ({ id: e.id, at: e.at, round: e.round, type: e.kind, title: titleOf(e.kind), detail: e.text })),
    game: g ? {
      id: g.id, round: g.round, initialRounds: g.initialRoundCount, totalRounds: g.plannedTotalRounds, roundCap: g.maxRounds as 15 | 20,
      stability: g.stabilityTicks / g.startingSubjectCount, maxStability: 100, outcome: g.outcome ?? 'active',
      phase: { id: g.phase.id, type: g.phase.type, deadline: g.phase.deadline, paused: g.paused, pauseReason: g.pauseReason, remainingMs: g.phase.remainingMs, eligibleIds: [...g.phase.eligibleIds], speakerId: g.phase.speakerId },
      trial: g.trial ? { id: g.trial.id, title: g.trial.title, narrative: g.trial.description, medicalTarget: g.trial.threshold, securityTarget: g.trial.threshold } : null,
      voteType: g.trial?.voteType ?? null,
      voteTargets: g.phase.type === 'vote' ? [...g.phase.eligibleIds] : [],
      allocationTotals: g.trial?.totals ? { ...g.trial.totals } : null,
      extension: g.extension ? { additionalRounds: g.extension.addedRounds, proposedTotal: g.extension.toRounds } : null,
      results: showFull ? g.results.map(r => resultView(room, r)) : [],
      fullReveal,
    } : null,
    me: self ? {
      compliance: self.compliance, requirement: self.requirement,
      directive: !isFinal ? directiveView(privateDirective) : null,
      finalDirective: isFinal ? directiveView(privateDirective) : null,
      restriction: self.medicalMinimum > 0 || self.pendingRestriction,
      decision: self.allocation ? { ...self.allocation } : null, decisionSubmitted: self.allocation !== null,
      voteSubmitted: self.ballot !== undefined,
      finalChoice: self.finalChoice,
      extensionVote: g?.extension && Object.hasOwn(g.extension.ballots, viewerId) ? g.extension.ballots[viewerId]! : null,
      dossier: self.dossier.map(e => ({ id: e.id, round: e.round, title: titleOf(e.kind), text: e.text, complianceDelta: Number(e.data?.complianceDelta ?? 0), at: e.at })),
      result: ownResult ? resultView(room, ownResult) : null,
    } : null,
    ...(room.survival && survival ? { survival, survivorMe: viewer.role === 'subject' ? projectSurvivalPlayer(room.survival, viewerId) : null } : {}),
  };
}
