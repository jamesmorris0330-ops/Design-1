import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { DEFAULT_SETTINGS, PHASE_LABELS } from '../shared/protocol';
import type { Action, Allocation, PublicGame, PublicMember, RoomSettings, RoomView } from '../shared/protocol';
import { api, useRoom } from './useRoom';
import { ExperimentChamber } from './ExperimentChamber';
import { CharacterPortrait } from './CharacterPortrait';
import { ResourceStation } from './ResourceStation';
import { useExperimentAudio } from './useExperimentAudio';
import { AudioControls } from './AudioControls';
import { SurvivalLobby } from './SurvivalLobby';
import { SurvivalGame } from './SurvivalGame';

type Send = (action: Action) => boolean;
const subjectName = (member: PublicMember) => member.subjectNumber ? `Subject ${String(member.subjectNumber).padStart(2, '0')}` : member.role === 'subject' ? 'Subject' : 'Observer';
const finishedPhases = new Set(['full_reveal', 'aborted']);

function Icon({ name }: { name: 'arrow' | 'lock' | 'eye' | 'cross' | 'check' | 'copy' }) {
  const paths = { arrow: <path d="M5 12h14m-6-6 6 6-6 6" />, lock: <><rect x="5" y="10" width="14" height="11" rx="2" /><path d="M8 10V7a4 4 0 0 1 8 0v3m-4 5v2" /></>, eye: <><path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7S2 12 2 12Z" /><circle cx="12" cy="12" r="3" /></>, cross: <path d="m6 6 12 12M6 18 18 6" />, check: <path d="m5 12 4 4 10-10" />, copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4H4v12h4" /></> };
  return <svg className="icon" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function App() {
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [inviteCode, setInviteCode] = useState('');
  const [restoring, setRestoring] = useState(true);
  const [showHelp, setShowHelp] = useState(false);
  const [copied, setCopied] = useState(false);
  const room = useRoom(roomCode);
  const { view, connection } = room;
  const audio = useExperimentAudio(view);
  const send: Send = action => {
    const accepted = room.send(action);
    if (accepted && ['decision', 'vote', 'final_choice', 'ready', 'start', 'survival_start', 'survival_craft', 'survival_upgrade', 'survival_interact', 'survival_claim', 'survival_equip'].includes(action.type)) audio.playCue('confirm');
    return accepted;
  };

  useEffect(() => {
    let alive = true;
    const requested = new URLSearchParams(location.search).get('room')?.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    let last: string | null = null;
    try { last = localStorage.getItem('experiment:last-room'); } catch { /* Storage is optional. */ }
    const candidate = requested || last;
    api<{ rooms: { code: string; nickname: string; role: string }[] }>('/api/session').then(session => {
      if (!alive) return;
      if (candidate && session.rooms.some(r => r.code === candidate)) setRoomCode(candidate);
      else if (requested) setInviteCode(requested);
    }).catch(() => { if (alive && requested) setInviteCode(requested); }).finally(() => { if (alive) setRestoring(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    if (!roomCode) return;
    const url = new URL(location.href);
    url.searchParams.set('room', roomCode);
    history.replaceState(null, '', url);
    try { localStorage.setItem('experiment:last-room', roomCode); } catch { /* A session cookie still restores identity. */ }
  }, [roomCode]);

  const goHome = () => {
    setRoomCode(null);
    const url = new URL(location.href); url.searchParams.delete('room'); history.replaceState(null, '', url);
    try { localStorage.removeItem('experiment:last-room'); } catch { /* optional */ }
  };
  const copyCode = async () => {
    if (!view) return;
    try { await navigator.clipboard.writeText(view.code); setCopied(true); setTimeout(() => setCopied(false), 1800); }
    catch { room.dismissError(); /* The displayed selectable code remains usable without clipboard access. */ }
  };

  return <div className={view ? 'app in-room' : 'app'}>
    <header className="topbar">
      <a className="wordmark" href="/" onClick={event => { event.preventDefault(); goHome(); }} aria-label="The Experiment home"><span className="brand-mark">E<span>·</span></span><span>THE EXPERIMENT<span className="wordmark-sub">A WORLD THAT FIGHTS BACK</span></span></a>
      <div className="topbar-actions">
        <AudioControls audio={audio} />
        {roomCode && <span className={`connection ${connection}`} role="status"><span className="status-dot" />{connection === 'online' ? 'Synchronized' : connection === 'superseded' ? 'Another tab is active' : connection === 'reconnecting' ? 'Reconnecting…' : 'Connecting…'}</span>}
        <button className="text-button" onClick={() => setShowHelp(true)}>How to play <Icon name="arrow" /></button>
      </div>
    </header>
    {room.error && <div className="notice error-notice" role="alert"><span>{room.error}</span><button onClick={room.dismissError} aria-label="Dismiss error"><Icon name="cross" /></button></div>}
    {connection === 'superseded' && <div className="notice"><span>This Subject is being controlled in another tab. Continue here to reclaim control.</span><button className="button small" onClick={room.reconnect}>Continue here</button></div>}
    {view && connection === 'reconnecting' && <div className="notice" role="status">Connection interrupted. Your identity, locked choices, and dossier are preserved. Reconnecting automatically…</div>}
    {!roomCode ? <Landing onJoined={setRoomCode} inviteCode={inviteCode} restoring={restoring} /> : !view ? <main className="loading-shell"><span className="eyebrow">ESTABLISHING SECURE CHANNEL</span><h1>Rejoining<br />the Experiment.</h1><p>Your Subject identity is held by this browser’s secure session.</p><div className="loading-bar" /><button className="text-button" onClick={goHome}>Back to create / join</button></main> : <>
      <div className="room-strip"><span className="eyebrow">{view.status === 'lobby' ? 'PREPARATION ROOM' : view.status === 'postgame' ? 'SESSION ARCHIVE' : 'EXPERIMENT IN PROGRESS'}</span><button className="room-code" onClick={copyCode} aria-label="Copy room code"><span className="eyebrow">ROOM</span><strong data-testid="current-room-code">{view.code}</strong><Icon name={copied ? 'check' : 'copy'} /></button><span className="room-population">{view.members.filter(m => m.role === 'subject' && !m.removed).length} / 8 Subjects</span></div>
      <main className="room-layout">
        <div className="main-column" id="trial-area">{view.survival ? <SurvivalGame speakingId={audio.speakingId} view={view} send={send} online={connection === 'online'} pending={room.pendingTypes} /> : view.status === 'lobby' ? <SurvivalLobby view={view} send={send} online={connection === 'online'} pending={room.pendingTypes} /> : view.game ? <><ExperimentChamber view={view} speakingId={audio.speakingId} send={send} online={connection === 'online'} /><Game view={view} send={send} online={connection === 'online'} pending={room.pendingTypes} serverOffset={room.serverOffset} /></> : <section className="panel">Loading the survival world…</section>}</div>
        <aside className="side-column"><Participants view={view} /><Chat view={view} send={send} online={connection === 'online'} pending={room.pendingTypes} />{view.hostId === view.selfId && (view.survival ? <SurvivalAdministration view={view} send={send} online={connection === 'online'} /> : <HostControls view={view} send={send} online={connection === 'online'} />)}</aside>
      </main>
      {view.game && <nav className="mobile-room-nav" aria-label="Room sections"><a href="#trial-area">01 <strong>Trial</strong></a>{view.me && <a href="#private-dossier">02 <strong>Dossier</strong></a>}<a href="#public-chat">03 <strong>Chat</strong></a></nav>}
    </>}
    <footer className="site-footer"><span>THE EXPERIMENT <span className="footer-separator">/</span> SCAVENGE. BUILD. SURVIVE.</span><span>ONE SHELTER. A WORLD THAT FIGHTS BACK.</span></footer>
    {showHelp && <Help onClose={() => setShowHelp(false)} />}
  </div>;
}

function Landing({ onJoined, inviteCode, restoring }: { onJoined: (code: string) => void; inviteCode: string; restoring: boolean }) {
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [nickname, setNickname] = useState('');
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { if (inviteCode) { setCode(inviteCode); setMode('join'); } }, [inviteCode]);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(null); setLoading(true);
    try {
      const result = await api<{ code: string; memberId: string }>(mode === 'create' ? '/api/rooms' : `/api/rooms/${encodeURIComponent(code.toUpperCase().trim())}/join`, { nickname: nickname.trim() });
      onJoined(result.code);
    } catch (err) { setError(err instanceof Error ? err.message : 'Unable to enter the room.'); } finally { setLoading(false); }
  }
  return <main className="landing">
    <div className="landing-intro"><span className="eyebrow"><span className="status-dot orange" /> CONTINUOUS SURVIVAL · THE FRONTIER</span><span className="hero-index">001 / OBSERVATION</span></div>
    <div className="hero-grid">
      <section className="hero-story"><h1 className="hero-title">THE<br /><span>EXPERIMENT</span><span className="title-period">.</span></h1><div className="hero-description"><span className="description-line" /><p>Scavenge what remains.<br />Build somewhere to survive.<br /><strong>Fight for another day.</strong></p></div><div className="hero-pills"><span>1–8 players</span><span>CPU companions</span><span>No accounts</span><span>Persistent survival</span></div><p className="solo-intro">Play solo with CPU companions, or invite friends. Explore, loot, upgrade your crew, and defend your shelter from infected hordes.</p><div className="survival-frontier-art"><img src="/images/survival-frontier.png" alt="Survivors defend a fortified shelter against infected in an abandoned frontier" /><span>THE FRONTIER AWAITS</span></div></section>
      <section className="entry-card"><div className="card-label"><span>SUBJECT INTAKE</span><span>↳</span></div><h2>Enter the frontier.<br />Stay alive together.</h2><div className="entry-tabs" role="tablist" aria-label="Room entry"><button role="tab" aria-selected={mode === 'create'} onClick={() => { setMode('create'); setError(null); }}>Create a room</button><button role="tab" aria-selected={mode === 'join'} onClick={() => { setMode('join'); setError(null); }}>Join a room</button></div><form onSubmit={submit}><label className="field-label" htmlFor="nickname">Nickname</label><input id="nickname" name="nickname" autoComplete="nickname" placeholder="What should we call you?" value={nickname} onChange={e => setNickname(e.target.value)} maxLength={24} minLength={1} required />{mode === 'join' && <><label className="field-label" htmlFor="join-code">Room code</label><input id="join-code" className="code-input" value={code} onChange={e => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ''))} placeholder="ENTER CODE" maxLength={12} required autoComplete="off" /></>}{error && <p className="form-error" role="alert">{error}</p>}<button className="button orange-button full-width" type="submit" disabled={loading || restoring}>{loading ? 'Opening channel…' : restoring ? 'Checking session…' : mode === 'create' ? 'Create room' : 'Join room'}<Icon name="arrow" /></button></form><p className="intake-note"><Icon name="lock" />Just a nickname. Your progress stays saved.</p></section>
    </div>
    <section className="landing-principles"><div className="principle"><span className="principle-number">01</span><h3>Scavenge and fight.</h3><p>Collect supplies, guns, and gear. Aim, shoot, and defend yourself from infected.</p></div><div className="principle"><span className="principle-number">02</span><h3>Build your refuge.</h3><p>Choose one of five shelter types, upgrade your base, and rescue survivors.</p></div><div className="principle"><span className="principle-number">03</span><h3>Survive another day.</h3><p>Complete daily, weekly, and monthly goals. Return to your saved world.</p></div></section>
    <div className="landing-bottom"><span className="eyebrow">EVERY DAY IS ANOTHER CHANCE TO SURVIVE.</span><span className="decorative-bars" aria-hidden="true">▏▎▏▍▏▎▍▏▏▍▎▏▍▏▏▎</span></div>
  </main>;
}

