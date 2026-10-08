import { randomUUID } from 'node:crypto';
import {
  emptyInventory, itemIds, POSITIONS, positions, survivalActions,
  type CommunityPublic, type CommunityState, type DutyMetric, type PlayerDuty,
  type ShelterElection, type SurvivalAction, type SurvivalPlayer, type SurvivalWorld,
} from '../shared/survival.js';

export class ShelterGovernanceError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message); this.name = 'ShelterGovernanceError';
  }
}

const dayOf = (world: SurvivalWorld) => 1 + Math.floor(world.elapsedMs / world.dayLengthMs + 1 / 3);
const distance = (a: {x:number;y:number}, b: {x:number;y:number}) => Math.hypot(a.x - b.x, a.y - b.y);
const hash = (value:string) => { let n = 2166136261; for (const char of value) n = Math.imul(n ^ char.charCodeAt(0),16777619); return n >>> 0; };
const electionDuration = 30_000;

function event(world: SurvivalWorld, text: string, kind: string): void {
  world.events.push({id:randomUUID(),at:world.elapsedMs,text,kind});
  if (world.events.length > 100) world.events.splice(0,world.events.length - 100);
}

function state(world: SurvivalWorld): CommunityState {
  if (!world.community) initializeCommunity(world);
  return world.community!;
}

function addDuties(world: SurvivalWorld, memberId: string, day = dayOf(world)): void {
  const community = world.community!;
  const add = (position: PlayerDuty['position']) => {
    const existing = community.duties.find(duty => duty.day === day && duty.position === position && (position !== 'crew' || duty.memberId === memberId));
    if (existing) {
      if (position !== 'crew') existing.memberId = memberId;
      return;
    }
    const definition = position === 'crew'
      ? {duty:'Contribute two points: collect caches, fight infected, finish projects, or heal survivors.',metric:'contribution' as const,target:2}
      : POSITIONS[position];
    community.duties.push({
      id:position === 'crew' ? `duty:${day}:${memberId}:crew` : `duty:${day}:${position}`,memberId,day,position,title:definition.duty,
      metric:definition.metric,target:definition.target,progress:0,completed:false,
    });
  };
  add('crew');
  for (const position of positions) if (community.officers[position] === memberId) add(position);
}

export function initializeCommunity(world: SurvivalWorld): void {
  if (world.community) return;
  world.community = {
    officers:{captain:null,defender:null,scout:null,medic:null,engineer:null},
    duties:[],elections:[],supplies:emptyInventory(),lastDay:dayOf(world),
  };
  for (const id of Object.keys(world.players)) addDuties(world,id);
}

export function addCommunityPlayer(world: SurvivalWorld, id: string): void {
  state(world);
  if (world.players[id]) addDuties(world,id);
}

function actor(world: SurvivalWorld, id: string): SurvivalPlayer {
  if (!world.active) throw new ShelterGovernanceError('EXPEDITION_ENDED','The expedition has ended.');
  if (world.paused) throw new ShelterGovernanceError('PAUSED','Resume the expedition before acting.');
  const player = world.players[id];
  if (!player) throw new ShelterGovernanceError('SUBJECT_ONLY','Observers cannot change the shelter community.');
  if (player.hp <= 0) throw new ShelterGovernanceError('DOWNED','Recover before taking that action.');
  return player;
}

function resolveElection(world: SurvivalWorld, election: ShelterElection): void {
  const community = state(world);
  const counts = new Map(election.candidates.map(id => [id,0]));
  for (const candidate of Object.values(election.votes)) if (counts.has(candidate)) counts.set(candidate,counts.get(candidate)! + 1);
  const high = Math.max(0,...counts.values());
  const leaders = [...counts].filter(([,count]) => count === high && count > 0).map(([id]) => id);
  if (leaders.length === 1) {
    const winner = leaders[0]!;
    community.officers[election.position] = winner;
    // The office keeps one daily assignment across elections. Its progress and
    // completion transfer intact, preventing rewards from repeated reelection.
    addDuties(world,winner);
    event(world,`${POSITIONS[election.position].name} election complete. The new officer received ${high} ballot${high === 1 ? '' : 's'}.`,'election_result');
  } else {
    event(world,`${POSITIONS[election.position].name} election ended ${leaders.length > 1 ? 'in a tie' : 'without ballots'}. The existing appointment stays in place.`,'election_result');
  }
  community.elections = community.elections.filter(current => current.id !== election.id);
}

