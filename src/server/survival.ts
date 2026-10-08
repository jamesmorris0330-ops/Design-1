import { randomUUID } from 'node:crypto';
import {
  emptyInventory, itemIds, SHELTERS, WEAPONS, survivalActions,
  type Enemy, type ItemId, type ShelterType, type SurvivalAction, type SurvivalPlayer,
  type SurvivalPrivatePlayer, type SurvivalPublicWorld, type SurvivalWorld,
} from '../shared/survival.js';
import { initializeCommunity, addCommunityPlayer, applyCommunityAction, tickCommunity, projectCommunity, projectElectionVotes, recordDuty } from './shelterGovernance.js';
import { applyProgressionAction, carryingCapacity, initializeProgression, recordProgress, SurvivalProgressionError, tickProgression } from './survivalProgression.js';

export class SurvivalError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'SurvivalError'; }
}
function fail(code: string, message: string): never { throw new SurvivalError(code, message); }
const distance = (a: {x:number;y:number}, b: {x:number;y:number}) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (n:number, low:number, high:number) => Math.min(high, Math.max(low, n));
const SAFE_RADIUS = 95;
const MAX_ENEMIES = 64;
const hash = (value:string) => { let n = 2166136261; for (const char of value) n = Math.imul(n ^ char.charCodeAt(0), 16777619); return n >>> 0; };
function event(world:SurvivalWorld, text:string, kind:string):void {
  world.events.push({id:randomUUID(), at:world.elapsedMs, text, kind});
  if (world.events.length > 60) world.events.splice(0, world.events.length - 60);
}
const calendar = (world:SurvivalWorld) => {
  const total = world.elapsedMs / world.dayLengthMs + 1/3;
  const day = 1 + Math.floor(total);
  const hour = (total % 1) * 24;
  return {day, hour, week:1 + Math.floor((day - 1) / 7), month:1 + Math.floor((day - 1) / 30), night:hour >= 20 || hour < 6};
};

export function addSurvivalPlayer(world:SurvivalWorld, id:string, now = world.lastTickAt):void {
  if (world.players[id]) return;
  const angle = Object.keys(world.players).length * 2.399;
  world.players[id] = {
    id, x:world.shelter.x + Math.cos(angle) * 54, y:world.shelter.y + Math.sin(angle) * 54,
    aim:angle, hp:100, hunger:100, thirst:100, stamina:100,
    inventory:{...emptyInventory(), wood:8, metal:6, cloth:4, electronics:1, ammo:60, food:5, water:5, medicine:2},
    weapons:[{id:'pistol',level:1,magazine:12}], gear:[], equippedWeapon:'pistol',
    stats:{kills:0,loot:0,rescues:0,upgrades:0,waves:0,days:0},
    input:{moveX:0,moveY:0,aim:angle,fire:false,receivedAt:now},
    nextShotAt:0, reloadUntil:0, downUntil:0, lastDamageAt:0,
  };
  if (world.community) addCommunityPlayer(world, id);
}

