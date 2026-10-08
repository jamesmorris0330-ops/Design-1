import { randomUUID } from 'node:crypto';
import type { Action, Allocation, RoomView } from '../shared/protocol.js';
import { applyCommand, projectRoom, type Room } from './engine.js';

/** These agents have the same information boundary as a human client. */
function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) { value ^= char.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
}

function directiveMatches(text: string, allocation: Allocation): boolean {
  switch (text) {
    case 'Allocate at least 2 units to Medical.': return allocation.medical >= 2;
    case 'Allocate at least 2 units to Security.': return allocation.security >= 2;
    case 'Keep at least 2 units in Reserve.': return allocation.reserve >= 2;
    case 'Allocate no units to Medical.': return allocation.medical === 0;
    case 'Allocate no units to Security.': return allocation.security === 0;
    case 'Keep all 3 units in Reserve.': return allocation.reserve === 3;
    case 'Allocate exactly 1 unit to each system.': return allocation.medical === 1 && allocation.security === 1 && allocation.reserve === 1;
    // Other players' locked choices are unavailable. Treat the shared benchmark
    // as a reason to contribute to both systems, never as knowledge it was met.
    case 'Submit an allocation and have both Medical and Security reach their thresholds.': return allocation.medical >= 1 && allocation.security >= 1;
    default: return false;
  }
}

function allocationFor(view: RoomView): Allocation {
  const game = view.game!, me = view.me!;
  // When failure is close, every CPU guarantees a minimum contribution to
  // each public system instead of risking the shared objective for a reward.
  if (game.stability <= 40) return { medical: 1, security: 1, reserve: 1 };
  const profile = hash(view.selfId) % 3; // cautious, balanced, opportunistic
  const deficit = Math.max(0, me.requirement - me.compliance);
  const survivalWeight = game.stability <= 35 ? 5 : game.stability <= 55 ? 3 : game.stability <= 75 ? 1.8 : 1;
  const directiveWeight = deficit === 0 ? 0.5 : 2.15 + profile * 0.25;
  let best: Allocation = { medical: 1, security: 2, reserve: 0 }, bestScore = -Infinity;
  for (let medical = me.restriction ? 1 : 0; medical <= 3; medical++) {
    for (let security = 0; security <= 3 - medical; security++) {
      const allocation = { medical, security, reserve: 3 - medical - security };
      const bothSystems = medical > 0 && security > 0;
      const contribution = medical + security + (bothSystems ? 0.8 : 0);
      const reward = me.directive && directiveMatches(me.directive.text, allocation) ? me.directive.reward : 0;
      // A small stable preference varies equally good choices without reading
      // other Subjects' allocations, directives, Compliance or ballots.
      const preference = (hash(`${view.selfId}:${game.phase.id}:${medical}:${security}`) % 100) / 500;
      const score = contribution * survivalWeight + reward * directiveWeight + preference;
      if (score > bestScore) { bestScore = score; best = allocation; }
    }
  }
  return best;
}

function ballotFor(view: RoomView): string | null {
  const game = view.game!;
  const candidates = game.voteTargets.filter(id => id !== view.selfId && view.members.some(m => m.id === id && !m.removed && m.role === 'subject'));
  let best: string | null = null, bestScore = -Infinity;
  for (const id of candidates) {
    const candidate = view.members.find(m => m.id === id)!;
    const messages = view.chat.filter(m => m.senderId === id).map(m => m.text.toLowerCase());
    const supportive = messages.filter(text => /protect the group|both systems|medical and security|survival comes first/.test(text)).length;
    const selfish = messages.filter(text => /keep.*reserve|protect myself|protect yourself/.test(text)).length;
    const subjectLabel = `Subject ${String(candidate.subjectNumber).padStart(2, '0')}`;
    // Only an Exposure result legitimately associates a revealed directive
    // with its Subject. Aggregate resource outcomes cannot identify a culprit.
    const exposed = view.events.filter(event => event.type === 'vote_resolution' && event.detail.includes(`EXPOSURE selected ${subjectLabel}`));
    const riskyExposure = exposed.filter(event => /Exposed directive: (Keep|Allocate no)/.test(event.detail)).length;
    const publicReputation = supportive - selfish - riskyExposure;
    const reputationScore = game.voteType === 'trust' ? publicReputation : -publicReputation;
    const score = reputationScore + (hash(`${view.selfId}:${game.phase.id}:${id}`) % 1000) / 1000;
    if (score > bestScore) { bestScore = score; best = id; }
  }
  return best;
}