/** Returns false for actions belonging to the combat/progression engines. */
export function applyCommunityAction(world: SurvivalWorld, actorId: string, action: SurvivalAction, _now: number, _hostId: string, eligibleIds = new Set(Object.keys(world.players))): boolean {
  if (!['survival_election','survival_ballot','survival_deposit','survival_withdraw','survival_heal'].includes(action.type)) return false;
  if (!survivalActions.some(schema => schema.safeParse(action).success)) throw new ShelterGovernanceError('BAD_ACTION','Invalid community action.');
  const player = actor(world,actorId), community = state(world);
  if (!eligibleIds.has(actorId)) throw new ShelterGovernanceError('SUBJECT_ONLY','Your survivor seat is no longer active.');
  if (action.type === 'survival_election') {
    if (community.elections.some(election => election.position === action.position)) throw new ShelterGovernanceError('ELECTION_ACTIVE','An election for that position is already open.');
    const eligible = [...eligibleIds].filter(id => !!world.players[id]);
    community.elections.push({id:randomUUID(),position:action.position,candidates:[...eligible],eligibleIds:[...eligible],votes:{},endsAt:world.elapsedMs + electionDuration});
    event(world,`${POSITIONS[action.position].name} election opened. Each survivor has one private ballot; voting closes in 30 seconds.`,'election_start');
    return true;
  }
  if (action.type === 'survival_ballot') {
    const election = community.elections.find(current => current.id === action.electionId);
    if (!election || world.elapsedMs >= election.endsAt) throw new ShelterGovernanceError('ELECTION_CLOSED','That election is closed.');
    if (!election.eligibleIds.includes(actorId)) throw new ShelterGovernanceError('NOT_ELIGIBLE','You joined after this election opened. Vote in the next election.');
    if (!election.candidates.includes(action.candidateId)) throw new ShelterGovernanceError('BAD_CANDIDATE','Choose a candidate in this election.');
    if (Object.hasOwn(election.votes,actorId)) throw new ShelterGovernanceError('BALLOT_LOCKED','Your ballot is already locked.');
    election.votes[actorId] = action.candidateId;
    if (election.eligibleIds.every(id => Object.hasOwn(election.votes,id))) resolveElection(world,election);
    return true;
  }
  if (action.type === 'survival_deposit' || action.type === 'survival_withdraw') {
    if (distance(player,world.shelter) > 200) throw new ShelterGovernanceError('TOO_FAR','Return within 200 units of the shelter to use communal supplies.');
    const source = action.type === 'survival_deposit' ? player.inventory : community.supplies;
    const destination = action.type === 'survival_deposit' ? community.supplies : player.inventory;
    if (source[action.item] < action.amount) throw new ShelterGovernanceError('INSUFFICIENT_SUPPLIES',`There is not enough ${action.item} to transfer.`);
    const limit = action.item === 'ammo' ? 2000 : 500;
    if (destination[action.item] + action.amount > limit) throw new ShelterGovernanceError('INVENTORY_FULL',`The destination can hold at most ${limit} ${action.item}.`);
    if (action.type === 'survival_withdraw' && action.item !== 'ammo') {
      const carried = itemIds.reduce((sum,item) => sum + (item === 'ammo' ? 0 : player.inventory[item]),0);
      const backpack = player.gear.find(gear => gear.id === 'backpack')?.level ?? 0;
      const storage = world.facilities.find(facility => facility.kind === 'storage')?.level ?? 0;
      if (carried + action.amount > 60 + 20 * backpack + 20 * storage) throw new ShelterGovernanceError('INVENTORY_FULL','Your pack cannot hold that transfer.');
    }
    source[action.item] -= action.amount; destination[action.item] += action.amount;
    // Sharing is useful, but cycling the same materials cannot farm duties.
    return true;
  }
  if (action.type === 'survival_heal') {
    const target = world.players[action.targetId] ?? world.survivors.find(survivor => survivor.id === action.targetId);
    if (!target) throw new ShelterGovernanceError('BAD_TARGET','Choose a survivor to treat.');
    if (target.hp <= 0) throw new ShelterGovernanceError('DOWNED','A fallen survivor must recover before treatment.');
    if (distance(player,target) > 100) throw new ShelterGovernanceError('TOO_FAR','Move within 100 units of the survivor to treat them.');
    if (target.hp >= 100) throw new ShelterGovernanceError('FULL_HEALTH','That survivor is already healthy.');
    if (player.inventory.medicine < 1) throw new ShelterGovernanceError('INSUFFICIENT_SUPPLIES','You need one medicine to treat a survivor.');
    const restored = Math.min(40,100 - target.hp);
    player.inventory.medicine--; target.hp += restored;
    recordDuty(world,actorId,'healing',restored);
    event(world,`A survivor received field treatment and recovered ${Math.round(restored)} health.`,'healing');
    return true;
  }
  return false;
}

