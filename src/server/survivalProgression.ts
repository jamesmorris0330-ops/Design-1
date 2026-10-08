import { randomUUID } from 'node:crypto';
import { recordDuty } from './shelterGovernance.js';
import {
  RECIPES, SHELTERS, UPGRADE_RULES, WEAPONS, itemIds,
  type CalendarGoal, type Inventory, type ProgressMetric,
  type RecruitedSurvivor, type SurvivalAction, type SurvivalPlayer,
  type SurvivalWorld, type UpgradeJob,
} from '../shared/survival.js';

export class SurvivalProgressionError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'SurvivalProgressionError'; }
}

const MAX_LEVEL = 5;
const MAX_JOBS = 3;
const upgradeRules = UPGRADE_RULES;

export function upgradeCost(kind: keyof typeof upgradeRules, nextLevel: number): Partial<Inventory> {
  return Object.fromEntries(Object.entries(upgradeRules[kind].cost).map(([item, amount]) => [item, amount * nextLevel]));
}

export function upgradeDurationMs(kind: keyof typeof upgradeRules, nextLevel: number): number {
  return upgradeRules[kind].durationMs * nextLevel;
}

function event(world: SurvivalWorld, text: string, kind: string, speakerId?: string): void {
  world.events.push({ id: randomUUID(), at: world.elapsedMs, text, kind, ...(speakerId ? { speakerId } : {}) });
  if (world.events.length > 100) world.events.splice(0, world.events.length - 100);
}

const distance = (a: {x:number;y:number}, b: {x:number;y:number}) => Math.hypot(a.x - b.x, a.y - b.y);
export const survivalCalendarDay = (world: SurvivalWorld): number => 1 + Math.floor(world.elapsedMs / world.dayLengthMs + 1 / 3);

function actor(world: SurvivalWorld, actorId: string): SurvivalPlayer {
  const player = world.players[actorId];
  if (!world.active) throw new SurvivalProgressionError('survival_inactive', 'The survival world is not active.');
  if (world.paused) throw new SurvivalProgressionError('survival_paused', 'Resume the world before taking that action.');
  if (!player) throw new SurvivalProgressionError('survival_observer', 'Observers cannot change survival equipment.');
  if (player.hp <= 0) throw new SurvivalProgressionError('survival_downed', 'Recover before taking that action.');
  return player;
}

function nearBase(world: SurvivalWorld, player: SurvivalPlayer): void {
  if (distance(player, world.shelter) > 200) throw new SurvivalProgressionError('survival_base_required', 'Return within 200 units of your shelter to build or upgrade.');
}

function pay(player: SurvivalPlayer, cost: Partial<Inventory>): void {
  for (const item of itemIds) if (player.inventory[item] < (cost[item] ?? 0)) {
    throw new SurvivalProgressionError('survival_materials', `Not enough ${item} for this project.`);
  }
  for (const item of itemIds) player.inventory[item] -= cost[item] ?? 0;
}

function hasPending(world: SurvivalWorld, kind: UpgradeJob['kind'], targetId: string, ownerId?: string): boolean {
  return world.jobs.some(job => job.kind === kind && job.targetId === targetId && (ownerId === undefined || job.ownerId === ownerId));
}

function availableQueue(world: SurvivalWorld): void {
  if (world.jobs.length >= MAX_JOBS) throw new SurvivalProgressionError('survival_queue_full', 'Three projects are already in progress.');
}

function craftSpeed(world: SurvivalWorld): number {
  return 1 + .2 * (world.facilities.find(facility => facility.kind === 'workbench')?.level ?? 0);
}

export function carryingCapacity(world: SurvivalWorld, playerId: string): number {
  const backpack = world.players[playerId]?.gear.find(gear => gear.id === 'backpack')?.level ?? 0;
  const storage = world.facilities.find(facility => facility.kind === 'storage')?.level ?? 0;
  return 60 + backpack * 20 + storage * 20;
}

function carried(player: SurvivalPlayer): number {
  return itemIds.reduce((total, item) => total + (item === 'ammo' ? 0 : player.inventory[item]), 0);
}