export function createSurvivalWorld(memberIds:string[], shelterType:ShelterType, dayLengthMinutes:number, now:number):SurvivalWorld {
  if (!SHELTERS[shelterType] || ![60,120,240].includes(dayLengthMinutes)) fail('BAD_SETTINGS','Choose a shelter and a 1, 2, or 4 hour survival day.');
  const sites = [
    {id:'site-farmhouse',type:'farmhouse' as const,x:1500,y:1100,discovered:false},
    {id:'site-bunker',type:'bunker' as const,x:970,y:780,discovered:false},
    {id:'site-warehouse',type:'warehouse' as const,x:2110,y:940,discovered:false},
    {id:'site-apartment',type:'apartment' as const,x:1860,y:1650,discovered:false},
    {id:'site-ranger-station',type:'ranger_station' as const,x:810,y:1510,discovered:false},
  ];
  const chosen = sites.find(site => site.type === shelterType)!;
  chosen.discovered = true;
  const info = SHELTERS[shelterType];
  const world:SurvivalWorld = {
    id:randomUUID(),active:true,paused:false,elapsedMs:0,dayLengthMs:dayLengthMinutes * 60_000,lastTickAt:now,tickNumber:0,
    width:3000,height:2200,players:{},
    shelter:{siteId:chosen.id,type:shelterType,x:chosen.x,y:chosen.y,level:1,hp:info.health,maxHp:info.health,defense:info.defense,capacity:info.capacity},
    sites, containers:[], enemies:[], rescues:[], survivors:[], facilities:[], jobs:[], goals:[], events:[],
    wave:{active:false,number:0,completed:0,nextAt:90_000,remainingSpawns:0,nextSpawnAt:0},
    nextRoamerAt:12_000,lastDay:1,
  };
  for (const id of [...new Set(memberIds)]) addSurvivalPlayer(world,id,now);
  const labels = ['Abandoned supply crate','Emergency medical case','Workshop cache','Sealed ammunition box','Evacuation baggage','Ration locker'];
  for (let i = 0; i < 26; i++) {
    const angle = i * 2.399;
    const radius = i < 5 ? 170 + i * 36 : 370 + (i % 7) * 90;
    world.containers.push({
      id:`loot-${i + 1}`,x:clamp(chosen.x + Math.cos(angle) * radius,65,world.width - 65),y:clamp(chosen.y + Math.sin(angle) * radius,65,world.height - 65),
      label:labels[i % labels.length]!,opened:false,
      contents:i % 3 === 0 ? {metal:5,cloth:3,ammo:24,medicine:1} : i % 3 === 1 ? {wood:7,metal:3,electronics:2,food:2} : {food:3,water:4,cloth:4,ammo:18},
      ...(i === 1 || i === 16 ? {weapon:'rifle' as const} : i === 6 ? {weapon:'shotgun' as const} : {}),
      ...(i === 3 ? {gear:'armor' as const} : i === 8 ? {gear:'backpack' as const} : i === 10 ? {gear:'boots' as const} : {}),
      respawnDay:3,
    });
  }
  const rescueRoles = ['guardian','medic','scavenger','engineer'] as const;
  const names = ['Mara','Luis','Sana','Drew','Imani','Owen','Vera','Ezra','Talia','Rafael','Noor','Cole'];
  for (let i = 0; i < 12; i++) {
    const angle = i < 4 ? .8 + i * 1.5 : .8 + i * 2.399;
    const radius = i < 4 ? 330 + i * 80 : 720 + (i - 4) * 85;
    world.rescues.push({id:`rescue-${i + 1}`,name:names[i]!,role:rescueRoles[i % 4]!,x:clamp(chosen.x + Math.cos(angle) * radius,65,2935),y:clamp(chosen.y + Math.sin(angle) * radius,65,2135),rescued:false});
  }
  for (let i = 0; i < 4; i++) spawnEnemy(world,false,i * 1.55 + .1,310 + i * 35);
  initializeProgression(world);
  initializeCommunity(world);
  event(world,'Day 1 · 08:00. Your shelter is secure for now. Explore, collect supplies, recruit survivors, and prepare for the first night.','start');
  return world;
}

function spawnEnemy(world:SurvivalWorld, horde:boolean, angle?:number, radius?:number):void {
  if (world.enemies.length >= MAX_ENEMIES) return;
  const seed = hash(`${world.id}:${world.tickNumber}:${world.enemies.length}:${world.wave.number}`);
  const a = angle ?? (seed % 6283) / 1000;
  const r = radius ?? (horde ? 610 + seed % 180 : 460 + seed % 360);
  const brute = horde && world.wave.number >= 2 && seed % 5 === 0;
  const hp = brute ? 145 + world.wave.number * 8 : 58 + Math.min(38,world.wave.number * 3);
  world.enemies.push({id:randomUUID(),x:clamp(world.shelter.x + Math.cos(a) * r,30,world.width - 30),y:clamp(world.shelter.y + Math.sin(a) * r,30,world.height - 30),hp,maxHp:hp,kind:brute?'brute':'infected',horde,attackAt:world.elapsedMs + 700});
}

