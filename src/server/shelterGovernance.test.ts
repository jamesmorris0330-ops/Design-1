import { describe, expect, it } from 'vitest';
import { emptyInventory, positions, type PositionId, type SurvivalAction, type SurvivalWorld } from '../shared/survival.js';
import { addSurvivalPlayer, createSurvivalWorld } from './survival.js';
import {
  addCommunityPlayer, applyCommunityAction, initializeCommunity, projectCommunity,
  projectElectionVotes, recordDuty, ShelterGovernanceError, tickCommunity,
} from './shelterGovernance.js';

function world(ids = ['alpha','bravo']): SurvivalWorld {
  const value = createSurvivalWorld(ids,'farmhouse',60,1000);
  initializeCommunity(value);
  return value;
}
const act = (w: SurvivalWorld, id: string, action: SurvivalAction) => applyCommunityAction(w,id,action,w.lastTickAt,'alpha');
function open(w: SurvivalWorld, position: PositionId = 'defender'): string {
  act(w,'alpha',{type:'survival_election',position});
  return w.community!.elections.find(election => election.position === position)!.id;
}
function elect(w: SurvivalWorld, candidateId: string, position: PositionId = 'defender'): void {
  const electionId = open(w,position);
  for (const id of Object.keys(w.players)) act(w,id,{type:'survival_ballot',electionId,candidateId});
}
function reject(operation: () => unknown, code: string): void {
  try { operation(); throw new Error('Expected rejection'); }
  catch (error) { expect(error).toBeInstanceOf(ShelterGovernanceError); expect((error as ShelterGovernanceError).code).toBe(code); }
}
const tick = (w: SurvivalWorld, eligible = new Set(Object.keys(w.players)), cpus = new Set<string>()) => tickCommunity(w,eligible,cpus);