function Lobby({ view, send, online, pending }: { view: RoomView; send: Send; online: boolean; pending: string[] }) {
  const self = view.members.find(m => m.id === view.selfId);
  const isHost = view.hostId === view.selfId;
  const subjects = view.members.filter(m => m.role === 'subject' && !m.removed);
  const humanSubjects = subjects.filter(m => m.controller === 'human');
  const cpuCount = subjects.filter(m => m.controller === 'cpu').length;
  const autoFill = Math.max(0, 4 - subjects.length);
  const allReady = humanSubjects.length >= 1 && humanSubjects.every(m => m.ready);
  return <>
    <section className="lobby-heading"><span className="eyebrow">BEFORE WE BEGIN</span><h1>Ordinary people.<br /><em>Unusual instructions.</em></h1><p>Start with 1–8 players. CPU Subjects fill the group to at least four.<br /> Share the room code, mark ready, and let the Experiment begin.</p></section>
    <section className="orientation"><span className="eyebrow">YOUR TWO CONDITIONS FOR QUALIFICATION</span><div className="orientation-grid"><div><span className="condition-number">01</span><h3>The group survives.</h3><p>Keep Group Stability above zero through the finale.</p></div><span className="condition-plus">+</span><div><span className="condition-number">02</span><h3>You earn enough Compliance.</h3><p>Complete your private directives to meet your personal target.</p></div></div></section>
    <section className="panel settings-panel"><div className="section-heading"><div><span className="eyebrow">SESSION PARAMETERS</span><h2>The shape of the experiment.</h2></div><span className="small-tag">{isHost ? 'HOST SETTINGS' : 'SET BY HOST'}</span></div><Settings settings={view.settings} canEdit={isHost && online} send={send} />
      <div className="cpu-setup"><div><strong>{humanSubjects.length} player{humanSubjects.length === 1 ? '' : 's'} · {cpuCount} CPU Subject{cpuCount === 1 ? '' : 's'}</strong><p>{autoFill > 0 ? `${autoFill} CPU Subject${autoFill === 1 ? '' : 's'} will join automatically when the game starts.` : `${subjects.length} of 8 Subject seats filled.`} CPU Subjects follow the same rules and keep their directives private.</p></div>{isHost && <button className="button outline-button" disabled={!online || subjects.length >= 8 || pending.includes('add_cpu')} onClick={() => send({ type: 'add_cpu' })}>Add CPU player</button>}</div>
      <p className="cpu-takeover-note">Friends can join using this room code and take over an available CPU Subject in the lobby or during an active game. Their inherited score, history, and locked choices stay in place.</p>
      <div className="lobby-action"><div><strong>{allReady ? 'All players are ready.' : humanSubjects.length === 0 ? 'At least one player must join as a Subject.' : 'Waiting for players to mark ready.'}</strong><p>{self?.role === 'spectator' ? 'You are an observer. You can follow public events and chat.' : 'Your private directives arrive after the first crisis.'}</p></div><div className="lobby-buttons">{self?.role === 'subject' && !self.removed && <button className={`button ${self.ready ? 'outline-button' : 'dark-button'}`} disabled={!online || pending.includes('ready')} onClick={() => send({ type: 'ready', ready: !self.ready })}>{self.ready ? <><Icon name="check" />Not ready</> : 'Mark ready'}</button>}{isHost && <button className="button orange-button" disabled={!allReady || !online || pending.includes('start')} onClick={() => send({ type: 'start' })}>{autoFill > 0 ? 'Start with CPU players' : 'Start experiment'}<Icon name="arrow" /></button>}</div></div>
    </section>
    <p className="privacy-footnote"><Icon name="lock" />The server holds every secret. A host cannot see other Subjects’ directives or change scores.</p>
  </>;
}

