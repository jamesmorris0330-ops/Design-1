import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, RoomView } from '../shared/protocol';
import type { SurvivalEvent } from '../shared/survival';

// Deliberately omit the private player record from the entire audio pipeline.
export type PublicAudioView = Pick<RoomView, 'id' | 'code' | 'status' | 'game' | 'members' | 'chat' | 'chatMuted' | 'survival'>;
type Cue = 'confirm' | 'click' | 'impact' | 'shot';
type SpeechLine = { text: string; speakerId: string; key: string };
type AudioEngine = { context: AudioContext; master: GainNode; ambient: { nodes: AudioNode[]; sources: OscillatorNode[]; pulse: OscillatorNode } | null };
type AudioPreferences = { volume: number; voices: boolean };
const preferenceKey = 'experiment:audio-preferences';
const narratedSurvivalKinds = new Set(['start', 'new_day', 'horde-start', 'horde-complete', 'rescue', 'project_complete', 'shelter_move', 'goal_claim', 'survival-ended']);

function readPreferences(): AudioPreferences {
  try {
    const parsed = JSON.parse(localStorage.getItem(preferenceKey) ?? '{}') as Partial<AudioPreferences>;
    return { volume: typeof parsed.volume === 'number' && Number.isFinite(parsed.volume) ? Math.min(1, Math.max(0, parsed.volume)) : 0.55, voices: parsed.voices !== false };
  } catch { return { volume: 0.55, voices: true }; }
}

/** All spoken instructions describe public rules; individual directives stay on screen. */
export function phaseNarration(view: PublicAudioView): string | null {
  if (view.survival) {
    const world = view.survival;
    if (!world.active) return 'The shelter has fallen. Your expedition is over. Return to the lobby to begin again.';
    const update = world.events.findLast(event => narratedSurvivalKinds.has(event.kind));
    if (world.wave.active && (!update || update.kind === 'horde-start')) return `Horde wave ${world.wave.number} incoming. Defend your shelter and protect your crew.`;
    return update?.text ?? `Day ${world.day}. Explore, collect supplies, recruit survivors, and defend your shelter. Use your weapons to fight infected enemies.`;
  }
  const game = view.game;
  if (!game) return view.status === 'lobby' ? 'Welcome to the Experiment. Choose your shelter. Gather your crew. Scavenge, build, and fight to survive another day.' : null;
  switch (game.phase.type) {
    case 'crisis': return `Trial ${game.round}. ${game.trial?.title ?? 'A new crisis'}. ${game.trial?.narrative ?? 'The chamber is waiting for your response.'}`;
    case 'directive': return 'Private instructions have been issued. Read yours silently. A directive can reward you while putting everyone else at risk.';
    case 'discussion': return 'The public channel is open. Question another Subject. Negotiate a plan. Remember: promises are not binding.';
    case 'decision': return 'Route your three energy units. Medical and Security need the whole group. Reserve serves your private plan. Lock your allocation before time expires.';
    case 'reveal': return game.allocationTotals ? `The allocations are revealed. Medical received ${game.allocationTotals.medical}. Security received ${game.allocationTotals.security}. Reserve received ${game.allocationTotals.reserve}. Group Stability is ${game.stability}.` : 'The Trial has resolved. Review the public record.';
    case 'vote': return game.voteType === 'exposure' ? 'Exposure vote. Choose a Subject whose previous directive should be revealed.' : game.voteType === 'restriction' ? 'Restriction vote. Choose a Subject who must commit a Medical unit next Trial.' : 'Trust vote. Choose the Subject you trust. A unique leader receives one Compliance point.';
    case 'consequences': return 'Your votes have consequences. The public record has been updated.';
    case 'dossier': return 'Review your private dossier. The next Trial is approaching.';
    case 'extension_offer': return 'Do you need more time? The group can consent to extra Trials before the finale. Your Compliance requirement will stay fixed.';
    case 'extension_vote': return 'Extension vote. A strict majority of Subjects must agree to continue.';
    case 'final_interrogation': return 'Final interrogation. Each Subject gets one last public statement. Say what you need them to hear.';
    case 'final_directive': return 'Your final private instruction is ready. The last choice belongs to you.';
    case 'final_choice': return 'The final choice. Protect the group, or protect yourself. Your choice remains secret until every Subject has locked in.';
    case 'final_resolution': return game.outcome === 'failed' ? 'Group Stability has collapsed. The Experiment is over.' : `The final choices have resolved. Group Stability is ${game.stability}.`;
    case 'personal_results': return 'The group result is decided. Review your own Compliance result privately.';
    case 'full_reveal': return game.outcome === 'survived' ? 'The group survived. The full record is now open. Discover who qualified, who protected you, and who followed a different plan.' : 'The group did not survive. The full record is now open. Review the decisions that brought the chamber down.';
    case 'aborted': return 'The host has ended the Experiment. Unrevealed private records remain sealed.';
  }
}