function shelterStatistics(world: SurvivalWorld): void {
  const shelter = world.shelter;
  const base = SHELTERS[shelter.type];
  const ratio = shelter.maxHp > 0 ? Math.max(0, Math.min(1, shelter.hp / shelter.maxHp)) : 1;
  const maxHp = Math.round(base.health * (1 + .25 * (shelter.level - 1)));
  shelter.maxHp = maxHp;
  shelter.hp = Math.round(maxHp * ratio);
  shelter.defense = base.defense + 5 * (shelter.level - 1) + 5 * (world.facilities.find(facility => facility.kind === 'barricade')?.level ?? 0);
  shelter.capacity = base.capacity + Math.floor((shelter.level - 1) / 2);
}

const goalTemplates: Record<CalendarGoal['period'], Omit<CalendarGoal, 'id'|'period'|'progress'|'claimed'|'expiresDay'>[]> = {
  daily: [
    { title: 'Supply run: open 4 caches', metric: 'loot', target: 4, reward: { food: 3, water: 3 } },
    { title: 'Clear the perimeter: defeat 8 infected', metric: 'kills', target: 8, reward: { ammo: 18, medicine: 1 } },
    { title: 'Invest in survival: finish an upgrade', metric: 'upgrades', target: 1, reward: { wood: 4, metal: 4 } },
  ],
  weekly: [
    { title: 'Hold the line: survive 3 horde waves', metric: 'waves', target: 3, reward: { metal: 10, ammo: 36 } },
    { title: 'Bring them home: rescue 2 survivors', metric: 'rescues', target: 2, reward: { food: 6, medicine: 3 } },
    { title: 'Make it through: survive 5 days', metric: 'days', target: 5, reward: { wood: 12, water: 8 } },
  ],
  monthly: [
    { title: 'Keep the community alive for 20 days', metric: 'days', target: 20, reward: { food: 20, medicine: 8 } },
    { title: 'Build a future: finish 12 upgrades', metric: 'upgrades', target: 12, reward: { electronics: 12, metal: 20 } },
    { title: 'Reclaim the district: defeat 100 infected', metric: 'kills', target: 100, reward: { ammo: 100, cloth: 20 } },
  ],
};

function remainingUpgradePotential(world: SurvivalWorld): number {
  const remainingLevels = (level: number) => Math.max(0, MAX_LEVEL - level);
  let remaining = remainingLevels(world.shelter.level);
  for (const kind of ['workbench', 'storage', 'barricade', 'rain_collector'] as const) {
    remaining += remainingLevels(world.facilities.find(facility => facility.kind === kind)?.level ?? 1);
  }
  for (const player of Object.values(world.players)) {
    for (const id of Object.keys(WEAPONS)) remaining += remainingLevels(player.weapons.find(weapon => weapon.id === id)?.level ?? 1);
    for (const id of ['armor', 'backpack', 'boots'] as const) remaining += remainingLevels(player.gear.find(gear => gear.id === id)?.level ?? 1);
  }
  for (const survivor of world.survivors) remaining += remainingLevels(survivor.level);
  // Unrecruited survivors can still be rescued and upgraded in a later period.
  remaining += world.rescues.filter(rescue => !rescue.rescued).length * (MAX_LEVEL - 1);
  return remaining;
}

/** Choose repeatable objectives once finite recruitment or upgrades run out. */
function templatesFor(world: SurvivalWorld, period: CalendarGoal['period']): typeof goalTemplates[typeof period] {
  return goalTemplates[period].map(template => {
    if (template.metric === 'rescues' && world.rescues.filter(rescue => !rescue.rescued).length < template.target) {
      return { ...template, title: 'Restock the community: open 12 caches', metric: 'loot' as const, target: 12 };
    }
    if (template.metric === 'upgrades' && remainingUpgradePotential(world) < template.target) {
      return period === 'daily'
        ? { ...template, title: 'Keep supplies flowing: open 6 caches', metric: 'loot' as const, target: 6 }
        : { ...template, title: 'Protect the community: survive 5 horde waves', metric: 'waves' as const, target: 5 };
    }
    return template;
  });
}

