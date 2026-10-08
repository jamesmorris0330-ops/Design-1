import { useId, useState } from 'react';
import type { Action, PublicMember, RoomView } from '../shared/protocol';
import { POSITIONS, itemIds, positions, type ItemId, type PlayerDuty, type PositionId } from '../shared/survival';
import './shelter-duties.css';

interface ShelterDutiesProps {
  view: RoomView;
  send: (action: Action) => boolean;
  online: boolean;
  pending: string[];
}

const itemNames: Record<ItemId, string> = { wood: 'Wood', metal: 'Metal', cloth: 'Cloth', electronics: 'Electronics', ammo: 'Ammunition', food: 'Food', water: 'Water', medicine: 'Medicine' };
const duration = (ms: number) => {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return seconds >= 60 ? `${Math.floor(seconds / 60)}m ${seconds % 60}s` : `${seconds}s`;
};
const percent = (duty: PlayerDuty | undefined) => duty ? Math.max(0, Math.min(100, duty.progress / Math.max(1, duty.target) * 100)) : 0;

function TransferArrow({ reverse = false }: { reverse?: boolean }) {
  return <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={{ transform: reverse ? 'rotate(180deg)' : undefined, flexShrink: 0 }}><path d="M3 13 13 3M5 3h8v8" /></svg>;
}

function RoleIllustration({ position }: { position: PositionId }) {
  const id = `duty-${useId().replaceAll(':', '')}`;
  return <svg className="shelter-role-illustration" viewBox="0 0 100 80" fill="none" aria-hidden="true">
    <defs><linearGradient id={id} x1="15" y1="10" x2="86" y2="75" gradientUnits="userSpaceOnUse"><stop stopColor="#294c4a" /><stop offset="1" stopColor="#162c34" /></linearGradient></defs>
    <path d="m50 4 35 20v37L50 79 15 61V24Z" fill={`url(#${id})`} stroke="#476664" />
    <path d="M23 30v26l27 15 27-15V30" stroke="#89b9a0" strokeOpacity=".2" />
    {position === 'captain' && <><path d="m30 32 10 7 10-17 10 17 10-7-4 25H34Z" fill="#d2b175" stroke="#efcea1" strokeWidth="2" /><path d="M35 62h30M40 48h20" stroke="#efcea1" strokeWidth="2" /><circle cx="50" cy="49" r="4" fill="#2b4547" /></>}
    {position === 'defender' && <><path d="m50 20 22 9-3 23q-6 14-19 20-13-6-19-20l-3-23Z" fill="#6d8880" stroke="#b8c6a5" strokeWidth="2" /><path d="M50 25v38m-16-29 16 7 16-7" stroke="#2d454a" strokeWidth="3" /><path d="m43 47 6 6 10-12" stroke="#e4c789" strokeWidth="3" /></>}
    {position === 'scout' && <><circle cx="50" cy="44" r="23" fill="#3b6262" stroke="#a7c5ad" strokeWidth="2" /><circle cx="50" cy="44" r="17" stroke="#7ca69a" strokeDasharray="2 5" /><path d="m50 24 8 20-8 20-8-20Z" fill="#d4b078" stroke="#eed7aa" /><path d="M50 44v20l8-20Z" fill="#305252" stroke="#91b9a6" /><path d="M50 15v5m0 48v5M21 44h5m48 0h5" stroke="#b2c6b1" /></>}
    {position === 'medic' && <><rect x="25" y="30" width="50" height="32" rx="5" fill="#846957" stroke="#d9b496" strokeWidth="2" /><path d="M40 30v-7h20v7" stroke="#d9b496" strokeWidth="3" /><path d="M46 36h8v7h7v8h-7v7h-8v-7h-7v-8h7Z" fill="#e5d3b4" /><path d="M29 64h42" stroke="#665a4e" strokeWidth="2" /></>}
    {position === 'engineer' && <><path d="M36 19a15 15 0 0 0 12 23l20 24 9-9-25-20a15 15 0 0 0-21-19l10 10-8 8-10-10Z" fill="#82928a" stroke="#c6cbb0" strokeWidth="2" /><path d="m59 19 13 13-8 8-4-4-25 29-10-10 29-25-4-4Z" fill="#a78356" stroke="#d2b281" strokeWidth="2" /><circle cx="68" cy="57" r="3" fill="#304c4d" /></>}
  </svg>;
}

