import { useEffect, useState } from 'react';
import { PHASE_LABELS, type Action, type PublicMember, type RoomView } from '../shared/protocol';
import { CharacterPortrait } from './CharacterPortrait';
import './chamber.css';

interface ExperimentChamberProps {
  view: RoomView | null;
  speakingId?: string | null;
  send?: (action: Action) => boolean;
  online?: boolean;
}

const DEMO_SUBJECTS: PublicMember[] = [
  { id: 'experiment-iris', nickname: 'IRIS', subjectNumber: 1, role: 'subject', controller: 'cpu', ready: true, removed: false, connected: true },
  { id: 'experiment-milo', nickname: 'MILO', subjectNumber: 2, role: 'subject', controller: 'cpu', ready: true, removed: false, connected: true },
  { id: 'experiment-nova', nickname: 'NOVA', subjectNumber: 3, role: 'subject', controller: 'cpu', ready: true, removed: false, connected: true },
];

const STATIONS = [
  { key: 'medical' as const, name: 'Medical', label: 'Life support', icon: 'cross' },
  { key: 'security' as const, name: 'Security', label: 'Containment', icon: 'shield' },
  { key: 'reserve' as const, name: 'Reserve', label: 'Stored energy', icon: 'battery' },
];

function StationIcon({ type }: { type: string }) {
  return <svg viewBox="0 0 40 40" aria-hidden="true" focusable="false">
    {type === 'cross' ? <path d="M15 6H25V15H34V25H25V34H15V25H6V15H15Z" /> : type === 'shield' ? <><path d="M20 4 33 9V21Q32 30 20 36Q8 30 7 21V9Z" /><path d="m14 20 4 4 9-10" /></> : <><rect x="9" y="8" width="22" height="27" rx="3" /><path d="M16 4H24M15 15H25M15 22H25M15 29H25" /></>}
  </svg>;
}

function Reactor({ stability, failed }: { stability: number; failed: boolean }) {
  const arc = Math.max(0, Math.min(stability, 100)) / 100 * 540;
  return <div className={`chamber-reactor ${failed ? 'reactor-failed' : ''}`} aria-hidden="true">
    <div className="reactor-rays" />
    <svg viewBox="0 0 240 240" className="reactor-rings">
      <defs><radialGradient id="chamber-core-light"><stop stopColor="#edffff" /><stop offset=".2" stopColor="#68f6e8" stopOpacity=".9" /><stop offset="1" stopColor="#3ccbc7" stopOpacity="0" /></radialGradient></defs>
      <circle cx="120" cy="120" r="108" className="reactor-orbit outer" />
      <circle cx="120" cy="120" r="94" className="reactor-orbit inner" />
      <circle cx="120" cy="120" r="86" className="reactor-progress-track" />
      <circle cx="120" cy="120" r="86" className="reactor-progress" strokeDasharray={`${arc} 540`} transform="rotate(-90 120 120)" />
      <circle cx="120" cy="120" r="76" fill="url(#chamber-core-light)" />
      <g className="reactor-structure"><path d="M120 67 164 93 164 145 120 171 76 145 76 93Z" /><path d="M120 67V119L164 145M120 119 76 145M76 93 120 119 164 93M120 119V171" /></g>
      <circle cx="120" cy="120" r="5" fill="#e9fffc" />
      {[0, 1, 2, 3].map(index => <g key={index} transform={`rotate(${index * 90} 120 120)`}><path d="M120 5V13 M115 8H125" stroke="currentColor" strokeWidth="1" /><circle cx="120" cy="28" r="2" fill="currentColor" /></g>)}
    </svg>
    <div className="reactor-plinth"><span /><span /><span /></div>
  </div>;
}