function inventoryLoad(player:SurvivalPlayer):number { return itemIds.reduce((sum,item) => sum + (item === 'ammo' ? 0 : player.inventory[item]),0); }
function loot(world:SurvivalWorld, player:SurvivalPlayer, targetId:string):void {
  const container = world.containers.find(c => c.id === targetId);
  if (!container) fail('BAD_TARGET','That object cannot be collected.');
  if (distance(player,container) > 100) fail('TOO_FAR','Move closer to the supply crate to collect it.');
  if (container.opened) fail('ALREADY_COLLECTED','These supplies have already been collected.');
  let room = Math.max(0,carryingCapacity(world,player.id) - inventoryLoad(player));
  let transferred = 0;
  for (const item of itemIds) {
    const available = container.contents[item] ?? 0;
    const amount = Math.min(available,item === 'ammo' ? 2000 - player.inventory.ammo : Math.min(room,500 - player.inventory[item]));
    if (amount <= 0) continue;
    player.inventory[item] += amount;
    container.contents[item] = available - amount;
    transferred += amount;
    if (item !== 'ammo') room -= amount;
  }
  if (container.weapon && !player.weapons.some(w => w.id === container.weapon)) {
    player.weapons.push({id:container.weapon,level:1,magazine:WEAPONS[container.weapon].magazine});
    delete container.weapon; transferred++;
  }
  if (container.gear && !player.gear.some(g => g.id === container.gear)) {
    player.gear.push({id:container.gear,level:1});
    delete container.gear; transferred++;
  }
  if (!transferred) fail('INVENTORY_FULL','Your pack is full. Spend supplies or upgrade your backpack before collecting more.');
  if (itemIds.every(item => (container.contents[item] ?? 0) === 0) && !container.weapon && !container.gear) {
    container.opened = true;
    container.respawnDay = calendar(world).day + 2;
    container.respawnAt = world.elapsedMs + 12 * 60_000;
    recordProgress(world,player.id,'loot');
  }
  event(world,`${container.label} scavenged. Supplies are stored in the collector’s pack.`,'loot');
}

function beginReload(world:SurvivalWorld, player:SurvivalPlayer):void {
  const weapon = player.weapons.find(w => w.id === player.equippedWeapon)!;
  if (player.reloadUntil > 0) return;
  if (weapon.magazine >= WEAPONS[weapon.id].magazine || player.inventory.ammo < 1) return;
  player.reloadUntil = world.elapsedMs + (weapon.id === 'shotgun' ? 1900 : 1300);
}
function killEnemy(world:SurvivalWorld, enemy:Enemy, playerId?:string):void {
  world.enemies = world.enemies.filter(e => e.id !== enemy.id);
  if (playerId) recordProgress(world,playerId,'kills');
  // Ammunition drops keep a defended expedition viable without inventing reserve rounds.
  if (hash(enemy.id) % 3 === 0 && world.containers.length < 80) world.containers.push({id:`drop-${enemy.id}`,x:enemy.x,y:enemy.y,label:'Infected supply drop',opened:false,contents:{ammo:8,metal:1},respawnDay:calendar(world).day + 2});
}
function fire(world:SurvivalWorld, player:SurvivalPlayer):void {
  if (player.hp <= 0 || player.reloadUntil > world.elapsedMs || player.nextShotAt > world.elapsedMs) return;
  const owned = player.weapons.find(w => w.id === player.equippedWeapon)!;
  const weapon = WEAPONS[owned.id];
  if (owned.magazine <= 0) { beginReload(world,player); return; }
  owned.magazine--;
  player.nextShotAt = world.elapsedMs + weapon.cooldownMs;
  const dx = Math.cos(player.aim), dy = Math.sin(player.aim);
  const targets = world.enemies.map(enemy => {
    const ex = enemy.x - player.x, ey = enemy.y - player.y;
    return {enemy,along:ex * dx + ey * dy,lateral:Math.abs(ex * dy - ey * dx)};
  }).filter(hit => hit.along >= -14 && hit.along <= weapon.range && hit.lateral <= 19 + hit.along * weapon.spread).sort((a,b) => a.along - b.along);
  const count = owned.id === 'shotgun' ? 3 : 1;
  for (const {enemy} of targets.slice(0,count)) {
    enemy.hp -= weapon.damage * (1 + (owned.level - 1) * .2);
    if (enemy.hp <= 0) killEnemy(world,enemy,player.id);
  }
}