function SupplyIcon({ item }: { item: ItemId }) {
  const shape = {
    wood: <><path d="m7 20 14-13 12 10-14 13Z" fill="#93714f" /><path d="m21 7 3 12-5 11M7 20l17-1 9-2" /></>,
    metal: <><path d="m5 20 24-11 7 9-24 11Z" fill="#8b9d9b" /><path d="m5 20 7 9v5L5 26Zm7 9 24-11v5L12 34Z" fill="#415e67" /></>,
    cloth: <><path d="M8 11q8-7 16-2l10 5-6 20q-11-7-21-2l4-12Z" fill="#8f947b" /><path d="m11 20 16 4M16 11l6 19" strokeDasharray="2 2" /></>,
    electronics: <><rect x="9" y="8" width="24" height="26" rx="3" fill="#3d7866" /><rect x="16" y="15" width="10" height="12" fill="#24464c" /><path d="M18 8v7m6-7v7m-6 12v7m6-7v7M9 19h7m-7 6h7m10-6h7m-7 6h7" /></>,
    ammo: <>{[11, 21, 31].map(x => <path key={x} d={`M${x-3} 16q3-11 6 0v17h-6Zm-1 17h8`} fill="#caa562" />)}</>,
    food: <><rect x="10" y="10" width="24" height="25" rx="3" fill="#958160" /><ellipse cx="22" cy="10" rx="12" ry="4" fill="#c3b18b" /><path d="M11 18h22v12H11Z" fill="#54735b" /><path d="M18 24h8m-4-4v8" /></>,
    water: <><path d="M16 8h12v7l5 5v13q-10 7-22 0V20l5-5Z" fill="#507f95" /><path d="M15 8h14M14 22h15v8H14" stroke="#aacacf" /></>,
    medicine: <><rect x="7" y="13" width="29" height="22" rx="4" fill="#8c6b59" /><path d="M16 13V8h11v5" /><path d="M19 18h6v5h5v6h-5v5h-6v-5h-5v-6h5Z" fill="#e9cfaf" stroke="none" /></>,
  }[item];
  return <svg viewBox="0 0 44 44" className="shelter-supply-icon" fill="none" stroke="#c6d3ba" strokeWidth="1.5" strokeLinejoin="round" strokeLinecap="round" aria-hidden="true">{shape}</svg>;
}

function DutyProgress({ duty, label }: { duty: PlayerDuty; label?: string }) {
  const value = Math.min(duty.target, Math.max(0, duty.progress));
  return <div className={`shelter-duty-progress ${duty.completed ? 'is-complete' : ''}`}>
    <div><span>{duty.completed ? 'COMPLETE' : label ?? 'DAILY DUTY'}</span><b>{Number(value.toFixed(1))} / {duty.target}</b></div>
    <div role="progressbar" aria-label={`${duty.title} progress`} aria-valuemin={0} aria-valuemax={duty.target} aria-valuenow={value}><i style={{ width: `${percent(duty)}%` }} /></div>
  </div>;
}