export function publicCpuLine(view: PublicAudioView, message: ChatMessage): SpeechLine | null {
  if (view.chatMuted || !view.members.some(member => member.id === message.senderId && member.controller === 'cpu' && !member.removed)) return null;
  // Keep speaking turns brief. The complete, unabridged line remains in public chat.
  const text = message.text.length > 220 ? `${message.text.slice(0, 217).replace(/\s+\S*$/, '')}…` : message.text;
  return { text, speakerId: message.senderId, key: message.id };
}

export function publicSurvivorLine(view: PublicAudioView, event: SurvivalEvent): SpeechLine | null {
  if (event.kind !== 'survivor_dialogue' || !event.speakerId || !view.survival?.survivors.some(survivor => survivor.id === event.speakerId && survivor.hp > 0)) return null;
  const text = event.text.length > 220 ? `${event.text.slice(0, 217).replace(/\s+\S*$/, '')}…` : event.text;
  return { text, speakerId: event.speakerId, key: event.id };
}

function publicSpeakerAllowed(view: PublicAudioView | null, speakerId: string | null): boolean {
  if (!view || !speakerId) return false;
  if (speakerId === 'experiment') return true;
  if (view.survival?.survivors.some(survivor => survivor.id === speakerId && survivor.hp > 0)) return true;
  return !view.chatMuted && view.members.some(member => member.id === speakerId && member.controller === 'cpu' && !member.removed);
}

function ambientPulse(view: PublicAudioView | null): number {
  if (view?.survival) return view.survival.wave.active || view.survival.shelter.hp <= view.survival.shelter.maxHp * 0.3 ? 1.6 : 0.65;
  return (view?.game?.stability ?? 60) <= 30 ? 1.6 : 0.65;
}

function identityHash(value: string): number {
  let result = 0;
  for (const character of value) result = ((result << 5) - result + character.charCodeAt(0)) | 0;
  return Math.abs(result);
}

