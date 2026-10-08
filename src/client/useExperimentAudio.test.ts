import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, PHASE_LABELS, type ChatMessage, type PhaseType, type RoomView } from '../shared/protocol';
import { createSurvivalWorld, projectSurvivalWorld } from '../server/survival';
import { phaseNarration, publicCpuLine, publicSurvivorLine, type PublicAudioView } from './useExperimentAudio';

function publicView(): PublicAudioView {
  return {
    id: 'room', code: 'ABC123', status: 'running', chatMuted: false, chat: [],
    members: [
      { id: 'human', nickname: 'Person', subjectNumber: 1, role: 'subject', controller: 'human', ready: true, removed: false, connected: true },
      { id: 'cpu', nickname: 'Echo', subjectNumber: 2, role: 'subject', controller: 'cpu', ready: true, removed: false, connected: true },
    ],
    game: {
      id: 'game', round: 1, initialRounds: 3, totalRounds: 3, roundCap: 20, stability: 60, maxStability: 100, outcome: 'active',
      phase: { id: 'phase', type: 'crisis', deadline: 10000, paused: false, remainingMs: null, eligibleIds: ['human', 'cpu'], speakerId: null },
      trial: { id: 'trial', title: 'Oxygen leak', narrative: 'The chamber pressure is falling.', medicalTarget: 4, securityTarget: 4 },
      voteType: null, voteTargets: [], allocationTotals: null, extension: null, results: [], fullReveal: [],
    },
  };
}
const message: ChatMessage = { id: 'chat', senderId: 'cpu', nickname: 'Echo', text: 'We need one Medical unit from everyone.', at: 2000, type: 'chat' };

function survivalView(): PublicAudioView {
  const view = publicView(); view.game = null;
  view.survival = projectSurvivalWorld(createSurvivalWorld(['human'], 'farmhouse', 60, 1000));
  view.survival.survivors.push({ id: 'npc', name: 'Mara', role: 'medic', level: 1, x: 500, y: 500, hp: 100 });
  return view;
}