export function ShelterDuties({ view, send, online, pending }: ShelterDutiesProps) {
  const [candidateChoices, setCandidateChoices] = useState<Record<string, string>>({});
  const [item, setItem] = useState<ItemId>('wood');
  const [amount, setAmount] = useState(5);
  const [aidTargetId, setAidTargetId] = useState('');
  const world = view.survival;
  const me = view.survivorMe;
  const community = world?.community;
  if (!world || !community) return <div className="shelter-duties" data-testid="shelter-duties"><div className="shelter-duty-loading" role="status">Preparing your shelter’s duty board…</div></div>;

  const player = world.players.find(member => member.id === view.selfId);
  const crew = view.members.filter(member => !member.removed && member.role === 'subject' && world.players.some(survivor => survivor.id === member.id));
  const memberLabel = (id: string | null) => id ? (view.members.find(member => member.id === id)?.nickname ?? 'Former crew member') : 'Position vacant';
  const currentDuties = community.duties.filter(duty => duty.day === world.day);
  const ownDuties = currentDuties.filter(duty => duty.memberId === view.selfId);
  const completeCount = currentDuties.filter(duty => duty.completed).length;
  const playable = online && world.active && !world.paused && !!player && !!me && me.hp > 0;
  const nearShelter = !!player && Math.hypot(player.x - world.shelter.x, player.y - world.shelter.y) <= 200;
  const dailyPhase = (world.elapsedMs / Math.max(1, world.dayLengthMs) + 1 / 3) % 1;
  const dayRemaining = world.dayLengthMs * (1 - dailyPhase);
  const quantityValid = Number.isInteger(amount) && amount >= 1 && amount <= 100;
  const transferReady = playable && nearShelter && quantityValid;
  const wounded = [
    ...world.players.filter(target => target.id !== view.selfId && target.hp < 100 && crew.some(member => member.id === target.id)).map(target => ({ ...target, name: memberLabel(target.id) })),
    ...world.survivors.filter(target => target.hp < 100).map(target => ({ ...target, name: `${target.name} · ${target.role}` })),
  ];
  const chosenAid = wounded.find(target => target.id === aidTargetId) ?? wounded[0];
  const aidDistance = player && chosenAid ? Math.hypot(player.x - chosenAid.x, player.y - chosenAid.y) : Infinity;
  const nameBadge = (member: PublicMember) => `${member.nickname}${member.controller === 'cpu' ? ' · CPU' : member.id === view.selfId ? ' · You' : ''}`;

  return <div className="shelter-duties" data-testid="shelter-duties">
    <div className="shelter-duty-heading"><div><span className="survival-kicker">SHARED SHELTER / COMMUNITY BOARD</span><h2>Everybody has a job.</h2><p className="survival-muted">Elect the crew who will lead each position. You can hold more than one role, and everyone has a daily contribution duty.</p></div><div className="shelter-duty-day"><span>DAY {world.day}</span><strong>{completeCount}<small> / {currentDuties.length}</small></strong><span>DUTIES COMPLETE</span></div></div>

    <div className="shelter-duty-brief"><span className="shelter-duty-warning" aria-hidden="true">!</span><div><strong>A stronger shelter starts with a reliable crew.</strong><p>Each completed duty adds <b>1 food, 1 water, and 6 ammunition</b> to the communal stash. Each unfinished duty costs your shelter <b>20 health</b> when the next game day begins.</p></div><div className="shelter-duty-countdown"><span>NEXT DAILY RESET</span><time>{duration(dayRemaining)}</time><small>{world.paused ? 'WORLD PAUSED' : 'ACTIVE PLAY TIME'}</small></div></div>

    <div className="shelter-position-grid">
      {positions.map(position => {
        const definition = POSITIONS[position];
        const officerId = community.officers[position];
        const officerDuty = currentDuties.find(duty => duty.position === position && duty.memberId === officerId);
        const election = community.elections.find(current => current.position === position);
        const ownVote = election ? me?.electionVotes?.[election.id] : undefined;
        const candidates = election ? crew.filter(member => election.candidates.includes(member.id)) : crew;
        const preferred = election ? candidateChoices[election.id] : undefined;
        const choice = candidates.some(candidate => candidate.id === preferred) ? preferred : candidates[0]?.id ?? '';
        const eligible = !!election && election.eligibleIds.includes(view.selfId);
        return <article className={`shelter-position-card ${officerId === view.selfId ? 'is-your-role' : ''}`} key={position} data-testid={`shelter-role-${position}`}>
          <div className="shelter-position-title"><RoleIllustration position={position} /><div><span>{officerId === view.selfId ? 'YOUR ELECTED ROLE' : 'COMMUNITY POSITION'}</span><h3>{definition.name}</h3></div></div>
          <div className="shelter-position-holder"><span>OFFICE HOLDER</span><strong>{memberLabel(officerId)}{officerId && crew.find(member => member.id === officerId)?.controller === 'cpu' && <small>CPU</small>}</strong></div>
          <p className="shelter-position-description">{definition.duty}</p>
          {officerDuty ? <DutyProgress duty={officerDuty} /> : <div className="shelter-duty-unassigned">{officerId ? 'A duty will appear when this role is assigned.' : 'Elect someone to take responsibility.'}</div>}
          <div className="shelter-position-election">
            {election ? <>
              <div className="shelter-election-status"><span className="shelter-election-live" /><strong>Election open</strong><time>{duration(election.endsAt - world.elapsedMs)}</time></div>
              <p className="shelter-election-count">{election.ballotsCast} / {election.eligibleIds.length} ballots cast · Your ballot is private.</p>
              {ownVote ? <p className="shelter-ballot-locked" role="status"><span aria-hidden="true">✓</span> Your vote: <strong>{memberLabel(ownVote)}</strong></p> : eligible ? <>
                <label htmlFor={`shelter-candidate-${position}`}>Choose a candidate</label>
                <select id={`shelter-candidate-${position}`} aria-label={`Role candidate ${position}`} value={choice} disabled={!playable || pending.includes('survival_ballot')} onChange={event => setCandidateChoices(current => ({ ...current, [election.id]: event.target.value }))}>
                  {candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{nameBadge(candidate)}</option>)}
                </select>
                <button className="survival-button primary small" aria-label={`Vote for ${definition.name}`} disabled={!playable || !choice || pending.includes('survival_ballot')} onClick={() => choice && send({ type: 'survival_ballot', electionId: election.id, candidateId: choice })}>Lock private vote</button>
              </> : <p className="shelter-election-count">This election is being decided by the eligible crew.</p>}
            </> : <button className="survival-button secondary small" aria-label={`Elect ${definition.name}`} disabled={!playable || !crew.length || pending.includes('survival_election')} onClick={() => send({ type: 'survival_election', position })}>Elect {definition.name} <TransferArrow /></button>}
          </div>
        </article>;
      })}
    </div>
    <p className="shelter-election-rule">The most votes wins. A tie keeps the current officer; a vacant tied position stays vacant. Elections use the game clock and pause with the world.</p>

    <section className="shelter-personal-duties" aria-label="Daily crew duties">
      <div className="shelter-section-heading"><div><span className="survival-kicker">DAY {world.day} / INDIVIDUAL RESPONSIBILITIES</span><h3>Today’s duty roster.</h3></div><span className="survival-chip">{ownDuties.length ? `${ownDuties.filter(duty => duty.completed).length} / ${ownDuties.length} YOUR DUTIES` : 'PUBLIC ROSTER'}</span></div>
      <div className="shelter-duty-roster">{crew.map(member => {
        const duties = currentDuties.filter(duty => duty.memberId === member.id);
        return <article className={`shelter-crew-duty ${member.id === view.selfId ? 'is-you' : ''}`} key={member.id}>
          <div className="shelter-crew-duty-name"><span className="shelter-crew-marker" aria-hidden="true">{member.nickname.slice(0, 1).toUpperCase()}</span><div><strong>{member.nickname}</strong><span>{member.controller === 'cpu' ? 'CPU COMPANION' : member.id === view.selfId ? 'YOU / YOUR RESPONSIBILITIES' : 'SHELTER CREW'}</span></div></div>
          {duties.length ? duties.map(duty => <div className="shelter-roster-task" key={duty.id}><p>{duty.title}</p><DutyProgress duty={duty} label={duty.position === 'crew' ? 'CREW CONTRIBUTION' : POSITIONS[duty.position].name.toUpperCase()} /></div>) : <p className="shelter-duty-unassigned">Daily duties are being assigned.</p>}
        </article>;
      })}</div>
    </section>

    <section className="shelter-communal-stash" aria-label="Communal supply stash">
      <div className="shelter-section-heading"><div><span className="survival-kicker">EVERYONE’S SUPPLIES / PUBLIC</span><h3>Keep the whole crew supplied.</h3></div><span className={`survival-chip ${nearShelter ? 'is-near' : ''}`}>{nearShelter ? 'AT SHELTER' : 'RETURN TO SHELTER'}</span></div>
      <div className="shelter-stash-grid">{itemIds.map(id => <button type="button" className={`shelter-stash-item ${item === id ? 'is-selected' : ''}`} key={id} aria-label={`Select stash ${itemNames[id]}`} aria-pressed={item === id} onClick={() => setItem(id)}><SupplyIcon item={id} /><strong data-testid={`stash-${id}`}>{community.supplies[id]}</strong><span>{itemNames[id]}</span></button>)}</div>
      <div className="shelter-stash-transfer"><div><label htmlFor="shelter-stash-item">Transfer supplies</label><select id="shelter-stash-item" aria-label="Stash item" value={item} onChange={event => setItem(event.target.value as ItemId)}>{itemIds.map(id => <option key={id} value={id}>{itemNames[id]}</option>)}</select></div><div><label htmlFor="shelter-stash-amount">Amount</label><input id="shelter-stash-amount" aria-label="Stash amount" type="number" inputMode="numeric" min={1} max={100} step={1} value={Number.isFinite(amount) ? amount : ''} onChange={event => setAmount(event.target.value === '' ? NaN : Number(event.target.value))} /></div><div className="shelter-stash-personal"><span>YOUR PACK / PRIVATE</span><strong>{me?.inventory[item] ?? '—'} <small>{itemNames[item]}</small></strong></div><div className="shelter-stash-buttons"><button className="survival-button secondary small" aria-label="Deposit supplies" disabled={!transferReady || !me || me.inventory[item] < amount || pending.includes('survival_deposit')} onClick={() => send({ type: 'survival_deposit', item, amount })}>Deposit <TransferArrow /></button><button className="survival-button primary small" aria-label="Withdraw supplies" disabled={!transferReady || community.supplies[item] < amount || pending.includes('survival_withdraw')} onClick={() => send({ type: 'survival_withdraw', item, amount })}>Withdraw <TransferArrow reverse /></button></div></div>
      <p className="shelter-stash-note">Deposit or withdraw within 200 units of the shelter. The stash is shared; every player’s pack stays private. Your carrying capacity still applies.</p>
    </section>

    <section className="shelter-field-aid" aria-label="Heal another survivor"><RoleIllustration position="medic" /><div className="shelter-field-aid-copy"><span className="survival-kicker">LOOK AFTER YOUR CREW</span><h3>Field aid.</h3><p>Use one medicine to heal a wounded player or recruited survivor within 100 units. Medical aid counts toward your daily duties.</p></div><div className="shelter-field-aid-actions"><label htmlFor="shelter-aid-target">Wounded crew member</label><select id="shelter-aid-target" aria-label="Heal crew member" value={chosenAid?.id ?? ''} disabled={!wounded.length} onChange={event => setAidTargetId(event.target.value)}>{wounded.length ? wounded.map(target => <option key={target.id} value={target.id}>{target.name} · {Math.ceil(target.hp)} HP</option>) : <option value="">The crew is healthy</option>}</select><button className="survival-button secondary small" disabled={!playable || !chosenAid || aidDistance > 100 || !me || me.inventory.medicine < 1 || pending.includes('survival_heal')} onClick={() => chosenAid && send({ type: 'survival_heal', targetId: chosenAid.id })}>Heal crew member <span>1 medicine</span></button><small>{!chosenAid ? 'No wounded crew need aid.' : aidDistance > 100 ? 'Move closer to this crew member.' : (me?.inventory.medicine ?? 0) < 1 ? 'Collect or craft medicine first.' : 'Crew member is within reach.'}</small></div></section>
  </div>;
}
