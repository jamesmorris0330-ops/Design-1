import { useId, useState } from 'react';
import type { Action, RoomView } from '../shared/protocol';
import { SHELTERS, shelterTypes, type ShelterType } from '../shared/survival';
import './survival-ui.css';

export interface SurvivalScreenProps {
  view: RoomView;
  send: (action: Action) => boolean;
  online: boolean;
  pending: string[];
  speakingId?: string | null;
}

export function ShelterIllustration({ type, className = '' }: { type: ShelterType; className?: string }) {
  const gradient = `shelter-${useId().replaceAll(':', '')}`;
  return <svg viewBox="0 0 240 150" className={`shelter-illustration ${className}`} aria-hidden="true">
    <defs><linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#233b42" /><stop offset="1" stopColor="#101b24" /></linearGradient></defs>
    <rect width="240" height="150" rx="9" fill={`url(#${gradient})`} />
    <circle cx="189" cy="31" r="17" fill="#e7c788" opacity=".65" />
    <path d="M0 89 30 61 66 90 95 62 129 95 175 57 219 92 240 75V150H0Z" fill="#2d4b4b" />
    <path d="M0 117 58 101 120 121 186 104 240 117V150H0Z" fill="#132529" />
    {[18, 30, 217, 228].map((x, index) => <g key={x} transform={`translate(${x} ${index % 2 ? 10 : 0})`}><path d="M0 44-13 84H13ZM0 64-17 101H17Z" fill="#152d30" /><path d="M0 86V130" stroke="#0c1a21" strokeWidth="3" /></g>)}
    {type === 'farmhouse' && <><path d="M63 76H171V127H63Z" fill="#9b7353" stroke="#cca273" strokeWidth="2" /><path d="M53 78 114 34 178 78Z" fill="#473e3d" stroke="#927b64" strokeWidth="3" /><rect x="83" y="88" width="20" height="19" fill="#efd495" /><rect x="134" y="88" width="20" height="19" fill="#efd495" /><path d="M109 128V89H126V128" fill="#463b32" /><path d="M61 122H172M159 57V36H169V63" stroke="#b39572" strokeWidth="4" /><path d="M39 131V115M195 131V115M32 119H54M182 119H208" stroke="#887254" strokeWidth="3" /></>}
    {type === 'bunker' && <><path d="M49 121 68 71 93 53H157L181 71 197 121Z" fill="#65746a" stroke="#98a48a" strokeWidth="2" /><path d="M67 122 80 89H166L180 122Z" fill="#3b4644" /><rect x="99" y="78" width="49" height="50" rx="5" fill="#203335" stroke="#86978b" strokeWidth="4" /><path d="M112 87V121M138 87V121M113 105H137" stroke="#768a7e" strokeWidth="2" /><rect x="155" y="77" width="15" height="8" fill="#e1ba7b" /><path d="M77 65H164M73 71H173M64 84H87" stroke="#90a58b" strokeWidth="3" /><path d="M114 130 85 150H160L137 130" fill="#6f7869" /></>}
    {type === 'warehouse' && <><path d="M49 67H193V127H49Z" fill="#516270" stroke="#809194" strokeWidth="2" /><path d="M38 70 122 34 202 70Z" fill="#38444b" stroke="#839095" strokeWidth="2" /><path d="M57 84H98V126H57M137 84H178V126H137" fill="#304049" stroke="#8c9a99" strokeWidth="2" /><path d="M58 91H97M58 99H97M58 107H97M58 115H97M138 91H177M138 99H177M138 107H177M138 115H177" stroke="#658080" /><rect x="109" y="86" width="16" height="39" fill="#b0a47b" /><path d="M65 57H174" stroke="#dda873" strokeWidth="4" /><path d="M193 102H211V126H193M25 112H46V132H25" fill="#795f49" stroke="#ad8960" /></>}
    {type === 'apartment' && <><rect x="74" y="34" width="102" height="94" fill="#80645b" stroke="#b39478" strokeWidth="2" /><path d="M69 34H181M73 63H177M73 91H177" stroke="#403f40" strokeWidth="5" />{[87, 117, 147].map(x => [43, 73, 103].map(y => <rect key={`${x}-${y}`} x={x} y={y} width="16" height="13" fill={(x + y) % 3 ? '#dcc287' : '#23393d'} stroke="#374147" strokeWidth="2" />))}<path d="M108 128V106H126V128" fill="#253639" /><path d="M47 129V93H74M176 92H193V130" fill="#475650" stroke="#82917b" strokeWidth="2" /><path d="M81 29V19H144V29" stroke="#566b68" strokeWidth="3" /></>}
    {type === 'ranger_station' && <><path d="M57 86H165V126H57Z" fill="#78664d" stroke="#b29a6d" strokeWidth="2" /><path d="M46 88 109 53 175 88Z" fill="#415a4e" stroke="#95aa82" strokeWidth="2" /><path d="M57 99H165M57 110H165M57 120H165" stroke="#a39266" strokeWidth="2" /><rect x="75" y="94" width="21" height="17" fill="#e7cd8b" /><path d="M115 126V93H135V126" fill="#303e36" /><path d="M183 130V48M202 130V48M183 77H202M183 101H202M182 126 203 78M182 100 203 51" stroke="#8a9577" strokeWidth="3" /><rect x="175" y="34" width="35" height="24" fill="#67765b" stroke="#aabb88" strokeWidth="2" /><path d="M170 34 192 17 215 34Z" fill="#405949" /><rect x="186" y="40" width="13" height="10" fill="#e6ca87" /></>}
    <path d="M0 143Q120 133 240 142" stroke="#bda073" opacity=".4" fill="none" />
    <ellipse cx="118" cy="131" rx="75" ry="5" fill="#070e15" opacity=".5" />
  </svg>;
}