function Settings({ settings, canEdit, send }: { settings: RoomSettings; canEdit: boolean; send: Send }) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings.rounds, settings.roundCap, settings.extensions, settings.allowSpectators]);
  const changed = JSON.stringify(draft) !== JSON.stringify(settings);
  return <div className="settings-body"><div className="settings-row"><div><label className="field-label" htmlFor="round-count">Total rounds, including the finale</label><div className="round-presets">{[3, 5, 7, 10, 15, 20].map(n => <button key={n} className={draft.rounds === n ? 'selected' : ''} disabled={!canEdit || n > draft.roundCap} onClick={() => setDraft({ ...draft, rounds: n })}>{n}</button>)}<input aria-label="Total rounds, including the finale" id="round-count" type="number" min={3} max={draft.roundCap} value={draft.rounds} disabled={!canEdit} onChange={e => setDraft({ ...draft, rounds: Math.max(3, Math.min(draft.roundCap, Number(e.target.value) || 3)) })} /></div><p className="field-note">Approximately {Math.max(5, Math.round(draft.rounds * 2.4))}–{Math.round(draft.rounds * 3)} minutes, before pauses.</p></div><div><label className="field-label" htmlFor="round-cap">Maximum session length</label><select id="round-cap" value={draft.roundCap} disabled={!canEdit} onChange={e => { const cap = Number(e.target.value) as 15 | 20; setDraft({ ...draft, roundCap: cap, rounds: Math.min(draft.rounds, cap) }); }}><option value={15}>15 rounds</option><option value={20}>20 rounds</option></select></div></div><div className="check-options"><label><input type="checkbox" checked={draft.extensions} disabled={!canEdit} onChange={e => setDraft({ ...draft, extensions: e.target.checked })} /><span><strong>Allow extra rounds</strong><small>Before the finale, Subjects can consent to extend the session. Compliance targets stay fixed.</small></span></label><label><input type="checkbox" checked={draft.allowSpectators} disabled={!canEdit} onChange={e => setDraft({ ...draft, allowSpectators: e.target.checked })} /><span><strong>Allow late spectators</strong><small>During an active game, new players take available CPU seats first. Otherwise, late arrivals can observe public information.</small></span></label></div>{canEdit && changed && <button className="button dark-button small" onClick={() => send({ type: 'settings', settings: draft })}>Save settings</button>}</div>;
}

function Participants({ view }: { view: RoomView }) {
  const members = view.members.filter(m => !m.removed);
  const subjects = members.filter(m => m.role === 'subject');
  const cpuCount = subjects.filter(m => m.controller === 'cpu').length;
  return <section className="panel participants-panel"><div className="section-heading compact"><span className="eyebrow">THE CREW</span><span className="eyebrow">{subjects.length - cpuCount} HUMAN · {cpuCount} CPU</span></div><ul className="participant-list">{members.map(member => <li key={member.id}><div className="participant-portrait"><CharacterPortrait seed={member.id} /></div><div className="participant-identity"><strong>{member.nickname}{member.id === view.selfId && <span> YOU</span>}{member.controller === 'cpu' && <span className="cpu-badge">CPU</span>}</strong><small>{subjectName(member)}{member.id === view.hostId ? ' · Host' : ''}</small></div><span className={`participant-status ${view.status === 'lobby' && member.ready ? 'ready' : ''}`} aria-label={member.controller === 'cpu' ? 'CPU-controlled Subject' : view.status === 'lobby' && member.ready ? 'Ready' : member.connected ? 'Connected' : 'Disconnected'}>{view.status === 'lobby' && member.ready ? <Icon name="check" /> : <span className={`status-dot ${member.controller === 'cpu' ? 'cpu' : member.connected ? '' : 'offline'}`} />}</span></li>)}</ul><p className="small-muted">{members.length - subjects.length > 0 ? `${members.length - subjects.length} observer${members.length - subjects.length === 1 ? '' : 's'} · ` : ''}CPU companions scavenge, fight, and help defend the shelter. Personal packs stay private.</p></section>;
}