export function useExperimentAudio(view: RoomView | null) {
  const preferences = useRef<AudioPreferences | null>(null);
  preferences.current ??= readPreferences();
  // A fresh page always needs a user gesture, even when the user previously enabled audio.
  const [enabled, setEnabled] = useState(false);
  const [voicesEnabled, setVoicesEnabled] = useState(preferences.current.voices);
  const [volume, updateVolume] = useState(preferences.current.volume);
  const [voiceAvailable, setVoiceAvailable] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const enabledRef = useRef(false);
  const voicesEnabledRef = useRef(voicesEnabled);
  const volumeRef = useRef(volume);
  const engine = useRef<AudioEngine | null>(null);
  const availableVoices = useRef<SpeechSynthesisVoice[]>([]);
  const speechQueue = useRef<SpeechLine[]>([]);
  const currentSpeech = useRef<SpeechSynthesisUtterance | null>(null);
  const currentSpeaker = useRef<string | null>(null);
  const speechTimeout = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextSpeech = useRef<() => void>(() => undefined);
  const seenChats = useRef<Set<string>>(new Set());
  const seenSurvivalEvents = useRef<Set<string>>(new Set());
  const observedContext = useRef<string | null>(null);
  const narratedPhase = useRef<string | null>(null);
  const soundedPhase = useRef<string | null>(null);
  const lastShotCue = useRef(0);
  const lastImpactCue = useRef(-650);
  const previousShelterHP = useRef<number | null>(null);
  const previousStability = useRef<{ gameId: string; value: number } | null>(null);
  const publicView = useRef<PublicAudioView | null>(null);
  publicView.current = view ? { id: view.id, code: view.code, status: view.status, game: view.game, members: view.members, chat: view.chat, chatMuted: view.chatMuted, survival: view.survival } : null;

  const stopSpeech = useCallback(() => {
    speechQueue.current = [];
    if (speechTimeout.current) clearTimeout(speechTimeout.current);
    speechTimeout.current = null;
    const utterance = currentSpeech.current;
    currentSpeech.current = null;
    currentSpeaker.current = null;
    if (utterance) { utterance.onend = null; utterance.onerror = null; utterance.onstart = null; }
    if (typeof window !== 'undefined' && 'speechSynthesis' in window) window.speechSynthesis.cancel();
    setSpeakingId(null);
  }, []);

  const stopAmbience = useCallback(() => {
    const ambient = engine.current?.ambient;
    if (!ambient) return;
    ambient.sources.forEach(source => { try { source.stop(); } catch { /* Already stopped. */ } });
    ambient.nodes.forEach(node => node.disconnect());
    if (engine.current) engine.current.ambient = null;
  }, []);

  const canPlay = useCallback(() => enabledRef.current && !document.hidden && !publicView.current?.game?.phase.paused && !publicView.current?.survival?.paused, []);

  const startAmbience = useCallback(() => {
    const audio = engine.current;
    if (!audio || audio.ambient || !canPlay() || audio.context.state !== 'running') return;
    const base = audio.context.createOscillator(); base.type = 'sine'; base.frequency.value = 58;
    const overtone = audio.context.createOscillator(); overtone.type = 'sine'; overtone.frequency.value = 116.3;
    const baseGain = audio.context.createGain(); baseGain.gain.value = 0.014;
    const overtoneGain = audio.context.createGain(); overtoneGain.gain.value = 0.003;
    const pulse = audio.context.createOscillator(); pulse.frequency.value = ambientPulse(publicView.current);
    const pulseGain = audio.context.createGain(); pulseGain.gain.value = 0.005;
    pulse.connect(pulseGain); pulseGain.connect(baseGain.gain);
    base.connect(baseGain); overtone.connect(overtoneGain); baseGain.connect(audio.master); overtoneGain.connect(audio.master);
    base.start(); overtone.start(); pulse.start();
    audio.ambient = { sources: [base, overtone, pulse], nodes: [base, overtone, pulse, baseGain, overtoneGain, pulseGain], pulse };
  }, [canPlay]);

  const playCue = useCallback((cue: Cue) => {
    const audio = engine.current;
    if (!audio || !canPlay() || audio.context.state !== 'running') return;
    const now = audio.context.currentTime;
    const tone = (frequency: number, delay: number, duration: number, strength: number, ending = frequency) => {
      const oscillator = audio.context.createOscillator(); const gain = audio.context.createGain();
      oscillator.type = cue === 'impact' || cue === 'shot' ? 'triangle' : 'sine';
      oscillator.frequency.setValueAtTime(frequency, now + delay);
      oscillator.frequency.exponentialRampToValueAtTime(Math.max(1, ending), now + delay + duration);
      gain.gain.setValueAtTime(0.0001, now + delay);
      gain.gain.exponentialRampToValueAtTime(strength, now + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + duration);
      oscillator.connect(gain); gain.connect(audio.master);
      oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
      oscillator.start(now + delay); oscillator.stop(now + delay + duration + 0.025);
    };
    if (cue === 'click') tone(520, 0, 0.07, 0.085, 660);
    if (cue === 'confirm') [420, 630, 840].forEach((frequency, index) => tone(frequency, index * 0.06, 0.14, 0.085));
    if (cue === 'shot') { tone(170, 0, 0.09, 0.20, 45); tone(800, 0, 0.025, 0.035, 90); }
    if (cue === 'impact') { tone(170, 0, 0.36, 0.24, 38); tone(83, 0.07, 0.34, 0.16, 29); }
  }, [canPlay]);

  const pumpSpeech = useCallback(() => {
    if (currentSpeech.current || !canPlay() || !voicesEnabledRef.current || volumeRef.current === 0 || !availableVoices.current.length || !('speechSynthesis' in window)) return;
    const line = speechQueue.current.shift();
    if (!line) return;
    if (!publicSpeakerAllowed(publicView.current, line.speakerId)) { nextSpeech.current(); return; }
    const utterance = new SpeechSynthesisUtterance(line.text);
    const english = availableVoices.current.filter(voice => /^en(?:-|_)/i.test(voice.lang));
    const choices = english.length ? english : availableVoices.current;
    const hash = line.speakerId === 'experiment' ? 0 : identityHash(line.speakerId);
    utterance.voice = choices[hash % choices.length];
    utterance.rate = line.speakerId === 'experiment' ? 0.92 : 0.98 + (hash % 3) * 0.04;
    utterance.pitch = line.speakerId === 'experiment' ? 0.72 : 0.84 + (hash % 5) * 0.11;
    utterance.volume = volumeRef.current;
    const complete = () => {
      if (currentSpeech.current !== utterance) return;
      if (speechTimeout.current) clearTimeout(speechTimeout.current);
      speechTimeout.current = null; currentSpeech.current = null; currentSpeaker.current = null; setSpeakingId(null);
      nextSpeech.current();
    };
    utterance.onstart = () => { if (currentSpeech.current === utterance) setSpeakingId(line.speakerId); };
    utterance.onend = complete; utterance.onerror = complete;
    currentSpeech.current = utterance;
    currentSpeaker.current = line.speakerId;
    // Some browser drivers never fire a completion event. A stuck voice must not block play.
    speechTimeout.current = setTimeout(() => {
      if (currentSpeech.current !== utterance) return;
      utterance.onend = null; utterance.onerror = null; window.speechSynthesis.cancel(); complete();
    }, Math.max(7000, Math.min(26000, line.text.length * 85)));
    try { window.speechSynthesis.speak(utterance); } catch { complete(); }
  }, [canPlay]);
  nextSpeech.current = pumpSpeech;

  const enqueue = useCallback((line: SpeechLine, priority = false) => {
    if (!canPlay() || !voicesEnabledRef.current || volumeRef.current === 0 || !availableVoices.current.length) return;
    if (priority) { stopSpeech(); speechQueue.current.push(line); }
    else { speechQueue.current.push(line); if (speechQueue.current.length > 3) speechQueue.current.shift(); }
    nextSpeech.current();
  }, [canPlay, stopSpeech]);

  const enable = useCallback(() => {
    enabledRef.current = true; setEnabled(true);
    if (!engine.current) {
      const AudioConstructor = window.AudioContext ?? (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (AudioConstructor) {
        try {
          const context = new AudioConstructor(); const master = context.createGain();
          master.gain.value = volumeRef.current * 0.7; master.connect(context.destination);
          engine.current = { context, master, ambient: null };
        } catch { /* Captions and device speech can still work without a sound context. */ }
      }
    }
    const context = engine.current?.context;
    if (context) void context.resume().then(() => { startAmbience(); playCue('confirm'); }).catch(() => undefined);
  }, [playCue, startAmbience]);

  const toggle = useCallback(() => {
    if (!enabledRef.current) { enable(); return; }
    enabledRef.current = false; setEnabled(false); stopSpeech(); stopAmbience();
    if (engine.current) void engine.current.context.suspend().catch(() => undefined);
  }, [enable, stopAmbience, stopSpeech]);

  const toggleVoices = useCallback(() => {
    voicesEnabledRef.current = !voicesEnabledRef.current; setVoicesEnabled(voicesEnabledRef.current);
    if (!voicesEnabledRef.current) stopSpeech();
    else narratedPhase.current = null;
  }, [stopSpeech]);

  const setVolume = useCallback((value: number) => {
    const next = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    volumeRef.current = next; updateVolume(next);
    if (engine.current) engine.current.master.gain.setTargetAtTime(next * 0.7, engine.current.context.currentTime, 0.03);
    if (next === 0) stopSpeech();
    else if (currentSpeech.current) currentSpeech.current.volume = next;
  }, [stopSpeech]);

  useEffect(() => {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ volume, voices: voicesEnabled })); } catch { /* Optional browser storage. */ }
  }, [volume, voicesEnabled]);

  useEffect(() => {
    if (!('speechSynthesis' in window)) return;
    const refresh = () => {
      availableVoices.current = window.speechSynthesis.getVoices();
      setVoiceAvailable(availableVoices.current.length > 0);
    };
    refresh(); window.speechSynthesis.addEventListener('voiceschanged', refresh);
    return () => window.speechSynthesis.removeEventListener('voiceschanged', refresh);
  }, []);

  useEffect(() => {
    const snapshot = publicView.current;
    const contextKey = snapshot ? `${snapshot.id}:${snapshot.survival?.id ?? snapshot.game?.id ?? 'lobby'}` : 'landing';
    const contextChanged = contextKey !== observedContext.current;
    if (contextChanged) {
      stopSpeech(); observedContext.current = contextKey; narratedPhase.current = null; soundedPhase.current = null;
      previousStability.current = null; previousShelterHP.current = null; lastShotCue.current = 0; lastImpactCue.current = -650;
      seenChats.current = new Set(snapshot?.chat.map(message => message.id) ?? []);
      seenSurvivalEvents.current = new Set(snapshot?.survival?.events.map(event => event.id) ?? []);
    }
    if (!snapshot) { stopAmbience(); return; }
    if (snapshot.game?.phase.paused || snapshot.survival?.paused || document.hidden || !enabled) {
      stopSpeech(); stopAmbience();
      snapshot.chat.forEach(message => seenChats.current.add(message.id));
      snapshot.survival?.events.forEach(event => seenSurvivalEvents.current.add(event.id));
      if (snapshot.game) previousStability.current = { gameId: snapshot.game.id, value: snapshot.game.stability };
      if (snapshot.survival) previousShelterHP.current = snapshot.survival.shelter.hp;
      return;
    }
    startAmbience();
    if (engine.current?.ambient) engine.current.ambient.pulse.frequency.setTargetAtTime(ambientPulse(snapshot), engine.current.context.currentTime, 0.15);
    const survivalEvent = snapshot.survival?.events.findLast(event => narratedSurvivalKinds.has(event.kind));
    const phaseKey = snapshot.survival ? `${snapshot.survival.id}:${survivalEvent?.id ?? 'start'}` : snapshot.game?.phase.id ?? 'lobby';
    if (snapshot.survival) {
      const world = snapshot.survival;
      if (world.players.some(player => player.firing) && world.elapsedMs - lastShotCue.current >= 200) { playCue('shot'); lastShotCue.current = world.elapsedMs; }
      if (previousShelterHP.current !== null && world.shelter.hp < previousShelterHP.current && world.elapsedMs - lastImpactCue.current >= 650) { playCue('impact'); lastImpactCue.current = world.elapsedMs; }
      previousShelterHP.current = world.shelter.hp;
    }
    if (phaseKey !== narratedPhase.current && voicesEnabled && voiceAvailable && volume > 0) {
      narratedPhase.current = phaseKey;
      const text = phaseNarration(snapshot);
      if (text) enqueue({ text, speakerId: 'experiment', key: phaseKey }, true);
    }
    if (phaseKey !== soundedPhase.current) {
      soundedPhase.current = phaseKey;
      if (!contextChanged && snapshot.game) playCue(snapshot.game.phase.type === 'crisis' || snapshot.game.outcome === 'failed' ? 'impact' : snapshot.game.phase.type === 'reveal' || snapshot.game.phase.type === 'full_reveal' ? 'confirm' : 'click');
      if (!contextChanged && snapshot.survival && survivalEvent) playCue(survivalEvent.kind === 'horde-start' || survivalEvent.kind === 'survival-ended' ? 'impact' : survivalEvent.kind === 'project_complete' || survivalEvent.kind === 'horde-complete' ? 'confirm' : 'click');
    }
    if (snapshot.game) {
      const last = previousStability.current;
      if (last?.gameId === snapshot.game.id && last.value !== snapshot.game.stability) playCue(snapshot.game.stability < last.value ? 'impact' : 'confirm');
      previousStability.current = { gameId: snapshot.game.id, value: snapshot.game.stability };
    }
    if (currentSpeech.current && !publicSpeakerAllowed(snapshot, currentSpeaker.current)) stopSpeech();
    if (!voicesEnabled || !voiceAvailable || volume === 0) stopSpeech();
    for (const message of snapshot.chat) {
      if (seenChats.current.has(message.id)) continue;
      seenChats.current.add(message.id);
      const line = publicCpuLine(snapshot, message);
      if (line) enqueue(line);
    }
    for (const event of snapshot.survival?.events ?? []) {
      if (seenSurvivalEvents.current.has(event.id)) continue;
      seenSurvivalEvents.current.add(event.id);
      const line = publicSurvivorLine(snapshot, event);
      if (line) enqueue(line);
    }
    // Bound memory without replaying chat entries still retained by the server.
    if (seenChats.current.size > 500) seenChats.current = new Set(snapshot.chat.map(message => message.id));
    if (seenSurvivalEvents.current.size > 500) seenSurvivalEvents.current = new Set(snapshot.survival?.events.map(event => event.id) ?? []);
  }, [view, enabled, voicesEnabled, voiceAvailable, volume, enqueue, playCue, startAmbience, stopAmbience, stopSpeech]);

  useEffect(() => {
    const visibility = () => {
      if (document.hidden) {
        stopSpeech(); stopAmbience();
        if (engine.current) void engine.current.context.suspend().catch(() => undefined);
      } else if (enabledRef.current && !publicView.current?.game?.phase.paused && !publicView.current?.survival?.paused) {
        if (engine.current) void engine.current.context.resume().then(startAmbience).catch(() => undefined);
        const snapshot = publicView.current;
        snapshot?.chat.forEach(message => seenChats.current.add(message.id));
        snapshot?.survival?.events.forEach(event => seenSurvivalEvents.current.add(event.id));
      }
    };
    document.addEventListener('visibilitychange', visibility);
    return () => document.removeEventListener('visibilitychange', visibility);
  }, [startAmbience, stopAmbience, stopSpeech]);

  useEffect(() => () => {
    enabledRef.current = false; stopSpeech(); stopAmbience();
    if (engine.current) void engine.current.context.close().catch(() => undefined);
    engine.current = null;
  }, [stopAmbience, stopSpeech]);

  return { enabled, voicesEnabled, volume, setVolume, enable, toggle, toggleVoices, speakingId, playCue, voiceAvailable };
}
