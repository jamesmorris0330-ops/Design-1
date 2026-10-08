import { describe, expect, it } from 'vitest';
import type { SurvivalAction, SurvivalWorld } from '../shared/survival.js';
import { addSurvivalPlayer, applySurvivalAction, createSurvivalWorld, projectSurvivalPlayer, projectSurvivalWorld, SurvivalError, tickSurvivalWorld } from './survival.js';

const NOW = 10_000;
function world():SurvivalWorld { return createSurvivalWorld(['alpha','bravo'],'farmhouse',60,NOW); }
function act(w:SurvivalWorld,action:SurvivalAction,id = 'alpha',now = w.lastTickAt):void { applySurvivalAction(w,id,action,now,'alpha'); }
function step(w:SurvivalWorld,ms = 100,active = new Set(['alpha','bravo']),cpus = new Set<string>()):void { tickSurvivalWorld(w,w.lastTickAt + ms,active,cpus); }
function reject(operation:() => void,code:string):void { try { operation(); throw Error('Expected rejection'); } catch(error) { expect(error).toBeInstanceOf(SurvivalError); expect((error as SurvivalError).code).toBe(code); } }
function input(w:SurvivalWorld,fire = false,moveX = 0,moveY = 0,aim = 0,id = 'alpha'):void { act(w,{type:'survival_input',moveX,moveY,aim,fire},id); }

 describe('server-authoritative survival world',() => {
  it('creates all five distinct shelter types, a private starting loadout, exploration loot, survivors, and immediate threats',() => {
    for (const type of ['farmhouse','bunker','warehouse','apartment','ranger_station'] as const) {
      const w = createSurvivalWorld(['alpha'],type,120,NOW);
      expect(w.shelter.type).toBe(type); expect(w.sites).toHaveLength(5);
      expect(w.sites.filter(site => site.discovered)).toHaveLength(1);
      expect(w.enemies.length).toBeGreaterThan(0); expect(w.containers.length).toBeGreaterThan(20); expect(w.rescues).toHaveLength(12);
      expect(projectSurvivalWorld(w)).toMatchObject({day:1,hour:8,week:1,month:1,night:false});
      expect(w.players.alpha!.weapons[0]).toMatchObject({id:'pistol',level:1,magazine:12});
      expect(w.wave.nextAt).toBe(90_000);
    }
    reject(() => createSurvivalWorld(['alpha'],'farmhouse',5,NOW),'BAD_SETTINGS');
  });

  it('normalizes diagonal movement, enforces boundaries, and rejects non-finite or oversized input',() => {
    const w = world(), p = w.players.alpha!;
    const start = {x:p.x,y:p.y}; input(w,false,1,1); step(w,100);
    expect(Math.hypot(p.x - start.x,p.y - start.y)).toBeCloseTo(15.5);
    expect(p.input.moveX).toBeCloseTo(1 / Math.sqrt(2));
    p.x = w.width - 23; input(w,false,1,0); step(w);
    expect(p.x).toBe(w.width - 22);
    reject(() => act(w,{type:'survival_input',moveX:2,moveY:0,aim:0,fire:false}),'BAD_ACTION');
    reject(() => act(w,{type:'survival_input',moveX:0,moveY:0,aim:NaN,fire:false}),'BAD_ACTION');
  });

  it('stops stale movement and gunfire rather than acting forever after a lost socket',() => {
    const w = world(), p = w.players.alpha!;
    input(w,true,1,0); step(w); step(w); step(w); step(w);
    const x = p.x, shots = p.weapons[0]!.magazine; step(w);
    expect(p.x).toBe(x); expect(p.weapons[0]!.magazine).toBe(shots);
    expect(p.input.fire).toBe(false);
  });

  it('freezes world time while nobody is connected and caps a delayed timer without catching up offline days',() => {
    const w = world();
    input(w,true,1,0);
    expect(tickSurvivalWorld(w,NOW + 5 * 60_000,new Set(),new Set(['bravo']))).toBe(false);
    expect(w.elapsedMs).toBe(0); expect(w.players.alpha!.input.fire).toBe(false);
    tickSurvivalWorld(w,NOW + 5 * 60_000 + 100,new Set(['alpha']),new Set(['bravo']));
    expect(w.elapsedMs).toBe(100);
    tickSurvivalWorld(w,NOW + 100 * 60_000,new Set(['alpha']),new Set(['bravo']));
    expect(w.elapsedMs).toBe(300);
  });

  it('restricts pause to the host and pauses reload/upgrade/clock progress together',() => {
    const w = world();
    reject(() => act(w,{type:'survival_pause',paused:true},'bravo'),'HOST_ONLY');
    act(w,{type:'survival_pause',paused:true});
    reject(() => input(w),'PAUSED');
    expect(tickSurvivalWorld(w,NOW + 5000,new Set(['alpha']),new Set())).toBe(false);
    expect(w.elapsedMs).toBe(0);
    act(w,{type:'survival_pause',paused:false},'alpha',NOW + 5000); step(w); expect(w.elapsedMs).toBe(100);
  });

  it('requires distance for loot and atomically gives one collector the contents and discovered weapon',() => {
    const w = world(), target = w.containers[1]!;
    reject(() => act(w,{type:'survival_interact',targetId:target.id}),'TOO_FAR');
    const p = w.players.alpha!; p.x = target.x; p.y = target.y;
    const inventory = {...p.inventory}; act(w,{type:'survival_interact',targetId:target.id});
    expect(p.inventory.wood).toBe(inventory.wood + 7); expect(p.inventory.electronics).toBe(inventory.electronics + 2);
    expect(p.weapons.some(weapon => weapon.id === 'rifle')).toBe(true);
    expect(target.opened).toBe(true); expect(p.stats.loot).toBe(1);
    const other = w.players.bravo!; other.x = target.x; other.y = target.y;
    const otherInventory = {...other.inventory}; reject(() => act(w,{type:'survival_interact',targetId:target.id},'bravo'),'ALREADY_COLLECTED');
    expect(other.inventory).toEqual(otherInventory);
  });

  it('leaves duplicate equipment for another survivor rather than silently destroying a shared weapon',() => {
    const w = world(), cache = w.containers[1]!, p = w.players.alpha!, other = w.players.bravo!;
    p.weapons.push({id:'rifle',level:2,magazine:24}); p.x = other.x = cache.x; p.y = other.y = cache.y;
    act(w,{type:'survival_interact',targetId:cache.id}); expect(cache.weapon).toBe('rifle'); expect(cache.opened).toBe(false);
    act(w,{type:'survival_interact',targetId:cache.id},'bravo'); expect(other.weapons.some(weapon => weapon.id === 'rifle')).toBe(true); expect(cache.opened).toBe(true);
  });

  it('preserves excess loot in the container instead of discarding resources when a pack fills',() => {
    const w = world(), p = w.players.alpha!, target = w.containers[0]!;
    p.x = target.x; p.y = target.y; p.inventory = {...p.inventory,wood:500,metal:0,cloth:0,electronics:0,food:0,water:0,medicine:0};
    const initialMetal = target.contents.metal!; act(w,{type:'survival_interact',targetId:target.id});
    expect(p.inventory.ammo).toBe(84); expect(target.contents.metal).toBe(initialMetal);
    expect(target.opened).toBe(false); expect(p.stats.loot).toBe(0);
    reject(() => act(w,{type:'survival_interact',targetId:target.id}),'INVENTORY_FULL');
    p.inventory.wood = 0; act(w,{type:'survival_interact',targetId:target.id});
    expect(target.opened).toBe(true); expect(p.inventory.metal).toBe(initialMetal); expect(p.stats.loot).toBe(1);
  });

  it('uses server aim/range/ammunition/cooldowns for damage and grants kills only when an infected dies',() => {
    const w = world(), p = w.players.alpha!;
    w.enemies = [{id:'target',x:p.x + 160,y:p.y,hp:52,maxHp:52,kind:'infected',horde:false,attackAt:999_999}];
    input(w,true); step(w); expect(w.enemies[0]!.hp).toBe(26); expect(p.weapons[0]!.magazine).toBe(11);
    input(w,true); step(w); expect(w.enemies[0]!.hp).toBe(26); expect(p.weapons[0]!.magazine).toBe(11);
    input(w,true); step(w); input(w,true); step(w); input(w,true); step(w);
    expect(w.enemies.some(enemy => enemy.id === 'target')).toBe(false); expect(p.stats.kills).toBe(1);
    expect(p.weapons[0]!.magazine).toBe(10);
    w.enemies = [{id:'far',x:p.x + 800,y:p.y,hp:52,maxHp:52,kind:'infected',horde:false,attackAt:999_999}];
    w.elapsedMs += 400; input(w,true); step(w); expect(w.enemies[0]!.hp).toBe(52);
  });

  it('reloads from actual reserve ammunition only after the authoritative timer completes',() => {
    const w = world(), p = w.players.alpha!; w.enemies = [];
    p.weapons[0]!.magazine = 0; p.inventory.ammo = 5;
    act(w,{type:'survival_reload'}); expect(projectSurvivalPlayer(w,'alpha')!.reloadRemainingMs).toBe(1300);
    for (let i = 0; i < 12; i++) step(w);
    expect(p.weapons[0]!.magazine).toBe(0); expect(p.inventory.ammo).toBe(5);
    step(w); expect(p.weapons[0]!.magazine).toBe(5); expect(p.inventory.ammo).toBe(0);
    reject(() => act(w,{type:'survival_equip',kind:'weapon',targetId:'rifle'}),'NOT_OWNED');
  });

  it('lets infected attack exposed players, armor reduce damage, and fallen players recover after the clock delay',() => {
    const w = world(), p = w.players.alpha!; p.x = w.shelter.x + 200; p.hp = 8;
    w.enemies = [{id:'close',x:p.x + 20,y:p.y,hp:100,maxHp:100,kind:'infected',horde:false,attackAt:0}];
    step(w); expect(p.hp).toBe(0); expect(projectSurvivalPlayer(w,'alpha')!.respawnRemainingMs).toBe(20_000);
    reject(() => act(w,{type:'survival_respawn'}),'RECOVERY_PENDING');
    reject(() => act(w,{type:'survival_input',moveX:1,moveY:0,aim:0,fire:false}),'DOWNED');
    w.elapsedMs += 20_000; act(w,{type:'survival_respawn'});
    expect(p.hp).toBe(75); expect(p.x).toBe(w.shelter.x);
    p.x += 200; p.hp = 100; p.gear.push({id:'armor',level:2}); w.enemies[0]!.x = p.x + 20; w.enemies[0]!.attackAt = 0;
    step(w); expect(p.hp).toBe(96);
  });

  it('defends players inside the shelter while the shelter itself can be damaged and destroyed',() => {
    const w = world(), p = w.players.alpha!; w.shelter.hp = 2;
    w.enemies = [{id:'siege',x:w.shelter.x + 124,y:w.shelter.y,hp:100,maxHp:100,kind:'infected',horde:true,attackAt:0}];
    step(w); expect(p.hp).toBe(100); expect(w.shelter.hp).toBe(0); expect(w.active).toBe(false);
    expect(w.events.at(-1)!.kind).toBe('survival-ended');
    reject(() => act(w,{type:'survival_reload'}),'EXPEDITION_ENDED');
  });

  it('starts the night horde, completes it when all horde enemies are defeated, and credits the shared goal once',() => {
    const w = world(); w.enemies = []; w.elapsedMs = w.dayLengthMs / 2 - 100;
    step(w); expect(w.wave.active).toBe(true); expect(w.wave.number).toBe(1);
    expect(w.enemies.some(enemy => enemy.horde)).toBe(true); expect(projectSurvivalWorld(w)).toMatchObject({hour:20,night:true});
    w.wave.remainingSpawns = 0; w.enemies = []; step(w);
    expect(w.wave).toMatchObject({active:false,completed:1,nextAt:w.dayLengthMs * 1.5});
    expect(w.players.alpha!.stats.waves).toBe(1); expect(w.players.bravo!.stats.waves).toBe(1);
  });

  it('gives CPU companions legal movement and finite ammunition while they defend human players',() => {
    const w = world(), bot = w.players.bravo!;
    w.enemies = [{id:'bot-target',x:bot.x + 150,y:bot.y,hp:58,maxHp:58,kind:'infected',horde:false,attackAt:999_999}];
    for (let i = 0; i < 12; i++) step(w,100,new Set(['alpha']),new Set(['bravo']));
    expect(w.enemies.some(enemy => enemy.id === 'bot-target')).toBe(false);
    expect(bot.stats.kills).toBe(1); expect(bot.weapons[0]!.magazine).toBeLessThan(12);
    const botX = bot.x;
    for (let i = 0; i < 10; i++) step(w,100,new Set(['alpha']),new Set(['bravo']));
    expect(bot.x).not.toBe(botX);
  });

  it('finishes CPU reloads once instead of restarting their timer at the completion boundary',() => {
    const w = world(), bot = w.players.bravo!; w.enemies = []; bot.weapons[0]!.magazine = 0; bot.inventory.ammo = 5;
    for (let i = 0; i < 15; i++) step(w,100,new Set(['alpha']),new Set(['bravo']));
    expect(bot.weapons[0]!.magazine).toBe(5); expect(bot.inventory.ammo).toBe(0); expect(bot.reloadUntil).toBe(0);
  });

  it('does not move, hunger, or target offline humans while connected companions keep the world active',() => {
    const w = world(), offline = w.players.bravo!; offline.x = w.shelter.x + 250; input(w,true,1,0,0,'bravo');
    w.enemies = [{id:'near-offline',x:offline.x + 20,y:offline.y,hp:100,maxHp:100,kind:'infected',horde:false,attackAt:0}];
    const before = {x:offline.x,hunger:offline.hunger,hp:offline.hp};
    step(w,100,new Set(['alpha']));
    expect({x:offline.x,hunger:offline.hunger,hp:offline.hp}).toEqual(before);
  });

  it('offers an early preparation raid then schedules the first actual night without turning days into rounds',() => {
    const w = world(); w.elapsedMs = 89_900; w.enemies = []; step(w);
    expect(w.wave.active).toBe(true); expect(projectSurvivalWorld(w).night).toBe(false);
    expect(w.events.find(event => event.kind === 'horde-start')!.text).toMatch(/^Horde 1/);
    w.wave.remainingSpawns = 0; w.enemies = []; step(w);
    expect(w.wave.nextAt).toBe(w.dayLengthMs / 2);
    w.elapsedMs = w.dayLengthMs / 2 - 100; step(w);
    expect(w.wave.number).toBe(2); expect(projectSurvivalWorld(w).night).toBe(true);
  });

  it('replenishes ordinary supplies after twelve active minutes without respawning discovered guns or gear',() => {
    const w = world(), p = w.players.alpha!, cache = w.containers[1]!; p.x = cache.x; p.y = cache.y;
    act(w,{type:'survival_interact',targetId:cache.id});
    expect(cache.opened).toBe(true); expect(cache.weapon).toBeUndefined(); expect(cache.respawnAt).toBe(720_000);
    w.elapsedMs = 719_800; step(w); expect(cache.opened).toBe(true); step(w);
    expect(cache.opened).toBe(false); expect(cache.contents).not.toEqual({}); expect(cache.weapon).toBeUndefined();
    expect(p.weapons.filter(weapon => weapon.id === 'rifle')).toHaveLength(1);
  });

  it('lets an observer who owns the room pause without gaining survivor controls or inventory',() => {
    const w = world(); applySurvivalAction(w,'observer',{type:'survival_pause',paused:true},NOW,'observer');
    expect(w.paused).toBe(true); expect(projectSurvivalPlayer(w,'observer')).toBeNull();
    reject(() => applySurvivalAction(w,'observer',{type:'survival_reload'},NOW,'observer'),'SUBJECT_ONLY');
  });

  it('makes boots and weapon upgrades change movement speed and real damage',() => {
    const w = world(), p = w.players.alpha!, other = w.players.bravo!;
    p.gear.push({id:'boots',level:3}); input(w,false,1,0); input(w,false,1,0,0,'bravo');
    const x = p.x, otherX = other.x; step(w);
    expect(p.x - x).toBeCloseTo(15.5 * 1.18); expect(other.x - otherX).toBeCloseTo(15.5);
    p.weapons[0]!.level = 2; w.enemies = [{id:'upgraded-hit',x:p.x + 150,y:p.y,hp:70,maxHp:70,kind:'infected',horde:false,attackAt:999_999}];
    input(w,true); step(w); expect(w.enemies[0]!.hp).toBeCloseTo(70 - 26 * 1.2);
  });

  it('never projects input timestamps, enemy attack timers, container contents, or another player’s inventory',() => {
    const w = world(), publicView = projectSurvivalWorld(w), personal = projectSurvivalPlayer(w,'alpha')!;
    const serialized = JSON.stringify(publicView);
    for (const field of ['inventory','contents','receivedAt','attackAt','nextActionAt','lastTickAt','nextShotAt','reloadUntil']) expect(serialized).not.toContain(`"${field}"`);
    expect(publicView.players[0]).not.toHaveProperty('weapons'); expect(publicView.players[0]).not.toHaveProperty('stats');
    expect(personal.inventory).toEqual(w.players.alpha!.inventory); expect(personal).not.toHaveProperty('input'); expect(projectSurvivalPlayer(w,'observer')).toBeNull();
    personal.inventory.ammo = 999; publicView.shelter.hp = 0; expect(w.players.alpha!.inventory.ammo).toBe(60); expect(w.shelter.hp).toBeGreaterThan(0);
  });

  it('adds new human seats without resetting the persistent expedition or changing existing inventories',() => {
    const w = world(), id = w.id; w.players.alpha!.inventory.wood = 30;
    addSurvivalPlayer(w,'newcomer',NOW + 100); addSurvivalPlayer(w,'alpha',NOW + 100);
    expect(w.players.newcomer!.hp).toBe(100); expect(w.players.alpha!.inventory.wood).toBe(30); expect(w.id).toBe(id);
    expect(Object.keys(w.players)).toHaveLength(3);
  });

  it('advances shared duties through actual scavenging, gunfire, and completed crafting without minting progress at project start',() => {
    const w = world(), p = w.players.alpha!; w.enemies = [];
    for (const position of ['defender','scout','engineer'] as const) {
      act(w,{type:'survival_election',position});
      const electionId = w.community!.elections[0]!.id;
      act(w,{type:'survival_ballot',electionId,candidateId:'alpha'});
      act(w,{type:'survival_ballot',electionId,candidateId:'alpha'},'bravo');
    }
    const cache = w.containers[0]!; p.x = cache.x; p.y = cache.y;
    act(w,{type:'survival_interact',targetId:cache.id});
    expect(cache.opened).toBe(true);
    expect(w.community!.duties.find(duty => duty.position === 'scout')!.progress).toBe(1);
    expect(w.community!.duties.find(duty => duty.memberId === 'alpha' && duty.position === 'crew')!.progress).toBe(1);
    w.enemies = [{id:'duty-infected',x:p.x + 80,y:p.y,hp:1,maxHp:58,kind:'infected',horde:false,attackAt:999_999}];
    input(w,true); step(w);
    expect(w.enemies).toHaveLength(0); expect(p.stats.kills).toBe(1);
    expect(w.community!.duties.find(duty => duty.position === 'defender')!.progress).toBe(1);
    expect(w.community!.duties.find(duty => duty.memberId === 'alpha' && duty.position === 'crew')!.progress).toBe(1.5);
    input(w,false); p.x = w.shelter.x; p.y = w.shelter.y;
    act(w,{type:'survival_craft',recipeId:'ammo'});
    expect(w.community!.duties.find(duty => duty.position === 'engineer')!.progress).toBe(0);
    const ammo = p.inventory.ammo, finish = w.jobs[0]!.finishAt;
    w.elapsedMs = finish - 100; step(w);
    expect(w.jobs).toHaveLength(0); expect(p.inventory.ammo).toBe(ammo + 12);
    expect(w.community!.duties.find(duty => duty.position === 'engineer')!.progress).toBe(1);
    expect(w.community!.duties.find(duty => duty.memberId === 'alpha' && duty.position === 'crew')).toMatchObject({progress:2,completed:true});
    expect(projectSurvivalWorld(w).community!.supplies).toMatchObject({food:1,water:1,ammo:6});
  });

  it('runs CPU election ballots and closes their private election from normal elapsed world ticks',() => {
    const w = world(); w.enemies = [];
    act(w,{type:'survival_election',position:'captain'});
    const electionId = w.community!.elections[0]!.id;
    act(w,{type:'survival_ballot',electionId,candidateId:'alpha'});
    for (let i = 0; i < 14; i++) step(w,100,new Set(['alpha']),new Set(['bravo']));
    expect(w.community!.elections).toHaveLength(1);
    expect(projectSurvivalWorld(w).community!.elections[0]!.ballotsCast).toBe(1);
    expect(projectSurvivalPlayer(w,'alpha')!.electionVotes).toEqual({[electionId]:'alpha'});
    expect(projectSurvivalPlayer(w,'bravo')!.electionVotes).toEqual({});
    step(w,100,new Set(['alpha']),new Set(['bravo']));
    expect(w.elapsedMs).toBe(1500); expect(w.community!.elections).toHaveLength(0);
    expect(w.community!.officers.captain === null || w.community!.officers.captain === 'alpha').toBe(true);
    expect(projectSurvivalPlayer(w,'alpha')!.electionVotes).toEqual({});
    const publicResult = w.events.at(-1)!;
    expect(publicResult.kind).toBe('election_result');
    expect(publicResult.text).not.toContain('alpha'); expect(publicResult.text).not.toContain('bravo');
  });

  it('turns governance and progression rejections into normal SurvivalError codes without changing resources',() => {
    const w = world(), inventory = structuredClone(w.players.alpha!.inventory);
    reject(() => act(w,{type:'survival_withdraw',item:'wood',amount:1}),'INSUFFICIENT_SUPPLIES');
    reject(() => act(w,{type:'survival_ballot',electionId:'missing',candidateId:'alpha'}),'ELECTION_CLOSED');
    reject(() => act(w,{type:'survival_craft',recipeId:'missing'}),'survival_recipe');
    expect(w.players.alpha!.inventory).toEqual(inventory);
    expect(w.jobs).toHaveLength(0); expect(w.community!.supplies.wood).toBe(0);
  });

  it('clears departed officers and ballots during a paused membership update without advancing the world',() => {
    const w = world();
    act(w,{type:'survival_election',position:'defender'});
    let electionId = w.community!.elections[0]!.id;
    act(w,{type:'survival_ballot',electionId,candidateId:'bravo'});
    act(w,{type:'survival_ballot',electionId,candidateId:'bravo'},'bravo');
    expect(w.community!.officers.defender).toBe('bravo');
    act(w,{type:'survival_election',position:'scout'}); electionId = w.community!.elections[0]!.id;
    act(w,{type:'survival_ballot',electionId,candidateId:'bravo'});
    act(w,{type:'survival_pause',paused:true});
    const elapsed = w.elapsedMs, health = w.shelter.hp;
    tickSurvivalWorld(w,w.lastTickAt + 100,new Set(['alpha']),new Set(),new Set(['alpha']));
    expect(w.community!.officers.defender).toBeNull();
    expect(w.community!.elections[0]).toMatchObject({eligibleIds:['alpha'],candidates:['alpha'],votes:{}});
    expect(w.elapsedMs).toBe(elapsed); expect(w.shelter.hp).toBe(health); expect(w.paused).toBe(true);
  });
 });

 describe('survival calendar display', () => {
  it('preserves minutes throughout the one-hour active game day and rolls over at midnight', () => {
    const w = world();
    w.elapsedMs = 45_000;
    expect(projectSurvivalWorld(w).hour).toBeCloseTo(8.3);
    expect(projectSurvivalWorld(w).day).toBe(1);
    w.elapsedMs = 2_400_000;
    expect(projectSurvivalWorld(w)).toMatchObject({day:2,hour:0,night:true});
  });
 });