export function recordDuty(world: SurvivalWorld, actorId: string, metric: DutyMetric, amount: number): void {
  if (!world.active || world.paused || !world.players[actorId] || !Number.isFinite(amount) || amount <= 0) return;
  const community = state(world), day = dayOf(world);
  addDuties(world,actorId,day);
  const contribution = metric === 'kills' ? amount * .5 : metric === 'healing' ? amount / 40 : amount;
  for (const duty of community.duties) {
    if (duty.memberId !== actorId || duty.day !== day || duty.completed) continue;
    const advance = duty.metric === metric ? amount : duty.metric === 'contribution' ? contribution : 0;
    if (advance <= 0) continue;
    duty.progress = Math.min(duty.target,duty.progress + advance);
    if (duty.progress < duty.target) continue;
    duty.completed = true;
    community.supplies.food = Math.min(500,community.supplies.food + 1);
    community.supplies.water = Math.min(500,community.supplies.water + 1);
    community.supplies.ammo = Math.min(2000,community.supplies.ammo + 6);
    event(world,`${duty.position === 'crew' ? 'Crew' : POSITIONS[duty.position].name} duty completed. Communal supplies gained one food, one water, and six rounds.`,'duty_complete');
  }
}

export function tickCommunity(world: SurvivalWorld, eligibleIds: Set<string>, cpuIds: Set<string>): boolean {
  const wasMissing = !world.community, community = state(world);
  let changed = wasMissing;
  const eligible = new Set([...eligibleIds].filter(id => !!world.players[id]));
  for (const position of positions) if (community.officers[position] && !eligible.has(community.officers[position]!)) {
    community.officers[position] = null; changed = true;
  }
  const duties = community.duties.filter(duty => duty.position !== 'crew' || eligible.has(duty.memberId));
  if (duties.length !== community.duties.length) { community.duties = duties; changed = true; }
  for (const id of eligible) {
    const before = community.duties.length; addDuties(world,id);
    changed ||= before !== community.duties.length;
  }
  // Membership can change while paused. Remove departed voters and officers
  // immediately, while leaving the clock, CPU ballots, and tally frozen.
  for (const election of community.elections) {
    const candidates = election.candidates.filter(id => eligible.has(id));
    const voters = election.eligibleIds.filter(id => eligible.has(id));
    if (candidates.length !== election.candidates.length || voters.length !== election.eligibleIds.length) changed = true;
    election.candidates = candidates; election.eligibleIds = voters;
    for (const [voter,candidate] of Object.entries(election.votes)) if (!eligible.has(voter) || !candidates.includes(candidate)) {
      delete election.votes[voter]; changed = true;
    }
  }
  if (!world.active || world.paused) return changed;
  const day = dayOf(world);
  while (community.lastDay < day) {
    const missed = community.duties.filter(duty => duty.day === community.lastDay && !duty.completed &&
      (duty.position === 'crew' || community.officers[duty.position] === duty.memberId));
    if (missed.length) {
      const damage = missed.length * 20;
      world.shelter.hp = Math.max(0,world.shelter.hp - damage);
      event(world,`${missed.length} unfinished day ${community.lastDay} dut${missed.length === 1 ? 'y' : 'ies'} cost the shelter ${damage} health.`,'duty_missed');
    }
    community.lastDay++;
    for (const id of eligible) addDuties(world,id,community.lastDay);
    changed = true;
  }
  community.duties = community.duties.filter(duty => duty.day >= day - 2);
  for (const election of [...community.elections]) {
    const candidates = election.candidates, voters = election.eligibleIds;
    if (world.elapsedMs >= election.endsAt - electionDuration + 1500 && world.elapsedMs < election.endsAt && candidates.length) {
      for (const id of voters) if (cpuIds.has(id) && world.players[id]!.hp > 0 && !Object.hasOwn(election.votes,id)) {
        election.votes[id] = candidates[hash(`${world.id}:${election.id}:${id}`) % candidates.length]!;
        changed = true;
      }
    }
    if (!candidates.length || world.elapsedMs >= election.endsAt || voters.every(id => Object.hasOwn(election.votes,id))) {
      resolveElection(world,election); changed = true;
    }
  }
  return changed;
}

export function projectCommunity(world: SurvivalWorld): CommunityPublic {
  const community = state(world);
  return structuredClone({
    officers:community.officers,duties:community.duties,supplies:community.supplies,
    elections:community.elections.map(({id,position,candidates,eligibleIds,votes,endsAt}) => ({
      id,position,candidates,eligibleIds,ballotsCast:Object.keys(votes).length,endsAt,
    })),
  });
}

export function projectElectionVotes(world: SurvivalWorld, id: string): Record<string,string> {
  return Object.fromEntries(state(world).elections.flatMap(election =>
    Object.hasOwn(election.votes,id) ? [[election.id,election.votes[id]!]] : []));
}