function periodStart(day: number, period: CalendarGoal['period']): number {
  const length = period === 'daily' ? 1 : period === 'weekly' ? 7 : 30;
  return 1 + Math.floor((day - 1) / length) * length;
}

function refreshGoals(world: SurvivalWorld, day: number): boolean {
  let changed = false;
  for (const period of ['daily', 'weekly', 'monthly'] as const) {
    const start = periodStart(day, period);
    const length = period === 'daily' ? 1 : period === 'weekly' ? 7 : 30;
    if (world.goals.some(goal => goal.period === period && goal.expiresDay === start + length)) continue;
    world.goals = world.goals.filter(goal => goal.period !== period);
    world.goals.push(...templatesFor(world, period).map((template, index): CalendarGoal => ({
      ...template, reward: { ...template.reward }, id: `${period}-${start}-${index}`, period, progress: 0,
      claimed: false, expiresDay: start + length,
    })));
    changed = true;
  }
  return changed;
}

export function initializeProgression(world: SurvivalWorld): void {
  shelterStatistics(world);
  refreshGoals(world, survivalCalendarDay(world));
  if (!world.lastDay || world.lastDay < 1) world.lastDay = survivalCalendarDay(world);
}

/** Shared objectives advance once for an event; personal totals belong to its actor. */
export function recordProgress(world: SurvivalWorld, actorId: string, metric: ProgressMetric, amount = 1): void {
  if (!Number.isFinite(amount) || amount <= 0) return;
  amount = Math.min(1_000_000, Math.floor(amount));
  const player = world.players[actorId];
  if (player) { player.stats[metric] += amount; if (metric === 'kills' || metric === 'loot') recordDuty(world,actorId,metric,amount); }
  for (const goal of world.goals) if (goal.metric === metric && !goal.claimed) goal.progress = Math.min(goal.target, goal.progress + amount);
}

function queueCraft(world: SurvivalWorld, player: SurvivalPlayer, recipeId: string): void {
  nearBase(world, player);
  const recipe = RECIPES.find(candidate => candidate.id === recipeId);
  if (!recipe) throw new SurvivalProgressionError('survival_recipe', 'That recipe is not available.');
  availableQueue(world);
  if (recipe.weapon && (player.weapons.some(weapon => weapon.id === recipe.weapon) || hasPending(world, 'craft', recipeId, player.id))) {
    throw new SurvivalProgressionError('survival_owned', 'You already own or are building this weapon.');
  }
  if (recipe.gear && (player.gear.some(gear => gear.id === recipe.gear) || hasPending(world, 'craft', recipeId, player.id))) {
    throw new SurvivalProgressionError('survival_owned', 'You already own or are building this gear.');
  }
  if (recipe.facility && (world.facilities.some(facility => facility.kind === recipe.facility) || hasPending(world, 'craft', recipeId))) {
    throw new SurvivalProgressionError('survival_owned', 'This shelter facility already exists or is being built.');
  }
  if (recipe.repairShelterHp && world.shelter.hp >= world.shelter.maxHp) throw new SurvivalProgressionError('survival_full', 'Your shelter does not need repairs.');
  pay(player, recipe.cost);
  world.jobs.push({ id: randomUUID(), ownerId: player.id, kind: 'craft', targetId: recipe.id, level: 1,
    finishAt: world.elapsedMs + Math.ceil(recipe.durationMs / craftSpeed(world)), label: recipe.name });
  event(world, `${recipe.name} construction started.`, 'project');
}