function down(world:SurvivalWorld, player:SurvivalPlayer):void {
  if (player.downUntil > world.elapsedMs) return;
  player.hp = 0;
  player.downUntil = world.elapsedMs + 20_000;
  player.input.moveX = player.input.moveY = 0;
  player.input.fire = false;
  player.reloadUntil = 0;
  event(world,'A survivor has fallen. Shelter recovery becomes available after 20 seconds.','downed');
}

export function applySurvivalAction(world:SurvivalWorld, actorId:string, action:SurvivalAction, now:number, hostId:string, eligibleIds = new Set(Object.keys(world.players))):void {
  if (!survivalActions.some(schema => schema.safeParse(action).success)) fail('BAD_ACTION','Invalid survival action.');
  if (action.type === 'survival_pause') {
    if (actorId !== hostId) fail('HOST_ONLY','Only the host can pause the expedition.');
    world.paused = action.paused;
    world.lastTickAt = now;
    for (const p of Object.values(world.players)) { p.input.fire = false; p.input.moveX = p.input.moveY = 0; }
    event(world,action.paused?'The expedition is paused.':'The expedition has resumed.','pause');
    return;
  }
  const player = world.players[actorId];
  if (!player) fail('SUBJECT_ONLY','Join an active survivor seat to play.');
  if (!world.active) fail('EXPEDITION_ENDED','The shelter has fallen. Start a new expedition to continue.');
  if (world.paused) fail('PAUSED','The expedition is paused.');
  if (action.type === 'survival_start') fail('BAD_STATE','This expedition is already running.');
  if (action.type === 'survival_respawn') {
    if (player.hp > 0) fail('NOT_DOWNED','You are already standing.');
    if (world.elapsedMs < player.downUntil) fail('RECOVERY_PENDING','Shelter recovery is not ready yet.');
    player.x = world.shelter.x; player.y = world.shelter.y;
    player.hp = 75; player.hunger = Math.max(40,player.hunger); player.thirst = Math.max(40,player.thirst);
    player.downUntil = 0; player.lastDamageAt = world.elapsedMs;
    event(world,'A fallen survivor recovered at the shelter.','recovered');
    return;
  }
  if (player.hp <= 0) fail('DOWNED','Recover at your shelter before acting.');
  if (action.type === 'survival_input') {
    const length = Math.hypot(action.moveX,action.moveY);
    player.input = {...action,moveX:length > 1?action.moveX / length:action.moveX,moveY:length > 1?action.moveY / length:action.moveY,aim:Math.atan2(Math.sin(action.aim),Math.cos(action.aim)),receivedAt:now};
    return;
  }
  if (action.type === 'survival_reload') { beginReload(world,player); return; }
  if (action.type === 'survival_equip') {
    if (action.kind === 'weapon') {
      const weapon = player.weapons.find(w => w.id === action.targetId);
      if (!weapon) fail('NOT_OWNED','You do not own that weapon.');
      if (player.reloadUntil > world.elapsedMs) fail('RELOADING','Finish reloading before changing weapons.');
      player.equippedWeapon = weapon.id;
    } else if (!player.gear.some(g => g.id === action.targetId)) fail('NOT_OWNED','You do not own that gear.');
    return;
  }
  if (action.type === 'survival_consume') {
    if (player.inventory[action.item] < 1) fail('INSUFFICIENT_SUPPLIES',`You have no ${action.item}.`);
    if (action.item === 'medicine') { if (player.hp >= 100) fail('FULL_HEALTH','You are already at full health.'); const restored = Math.min(45, 100 - player.hp); player.hp += restored; recordDuty(world, actorId, 'healing', restored); }
    if (action.item === 'food') { if (player.hunger >= 100) fail('FULL_HUNGER','You do not need food yet.'); player.hunger = Math.min(100,player.hunger + 35); }
    if (action.item === 'water') { if (player.thirst >= 100) fail('FULL_THIRST','You do not need water yet.'); player.thirst = Math.min(100,player.thirst + 40); }
    player.inventory[action.item]--;
    return;
  }
  try {
    if (applyCommunityAction(world,actorId,action,now,hostId,eligibleIds)) return;
    if (applyProgressionAction(world,actorId,action,now,hostId)) return;
  } catch (error) {
    // Every domain rejection must become a normal, persisted negative ACK.
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') fail(error.code,error.message);
    throw error;
  }
  if (action.type === 'survival_interact') {
    const site = world.sites.find(s => s.id === action.targetId);
    if (site) {
      if (distance(player,site) > 180) fail('TOO_FAR','Explore closer to discover this shelter.');
      site.discovered = true;
      event(world,`${SHELTERS[site.type].name} discovered. The host may move the whole community here.`,'discovery');
      return;
    }
    loot(world,player,action.targetId);
    return;
  }
  fail('BAD_ACTION','This survival action is not available.');
}