function Chat({ view, send, online, pending }: { view: RoomView; send: Send; online: boolean; pending: string[] }) {
  const [text, setText] = useState('');
  const messages = useRef<HTMLDivElement>(null);
  const self = view.members.find(m => m.id === view.selfId);
  useEffect(() => { if (messages.current) messages.current.scrollTop = messages.current.scrollHeight; }, [view.chat.length]);
  const submit = (event: FormEvent) => { event.preventDefault(); if (text.trim() && send({ type: 'chat', text: text.trim() })) setText(''); };
  return <section className="panel chat-panel" id="public-chat"><div className="section-heading compact"><span className="eyebrow">PUBLIC CHANNEL</span><span className="small-tag">{view.chatMuted ? 'MUTED' : 'ALL CREW'}</span></div><div className="chat-messages" ref={messages} role="log" aria-label="Public chat" aria-live="polite">{view.chat.length === 0 ? <div className="chat-empty"><span aria-hidden="true">“</span><p>Plan your next supply run.<br />The whole crew can hear you.</p></div> : view.chat.map(message => <div className={`chat-message ${message.senderId === view.selfId ? 'own' : ''} ${message.type === 'statement' ? 'statement-message' : ''}`} key={message.id}><div><strong>{message.nickname}</strong><time>{new Date(message.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></div><p>{message.text}</p>{message.type === 'statement' && <small>FINAL STATEMENT</small>}</div>)}</div><form className="chat-form" onSubmit={submit}><label className="sr-only" htmlFor="chat-input">Public message</label><input id="chat-input" maxLength={500} placeholder={view.chatMuted ? 'Public chat is muted' : 'Message the room…'} value={text} onChange={e => setText(e.target.value)} disabled={!online || view.chatMuted || self?.removed} /><button className="chat-send" aria-label="Send public message" disabled={!online || view.chatMuted || !text.trim() || pending.includes('chat') || self?.removed}><Icon name="arrow" /></button></form><p className="small-muted chat-warning">Public messages are visible to everyone. Share private information only if you choose.</p></section>;
}

function Game({ view, send, online, pending, serverOffset }: { view: RoomView; send: Send; online: boolean; pending: string[]; serverOffset: number }) {
  const game = view.game!;
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 500); return () => clearInterval(timer); }, []);
  const self = view.members.find(m => m.id === view.selfId);
  const eligible = !self?.removed && game.phase.eligibleIds.includes(view.selfId) && self?.role === 'subject';
  const seconds = game.phase.paused ? Math.ceil((game.phase.remainingMs ?? 0) / 1000) : game.phase.deadline ? Math.max(0, Math.ceil((game.phase.deadline - (now + serverOffset)) / 1000)) : null;
  const active = online && !game.phase.paused;
  const inheritedCpuSeat = view.me?.dossier.some(entry => entry.title === 'CPU seat inherited');
  return <>
    <section className="game-heading"><div><span className="eyebrow" data-testid="current-round">{game.outcome === 'aborted' ? 'SESSION TERMINATED' : game.phase.type.startsWith('final_') || ['personal_results', 'full_reveal'].includes(game.phase.type) ? 'THE FINAL EXPERIMENT' : `ROUND ${String(game.round).padStart(2, '0')} / ${String(game.totalRounds).padStart(2, '0')}`}</span><h1 data-testid="phase">{PHASE_LABELS[game.phase.type]}</h1></div><div className={`phase-clock ${game.phase.paused ? 'paused' : ''}`}><span className="eyebrow">{game.phase.paused ? 'PAUSED' : game.phase.type === 'final_choice' && seconds === 0 ? 'WAITING FOR CHOICES' : 'TIME REMAINING'}</span><strong>{seconds === null ? '—' : `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`}</strong></div></section>
    <section className={`stability-panel ${game.stability <= 20 ? 'critical' : ''}`}><div><span className="eyebrow">PUBLIC · GROUP STABILITY</span><div className="stability-number"><strong data-testid="public-stability">{Number.isInteger(game.stability) ? game.stability : game.stability.toFixed(1)}</strong><span>/ {game.maxStability}</span></div></div><div className="stability-track"><div className="stability-scale"><span>{game.stability <= 0 ? 'GROUP FAILURE' : game.outcome === 'survived' ? 'GROUP SURVIVED' : 'ABOVE ZERO TO SURVIVE'}</span><span>EVERYONE SEES THIS</span></div><div className="meter" role="meter" aria-label="Group Stability" aria-valuemin={0} aria-valuemax={game.maxStability} aria-valuenow={Math.max(0, game.stability)}><div style={{ width: `${Math.max(0, Math.min(100, game.stability / game.maxStability * 100))}%` }} /></div><div className="meter-labels"><span>0 · FAILURE</span><span>100 · STABLE</span></div></div></section>
    {game.phase.paused && <div className="paused-banner" role="status">{game.phase.pauseReason ? `${game.phase.pauseReason} ` : 'The Experiment is paused. '}Decisions are frozen; discussion can continue in public chat.</div>}
    {self?.role === 'spectator' && <div className="observer-banner">OBSERVER PROTOCOL · Follow the public Trial. Subject directives, scores, and decisions stay private.</div>}
    {inheritedCpuSeat && !finishedPhases.has(game.phase.type) && <div className="takeover-banner" role="status"><strong>CPU Subject inherited.</strong><p>You now control this Subject. Your score, dossier, and any locked choices are preserved. Continue from the current phase.</p></div>}
    <PhaseMomentum view={view} send={send} active={active} pending={pending} />
    <PhasePanel view={view} send={send} active={active} eligible={eligible} pending={pending} />
    {view.me && <PrivateDossier view={view} />}
    {game.phase.type === 'full_reveal' && <FullReveal view={view} send={send} online={online} pending={pending} />}
    <PublicRecord view={view} />
  </>;
}

function PhaseMomentum({ view, send, active, pending }: { view: RoomView; send: Send; active: boolean; pending: string[] }) {
  const game = view.game!;
  const beats = ['crisis', 'directive', 'discussion', 'decision', 'reveal', 'vote', 'consequences', 'dossier'];
  const beat = beats.indexOf(game.phase.type);
  const labels: Partial<Record<typeof game.phase.type, string>> = {
    crisis: 'Receive private directive', directive: 'Open the discussion', discussion: 'Begin secret allocations',
    reveal: 'Begin the ballot', consequences: 'Review your dossier', dossier: 'Continue experiment',
    final_directive: 'Begin the final choice', final_resolution: 'Open personal results', personal_results: 'Open the full reveal',
  };
  const next = labels[game.phase.type];
  if (finishedPhases.has(game.phase.type)) return null;
  return <div className="phase-momentum">
    {beat >= 0 && <ol aria-label="Trial progress" className="trial-progress">{beats.map((name, index) => <li key={name} className={index === beat ? 'current' : index < beat ? 'complete' : ''} aria-current={index === beat ? 'step' : undefined}><span>{index + 1}</span><small>{name}</small></li>)}</ol>}
    {next && <div className="pace-control"><p>{view.hostId === view.selfId ? 'Ready? Move the scene forward without waiting for the timer.' : 'The host can move this scene forward when the room is ready.'}</p>{view.hostId === view.selfId && <button className="button outline-button small" disabled={!active || pending.includes('advance')} onClick={() => send({ type: 'advance' })}>{next}<Icon name="arrow" /></button>}</div>}
  </div>;
}