function queueUpgrade(world: SurvivalWorld, player: SurvivalPlayer, kind: keyof typeof upgradeRules, targetId: string): void {
  nearBase(world, player);
  availableQueue(world);
  const personal = kind === 'weapon' || kind === 'gear';
  if (hasPending(world, kind, kind === 'shelter' ? 'shelter' : targetId, personal ? player.id : undefined)) throw new SurvivalProgressionError('survival_project_duplicate', 'That upgrade is already in progress.');
  const target = kind === 'weapon' ? player.weapons.find(weapon => weapon.id === targetId)
    : kind === 'gear' ? player.gear.find(gear => gear.id === targetId)
    : kind === 'survivor' ? world.survivors.find(survivor => survivor.id === targetId)
    : kind === 'facility' ? world.facilities.find(facility => facility.id === targetId)
    : targetId === world.shelter.siteId || targetId === 'shelter' ? world.shelter : undefined;
  if (!target) throw new SurvivalProgressionError('survival_target', 'That upgrade target is not owned or available.');
  if (target.level >= MAX_LEVEL) throw new SurvivalProgressionError('survival_level_cap', 'This is already at maximum level 5.');
  const level = target.level + 1;
  pay(player, upgradeCost(kind, level));
  world.jobs.push({ id: randomUUID(), ownerId: player.id, kind, targetId: kind === 'shelter' ? 'shelter' : targetId,
    level, finishAt: world.elapsedMs + Math.ceil(upgradeDurationMs(kind, level) / craftSpeed(world)), label: `${kind.charAt(0).toUpperCase() + kind.slice(1)} level ${level}` });
  event(world, `${kind.charAt(0).toUpperCase() + kind.slice(1)} level ${level} upgrade started.`, 'project');
}

function finishJob(world: SurvivalWorld, job: UpgradeJob): void {
  const owner = world.players[job.ownerId];
  if (job.kind === 'craft') {
    const recipe = RECIPES.find(candidate => candidate.id === job.targetId);
    if (!recipe) return;
    if (recipe.output && owner) owner.inventory[recipe.output.item] += recipe.output.amount;
    if (recipe.weapon && owner && !owner.weapons.some(weapon => weapon.id === recipe.weapon)) owner.weapons.push({ id: recipe.weapon, level: 1, magazine: 0 });
    if (recipe.gear && owner && !owner.gear.some(gear => gear.id === recipe.gear)) owner.gear.push({ id: recipe.gear, level: 1 });
    if (recipe.facility && !world.facilities.some(facility => facility.kind === recipe.facility)) world.facilities.push({ id: recipe.facility, kind: recipe.facility, level: 1 });
    if (recipe.repairShelterHp) world.shelter.hp = Math.min(world.shelter.maxHp, world.shelter.hp + recipe.repairShelterHp);
    if (recipe.facility) shelterStatistics(world);
  } else {
    const target = job.kind === 'weapon' ? owner?.weapons.find(weapon => weapon.id === job.targetId)
      : job.kind === 'gear' ? owner?.gear.find(gear => gear.id === job.targetId)
      : job.kind === 'survivor' ? world.survivors.find(survivor => survivor.id === job.targetId)
      : job.kind === 'facility' ? world.facilities.find(facility => facility.id === job.targetId)
      : world.shelter;
    if (!target) return;
    target.level = job.level;
    if (job.kind === 'shelter' || job.kind === 'facility') shelterStatistics(world);
    recordProgress(world, job.ownerId, 'upgrades');
  }
  recordDuty(world,job.ownerId,'projects',1);
  event(world, `${job.label} completed.`, 'project_complete');
}

function supplyRecipient(world: SurvivalWorld, activeIds?: Set<string>): SurvivalPlayer | undefined {
  return Object.values(world.players).filter(player => (!activeIds || activeIds.has(player.id)) && player.hp > 0 && distance(player, world.shelter) <= 300 && carried(player) < carryingCapacity(world, player.id))
    .sort((a, b) => distance(a, world.shelter) - distance(b, world.shelter) || a.id.localeCompare(b.id))[0];
}

function addSupply(world: SurvivalWorld, item: keyof Inventory, amount: number, activeIds?: Set<string>): void {
  const recipient = supplyRecipient(world, activeIds);
  if (!recipient) return;
  const space = carryingCapacity(world, recipient.id) - carried(recipient);
  recipient.inventory[item] += Math.max(0, Math.min(space, amount));
}

