import { randomUUID } from 'node:crypto';
import type { Action, Allocation, ChatMessage, RoomView } from '../shared/protocol.js';
import { applyCommand, projectRoom, type Room } from './engine.js';

/** These agents have the same information boundary as a human client. */
function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) { value ^= char.charCodeAt(0); value = Math.imul(value, 16777619); }
  return value >>> 0;
}

type RequestIntent = 'medical' | 'security' | 'group' | 'explanation';
type PublicRequest = { message: ChatMessage; intent: RequestIntent };

/** A stable voice, rather than a fresh random personality on each reconnect. */
function personality(view: RoomView): number { return hash(view.selfId) % 3; }

function pick(view: RoomView, key: string, lines: readonly string[]): string {
  return lines[hash(`${view.selfId}:${view.game!.round}:${key}`) % lines.length]!;
}

/** Public appeals are ordinary, nonbinding chat, not an extra game mechanic. */
function publicRequests(view: RoomView): PublicRequest[] {
  const me = view.members.find(member => member.id === view.selfId)!;
  const prefix = `@${me.nickname.toLocaleLowerCase()}`;
  const currentCrisis = view.events.findLast(event => event.type === 'crisis' && event.round === view.game!.round);
  const currentFinale = view.events.findLast(event => event.type === 'finale');
  const roundStart = currentCrisis?.at ?? currentFinale?.at ?? Infinity;
  return view.chat.flatMap(message => {
    const sender = view.members.find(member => member.id === message.senderId);
    if (message.type !== 'chat' || message.at < roundStart || !sender || sender.removed || sender.controller !== 'human' || sender.role !== 'subject' || !view.game!.phase.eligibleIds.includes(sender.id)) return [];
    const text = message.text.toLocaleLowerCase();
    if (!text.startsWith(prefix) || !/^[\s—,:-]/.test(text.slice(prefix.length))) return [];
    const request = text.slice(prefix.length);
    const intent: RequestIntent = /medical/.test(request) ? 'medical' : /security/.test(request) ? 'security' : /protect.*group|surviv|protect.*everyone/.test(request) ? 'group' : 'explanation';
    return [{ message, intent }];
  });
}

function latestAppeal(view: RoomView): PublicRequest | undefined {
  return publicRequests(view).findLast(request => request.intent !== 'explanation');
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
  const appeal = latestAppeal(view);
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
      // A human can steer a still-unlocked plan, but conflicting private
      // incentives can still make the CPU refuse. Two units satisfy a request;
      // a third adds no persuasion bonus, so support for both systems matters.
      const persuasion = appeal?.intent === 'medical' || appeal?.intent === 'security'
        ? Math.min(2, allocation[appeal.intent]) * (profile === 0 ? 1.8 : profile === 1 ? 1.5 : 1.1)
        : appeal?.intent === 'group' && bothSystems ? 1.5 : 0;
      const score = contribution * survivalWeight + reward * directiveWeight + preference + persuasion;
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
  if (latestAppeal(view)?.intent === 'group' && personality(view) !== 2) return 'group';
  return me.finalDirective?.text === 'Choose Protect Yourself.' ? 'self' : 'group';
}

function publicOutcome(view: RoomView): string | null {
  return view.events.findLast(event => event.type === 'resource_resolution')?.detail ?? null;
}