function PhasePanel({ view, send, active, eligible, pending }: { view: RoomView; send: Send; active: boolean; eligible: boolean; pending: string[] }) {
  const game = view.game!;
  const phase = game.phase.type;
  const host = view.hostId === view.selfId;
  if (finishedPhases.has(phase)) return phase === 'aborted' ? <section className="panel abort-panel"><span className="eyebrow">SESSION CLOSED BY HOST</span><h2>The experiment was interrupted.</h2><p>No Subjects qualify from an aborted session. Unrevealed directives and choices remain private.</p>{host && <button className="button orange-button" disabled={!active || pending.includes('rematch')} onClick={() => send({ type: 'rematch' })}>Return to lobby<Icon name="arrow" /></button>}</section> : null;
  if (phase === 'extension_offer' || phase === 'extension_vote') return <section className="panel extension-panel"><span className="eyebrow">CONTINUATION CHECKPOINT · PUBLIC</span><h2>Is the experiment over yet?</h2><p>Extend the session for more play and more opportunities. Your original Compliance requirement stays fixed. There is still exactly one finale.</p>{phase === 'extension_vote' ? <><div className="extension-summary"><strong>+{game.extension?.additionalRounds} rounds</strong><span>{game.extension?.proposedTotal} total rounds, including the finale</span></div>{view.me?.extensionVote !== null && view.me?.extensionVote !== undefined ? <p className="locked-notice"><Icon name="lock" />Your consent is locked: {view.me.extensionVote ? 'Yes' : 'No'}. Ballots remain secret until resolution.</p> : eligible ? <div className="action-buttons"><button className="button orange-button" disabled={!active || pending.includes('extension_vote')} onClick={() => send({ type: 'extension_vote', yes: true })}>Vote to extend</button><button className="button outline-button" disabled={!active || pending.includes('extension_vote')} onClick={() => send({ type: 'extension_vote', yes: false })}>Vote to continue to finale</button></div> : <p>The Subjects are casting secret consent ballots.</p>}<p className="field-note">A strict majority of the frozen Subject roster must consent. Missing ballots count as no.</p></> : host ? <><div className="extension-options">{([1, 2, 3, 5] as const).filter(n => game.totalRounds + n <= game.roundCap).map(n => <button className="button outline-button" key={n} disabled={!active || pending.includes('extension')} onClick={() => send({ type: 'extension', additionalRounds: n })}>Propose +{n} round{n !== 1 ? 's' : ''}</button>)}</div><button className="button dark-button" disabled={!active || pending.includes('continue')} onClick={() => send({ type: 'continue' })}>Continue to finale<Icon name="arrow" /></button></> : <p className="locked-notice">The host can propose an extension or continue to the finale. This checkpoint reveals no private score standings.</p>}</section>;
  if (phase === 'final_interrogation') {
    const speaker = view.members.find(m => m.id === game.phase.speakerId);
    return <section className="panel finale-panel"><span className="eyebrow">FINAL INTERROGATION · PUBLIC</span><h2>One last chance to be believed.</h2><p>Defend yourself, make an accusation, or reveal a part of your dossier. Sharing a private directive is your decision.</p><div className="speaker-banner"><span className="subject-avatar">{speaker?.subjectNumber ? String(speaker.subjectNumber).padStart(2, '0') : '—'}</span><div><span className="eyebrow">CURRENT SPEAKER</span><strong>{speaker?.nickname ?? 'Awaiting next Subject'}</strong></div></div>{eligible && game.phase.speakerId === view.selfId ? <FinalStatement phaseId={game.phase.id} send={send} active={active} pending={pending} /> : <p className="field-note">Listen to the current Subject. Statements appear in the public channel.</p>}</section>;
  }
  if (phase === 'final_directive') return <section className="panel finale-panel"><span className="eyebrow">FINAL DIRECTIVE · PRIVATE</span><h2>Your last instruction awaits.</h2><p>Open your private dossier to read it. The group’s survival and your personal Compliance will both decide your result.</p><p className="locked-notice"><Icon name="lock" />No other Subject receives your instruction.</p></section>;
  if (phase === 'final_choice') return <FinalChoice key={game.phase.id} view={view} send={send} active={active} eligible={eligible} pending={pending} />;
  if (phase === 'final_resolution') return <section className="panel finale-panel"><span className="eyebrow">FINAL RESOLUTION · PUBLIC</span><h2>{game.outcome === 'survived' ? 'The group survived.' : game.outcome === 'failed' ? 'The group did not survive.' : 'Calculating your collective fate.'}</h2><p>All locked final choices are resolved together. Personal Compliance is assessed next.</p></section>;
  if (phase === 'personal_results') return <section className="panel finale-panel"><span className="eyebrow">PERSONAL RESULTS · PRIVATE</span><h2>Your report is ready.</h2><p>Reveal your private dossier to discover your result. The full session record opens next.</p><p className="locked-notice"><Icon name="lock" />Other Subjects’ personal reports remain sealed in this phase.</p></section>;
  if (phase === 'vote') return <Vote key={game.phase.id} view={view} send={send} active={active} eligible={eligible} pending={pending} />;
  if (phase === 'decision') return <ResourceDecision key={game.phase.id} view={view} send={send} active={active} eligible={eligible} pending={pending} />;
  return <section className="panel trial-panel"><div className="section-heading"><span className="eyebrow">{phase === 'directive' ? 'PRIVATE INSTRUCTIONS · PUBLIC CRISIS' : 'TRIAL BRIEF · PUBLIC'}</span><span className="small-tag">RESOURCE ALLOCATION</span></div><h2>{game.trial?.title ?? 'Awaiting the next Trial'}</h2><p className="trial-narrative">{game.trial?.narrative}</p><TrialTargets game={game} />{phase === 'directive' ? <div className="context-tip"><Icon name="lock" /><p><strong>Your directive is ready.</strong> Reveal your private dossier below. It rewards an action that may conflict with the group’s needs.</p></div> : phase === 'discussion' ? <div className="context-tip"><Icon name="eye" /><p><strong>Discuss your plan in public chat.</strong> Each Subject will secretly allocate three units. Your promises are informal; your decision will be locked.</p></div> : phase === 'reveal' && game.allocationTotals ? <><h3 className="result-heading">The group’s allocation</h3><div className="allocation-totals">{(['medical', 'security', 'reserve'] as const).map(resource => <div key={resource}><span className="eyebrow">{resource}</span><strong>{game.allocationTotals![resource]}</strong><small>{resource === 'reserve' ? 'No direct Stability effect' : game.allocationTotals![resource] >= game.trial![`${resource}Target`] ? 'THRESHOLD MET · +10' : 'THRESHOLD MISSED · −15'}</small></div>)}</div><p className="field-note">Only combined totals are revealed. Individual choices and directive rewards remain private.</p></> : phase === 'consequences' ? <div className="context-tip"><p><strong>The ballot has resolved.</strong> Read the public record for the disclosed outcome. Tied leaders cause no mechanical effect.</p></div> : phase === 'dossier' ? <div className="context-tip"><Icon name="lock" /><p><strong>Your dossier has been updated.</strong> Review your own choices, outcomes, and Compliance history before the next Trial.</p></div> : <div className="context-tip"><p><strong>Two thresholds. One shared outcome.</strong> Each threshold met adds 10 Stability. Each missed costs 15. Think carefully about what everyone will contribute.</p></div>}</section>;
}

function TrialTargets({ game }: { game: PublicGame }) {
  if (!game.trial) return null;
  return <div className="trial-targets"><div><span className="target-symbol">+</span><div><span className="eyebrow">MEDICAL THRESHOLD</span><strong>{game.trial.medicalTarget} units</strong></div></div><div><span className="target-symbol security-symbol">◇</span><div><span className="eyebrow">SECURITY THRESHOLD</span><strong>{game.trial.securityTarget} units</strong></div></div></div>;
}