function cpuControls(world:SurvivalWorld, player:SurvivalPlayer, now:number):void {
  if (player.hp <= 0) {
    if (world.elapsedMs >= player.downUntil) { player.x = world.shelter.x; player.y = world.shelter.y; player.hp = 75; player.downUntil = 0; }
    return;
  }
  // CPU companions see only public map entities and their own inventory/condition.
  const nearestEnemy = world.enemies.filter(e => distance(player,e) < 490).sort((a,b) => distance(player,a) - distance(player,b))[0];
  let target:{x:number;y:number}|undefined;
  let fighting = false;
  if (nearestEnemy && distance(player,nearestEnemy) < WEAPONS[player.equippedWeapon].range) {
    player.aim = Math.atan2(nearestEnemy.y - player.y,nearestEnemy.x - player.x);
    fighting = true;
    if (distance(player,nearestEnemy) < 95 && distance(player,world.shelter) > SAFE_RADIUS) {
      target = {x:player.x + (player.x - nearestEnemy.x) * 3,y:player.y + (player.y - nearestEnemy.y) * 3};
    }
  } else {
    const rescue = player.inventory.food >= 2 && player.inventory.medicine >= 1 && world.survivors.length < world.shelter.capacity
      ? world.rescues.filter(site => !site.rescued && distance(player,site) < 430).sort((a,b) => distance(player,a) - distance(player,b))[0] : undefined;
    const supplies = world.containers.filter(c => !c.opened).sort((a,b) => distance(player,a) - distance(player,b));
    const container = supplies[hash(player.id) % Math.min(3,supplies.length)];
    if (rescue) {
      target = rescue;
      if (distance(player,rescue) <= 85) {
        try { applyProgressionAction(world,player.id,{type:'survival_interact',targetId:rescue.id},now,''); } catch (error) { if (!(error instanceof SurvivalProgressionError)) throw error; }
      }
    } else if (container) {
      target = container;
      if (distance(player,container) <= 85) {
        try { loot(world,player,container.id); } catch (error) { if (!(error instanceof SurvivalError)) throw error; }
      }
    } else target = world.shelter;
    if (nearestEnemy) player.aim = Math.atan2(nearestEnemy.y - player.y,nearestEnemy.x - player.x);
  }
  if (world.wave.active || world.shelter.hp < world.shelter.maxHp * .75 || player.hp < 40) {
    const guardAngle = hash(player.id) % 6283 / 1000;
    target = {x:world.shelter.x + Math.cos(guardAngle) * 65,y:world.shelter.y + Math.sin(guardAngle) * 65};
  }
  if (player.hp < 55 && player.inventory.medicine) { player.inventory.medicine--; player.hp = Math.min(100,player.hp + 45); }
  if (player.hunger < 60 && player.inventory.food) { player.inventory.food--; player.hunger = Math.min(100,player.hunger + 35); }
  if (player.thirst < 60 && player.inventory.water) { player.inventory.water--; player.thirst = Math.min(100,player.thirst + 40); }
  const owned = player.weapons.find(w => w.id === player.equippedWeapon)!;
  if (owned.magazine === 0) beginReload(world,player);
  const length = target ? Math.hypot(target.x - player.x,target.y - player.y) : 0;
  player.input = {moveX:target && length > 15?(target.x - player.x) / length:0,moveY:target && length > 15?(target.y - player.y) / length:0,aim:player.aim,fire:fighting,receivedAt:now};
}