/** Displays only public information. Never read private directives or personal decisions here. */
export function ExperimentChamber({ view, speakingId = null, send, online = true }: ExperimentChamberProps) {
  const game = view?.game ?? null;
  const members = view ? view.members.filter(member => member.role === 'subject' && !member.removed) : DEMO_SUBJECTS;
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [promptSent, setPromptSent] = useState(false);
  const focusId = focusedId ?? (speakingId && members.some(member => member.id === speakingId) ? speakingId : null);
  const focused = members.find(member => member.id === focusId) ?? members.find(member => member.controller === 'cpu') ?? members[0];
  const stability = game?.stability ?? 60;
  const mood = stability <= 30 ? 'critical' : stability <= 55 ? 'tense' : 'calm';
  const ended = game?.outcome === 'failed';
  const phase = game?.phase.type;
  const publicLine = focused ? view?.chat.filter(message => message.senderId === focused.id).at(-1) : null;
  const publicReveal = game?.allocationTotals;
  const latestEvent = view?.events.at(-1);
  const sceneLabel = !view ? 'THE EXPERIMENT · Chamber preview' : game ? `Experiment chamber · Stability ${stability} · ${PHASE_LABELS[game.phase.type]}` : 'Experiment chamber · Waiting for Subjects';
  const signalLabel = game?.phase.paused ? 'PROTOCOL PAUSED' : ended ? 'CONTAINMENT LOST' : game?.outcome === 'survived' ? 'SUBJECTS RELEASED' : view?.status === 'lobby' ? 'AWAITING SUBJECTS' : phase === 'decision' || phase === 'final_choice' ? 'PRIVATE DECISIONS' : phase === 'reveal' || phase === 'final_resolution' ? 'RESOLVING TRIAL' : phase === 'discussion' ? 'COMMUNICATION OPEN' : 'OBSERVATION ACTIVE';
  const conversationOpen = Boolean(phase && ['discussion', 'decision', 'final_interrogation', 'final_choice'].includes(phase));
  const self = view?.members.find(member => member.id === view.selfId);
  const canTalk = Boolean(view?.status === 'running' && self?.role === 'subject' && self.controller === 'human' && !self.removed && send && online && conversationOpen && !view?.chatMuted && !game?.phase.paused && focused?.controller === 'cpu' && !promptSent);

  useEffect(() => { if (focusedId && !members.some(member => member.id === focusedId)) setFocusedId(null); }, [view?.members, focusedId]);
  useEffect(() => {
    if (!promptSent) return;
    const timer = window.setTimeout(() => setPromptSent(false), 2500);
    return () => window.clearTimeout(timer);
  }, [promptSent]);

  const ask = (question: string) => {
    if (!canTalk || !focused) return;
    if (send?.({ type: 'chat', text: `@${focused.nickname} — ${question}` })) setPromptSent(true);
  };

  return <section className={`experiment-chamber chamber-${mood} ${!view ? 'chamber-preview' : ''} ${game?.phase.paused ? 'chamber-paused' : ''}`} aria-label={sceneLabel} data-testid="experiment-chamber">
    <div className="chamber-stage">
      <div className="chamber-scenery" aria-hidden="true" />
      <div className="chamber-vignette" aria-hidden="true" />
      <div className="chamber-grid-floor" aria-hidden="true" />
      <div className="chamber-scanline" aria-hidden="true" />
      <div className="chamber-telemetry">
        <span className="chamber-signal"><i />{signalLabel}</span>
        <span>{view ? `${view.code} / ${game ? `TRIAL ${String(game.round).padStart(2, '0')}` : 'INTAKE'}` : 'FACILITY 09 / INTAKE'}</span>
      </div>
      <div className="chamber-scene-copy">
        <span className="chamber-kicker">{!view ? 'A social experiment. A survival game.' : game?.trial ? 'CURRENT CRISIS' : 'ENTER THE CHAMBER'}</span>
        <h2>{!view ? <>Who will you<br />trust to survive?</> : game?.trial?.title ?? (view.status === 'lobby' ? 'Your Subjects are assembling.' : 'The final test.')}</h2>
        <p>{!view ? 'Your allies have instructions of their own.' : game ? stability <= 30 ? 'The chamber is failing. Every unit matters.' : phase === 'discussion' ? 'Ask a Subject for help. Decide whose word you believe.' : phase === 'decision' ? 'The room is watching. Your allocation stays secret.' : phase === 'reveal' ? 'Hidden choices have become public consequences.' : phase === 'final_choice' ? 'One last choice. Everyone carries the consequences.' : 'Keep the group alive. Earn your place outside.' : 'One human can play. CPU Subjects make their own choices.'}</p>
      </div>
      <Reactor stability={stability} failed={ended} />
      <div className="chamber-reactor-caption"><span>GROUP STABILITY</span><strong>{stability}<small> / 100</small></strong><i>{mood === 'critical' ? 'CRITICAL' : mood === 'tense' ? 'UNDER PRESSURE' : 'CONTAINMENT STABLE'}</i></div>
      <div className="chamber-stations">
        {STATIONS.map(station => {
          const value = publicReveal?.[station.key];
          const target = station.key === 'medical' ? game?.trial?.medicalTarget : station.key === 'security' ? game?.trial?.securityTarget : null;
          const met = value !== undefined && target != null ? value >= target : null;
          return <div key={station.key} className={`chamber-station ${station.key} ${met === false ? 'station-failed' : met === true ? 'station-supported' : ''}`}>
            <span className="station-icon"><StationIcon type={station.icon} /></span>
            <div><strong>{station.name}</strong><small>{value !== undefined ? `${value} ${target != null ? `/ ${target} units` : 'units stored'}` : station.label}</small></div>
            <span className="station-indicator" aria-label={met === false ? 'Target missed' : met === true ? 'Target met' : 'Awaiting allocation'} />
          </div>;
        })}
      </div>
      {!view && <div className="chamber-landing-subjects" aria-hidden="true">{DEMO_SUBJECTS.map((member, index) => <div key={member.id} style={{ '--portrait-delay': `${index * -1.7}s` } as React.CSSProperties}><CharacterPortrait seed={member.id} /><span>SUBJECT {String(index + 1).padStart(2, '0')}</span></div>)}</div>}
      {view && latestEvent && <div className="chamber-event-strip" key={latestEvent.id}><span>PUBLIC SIGNAL</span><strong>{latestEvent.title}</strong></div>}
    </div>
    {view && members.length > 0 && <div className="chamber-conversations">
      <div className="chamber-lineup" aria-label="Select a Subject to hear their public conversation">
        {members.map((member, index) => <button key={member.id} className={`chamber-subject ${focused?.id === member.id ? 'subject-focused' : ''} ${speakingId === member.id ? 'subject-speaking' : ''} ${!member.connected ? 'subject-disconnected' : ''}`} type="button" onClick={() => setFocusedId(member.id)} aria-pressed={focused?.id === member.id} aria-label={`Talk to ${member.nickname}`} style={{ '--portrait-delay': `${index * -1.3}s` } as React.CSSProperties}>
          <span className="chamber-subject-number">S{String(member.subjectNumber ?? index + 1).padStart(2, '0')}<i>{member.controller === 'cpu' ? 'CPU' : member.id === view.selfId ? 'YOU' : 'LIVE'}</i></span>
          <CharacterPortrait seed={member.id} speaking={speakingId === member.id} mood={mood} />
          <strong>{member.nickname}</strong>
          <span className="subject-voice-bars" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        </button>)}
      </div>
      {focused && <div className={`chamber-dialogue ${speakingId === focused.id ? 'dialogue-speaking' : ''}`}>
        <div className="chamber-dialogue-label"><span><i />{focused.nickname}</span><small>{focused.controller === 'cpu' ? 'CPU SUBJECT / PUBLIC CHANNEL' : 'SUBJECT / PUBLIC CHANNEL'}</small></div>
        <p key={publicLine?.id ?? focused.id}>{publicLine ? publicLine.text : focused.controller === 'cpu' ? view.status === 'lobby' ? 'I’m ready when you are. Let’s see who makes it out.' : 'Ask me where I stand. My choices are my own.' : focused.id === view.selfId ? 'Your voice belongs in this room. Speak in the public channel.' : 'Waiting for this Subject to speak in the public channel.'}</p>
        {focused.controller === 'cpu' && send && <div className="chamber-talk-actions" aria-label={`Public conversation with ${focused.nickname}`}>
          <button type="button" disabled={!canTalk} onClick={() => ask('Can you help Medical?')}>Can you help Medical?</button>
          <button type="button" disabled={!canTalk} onClick={() => ask('Can you help Security?')}>Can you help Security?</button>
          <button type="button" disabled={!canTalk} onClick={() => ask('Will you protect the group?')}>Will you protect the group?</button>
          {promptSent && <span role="status">Question sent to the public channel.</span>}
          {!conversationOpen && <span>Questions open during discussion, secret decisions, and the finale.</span>}
        </div>}
      </div>}
    </div>}
  </section>;
}