function ResourceDecision({ view, send, active, eligible, pending }: { view: RoomView; send: Send; active: boolean; eligible: boolean; pending: string[] }) {
  const [allocation, setAllocation] = useState<Allocation>(view.me?.decision ?? { medical: 0, security: 0, reserve: 0 });
  const total = allocation.medical + allocation.security + allocation.reserve;
  const locked = view.me?.decisionSubmitted ?? false;
  const canAct = active && eligible && !locked && !pending.includes('decision');
  return <section className="panel decision-panel"><div className="section-heading"><span className="eyebrow">SECRET DECISION · PRIVATE INPUT</span><span className="small-tag"><Icon name="lock" /> LOCKED ON SUBMIT</span></div><h2>Where will your resources go?</h2><p>Allocate exactly three units. The group needs Medical and Security; your directive may want something else.</p><TrialTargets game={view.game!} />{eligible ? <><div className="allocation-header"><strong>{locked ? 'Your locked allocation' : `${3 - total} unit${3 - total === 1 ? '' : 's'} remaining`}</strong><span>{Array.from({ length: 3 }, (_, i) => <i className={i < total ? 'filled' : ''} key={i} />)}</span></div><ResourceStation allocation={locked ? view.me?.decision ?? allocation : allocation} onChange={setAllocation} disabled={!canAct} restriction={view.me?.restriction ?? false} medicalTarget={view.game!.trial?.medicalTarget ?? 0} securityTarget={view.game!.trial?.securityTarget ?? 0} />{view.me?.restriction && <p className="restriction-notice">RESTRICTION ACTIVE · You must allocate at least one unit to Medical.</p>}{locked ? <p className="locked-notice"><Icon name="lock" />Allocation locked. Other Subjects cannot see your contribution.</p> : <button className="button orange-button full-width" disabled={!canAct || total !== 3 || (view.me?.restriction && allocation.medical < 1)} onClick={() => send({ type: 'decision', allocation })}>Lock allocation<Icon name="lock" /></button>}<p className="field-note">A missing decision contributes zero units and earns no directive reward. Submitted choices cannot be changed.</p></> : <p className="locked-notice">The eligible Subjects are making private allocations.</p>}</section>;
}

function Vote({ view, send, active, eligible, pending }: { view: RoomView; send: Send; active: boolean; eligible: boolean; pending: string[] }) {
  const [target, setTarget] = useState<string | null>(null);
  const type = view.game!.voteType;
  const explanations = { exposure: ['Exposure ballot', 'The unique leading Subject’s just-completed directive becomes public.'], restriction: ['Restriction ballot', 'The unique leading Subject must commit at least one Medical unit in the next ordinary Trial.'], trust: ['Trust ballot', 'The unique leading Subject earns +1 Compliance. All Trust votes contribute to the final Trust ranking.'] };
  const explanation = type ? explanations[type] : ['Mixed ballot', 'Vote according to this Trial’s rules.'];
  return <section className="panel vote-panel"><span className="eyebrow">{type?.toUpperCase()} VOTE · SECRET BALLOT</span><h2>{explanation[0]}</h2><p>{explanation[1]} Tied leaders have no mechanical effect. Self-voting is not allowed.</p>{view.me?.voteSubmitted ? <p className="locked-notice"><Icon name="lock" />Your ballot is locked. Individual ballots remain secret until consequences.</p> : eligible ? <><fieldset className="vote-options"><legend className="sr-only">Choose a ballot target</legend>{view.game!.voteTargets.filter(id => id !== view.selfId).map(id => { const member = view.members.find(m => m.id === id); if (!member) return null; return <label className={target === id ? 'selected' : ''} key={id}><input type="radio" name="ballot" value={id} checked={target === id} onChange={() => setTarget(id)} disabled={!active} /><span className="subject-avatar">{member.subjectNumber ? String(member.subjectNumber).padStart(2, '0') : '—'}</span><span><strong>{subjectName(member)}</strong><small>{member.nickname}</small></span></label>; })}<label className={`abstain-option ${target === null ? 'selected' : ''}`}><input type="radio" name="ballot" checked={target === null} onChange={() => setTarget(null)} disabled={!active} /><span>Abstain</span></label></fieldset><button className="button orange-button full-width" disabled={!active || pending.includes('vote')} onClick={() => send({ type: 'vote', targetId: target })}>Lock vote<Icon name="lock" /></button></> : <p className="locked-notice">The Subjects are casting private ballots.</p>}</section>;
}

function FinalStatement({ phaseId, send, active, pending }: { phaseId: string; send: Send; active: boolean; pending: string[] }) {
  const [text, setText] = useState('');
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => { setText(''); setSubmitted(false); }, [phaseId]);
  return <form onSubmit={e => { e.preventDefault(); if (send({ type: 'statement', text })) setSubmitted(true); }}><label className="field-label" htmlFor="final-statement">Final statement</label><textarea id="final-statement" rows={3} value={text} onChange={e => setText(e.target.value)} placeholder="What should the other Subjects know?" maxLength={500} required disabled={!active || submitted} /><button className="button dark-button" disabled={!active || !text.trim() || submitted || pending.includes('statement')}>{submitted ? 'Statement submitted' : 'Submit statement'}</button></form>;
}

function FinalChoice({ view, send, active, eligible, pending }: { view: RoomView; send: Send; active: boolean; eligible: boolean; pending: string[] }) {
  const [choice, setChoice] = useState<'group' | 'self' | null>(null);
  const locked = view.me?.finalChoice;
  return <section className="panel final-choice-panel"><span className="eyebrow">THE FINAL CHOICE · SECRET</span><h2>What are you willing to protect?</h2><p>Read your Final Directive in your private dossier. Every Subject must lock a choice before the Experiment resolves the outcome.</p>{eligible ? <><fieldset className="final-options"><legend className="sr-only">Final choice</legend><label className={(locked ?? choice) === 'group' ? 'selected' : ''}><input type="radio" name="final-choice" checked={(locked ?? choice) === 'group'} onChange={() => setChoice('group')} disabled={!active || !!locked} /><span className="final-symbol" aria-hidden="true"><svg viewBox="0 0 100 80"><path d="M50 4 87 19v24c0 18-37 34-37 34S13 61 13 43V19Z"/><circle cx="50" cy="31" r="9"/><path d="M33 57c0-20 34-20 34 0M23 31h9m36 0h9"/></svg></span><strong>Protect the Group</strong><small>Contribute to collective survival.</small></label><label className={(locked ?? choice) === 'self' ? 'selected self-choice' : 'self-choice'}><input type="radio" name="final-choice" checked={(locked ?? choice) === 'self'} onChange={() => setChoice('self')} disabled={!active || !!locked} /><span className="final-symbol" aria-hidden="true"><svg viewBox="0 0 100 80"><circle cx="50" cy="40" r="32"/><circle cx="50" cy="29" r="11"/><path d="M30 62c0-26 40-26 40 0M8 40h10m64 0h10"/></svg></span><strong>Protect Yourself</strong><small>Put your own instruction first.</small></label></fieldset>{locked ? <p className="locked-notice"><Icon name="lock" />Your final choice is locked: {locked === 'group' ? 'Protect the Group' : 'Protect Yourself'}. Waiting for all eligible Subjects.</p> : <button className="button orange-button full-width" disabled={!active || !choice || pending.includes('final_choice')} onClick={() => choice && send({ type: 'final_choice', choice })}>Lock final choice<Icon name="lock" /></button>}</> : <p className="locked-notice">The remaining Subjects are making their last private choice.</p>}<p className="field-note">The timer is a warning, not an automatic choice. The host can pause for reconnection or explicitly end a stuck session. Choices remain hidden until the prescribed reveal.</p></section>;
}