function stepPlayer(world:SurvivalWorld, player:SurvivalPlayer, deltaMs:number, now:number):void {
  if (player.hp <= 0) return;
  if (now - player.input.receivedAt > 450) { player.input.moveX = player.input.moveY = 0; player.input.fire = false; }
  const boots = player.gear.find(g => g.id === 'boots')?.level ?? 0;
  const speed = 155 * (1 + boots * .06) * (player.stamina < 15 ? .75 : 1);
  player.x = clamp(player.x + player.input.moveX * speed * deltaMs / 1000,22,world.width - 22);
  player.y = clamp(player.y + player.input.moveY * speed * deltaMs / 1000,22,world.height - 22);
  player.aim = player.input.aim;
  const dayFraction = deltaMs / world.dayLengthMs;
  player.hunger = Math.max(0,player.hunger - dayFraction * 55);
  player.thirst = Math.max(0,player.thirst - dayFraction * 75);
  player.stamina = clamp(player.stamina + ((Math.abs(player.input.moveX) + Math.abs(player.input.moveY)) > 0 ? -3 : 8) * deltaMs / 1000,0,100);
  if (player.hunger === 0 || player.thirst === 0) {
    player.hp = Math.max(0,player.hp - deltaMs / 1000 * .8);
    if (!player.hp) down(world,player);
  }
  if (player.reloadUntil > 0 && player.reloadUntil <= world.elapsedMs) {
    const owned = player.weapons.find(w => w.id === player.equippedWeapon)!;
    const amount = Math.min(WEAPONS[owned.id].magazine - owned.magazine,player.inventory.ammo);
    owned.magazine += amount; player.inventory.ammo -= amount; player.reloadUntil = 0;
  }
  if (player.input.fire) fire(world,player);
}

function stepEnemy(world:SurvivalWorld, enemy:Enemy, players:SurvivalPlayer[], deltaMs:number):void {
  const candidates = players.filter(p => p.hp > 0 && distance(p,world.shelter) > SAFE_RADIUS);
  const target = candidates.sort((a,b) => distance(enemy,a) - distance(enemy,b))[0];
  const attackingPlayer = target && distance(enemy,target) < 550;
  const destination = attackingPlayer ? target : world.shelter;
  const d = distance(enemy,destination);
  const reach = attackingPlayer ? 28 : 124;
  if (d > reach) {
    const speed = enemy.kind === 'brute' ? 47 : enemy.horde ? 74 : 55;
    const amount = Math.min(d - reach,speed * deltaMs / 1000);
    enemy.x += (destination.x - enemy.x) / d * amount;
    enemy.y += (destination.y - enemy.y) / d * amount;
  }
  if (distance(enemy,destination) <= reach + 1 && world.elapsedMs >= enemy.attackAt) {
    enemy.attackAt = world.elapsedMs + (enemy.kind === 'brute' ? 1400 : 1050);
    if (attackingPlayer) {
      const armor = target.gear.find(g => g.id === 'armor')?.level ?? 0;
      target.hp = Math.max(0,target.hp - Math.max(3,(enemy.kind === 'brute' ? 20 : 10) - armor * 3));
      target.lastDamageAt = world.elapsedMs;
      if (target.hp === 0) down(world,target);
    } else {
      world.shelter.hp = Math.max(0,world.shelter.hp - Math.max(2,(enemy.kind === 'brute' ? 34 : 15) - world.shelter.defense * .35));
    }
  }
}
function stepGuardians(world:SurvivalWorld):void {
  for (const survivor of world.survivors) {
    if (survivor.role !== 'guardian' || survivor.hp <= 0 || survivor.nextActionAt > world.elapsedMs) continue;
    survivor.x = world.shelter.x + 85; survivor.y = world.shelter.y - 18;
    const target = world.enemies.filter(e => distance(e,survivor) < 340).sort((a,b) => distance(a,survivor) - distance(b,survivor))[0];
    if (target) {
      target.hp -= 22 + survivor.level * 8;
      survivor.nextActionAt = world.elapsedMs + 800;
      if (target.hp <= 0) killEnemy(world,target);
    }
  }
}