function finalChoiceFor(view: RoomView): 'group' | 'self' {
  const game = view.game!, me = view.me!;
  if (game.stability <= 55 || me.compliance >= me.requirement) return 'group';
  return me.finalDirective?.text === 'Choose Protect Yourself.' ? 'self' : 'group';
}

function actionFor(view: RoomView): Action | null {
  const game = view.game!, me = view.me!;
  switch (game.phase.type) {
    case 'decision': return me.decisionSubmitted ? null : { type: 'decision', allocation: allocationFor(view) };
    case 'vote': return me.voteSubmitted ? null : { type: 'vote', targetId: ballotFor(view) };
    case 'extension_vote': {
      if (me.extensionVote !== null || !game.extension) return null;
      const manageableLength = game.extension.proposedTotal <= Math.min(game.roundCap, Math.max(7, game.initialRounds + 5));
      return { type: 'extension_vote', yes: game.stability > 25 && manageableLength && (me.compliance < me.requirement || game.extension.proposedTotal <= 5) };
    }
    case 'final_choice': return me.finalChoice === null ? { type: 'final_choice', choice: finalChoiceFor(view) } : null;
    case 'final_interrogation': {
      if (game.phase.speakerId !== view.selfId) return null;
      const statements = [
        'We can only qualify if the group survives. Judge what we have seen publicly, and protect the group if Stability is at risk.',
        'My directives have pulled me in different directions. Survival comes first; the final choice still matters.',
        'Medical and Security both needed us. I am weighing my own Compliance against the Stability we all share.',
      ];
      return { type: 'statement', text: statements[hash(view.selfId) % statements.length]! };
    }
    default: return null;
  }
}

/** Mutates the queued room only; the caller persists these actions atomically. */
export function runCpuPlayers(room: Room, now: number): boolean {
  const game = room.game;
  if (room.status !== 'running' || !game || game.paused || game.outcome !== null) return false;
  const phaseId = game.phase.id;
  const phaseType = game.phase.type;
  if (!['discussion', 'decision', 'vote', 'extension_vote', 'final_interrogation', 'final_choice'].includes(phaseType)) return false;
  // Ordinary inputs cannot sneak through an expired phase if a caller forgot
  // to run tick first. The final-choice deadline is only a warning by design.
  if (phaseType !== 'final_choice' && game.phase.deadline !== null && now >= game.phase.deadline) return false;
  let changed = false;
  for (const candidate of room.members) {
    if (room.game?.phase.id !== phaseId || room.game.paused || room.game.outcome !== null) break;
    if (candidate.controller !== 'cpu' || candidate.removed || candidate.role !== 'subject' || !game.phase.eligibleIds.includes(candidate.id) || game.subjects[candidate.id]?.withdrawn) continue;
    const due = game.phase.openedAt + 2_000 + hash(`${candidate.id}:${phaseId}`) % 3_001;
    if (now < due) continue;
    const view = projectRoom(room, candidate.id);
    if (!view.me) continue;
    let action: Action | null;
    if (phaseType === 'discussion') {
      if (room.chatMuted || candidate.cpuLastDiscussionPhase === phaseId) continue;
      const cautious = view.game!.stability <= 55;
      action = { type: 'chat', text: cautious ? 'Stability is under pressure. I want to support both Medical and Security this Trial.' : 'We need both systems to reach their targets. I am balancing that with my own directive.' };
    } else action = actionFor(view);
    if (!action) continue;
    applyCommand(room, candidate.id, { commandId: randomUUID(), gameId: game.id, phaseId, action }, now);
    if (phaseType === 'discussion') candidate.cpuLastDiscussionPhase = phaseId;
    changed = true;
  }
  return changed;
}