export function SurvivalLobby({ view, send, online, pending }: SurvivalScreenProps) {
  const [shelterType, setShelterType] = useState<ShelterType>('farmhouse');
  const [dayLengthMinutes, setDayLengthMinutes] = useState<60 | 120 | 240>(60);
  const isHost = view.selfId === view.hostId;
  const self = view.members.find(member => member.id === view.selfId);
  const players = view.members.filter(member => member.role === 'subject' && !member.removed);
  const humans = players.filter(member => member.controller !== 'cpu');
  const cpuCount = players.length - humans.length;
  const allReady = humans.length > 0 && humans.every(member => member.ready);
  return <div className="survival-ui survival-lobby" data-testid="survival-lobby">
    <section className="survival-intro">
      <span className="survival-kicker"><span className="survival-beacon" /> QUARANTINE ZONE / PREPARATION</span>
      <h1>Survive the<br /><em>Experiment.</em></h1>
      <p>The virus is outside. Your future is inside.<br />Scavenge, fight, rescue survivors, and build a shelter worth defending.</p>
      <div className="survival-loop"><span>01 <strong>Explore</strong></span><span>02 <strong>Build</strong></span><span>03 <strong>Defend</strong></span><span>04 <strong>Survive</strong></span></div>
    </section>
    <section className="survival-panel shelter-choice-panel">
      <div className="survival-panel-title"><div><span className="survival-kicker">ONE HOME. FIVE STARTING POINTS.</span><h2>Choose your shelter.</h2></div><span className="survival-chip">{isHost ? 'HOST SELECTS' : 'SELECTED BY HOST'}</span></div>
      <p className="survival-muted">Your crew shares one active base. Discover another shelter while exploring to move your community later.</p>
      <div className="shelter-choice-grid" role="radiogroup" aria-label="Starting shelter">
        {shelterTypes.map(type => { const shelter = SHELTERS[type]; return <button key={type} type="button" role="radio" aria-label={shelter.name} aria-checked={isHost && shelterType === type} className={`shelter-choice ${isHost && shelterType === type ? 'is-selected' : ''}`} disabled={!isHost || !online} onClick={() => setShelterType(type)}>
          <ShelterIllustration type={type} /><span className="shelter-choice-heading"><strong>{shelter.name}</strong>{isHost && shelterType === type && <span aria-hidden="true">✓</span>}</span><span className="shelter-description">{shelter.description}</span>
          <span className="shelter-stat-row"><span><b>{shelter.health}</b> durability</span><span><b>{shelter.defense}</b> defense</span><span><b>{shelter.capacity}</b> crew</span></span>
        </button>; })}
      </div>
      <div className="survival-day-setting"><div><label htmlFor="survival-day-length">Game day length</label><p className="survival-muted">A full day/night cycle passes during active play. Your world pauses when every human disconnects.</p></div><select id="survival-day-length" value={dayLengthMinutes} disabled={!isHost || !online} onChange={event => setDayLengthMinutes(Number(event.target.value) as 60 | 120 | 240)}><option value={60}>1 game day = 1 hour</option><option value={120}>1 game day = 2 hours</option><option value={240}>1 game day = 4 hours</option></select></div>
    </section>
    <section className="survival-panel survival-ready-panel">
      <div className="survival-panel-title"><div><span className="survival-kicker">BRING YOUR CREW</span><h2>{humans.length} player{humans.length === 1 ? '' : 's'} · {cpuCount} CPU companion{cpuCount === 1 ? '' : 's'}</h2></div>{isHost && <button className="survival-button secondary" disabled={!online || players.length >= 8 || pending.includes('add_cpu')} onClick={() => send({ type: 'add_cpu' })}>Add CPU player</button>}</div>
      <p className="survival-muted">Play alone, bring friends, or add optional CPU companions. Friends can join with the room code and take an available CPU seat during play.</p>
      <div className="survival-ready-actions"><div><strong>{allReady ? 'Your crew is ready.' : 'Mark ready when you are set.'}</strong><p className="survival-muted">{self?.role === 'spectator' ? 'You will observe the world and public crew activity.' : 'Keep supplies stocked. Defend your shelter. Stay alive.'}</p></div><div className="survival-button-row">{self?.role === 'subject' && !self.removed && <button className="survival-button secondary" disabled={!online || pending.includes('ready')} onClick={() => send({ type: 'ready', ready: !self.ready })}>{self.ready ? 'Not ready' : 'Mark ready'}</button>}{isHost && <button className="survival-button primary" disabled={!online || !allReady || pending.includes('survival_start')} onClick={() => send({ type: 'survival_start', shelterType, dayLengthMinutes })}>Start survival <span aria-hidden="true">↗</span></button>}</div></div>
    </section>
    <p className="survival-muted survival-lobby-tip">Desktop: WASD / arrow keys to move, mouse to aim, hold fire to shoot. Phone: movement and firing controls appear in the world.</p>
  </div>;
}