describe('shared shelter elections, duties, and supplies',() => {
  it('starts with one shared stash, vacant offices, and one duty for every player',() => {
    const w = world();
    expect(w.community!.supplies).toEqual(emptyInventory());
    expect(Object.values(w.community!.officers)).toEqual([null,null,null,null,null]);
    expect(w.community!.duties.map(duty => [duty.memberId,duty.position,duty.day])).toEqual([['alpha','crew',1],['bravo','crew',1]]);
    const before = structuredClone(w.community);
    initializeCommunity(w); addCommunityPlayer(w,'alpha');
    expect(w.community).toEqual(before);
  });

  it('projects only ballot counts publicly and only the requesting player’s ballot privately',() => {
    const w = world(), electionId = open(w);
    act(w,'alpha',{type:'survival_ballot',electionId,candidateId:'bravo'});
    const publicElection = projectCommunity(w).elections[0]!;
    expect(publicElection.ballotsCast).toBe(1);
    expect(Object.keys(publicElection).sort()).toEqual(['ballotsCast','candidates','eligibleIds','endsAt','id','position']);
    expect(projectElectionVotes(w,'alpha')).toEqual({[electionId]:'bravo'});
    expect(projectElectionVotes(w,'bravo')).toEqual({});
    expect(projectElectionVotes(w,'observer')).toEqual({});
    publicElection.candidates.length = 0;
    expect(w.community!.elections[0]!.candidates).toEqual(['alpha','bravo']);
    reject(() => act(w,'alpha',{type:'survival_ballot',electionId,candidateId:'alpha'}),'BALLOT_LOCKED');
  });

  it('freezes electorate and candidates, rejects invented candidates, and resolves unique plurality',() => {
    const w = world(), electionId = open(w);
    addSurvivalPlayer(w,'charlie'); addCommunityPlayer(w,'charlie');
    reject(() => act(w,'charlie',{type:'survival_ballot',electionId,candidateId:'alpha'}),'NOT_ELIGIBLE');
    reject(() => act(w,'alpha',{type:'survival_ballot',electionId,candidateId:'charlie'}),'BAD_CANDIDATE');
    act(w,'alpha',{type:'survival_ballot',electionId,candidateId:'bravo'});
    act(w,'bravo',{type:'survival_ballot',electionId,candidateId:'bravo'});
    expect(w.community!.officers.defender).toBe('bravo');
    expect(w.community!.elections).toHaveLength(0);
    expect(projectElectionVotes(w,'alpha')).toEqual({});
    expect(w.community!.duties.find(duty => duty.position === 'defender')!.memberId).toBe('bravo');
  });

  it('never includes removed saved-player records or observers in a newly opened election',() => {
    const w = world(), eligible = new Set(['alpha','observer']);
    applyCommunityAction(w,'alpha',{type:'survival_election',position:'captain'},0,'alpha',eligible);
    expect(w.community!.elections[0]).toMatchObject({candidates:['alpha'],eligibleIds:['alpha']});
    reject(() => applyCommunityAction(w,'bravo',{type:'survival_election',position:'medic'},0,'alpha',eligible),'SUBJECT_ONLY');
  });

  it('allows solo survivors to elect themselves to every position without creating duplicate duties',() => {
    const w = world(['alpha']);
    for (const position of positions) elect(w,'alpha',position);
    expect(Object.values(w.community!.officers)).toEqual(['alpha','alpha','alpha','alpha','alpha']);
    expect(w.community!.duties).toHaveLength(6);
    elect(w,'alpha','defender');
    expect(w.community!.duties).toHaveLength(6);
  });

  it('keeps the incumbent on tied or empty ballots and expires elections using world time',() => {
    const w = world(); elect(w,'alpha');
    let electionId = open(w);
    act(w,'alpha',{type:'survival_ballot',electionId,candidateId:'alpha'});
    act(w,'bravo',{type:'survival_ballot',electionId,candidateId:'bravo'});
    expect(w.community!.officers.defender).toBe('alpha');
    electionId = open(w);
    w.elapsedMs = 29_999; tick(w);
    expect(w.community!.elections).toHaveLength(1);
    w.elapsedMs = 30_000;
    reject(() => act(w,'alpha',{type:'survival_ballot',electionId,candidateId:'bravo'}),'ELECTION_CLOSED');
    tick(w); expect(w.community!.officers.defender).toBe('alpha');
    expect(w.community!.elections).toHaveLength(0);
    expect(w.events.at(-1)!.text).toContain('without ballots');
  });

  it('makes deterministic CPU ballots after 1.5 seconds without exposing their candidate',() => {
    const w = world(), electionId = open(w), copy = structuredClone(w);
    w.elapsedMs = 1499; tick(w,new Set(['alpha','bravo']),new Set(['bravo']));
    expect(w.community!.elections[0]!.votes).toEqual({});
    w.elapsedMs = 1500; copy.elapsedMs = 1500;
    tick(w,new Set(['alpha','bravo']),new Set(['bravo']));
    tick(copy,new Set(['alpha','bravo']),new Set(['bravo']));
    expect(w.community!.elections[0]!.votes).toEqual(copy.community!.elections[0]!.votes);
    expect(Object.keys(w.community!.elections[0]!.votes)).toEqual(['bravo']);
    expect(projectElectionVotes(w,'alpha')).toEqual({});
    expect(projectCommunity(w).elections[0]!.ballotsCast).toBe(1);
    expect(projectElectionVotes(w,'bravo')[electionId]).toBeTruthy();
  });

  it('requires CPU voters to recover before casting ballots just like human survivors',() => {
    const w = world(); open(w); w.players.bravo!.hp = 0; w.elapsedMs = 1500;
    tick(w,new Set(['alpha','bravo']),new Set(['bravo']));
    expect(w.community!.elections[0]!.votes).toEqual({});
    w.players.bravo!.hp = 75;
    tick(w,new Set(['alpha','bravo']),new Set(['bravo']));
    expect(Object.keys(w.community!.elections[0]!.votes)).toEqual(['bravo']);
  });

  it('cleans removed officers, voters, candidates, and ballots without adding late players',() => {
    const w = world(); elect(w,'bravo');
    const electionId = open(w,'scout');
    act(w,'alpha',{type:'survival_ballot',electionId,candidateId:'bravo'});
    addSurvivalPlayer(w,'charlie'); addCommunityPlayer(w,'charlie');
    tick(w,new Set(['alpha','charlie']));
    expect(w.community!.officers.defender).toBeNull();
    expect(w.community!.elections[0]).toMatchObject({candidates:['alpha'],eligibleIds:['alpha'],votes:{}});
    expect(w.community!.duties.some(duty => duty.position === 'crew' && duty.memberId === 'bravo')).toBe(false);
  });

  it('cleans departures during pause while leaving CPU voting and tally frozen',() => {
    const w = world(); elect(w,'bravo'); const electionId = open(w,'scout');
    act(w,'alpha',{type:'survival_ballot',electionId,candidateId:'bravo'});
    w.paused = true; w.elapsedMs = 40_000;
    expect(tick(w,new Set(['alpha']),new Set(['alpha']))).toBe(true);
    expect(w.community!.officers.defender).toBeNull();
    expect(w.community!.elections[0]).toMatchObject({eligibleIds:['alpha'],candidates:['alpha'],votes:{}});
    expect(w.community!.elections).toHaveLength(1);
    expect(w.shelter.hp).toBe(w.shelter.maxHp);
  });

  it('conserves private and communal supplies and rejects unsafe transfers without changing either stash',() => {
    const w = world(), before = w.players.alpha!.inventory.wood;
    act(w,'alpha',{type:'survival_deposit',item:'wood',amount:4});
    expect(w.players.alpha!.inventory.wood).toBe(before - 4); expect(w.community!.supplies.wood).toBe(4);
    act(w,'alpha',{type:'survival_withdraw',item:'wood',amount:3});
    expect(w.players.alpha!.inventory.wood + w.community!.supplies.wood).toBe(before);
    const snapshot = structuredClone([w.players.alpha!.inventory,w.community!.supplies]);
    reject(() => act(w,'alpha',{type:'survival_withdraw',item:'wood',amount:2}),'INSUFFICIENT_SUPPLIES');
    reject(() => act(w,'alpha',{type:'survival_deposit',item:'wood',amount:150} as SurvivalAction),'BAD_ACTION');
    expect([w.players.alpha!.inventory,w.community!.supplies]).toEqual(snapshot);
    expect(w.community!.duties[0]!.progress).toBe(0);
  });

  it('enforces shelter distance, item bounds, ammunition bounds, and real pack capacity',() => {
    const w = world(), player = w.players.alpha!;
    player.x = w.shelter.x + 201; player.y = w.shelter.y;
    reject(() => act(w,'alpha',{type:'survival_deposit',item:'wood',amount:1}),'TOO_FAR');
    player.x = w.shelter.x; w.community!.supplies.wood = 500;
    reject(() => act(w,'alpha',{type:'survival_deposit',item:'wood',amount:1}),'INVENTORY_FULL');
    w.community!.supplies.ammo = 2000;
    reject(() => act(w,'alpha',{type:'survival_deposit',item:'ammo',amount:1}),'INVENTORY_FULL');
    player.inventory = {...emptyInventory(),wood:60}; w.community!.supplies.food = 2;
    reject(() => act(w,'alpha',{type:'survival_withdraw',item:'food',amount:1}),'INVENTORY_FULL');
    player.gear.push({id:'backpack',level:1});
    act(w,'alpha',{type:'survival_withdraw',item:'food',amount:1});
    expect(player.inventory.food).toBe(1);
  });

  it('requires living active actors for community actions and freezes elections during pause',() => {
    const w = world(), electionId = open(w);
    w.paused = true; w.elapsedMs = 40_000;
    reject(() => act(w,'alpha',{type:'survival_ballot',electionId,candidateId:'alpha'}),'PAUSED');
    expect(tick(w)).toBe(false); expect(w.community!.elections).toHaveLength(1);
    w.paused = false; w.players.alpha!.hp = 0;
    reject(() => act(w,'alpha',{type:'survival_deposit',item:'wood',amount:1}),'DOWNED');
    reject(() => act(w,'observer',{type:'survival_election',position:'captain'}),'SUBJECT_ONLY');
    w.active = false;
    reject(() => act(w,'bravo',{type:'survival_election',position:'captain'}),'EXPEDITION_ENDED');
    expect(applyCommunityAction(w,'observer',{type:'survival_reload'},0,'alpha')).toBe(false);
  });

  it('uses actual paid healing for player and NPC health, preventing full-health reward farming',() => {
    const w = world(), player = w.players.alpha!, target = w.players.bravo!;
    target.x = player.x; target.y = player.y; target.hp = 75;
    const medicine = player.inventory.medicine;
    act(w,'alpha',{type:'survival_heal',targetId:'bravo'});
    expect(target.hp).toBe(100); expect(player.inventory.medicine).toBe(medicine - 1);
    expect(w.community!.duties.find(duty => duty.memberId === 'alpha')!.progress).toBe(25 / 40);
    reject(() => act(w,'alpha',{type:'survival_heal',targetId:'bravo'}),'FULL_HEALTH');
    w.survivors.push({id:'npc',name:'Mara',role:'guardian',level:1,x:player.x,y:player.y,hp:30,nextActionAt:0});
    act(w,'alpha',{type:'survival_heal',targetId:'npc'});
    expect(w.survivors[0]!.hp).toBe(70); expect(player.inventory.medicine).toBe(medicine - 2);
    expect(w.community!.duties.find(duty => duty.memberId === 'alpha')!.progress).toBe(65 / 40);
    reject(() => act(w,'alpha',{type:'survival_heal',targetId:'npc'}),'INSUFFICIENT_SUPPLIES');
  });

  it('rejects distant, downed, missing, and healthy treatment targets before charging medicine',() => {
    const w = world(), p = w.players.alpha!, target = w.players.bravo!, medicine = p.inventory.medicine;
    target.x = p.x + 101; target.y = p.y; target.hp = 20;
    reject(() => act(w,'alpha',{type:'survival_heal',targetId:'bravo'}),'TOO_FAR');
    target.x = p.x; target.hp = 0;
    reject(() => act(w,'alpha',{type:'survival_heal',targetId:'bravo'}),'DOWNED');
    reject(() => act(w,'alpha',{type:'survival_heal',targetId:'missing'}),'BAD_TARGET');
    target.hp = 100;
    reject(() => act(w,'alpha',{type:'survival_heal',targetId:'bravo'}),'FULL_HEALTH');
    expect(p.inventory.medicine).toBe(medicine);
  });

  it('awards completed duties once, counts honest contribution, and ignores invalid progress',() => {
    const w = world(); elect(w,'alpha');
    recordDuty(w,'alpha','kills',4);
    expect(w.community!.duties.find(duty => duty.position === 'crew' && duty.memberId === 'alpha')).toMatchObject({progress:2,completed:true});
    expect(w.community!.supplies).toMatchObject({food:1,water:1,ammo:6});
    recordDuty(w,'alpha','kills',2);
    expect(w.community!.supplies).toMatchObject({food:2,water:2,ammo:12});
    recordDuty(w,'alpha','kills',50); recordDuty(w,'alpha','kills',NaN); recordDuty(w,'alpha','kills',-1);
    expect(w.community!.supplies).toMatchObject({food:2,water:2,ammo:12});
    recordDuty(w,'observer','loot',100);
    expect(w.community!.duties).toHaveLength(3);
  });

  it('preserves office progress across reelections and cannot farm daily rewards by swapping officers',() => {
    const w = world(); elect(w,'alpha'); recordDuty(w,'alpha','kills',6);
    const supplies = structuredClone(w.community!.supplies);
    elect(w,'bravo');
    expect(w.community!.duties.filter(duty => duty.position === 'defender')).toHaveLength(1);
    expect(w.community!.duties.find(duty => duty.position === 'defender')).toMatchObject({memberId:'bravo',completed:true,progress:6});
    recordDuty(w,'bravo','kills',6); // only bravo's independent crew duty pays
    expect(w.community!.supplies).toMatchObject({food:supplies.food + 1,water:supplies.water + 1,ammo:supplies.ammo + 6});
    elect(w,'alpha'); recordDuty(w,'alpha','kills',6);
    expect(w.community!.supplies.food).toBe(supplies.food + 1);
  });

  it('charges missed duties once at day rollover and keeps only three daily boards',() => {
    const w = world(); elect(w,'alpha'); recordDuty(w,'alpha','loot',2);
    const health = w.shelter.hp;
    w.elapsedMs = w.dayLengthMs * 2 / 3 + 1; tick(w);
    expect(w.shelter.hp).toBe(health - 40); // bravo crew + alpha defender
    const after = w.shelter.hp; tick(w); expect(w.shelter.hp).toBe(after);
    expect(w.community!.duties.filter(duty => duty.day === 2)).toHaveLength(3);
    w.elapsedMs = w.dayLengthMs * (3 - 1 / 3) + 1; tick(w);
    expect(new Set(w.community!.duties.map(duty => duty.day))).toEqual(new Set([2,3,4]));
    expect(w.events.filter(event => event.kind === 'duty_missed')).toHaveLength(3);
  });

  it('keeps shared-stash rewards bounded and preserves stable CPU seats across handoff/reconnection',() => {
    const w = world(); elect(w,'bravo'); const electionId = open(w,'medic');
    act(w,'bravo',{type:'survival_ballot',electionId,candidateId:'bravo'});
    const snapshot = structuredClone(w.community);
    addCommunityPlayer(w,'bravo'); addCommunityPlayer(w,'bravo');
    expect(w.community).toEqual(snapshot);
    expect(projectElectionVotes(w,'bravo')).toEqual({[electionId]:'bravo'});
    w.community!.supplies.food = 500; w.community!.supplies.water = 500; w.community!.supplies.ammo = 2000;
    recordDuty(w,'bravo','kills',6);
    expect(w.community!.supplies).toMatchObject({food:500,water:500,ammo:2000});
    expect(w.community!.duties.filter(duty => duty.memberId === 'bravo' && duty.completed)).toHaveLength(2);
  });
});