function PrivateDossier({ view }: { view: RoomView }) {
  const [open, setOpen] = useState(false);
  const me = view.me!;
  useEffect(() => setOpen(false), [view.game?.id]);
  useEffect(() => {
    const conceal = () => { if (document.hidden) setOpen(false); };
    document.addEventListener('visibilitychange', conceal);
    return () => document.removeEventListener('visibilitychange', conceal);
  }, []);
  const phase = view.game?.phase.type;
  const directive = phase?.startsWith('final_') || phase === 'personal_results' || phase === 'full_reveal' ? me.finalDirective : me.directive;
  return <section className={`private-panel ${open ? 'opened' : ''}`} id="private-dossier"><div className="private-heading"><div><span className="eyebrow"><Icon name="lock" />PRIVATE · FOR YOUR EYES ONLY</span><h2>Experiment dossier</h2></div><button className={`button ${open ? 'private-close' : 'private-open'}`} onClick={() => setOpen(!open)} aria-expanded={open} aria-controls="private-content">{open ? 'Conceal dossier' : 'Reveal private dossier'}<Icon name={open ? 'lock' : 'eye'} /></button></div>{open ? <div id="private-content" className="private-content"><div className="compliance-summary"><div><span className="eyebrow">PERSONAL COMPLIANCE</span><strong>{me.compliance}<span>/ {me.requirement} required</span></strong></div><span className={`private-status ${me.compliance >= me.requirement ? 'achieved' : ''}`}>{me.compliance >= me.requirement ? 'TARGET REACHED' : 'TARGET PENDING'}</span></div>{me.result && <div className={`personal-report ${me.result.qualified ? 'qualified' : ''}`}><span className="eyebrow">YOUR PERSONAL RESULT</span><h3>{view.game?.outcome === 'aborted' ? 'Session aborted' : me.result.qualified ? 'Qualified.' : 'Not qualified.'}</h3><p>{view.game?.outcome === 'survived' ? 'Group: Survived' : 'Group: Did not survive'} · Compliance: {me.result.compliance} / {me.result.requirement}</p><span>{me.result.classification.replaceAll('_', ' ')}</span></div>}{directive && <div className="directive-card"><div><span className="eyebrow">{directive === me.finalDirective ? 'FINAL DIRECTIVE' : 'CURRENT DIRECTIVE'}</span><span className="reward">+{directive.reward} COMPLIANCE</span></div><h3>{directive.text}</h3><p>This instruction belongs to you. Other Subjects can only learn it through an authorized disclosure or your own words.</p></div>}{me.restriction && <p className="restriction-notice">Restriction: your next ordinary allocation must include at least one Medical unit.</p>}<details className="dossier-history"><summary>Dossier history <span>{me.dossier.length} entries</span></summary><div>{me.dossier.length ? [...me.dossier].reverse().map(entry => <article key={entry.id}><span className="eyebrow">ROUND {entry.round}{entry.complianceDelta !== 0 ? ` · ${entry.complianceDelta > 0 ? '+' : ''}${entry.complianceDelta} COMPLIANCE` : ''}</span><h4>{entry.title}</h4><p>{entry.text}</p></article>) : <p>Your directive, choice, and Compliance history will appear here as the Experiment unfolds.</p>}</div></details></div> : <div className="dossier-sealed" id="private-content"><span className="seal-icon"><Icon name="lock" /></span><p>Your instructions, Compliance, and history are sealed.<br /><span>Check your surroundings before opening.</span></p></div>}</section>;
}