function discussionLine(view: RoomView): string {
  const game = view.game!, voice = personality(view), outcome = publicOutcome(view);
  if (game.stability <= 40) return pick(view, 'danger', [
    'One unit to Medical, one to Security. Survival comes first now; nobody qualifies if this room collapses.',
    `Stability is ${game.stability}. We are running out of room for selfish moves. I intend to support both systems.`,
    'We are close to losing the whole experiment. Medical and Security need all of us this time.',
  ]);
  if (outcome && /Stability -/.test(outcome)) return pick(view, 'recovery', [
    'That last Trial cost us Stability. The public totals show the shortage; they do not tell us who held back.',
    `We took a hit last round. Stability is ${game.stability}; ask me for Medical or Security before I decide.`,
    'I want a better plan than blame this round. Tell me which system you can cover, and I will consider the other.',
  ]);
  const lines = [
    [
      `I want this room to survive. ${game.trial?.title ?? 'This Trial'} needs both systems; ask me where help is needed.`,
      'We have three units each, and two systems to save. I would rather coordinate than guess what you will do.',
      'Medical and Security both matter. I am listening if someone has a plan that keeps the group alive.',
    ],
    [
      `Each system needs ${game.trial?.medicalTarget ?? game.phase.eligibleIds.length} units. A pile of Reserve will not stop the crisis.`,
      'The totals will expose whether our plan worked, not every private choice. Tell me what you want me to cover.',
      `Stability is ${game.stability}. We have options, but my directive makes this less simple than it looks.`,
    ],
    [
      'I want to qualify, and I need this room alive to do it. Give me a reason to help your plan.',
      'My directive and your survival plan may not agree. Ask me before assuming I am on your side.',
      'I can negotiate. I cannot promise my private instructions will make cooperation painless.',
    ],
  ];
  return pick(view, 'discussion', lines[voice]!);
}

function revealLine(view: RoomView): string {
  const game = view.game!, totals = game.allocationTotals, trial = game.trial;
  if (!totals || !trial) return 'The public result is in. We can judge the shared outcome, not guess every private choice.';
  const medicalMet = totals.medical >= trial.medicalTarget, securityMet = totals.security >= trial.securityTarget;
  if (medicalMet && securityMet) return pick(view, 'both-saved', [
    `Both systems held. Medical ${totals.medical}, Security ${totals.security}. Now the question is who you trust.`,
    'We made it through that crisis. A successful group result does not mean everyone followed their directive.',
    `The room survived. Stability is ${game.stability}; do not let the next vote tear apart a working plan.`,
  ]);
  const failed = !medicalMet && !securityMet ? 'Medical and Security' : medicalMet ? 'Security' : 'Medical';
  return pick(view, 'shortage', [
    `${failed} fell short. I saw the same totals you did; they do not prove which Subject caused it.`,
    `That hurt. Stability is ${game.stability}. We need answers, but an accusation is not evidence.`,
    `${totals.reserve} units went to Reserve. ${failed} needed more help than the group delivered.`,
  ]);
}

function finalStatement(view: RoomView): string {
  const game = view.game!, voice = personality(view), outcome = publicOutcome(view);
  const opening = voice === 0 ? 'I want all of us to leave this room.' : voice === 1 ? `We reach the finale with ${game.stability} Stability.` : 'I came here to qualify, not to be a hero.';
  const evidence = outcome ? ` Our last public resource result was: ${outcome}` : '';
  const ending = game.stability <= 55 ? ' Protect the group. Another betrayal could finish us.' : voice === 2 ? ' I will weigh my last directive, but collapse rewards nobody. Ask me if you want my support.' : ' I intend to protect the group. Private instructions may pull us apart; the final decision is still ours.';
  return `${opening}${evidence}${ending}`;
}