export function tickSurvivalWorld(world:SurvivalWorld, now:number, activeIds:Set<string>, cpuIds:Set<string>, eligibleIds = new Set(Object.keys(world.players))):boolean {
  const wallDelta = Math.max(0,now - world.lastTickAt);
  world.lastTickAt = now;
  const communityChanged = tickCommunity(world,eligibleIds,cpuIds);
  const humanConnected = [...activeIds].some(id => world.players[id] && !cpuIds.has(id));
  if (!world.active || world.paused || !humanConnected || wallDelta <= 0) {
    if (!humanConnected || world.paused) for (const player of Object.values(world.players)) { player.input.fire = false; player.input.moveX = player.input.moveY = 0; }
    return communityChanged;
  }
  const deltaMs = Math.min(200,wallDelta);
  world.elapsedMs += deltaMs; world.tickNumber++;
  const players = Object.values(world.players).filter(p => activeIds.has(p.id) || cpuIds.has(p.id));
  for (const player of Object.values(world.players)) if (!activeIds.has(player.id) && !cpuIds.has(player.id)) { player.input.fire = false; player.input.moveX = player.input.moveY = 0; }
  for (const player of players) {
    if (cpuIds.has(player.id)) cpuControls(world,player,now);
    stepPlayer(world,player,deltaMs,now);
  }
  if (!world.wave.active && world.elapsedMs >= world.wave.nextAt) {
    world.wave.active = true; world.wave.number++;
    world.wave.remainingSpawns = Math.min(36,7 + world.wave.number * 3 + players.length * 2);
    world.wave.nextSpawnAt = world.elapsedMs;
    event(world,`${calendar(world).night ? 'Night horde' : 'Horde'} ${world.wave.number} incoming. Defend the shelter.`,'horde-start');
  }
  if (world.wave.active && world.wave.remainingSpawns > 0 && world.elapsedMs >= world.wave.nextSpawnAt && world.enemies.length < MAX_ENEMIES) {
    spawnEnemy(world,true);
    world.wave.remainingSpawns--;
    world.wave.nextSpawnAt = world.elapsedMs + 850;
  }
  if (world.elapsedMs >= world.nextRoamerAt && world.enemies.length < 16) {
    const groupSize = 2 + hash(`${world.id}:${world.tickNumber}`) % 2;
    for (let i = 0; i < groupSize; i++) spawnEnemy(world,false);
    world.nextRoamerAt = world.elapsedMs + 16_000;
  }
  for (const enemy of [...world.enemies]) stepEnemy(world,enemy,players,deltaMs);
  stepGuardians(world);
  if (world.wave.active && world.wave.remainingSpawns === 0 && !world.enemies.some(e => e.horde)) {
    world.wave.active = false; world.wave.completed++;
    const firstNight = world.dayLengthMs / 2;
    world.wave.nextAt = world.elapsedMs < firstNight ? firstNight : firstNight + (Math.floor((world.elapsedMs - firstNight) / world.dayLengthMs) + 1) * world.dayLengthMs;
    const ids = players.map(p => p.id);
    if (ids[0]) { recordProgress(world,ids[0],'waves'); for (const id of ids.slice(1)) world.players[id]!.stats.waves++; }
    event(world,`Horde ${world.wave.number} defeated. Repair, restock, and explore before the next night.`,'horde-complete');
  }
  tickCommunity(world,eligibleIds,cpuIds);
  tickProgression(world,deltaMs,new Set(players.map(player => player.id)));
  const today = calendar(world).day;
  let cachesRefilled = 0;
  for (const container of world.containers) if (container.opened && !container.id.startsWith('drop-') && (today >= container.respawnDay || (container.respawnAt !== undefined && world.elapsedMs >= container.respawnAt))) {
    const seed = hash(container.id);
    container.contents = seed % 3 === 0 ? {metal:5,cloth:3,ammo:24,medicine:1} : seed % 3 === 1 ? {wood:7,metal:3,electronics:2,food:2} : {food:3,water:4,cloth:4,ammo:18};
    container.opened = false; container.respawnDay = today + 2; delete container.respawnAt; cachesRefilled++;
  }
  world.containers = world.containers.filter(container => !container.id.startsWith('drop-') || !container.opened);
  if (cachesRefilled) event(world,`${cachesRefilled} supply caches are ready to scavenge again.`,'supplies-refreshed');
  if (world.shelter.hp <= 0) {
    world.active = false;
    event(world,'The shelter has fallen. This expedition has ended. Your community can start a new journey.','survival-ended');
  }
  return true;
}