function supportSurvivor(world: SurvivalWorld, survivor: RecruitedSurvivor, activeIds?: Set<string>): void {
  if (survivor.hp <= 0 || survivor.role === 'guardian' || world.elapsedMs < survivor.nextActionAt) return;
  if (survivor.role === 'medic') {
    survivor.nextActionAt = world.elapsedMs + 15_000;
    const patient = Object.values(world.players).filter(player => (!activeIds || activeIds.has(player.id)) && player.hp > 0 && player.hp < 100 && distance(player, world.shelter) <= 200)
      .sort((a, b) => a.hp - b.hp || a.id.localeCompare(b.id))[0];
    if (patient) patient.hp = Math.min(100, patient.hp + 8 + survivor.level * 4);
  } else if (survivor.role === 'engineer') {
    survivor.nextActionAt = world.elapsedMs + 30_000;
    if (world.shelter.hp > 0) world.shelter.hp = Math.min(world.shelter.maxHp, world.shelter.hp + survivor.level * 8);
  } else {
    survivor.nextActionAt = world.elapsedMs + 45_000;
    const resources = ['wood', 'metal', 'food'] as const;
    const seed = [...survivor.id].reduce((sum, character) => sum + character.charCodeAt(0), Math.floor(world.elapsedMs / 45_000));
    addSupply(world, resources[seed % resources.length]!, survivor.level, activeIds);
  }
}

export function tickProgression(world: SurvivalWorld, deltaMs: number, activeIds?: Set<string>): boolean {
  if (!world.active || world.paused || deltaMs <= 0) return false;
  let changed = false;
  const day = survivalCalendarDay(world);
  if (day !== world.lastDay) {
    const elapsedDays = Math.max(0, day - world.lastDay);
    changed = refreshGoals(world, day) || changed;
    for (const player of Object.values(world.players)) if (!activeIds || activeIds.has(player.id)) player.stats.days += elapsedDays;
    recordProgress(world, '', 'days', elapsedDays);
    world.lastDay = day;
    event(world, `Day ${day} begins. Daily objectives refreshed.`, 'new_day');
    changed = true;
  }
  const readyJobs = world.jobs.filter(job => job.finishAt <= world.elapsedMs);
  if (readyJobs.length) {
    world.jobs = world.jobs.filter(job => job.finishAt > world.elapsedMs);
    for (const job of readyJobs) finishJob(world, job);
    changed = true;
  }
  for (const survivor of world.survivors) if (survivor.role !== 'guardian' && survivor.hp > 0 && survivor.nextActionAt <= world.elapsedMs) {
    supportSurvivor(world, survivor, activeIds);
    changed = true;
  }
  const collector = world.facilities.find(facility => facility.kind === 'rain_collector');
  const previousElapsed = Math.max(0, world.elapsedMs - deltaMs);
  const waterCycles = Math.floor(world.elapsedMs / 45_000) - Math.floor(previousElapsed / 45_000);
  if (collector && waterCycles > 0) {
    addSupply(world, 'water', Math.min(waterCycles, 20) * collector.level, activeIds);
    changed = true;
  }
  return changed;
}