describe('public audio privacy boundary', () => {
  it('can narrate every phase without accessing any private player fields', () => {
    const view = { ...publicView(), hostId: 'human', settings: DEFAULT_SETTINGS, selfId: 'human' } as RoomView;
    Object.defineProperty(view, 'me', { get: () => { throw new Error('Audio accessed a private player record'); } });
    for (const type of Object.keys(PHASE_LABELS) as PhaseType[]) {
      view.game!.phase.type = type;
      expect(phaseNarration(view)).toEqual(expect.any(String));
    }
    expect(publicCpuLine(view, message)?.text).toBe(message.text);
  });

  it('narrates revealed aggregate allocations without assuming private decisions', () => {
    const view = publicView();
    view.game!.phase.type = 'reveal';
    view.game!.allocationTotals = { medical: 4, security: 5, reserve: 3 };
    expect(phaseNarration(view)).toContain('Medical received 4. Security received 5. Reserve received 3.');
    view.game!.allocationTotals = null;
    expect(phaseNarration(view)).not.toContain('received');
  });

  it('only voices current CPU public messages, never human or removed member messages', () => {
    const view = publicView();
    expect(publicCpuLine(view, message)?.speakerId).toBe('cpu');
    expect(publicCpuLine(view, { ...message, senderId: 'human' })).toBeNull();
    expect(publicCpuLine(view, { ...message, senderId: 'unknown' })).toBeNull();
    view.members[1]!.removed = true;
    expect(publicCpuLine(view, message)).toBeNull();
  });

  it('stops treating a CPU seat as an automatic voice after a human takes it over', () => {
    const view = publicView();
    view.members[1]!.controller = 'human';
    expect(publicCpuLine(view, message)).toBeNull();
  });

  it('does not voice messages while the public chat is muted and bounds long speaking turns', () => {
    const view = publicView(); view.chatMuted = true;
    expect(publicCpuLine(view, message)).toBeNull();
    view.chatMuted = false;
    const originalText = 'A lengthy public negotiation. '.repeat(20);
    const longMessage = { ...message, text: originalText };
    expect(publicCpuLine(view, longMessage)!.text.length).toBeLessThanOrEqual(220);
    expect(publicCpuLine(view, longMessage)!.text.endsWith('…')).toBe(true);
    expect(longMessage.text).toBe(originalText);
  });

  it('explains the current mixed vote and sealed abort rules accurately', () => {
    const view = publicView();
    view.game!.phase.type = 'vote'; view.game!.voteType = 'exposure';
    expect(phaseNarration(view)).toContain('previous directive');
    view.game!.voteType = 'restriction';
    expect(phaseNarration(view)).toContain('next Trial');
    view.game!.voteType = 'trust';
    expect(phaseNarration(view)).toContain('unique leader');
    view.game!.phase.type = 'aborted';
    expect(phaseNarration(view)).toContain('remain sealed');
  });

  it('voices public survival events without accessing either private player record', () => {
    const view = survivalView() as RoomView;
    for (const field of ['me', 'survivorMe']) Object.defineProperty(view, field, { get: () => { throw new Error(`Audio accessed ${field}`); } });
    const event = { id: 'greeting', at: 1000, kind: 'survivor_dialogue', speakerId: 'npc', text: 'I can help treat the wounded. Keep our shelter supplied.' };
    expect(phaseNarration(view)).toEqual(expect.any(String));
    expect(publicSurvivorLine(view, event)).toEqual({ key: 'greeting', speakerId: 'npc', text: event.text });
  });

  it('attributes NPC dialogue only to a living, publicly recruited survivor', () => {
    const view = survivalView();
    const event = { id: 'greeting', at: 1000, kind: 'survivor_dialogue', speakerId: 'npc', text: 'I will protect the shelter.' };
    expect(publicSurvivorLine(view, event)?.speakerId).toBe('npc');
    expect(publicSurvivorLine(view, { ...event, speakerId: 'unrecruited' })).toBeNull();
    expect(publicSurvivorLine(view, { ...event, speakerId: undefined })).toBeNull();
    expect(publicSurvivorLine(view, { ...event, kind: 'loot' })).toBeNull();
    view.survival!.survivors[0]!.hp = 0;
    expect(publicSurvivorLine(view, event)).toBeNull();
  });

  it('announces actual progression event kinds and ignores frequent loot updates', () => {
    const view = survivalView(); const world = view.survival!;
    for (const kind of ['new_day', 'project_complete', 'rescue', 'shelter_move', 'horde-complete']) {
      const text = `Public update: ${kind}`;
      world.events = [{ id: kind, at: 1000, kind, text }, { id: 'loot', at: 1100, kind: 'loot', text: 'A supply cache was opened.' }];
      expect(phaseNarration(view)).toBe(text);
    }
    world.wave.active = true; world.wave.number = 3;
    world.events = [{ id: 'horde', at: 2000, kind: 'horde-start', text: 'A horde is incoming.' }];
    expect(phaseNarration(view)).toContain('Horde wave 3 incoming');
    world.events.push({ id: 'built', at: 2100, kind: 'project_complete', text: 'Barricade completed.' });
    expect(phaseNarration(view)).toBe('Barricade completed.');
    world.active = false;
    expect(phaseNarration(view)).toContain('shelter has fallen');
  });

  it('keeps NPC story dialogue available when player chat is muted and limits spoken length', () => {
    const view = survivalView(); view.chatMuted = true;
    const event = { id: 'greeting', at: 1000, kind: 'survivor_dialogue', speakerId: 'npc', text: 'We can survive if we protect this shelter. '.repeat(15) };
    const original = event.text;
    expect(publicSurvivorLine(view, event)!.text.length).toBeLessThanOrEqual(220);
    expect(publicSurvivorLine(view, event)!.text.endsWith('…')).toBe(true);
    expect(event.text).toBe(original);
  });
});