export function projectSurvivalWorld(world:SurvivalWorld):SurvivalPublicWorld {
  const {day,hour,week,month,night} = calendar(world);
  return structuredClone({
    id:world.id,active:world.active,paused:world.paused,elapsedMs:world.elapsedMs,dayLengthMs:world.dayLengthMs,day,hour,week,month,night,
    width:world.width,height:world.height,community:projectCommunity(world),
    players:Object.values(world.players).map(p => ({id:p.id,x:p.x,y:p.y,aim:p.aim,hp:p.hp,downed:p.hp <= 0,weapon:p.equippedWeapon,weaponLevel:p.weapons.find(w => w.id === p.equippedWeapon)!.level,firing:p.hp > 0 && p.input.fire && p.nextShotAt > world.elapsedMs})),
    shelter:world.shelter,sites:world.sites,
    containers:world.containers.map(({id,x,y,label,opened}) => ({id,x,y,label,opened})),
    enemies:world.enemies.map(({id,x,y,hp,maxHp,kind,horde}) => ({id,x,y,hp,maxHp,kind,horde})),
    rescues:world.rescues,survivors:world.survivors.map(({id,name,role,level,x,y,hp}) => ({id,name,role,level,x,y,hp})),
    facilities:world.facilities,jobs:world.jobs,goals:world.goals,events:world.events,
    wave:{active:world.wave.active,number:world.wave.number,completed:world.wave.completed,nextAt:world.wave.nextAt,remainingSpawns:world.wave.remainingSpawns},
  });
}
export function projectSurvivalPlayer(world:SurvivalWorld, id:string):SurvivalPrivatePlayer|null {
  const p = world.players[id];
  if (!p) return null;
  return structuredClone({electionVotes:projectElectionVotes(world,id),hp:p.hp,hunger:p.hunger,thirst:p.thirst,stamina:p.stamina,inventory:p.inventory,weapons:p.weapons,gear:p.gear,equippedWeapon:p.equippedWeapon,stats:p.stats,reloadRemainingMs:Math.max(0,p.reloadUntil - world.elapsedMs),respawnRemainingMs:p.hp <= 0?Math.max(0,p.downUntil - world.elapsedMs):0});
}