/** Returns false for actions owned by the movement/combat engine. */
export function applyProgressionAction(world: SurvivalWorld, actorId: string, action: SurvivalAction, _now: number, hostId: string): boolean {
  if (!['survival_craft','survival_upgrade','survival_equip','survival_consume','survival_shelter','survival_claim','survival_interact'].includes(action.type)) return false;
  const rescue = action.type === 'survival_interact' ? world.rescues.find(site => site.id === action.targetId) : undefined;
  if (action.type === 'survival_interact' && !rescue) return false;
  const player = actor(world, actorId);
  if (action.type === 'survival_craft') queueCraft(world, player, action.recipeId);
  else if (action.type === 'survival_upgrade') queueUpgrade(world, player, action.kind, action.targetId);
  else if (action.type === 'survival_equip') {
    if (action.kind === 'weapon') {
      const weapon = player.weapons.find(candidate => candidate.id === action.targetId);
      if (!weapon) throw new SurvivalProgressionError('survival_equipment', 'You do not own that weapon.');
      if (player.equippedWeapon !== weapon.id) {
        player.equippedWeapon = weapon.id;
        player.reloadUntil = 0;
      }
    } else if (!player.gear.some(gear => gear.id === action.targetId)) throw new SurvivalProgressionError('survival_equipment', 'You do not own that gear.');
  } else if (action.type === 'survival_consume') {
    const stat = action.item === 'food' ? 'hunger' : action.item === 'water' ? 'thirst' : 'hp';
    if (player[stat] >= 100) throw new SurvivalProgressionError('survival_full', `Your ${stat === 'hp' ? 'health' : stat} is already full.`);
    if (player.inventory[action.item] <= 0) throw new SurvivalProgressionError('survival_materials', `You have no ${action.item}.`);
    player.inventory[action.item]--;
    player[stat] = Math.min(100, player[stat] + (action.item === 'food' ? 35 : action.item === 'water' ? 45 : 40));
  } else if (action.type === 'survival_shelter') {
    if (actorId !== hostId) throw new SurvivalProgressionError('host_required', 'Only the host can move the shared shelter.');
    if (world.wave.active) throw new SurvivalProgressionError('survival_horde', 'Defeat the active horde before moving shelter.');
    const site = world.sites.find(candidate => candidate.id === action.siteId);
    if (!site?.discovered) throw new SurvivalProgressionError('survival_undiscovered', 'Discover this shelter site first.');
    if (site.id === world.shelter.siteId) throw new SurvivalProgressionError('survival_current_shelter', 'This is already your active shelter.');
    if (distance(player, site) > 120) throw new SurvivalProgressionError('survival_proximity', 'Travel within 120 units of the new shelter before moving.');
    const capacity = SHELTERS[site.type].capacity + Math.floor((world.shelter.level - 1) / 2);
    if (world.survivors.length > capacity) throw new SurvivalProgressionError('survival_capacity', 'This shelter does not have room for your recruited survivors.');
    world.shelter.siteId = site.id;
    world.shelter.type = site.type;
    world.shelter.x = site.x;
    world.shelter.y = site.y;
    shelterStatistics(world);
    for (const [index, survivor] of world.survivors.entries()) {
      survivor.x = site.x + Math.cos(index * 2) * 60;
      survivor.y = site.y + Math.sin(index * 2) * 60;
    }
    event(world, `The community moved into the ${SHELTERS[site.type].name}. Improvements and crew relocated.`, 'shelter_move');
  } else if (action.type === 'survival_claim') {
    const goal = world.goals.find(candidate => candidate.id === action.goalId);
    if (!goal || goal.expiresDay <= survivalCalendarDay(world)) throw new SurvivalProgressionError('survival_goal', 'This objective is no longer available.');
    if (goal.claimed) throw new SurvivalProgressionError('survival_goal_claimed', 'The room has already claimed this reward.');
    if (goal.progress < goal.target) throw new SurvivalProgressionError('survival_goal_incomplete', 'Complete the objective before claiming its reward.');
    goal.claimed = true;
    recordDuty(world,actorId,'goals',1);
    for (const item of itemIds) player.inventory[item] += goal.reward[item] ?? 0;
    event(world, `${goal.title} completed. Its shared-room reward was claimed by one player.`, 'goal_claim');
  } else if (rescue) {
    if (rescue.rescued) throw new SurvivalProgressionError('survival_rescued', 'This survivor has already joined your shelter.');
    if (distance(player, rescue) > 100) throw new SurvivalProgressionError('survival_proximity', 'Move within 100 units to recruit this survivor.');
    if (world.survivors.length >= world.shelter.capacity) throw new SurvivalProgressionError('survival_capacity', 'Your shelter has no more room for survivors.');
    pay(player, { food: 2, medicine: 1 });
    rescue.rescued = true;
    world.survivors.push({ id: rescue.id, name: rescue.name, role: rescue.role, level: 1, hp: 100,
      x: world.shelter.x + 50, y: world.shelter.y + 50, nextActionAt: world.elapsedMs + 5_000 });
    recordProgress(world, actorId, 'rescues');
    event(world, `${rescue.name}, a ${rescue.role}, joined the shelter.`, 'rescue');
    const greeting = {
      guardian: "I'll hold the perimeter. Keep ammunition coming.",
      medic: "Bring the injured back to the shelter. I'll patch them up.",
      scavenger: "I'll search for supplies. Leave a little room in your pack.",
      engineer: "I'll keep these walls standing. Let's build something that lasts.",
    }[rescue.role];
    event(world, greeting, 'survivor_dialogue', rescue.id);
  }
  return true;
}