function replyLine(view: RoomView, request: PublicRequest): string {
  const human = request.message.nickname, me = view.me!, game = view.game!;
  const address = `@${human} — `;
  if (request.intent === 'medical' || request.intent === 'security') {
    if (!game.trial) return `${address}Resource allocation is over. The final choice is about protecting the group or yourself.`;
    if (me.decisionSubmitted) return `${address}I have already locked my allocation. I can hear your argument, but I cannot change that choice.`;
    const allocation = allocationFor(view), units = allocation[request.intent], system = request.intent === 'medical' ? 'Medical' : 'Security';
    if (game.stability <= 40) return `${address}I intend one unit for Medical and one for Security. At ${game.stability} Stability, we need both to hold.`;
    if (units >= 2) return `${address}I can aim ${units} units at ${system}. Keep the other system covered; this is my current plan, not a binding deal.`;
    if (units === 1) return `${address}I can aim one unit at ${system}, but my own directive pulls me elsewhere. Do not build your whole plan around me.`;
    return `${address}I cannot honestly promise ${system} support. My directive conflicts with that request; you may want to ask another Subject.`;
  }
  if (request.intent === 'group') {
    if (me.finalChoice !== null) return `${address}My final choice is locked. The reveal will show whether you were right to trust me.`;
    if (game.phase.type === 'final_choice') return finalChoiceFor(view) === 'group'
      ? `${address}You have persuaded me to protect the group. That is my intention; the final reveal will test it.`
      : `${address}I want to survive, but I cannot promise I will sacrifice my own qualification. My final directive is pulling the other way.`;
    if (!game.trial) return `${address}I am leaning toward protecting the group. We have not received the final directives yet, so I will not make an easy promise.`;
    const allocation = me.decision ?? allocationFor(view);
    return allocation.medical > 0 && allocation.security > 0
      ? `${address}I intend to support both Medical and Security. Survival comes first, but you will have to judge me by what is revealed.`
      : `${address}I want the group alive, but my directive does not make this easy. I cannot promise support for both systems.`;
  }
  if (/why|what happened|result|last trial/.test(request.message.text.toLocaleLowerCase())) {
    const outcome = publicOutcome(view);
    return `${address}${outcome ? `The latest public resource record says: ${outcome}` : `Stability is ${game.stability}. We have no resolved resource totals yet.`} It does not identify every private action.`;
  }
  return `${address}${pick(view, `answer:${request.message.id}`, [
    'Ask me to help Medical, Security, or protect the group. I will answer before I lock a choice, if I can.',
    'I am listening. Tell me which public problem you want us to solve; I cannot see anyone else’s private orders.',
    'You can question me, but judge accusations against the public record. My promises are not official contracts.',
  ])}`;
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
      return { type: 'statement', text: finalStatement(view) };
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
  if (!['discussion', 'decision', 'reveal', 'vote', 'extension_vote', 'final_interrogation', 'final_choice'].includes(phaseType)) return false;
  // Ordinary inputs cannot sneak through an expired phase if a caller forgot
  // to run tick first. The final-choice deadline is only a warning by design.
  if (phaseType !== 'final_choice' && game.phase.deadline !== null && now >= game.phase.deadline) return false;
  let changed = false;
  for (const candidate of room.members) {
    if (room.game?.phase.id !== phaseId || room.game.paused || room.game.outcome !== null) break;
    if (candidate.controller !== 'cpu' || candidate.removed || candidate.role !== 'subject' || !game.phase.eligibleIds.includes(candidate.id) || game.subjects[candidate.id]?.withdrawn) continue;
    const view = projectRoom(room, candidate.id);
    if (!view.me) continue;
    if (!room.chatMuted && ['discussion', 'decision', 'final_interrogation', 'final_choice'].includes(phaseType)) {
      const previous = candidate.cpuReplyState;
      const count = previous?.phaseId === phaseId ? previous.count : 0;
      const latestRequest = publicRequests(view).at(-1);
      // Answer the newest question, rather than queuing stale replies to every
      // earlier click when a human quickly changes their appeal.
      const request = count < 2 && latestRequest && !previous?.repliedIds.includes(latestRequest.message.id) ? latestRequest : undefined;
      if (request && now >= request.message.at + 1_000 + hash(`${candidate.id}:${request.message.id}`) % 2_001) {
        applyCommand(room, candidate.id, { commandId: randomUUID(), gameId: game.id, phaseId, action: { type: 'chat', text: replyLine(view, request) } }, now);
        candidate.cpuReplyState = { phaseId, count: count + 1, repliedIds: [...(previous?.repliedIds ?? []), request.message.id].slice(-16) };
        if (phaseType === 'discussion') candidate.cpuLastDiscussionPhase = phaseId;
        changed = true;
        continue;
      }
    }
    const due = game.phase.openedAt + 2_000 + hash(`${candidate.id}:${phaseId}`) % 3_001;
    if (now < due) continue;
    let action: Action | null;
    if (phaseType === 'discussion' || phaseType === 'reveal') {
      if (room.chatMuted || candidate.cpuLastDiscussionPhase === phaseId) continue;
      action = { type: 'chat', text: phaseType === 'reveal' ? revealLine(view) : discussionLine(view) };
    } else action = actionFor(view);
    if (!action) continue;
    applyCommand(room, candidate.id, { commandId: randomUUID(), gameId: game.id, phaseId, action }, now);
    if (phaseType === 'discussion' || phaseType === 'reveal') candidate.cpuLastDiscussionPhase = phaseId;
    changed = true;
  }
  return changed;
}