function FullReveal({ view, send, online, pending }: { view: RoomView; send: Send; online: boolean; pending: string[] }) {
  const game = view.game!;
  return <section className="panel full-reveal"><div className="section-heading"><span className="eyebrow">THE FULL REVEAL · PUBLIC</span><span className="small-tag">{game.outcome === 'survived' ? 'GROUP SURVIVED' : 'GROUP FAILED'}</span></div><h2>Now you know.</h2><p>Private instructions. Pivotal choices. The actual reasons behind the results.</p><div className="result-cards">{game.results.map(result => <article className={result.qualified ? 'result-card qualified' : 'result-card'} key={result.memberId}><div className="result-card-top"><span className="eyebrow">SUBJECT {String(result.subjectNumber).padStart(2, '0')}</span><span className="small-tag">{result.qualified ? 'QUALIFIED' : 'NOT QUALIFIED'}</span></div><h3>{result.nickname}</h3><div className="result-compliance">{result.compliance}<span>/ {result.requirement} Compliance</span></div><dl><div><dt>Directives completed</dt><dd>{result.directivesCompleted}</dd></div><div><dt>Trust rank</dt><dd>#{result.trustRank}</dd></div><div><dt>Trust votes</dt><dd>{result.trustVotes}</dd></div></dl><p className="classification">{result.classification.replaceAll('_', ' ')}</p>{result.removed && <small>Removed during session</small>}</article>)}</div><details className="reveal-history"><summary>Open the complete session record <span>{game.fullReveal.length} disclosures</span></summary><div>{game.fullReveal.map(entry => <article key={entry.id}><span className="eyebrow">ROUND {entry.round}</span><h4>{entry.title}</h4><p>{entry.detail}</p></article>)}</div></details><div className="rematch-row"><div><h3>The room stays open.</h3><p>Discuss the reveal, change settings, and try again with fresh directives.</p></div>{view.hostId === view.selfId ? <button className="button orange-button" disabled={!online || pending.includes('rematch')} onClick={() => send({ type: 'rematch' })}>Return to lobby<Icon name="arrow" /></button> : <p className="eyebrow">THE HOST CAN OPEN THE NEXT SESSION</p>}</div></section>;
}

function PublicRecord({ view }: { view: RoomView }) {
  return <section className="panel public-record"><div className="section-heading compact"><span className="eyebrow">PUBLIC RECORD</span><span className="small-tag">VERIFIED DISCLOSURES</span></div><details open><summary>What the Experiment has disclosed <span>{view.events.length} events</span></summary><div className="public-events">{view.events.length ? [...view.events].reverse().map(event => <article key={event.id}><span className="event-dot" /><div><span className="eyebrow">{event.round ? `ROUND ${event.round}` : 'LOBBY'} · {new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span><h4>{event.title}</h4><p>{event.detail}</p></div></article>) : <p className="small-muted">The public record begins when the Experiment starts.</p>}</div></details></section>;
}

function SurvivalAdministration({ view, send, online }: { view: RoomView; send: Send; online: boolean }) {
  const [targetId, setTargetId] = useState('');
  return <section className="panel host-panel"><details><summary>Host controls <span className="small-tag">SURVIVAL</span></summary><p className="small-muted">Pause the world or transfer leadership. Combat and inventories remain server-controlled.</p><div className="host-buttons"><button className="button outline-button small" disabled={!online} onClick={() => send({ type: 'survival_pause', paused: !view.survival!.paused })}>{view.survival!.paused ? 'Resume survival' : 'Pause survival'}</button><button className="button outline-button small" disabled={!online} onClick={() => send({ type: 'mute_chat', muted: !view.chatMuted })}>{view.chatMuted ? 'Unmute public chat' : 'Mute public chat'}</button></div><label className="field-label" htmlFor="survival-host-target">Transfer leadership</label><select id="survival-host-target" value={targetId} onChange={e => setTargetId(e.target.value)}><option value="">Choose a player</option>{view.members.filter(m => m.id !== view.selfId && !m.removed && m.controller === 'human').map(m => <option key={m.id} value={m.id}>{m.nickname}</option>)}</select><button className="button outline-button small" disabled={!online || !targetId} onClick={() => send({ type: 'transfer_host', targetId })}>Transfer host</button></details></section>;
}

function HostControls({ view, send, online }: { view: RoomView; send: Send; online: boolean }) {
  const [targetId, setTargetId] = useState('');
  const [confirmation, setConfirmation] = useState<'end' | 'remove' | null>(null);
  const game = view.game;
  const running = view.status === 'running' && game;
  const target = view.members.find(m => m.id === targetId);
  return <section className="panel host-panel"><details><summary>Host controls <span className="small-tag">ADMINISTRATION</span></summary><p className="small-muted">Controls manage the session. They cannot reveal private state, choose for Subjects, or edit scores.</p><div className="host-buttons">{running && <><button className="button outline-button small" disabled={!online} onClick={() => send({ type: game.phase.paused ? 'resume' : 'pause' })}>{game.phase.paused ? 'Resume experiment' : 'Pause experiment'}</button><button className="button outline-button small" disabled={!online || game.phase.paused || game.phase.type === 'final_choice'} onClick={() => send({ type: 'advance' })}>Advance phase</button></>}<button className="button outline-button small" disabled={!online} onClick={() => send({ type: 'mute_chat', muted: !view.chatMuted })}>{view.chatMuted ? 'Unmute public chat' : 'Mute public chat'}</button></div><p className="field-note">Advance uses the phase’s timeout rules. It cannot force an unsubmitted final choice.</p><label className="field-label" htmlFor="host-target">Subject administration</label><select id="host-target" value={targetId} onChange={e => { setTargetId(e.target.value); setConfirmation(null); }}><option value="">Choose a participant</option>{view.members.filter(m => m.id !== view.selfId && !m.removed).map(m => <option value={m.id} key={m.id}>{subjectName(m)} · {m.nickname}{m.controller === 'cpu' ? ' · CPU' : ''}</option>)}</select><div className="host-buttons">{target?.controller !== 'cpu' && <button className="button outline-button small" disabled={!online || !targetId} onClick={() => send({ type: 'transfer_host', targetId })}>Transfer host</button>}<button className="button outline-button small danger-text" disabled={!online || !targetId} onClick={() => setConfirmation('remove')}>Remove player</button>{!running && target && target.controller !== 'cpu' && <button className="button outline-button small" disabled={!online} onClick={() => send({ type: 'set_role', targetId, role: target.role === 'spectator' ? 'subject' : 'spectator' })}>{target.role === 'spectator' ? 'Promote to Subject' : 'Make spectator'}</button>}</div>{running && <button className="text-button danger-text" disabled={!online} onClick={() => setConfirmation('end')}>End experiment</button>}{confirmation && <div className="confirmation" role="alert"><strong>{confirmation === 'end' ? 'End this experiment?' : `Remove ${target?.nickname ?? 'this participant'}?`}</strong><p>{confirmation === 'end' ? 'The session is aborted with no winners. Hidden choices remain sealed.' : 'Committed history is preserved. Fewer than four Subjects pauses the current game.'}</p><div className="action-buttons"><button className="button danger-button small" disabled={!online} onClick={() => { send(confirmation === 'end' ? { type: 'end' } : { type: 'remove', targetId }); setConfirmation(null); }}>Confirm {confirmation === 'end' ? 'end' : 'removal'}</button><button className="button outline-button small" onClick={() => setConfirmation(null)}>Cancel</button></div></div>}</details></section>;
}

function Help({ onClose }: { onClose: () => void }) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    close.current?.focus();
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'Tab') { event.preventDefault(); close.current?.focus(); }
    };
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, [onClose]);
  return <div className="modal-backdrop" onClick={onClose}><section className="help-modal" role="dialog" aria-modal="true" aria-labelledby="help-title" onClick={e => e.stopPropagation()}><div className="section-heading"><span className="eyebrow">SUBJECT ORIENTATION</span><button className="icon-button" onClick={onClose} ref={close} aria-label="Close how to play"><Icon name="cross" /></button></div><h2 id="help-title">Survive the frontier.</h2><p className="help-intro">Explore a persistent world, collect supplies, recruit survivors, and defend one shelter against infected enemies. Day-to-day play is continuous; hordes arrive in combat waves.</p><ol className="help-steps"><li><strong>Start alone or with friends.</strong><p>Create a room, choose a shelter and day length, mark ready, then start. CPU teammates are optional; friends joining can take their places.</p></li><li><strong>Move, aim, and fight.</strong><p>Use WASD or arrow keys to move, the mouse to aim, and hold the left button to fire. Press R to reload and E to interact. Phones have movement and aim controls plus Interact and Reload buttons.</p></li><li><strong>Loot and look after yourself.</strong><p>Approach supply containers and survivors to interact. Food, water, and medicine restore your needs and health. Ammunition, gun cooldowns, armor, and range matter.</p></li><li><strong>Improve your equipment and crew.</strong><p>Craft guns, gear, medicine, and base facilities at your shelter. Upgrades consume the displayed resources and take time. Gear bonuses apply while owned; rescued survivors help according to their role.</p></li><li><strong>Keep one shelter standing.</strong><p>Repair and upgrade your chosen shelter. Discover another site to move the group there when no horde is active. Moving carries your upgrades and preserves your damage ratio.</p></li><li><strong>Share the shelter’s work.</strong><p>Open Duties to elect a Captain, Defender, Scout, Medic, and Engineer. Ballots are private. Everyone has a daily crew duty, and officers receive extra responsibilities. Completed duties add communal supplies; each unfinished duty costs the shelter 20 health at the next day. Deposit or withdraw supplies at the shelter and use medicine to treat nearby wounded teammates.</p></li><li><strong>Invest across days.</strong><p>Complete daily, weekly, and monthly goals. A week is seven game days and a month is thirty. The host chooses one, two, or four real hours per active game day.</p></li><li><strong>Return to the same world.</strong><p>Your browser session reconnects your player and saved inventory. When every human is offline, the survival clock stops and enemies cannot harm your group. A downed player can recover after the displayed delay.</p></li></ol><div className="help-footer"><Icon name="lock" /><p>The server owns combat, loot, costs, timers, and progress. Room codes admit new players; this browser’s anonymous session restores your existing player. Enable sound for effects and device-supported narration.</p></div></section></div>;
}
