import { describe, expect, it } from 'vitest';
import { itemIds, RECIPES, SHELTERS, type SurvivalAction, type SurvivalWorld } from '../shared/survival.js';
import { createSurvivalWorld } from './survival.js';
import {
  applyProgressionAction, carryingCapacity, initializeProgression, recordProgress,
  survivalCalendarDay, tickProgression, upgradeCost,
} from './survivalProgression.js';

function setup(): SurvivalWorld {
  const world = createSurvivalWorld(['host', 'guest'], 'farmhouse', 60, 1_000);
  for (const player of Object.values(world.players)) for (const item of itemIds) player.inventory[item] = 100;
  return world;
}
const act = (world: SurvivalWorld, action: SurvivalAction, actor = 'host') => applyProgressionAction(world, actor, action, 1_000, 'host');
function advance(world: SurvivalWorld, ms: number): boolean {
  world.elapsedMs += ms;
  return tickProgression(world, ms);
}
function enterDay(world: SurvivalWorld, day: number): void {
  const target = (day - 1 - 1 / 3) * world.dayLengthMs + 1;
  advance(world, target - world.elapsedMs);
}

describe('authoritative survival progression', () => {
  it('pays fixed crafting costs once, persists unfinished jobs, and grants no free loaded ammunition', () => {
    const world = setup();
    const player = world.players.host!;
    const before = { ...player.inventory };
    act(world, { type: 'survival_craft', recipeId: 'rifle' });
    expect(world.jobs).toHaveLength(1);
    expect(player.inventory).toEqual({ ...before, metal: 88, wood: 96, electronics: 97 });
    expect(() => act(world, { type: 'survival_craft', recipeId: 'rifle' })).toThrow(/already own/);
    expect(player.inventory).toEqual({ ...before, metal: 88, wood: 96, electronics: 97 });
    advance(world, 29_999);
    expect(player.weapons).toHaveLength(1);
    const restored: SurvivalWorld = JSON.parse(JSON.stringify(world));
    advance(restored, 1);
    expect(restored.jobs).toHaveLength(0);
    expect(restored.players.host!.weapons).toContainEqual({ id: 'rifle', level: 1, magazine: 0 });
    expect(restored.players.host!.inventory.ammo).toBe(before.ammo);
    tickProgression(restored, 1);
    expect(restored.players.host!.weapons.filter(weapon => weapon.id === 'rifle')).toHaveLength(1);
  });

  it('validates every cost before charging and bounds the shared paid project queue', () => {
    const world = setup();
    world.players.host!.inventory.electronics = 0;
    const before = { ...world.players.host!.inventory };
    expect(() => act(world, { type: 'survival_craft', recipeId: 'rifle' })).toThrow(/Not enough electronics/);
    expect(world.players.host!.inventory).toEqual(before);
    expect(world.jobs).toHaveLength(0);
    for (let index = 0; index < 3; index++) act(world, { type: 'survival_craft', recipeId: 'ammo' });
    const charged = { ...world.players.host!.inventory };
    expect(() => act(world, { type: 'survival_craft', recipeId: 'ammo' })).toThrow(/Three projects/);
    expect(world.players.host!.inventory).toEqual(charged);
    expect(world.jobs).toHaveLength(3);
    advance(world, 5_000);
    expect(world.players.host!.inventory.ammo).toBe(136);
  });

  it('prevents two players from building the same facility and workbenches speed future projects', () => {
    const world = setup();
    act(world, { type: 'survival_craft', recipeId: 'workbench' });
    const guestInventory = { ...world.players.guest!.inventory };
    expect(() => act(world, { type: 'survival_craft', recipeId: 'workbench' }, 'guest')).toThrow(/already exists/);
    expect(world.players.guest!.inventory).toEqual(guestInventory);
    advance(world, 20_000);
    expect(world.facilities).toContainEqual({ id: 'workbench', kind: 'workbench', level: 1 });
    act(world, { type: 'survival_craft', recipeId: 'rifle' });
    expect(world.jobs[0]!.finishAt - world.elapsedMs).toBe(25_000);
    expect(() => act(world, { type: 'survival_craft', recipeId: 'workbench' })).toThrow(/already exists/);
  });

  it('enforces ownership, level caps, duplicate targets and authoritative upgrade rewards', () => {
    const world = setup();
    world.players.guest!.weapons.push({ id: 'rifle', level: 1, magazine: 0 });
    expect(() => act(world, { type: 'survival_upgrade', kind: 'weapon', targetId: 'rifle' })).toThrow(/not owned/);
    const cost = upgradeCost('weapon', 2);
    const before = { ...world.players.host!.inventory };
    act(world, { type: 'survival_upgrade', kind: 'weapon', targetId: 'pistol' });
    for (const item of itemIds) expect(world.players.host!.inventory[item]).toBe(before[item] - (cost[item] ?? 0));
    expect(() => act(world, { type: 'survival_upgrade', kind: 'weapon', targetId: 'pistol' })).toThrow(/already in progress/);
    advance(world, 30_000);
    expect(world.players.host!.weapons[0]!.level).toBe(2);
    expect(world.players.host!.stats.upgrades).toBe(1);
    expect(world.goals.find(goal => goal.period === 'daily' && goal.metric === 'upgrades')!.progress).toBe(1);
    expect(world.players.guest!.stats.upgrades).toBe(0);
    world.players.host!.weapons[0]!.level = 5;
    expect(() => act(world, { type: 'survival_upgrade', kind: 'weapon', targetId: 'pistol' })).toThrow(/maximum level/);
  });

  it('keeps shelter damage proportional through an upgrade and rejects duplicate site aliases', () => {
    const world = setup();
    world.shelter.hp = world.shelter.maxHp / 2;
    act(world, { type: 'survival_upgrade', kind: 'shelter', targetId: world.shelter.siteId });
    const inventory = { ...world.players.host!.inventory };
    expect(() => act(world, { type: 'survival_upgrade', kind: 'shelter', targetId: 'shelter' })).toThrow(/already in progress/);
    expect(() => act(world, { type: 'survival_upgrade', kind: 'shelter', targetId: world.shelter.siteId })).toThrow(/already in progress/);
    expect(world.players.host!.inventory).toEqual(inventory);
    advance(world, 60_000);
    expect(world.shelter.level).toBe(2);
    expect(world.shelter.hp / world.shelter.maxHp).toBeCloseTo(.5, 2);
    expect(world.shelter.defense).toBe(SHELTERS.farmhouse.defense + 5);
  });

  it('requires actual discovery, travel, host authority and an ended horde before moving the single base', () => {
    const world = setup();
    const site = world.sites.find(candidate => candidate.type === 'bunker')!;
    expect(() => act(world, { type: 'survival_shelter', siteId: site.id })).toThrow(/Discover/);
    site.discovered = true;
    expect(() => act(world, { type: 'survival_shelter', siteId: site.id })).toThrow(/Travel within/);
    world.players.host!.x = site.x;
    world.players.host!.y = site.y;
    expect(() => act(world, { type: 'survival_shelter', siteId: site.id }, 'guest')).toThrow(/Only the host/);
    world.wave.active = true;
    expect(() => act(world, { type: 'survival_shelter', siteId: site.id })).toThrow(/active horde/);
    world.wave.active = false;
    world.shelter.hp = 550;
    world.facilities.push({ id: 'barrier', kind: 'barricade', level: 2 });
    act(world, { type: 'survival_shelter', siteId: site.id });
    expect(world.shelter).toMatchObject({ siteId: site.id, type: 'bunker', hp: 800, maxHp: 1600, defense: 42 });
    expect(world.facilities).toHaveLength(1);
    expect(world.sites.filter(candidate => candidate.discovered)).toHaveLength(2);
  });

  it('carries pending base upgrades and crew through shelter migration without refilling health', () => {
    const world = setup();
    world.shelter.hp = 550;
    act(world, { type: 'survival_upgrade', kind: 'shelter', targetId: 'shelter' });
    const site = world.sites.find(candidate => candidate.type === 'warehouse')!;
    site.discovered = true;
    Object.assign(world.players.host!, { x: site.x, y: site.y });
    world.survivors.push({ id: 'crew', name: 'Alex', role: 'guardian', level: 3, x: 0, y: 0, hp: 80, nextActionAt: 100_000 });
    act(world, { type: 'survival_shelter', siteId: site.id });
    expect(world.jobs).toHaveLength(1);
    expect(world.survivors[0]).toMatchObject({ name: 'Alex', level: 3, hp: 80 });
    expect(Math.hypot(world.survivors[0]!.x - site.x, world.survivors[0]!.y - site.y)).toBeCloseTo(60);
    advance(world, 60_000);
    expect(world.shelter).toMatchObject({ type: 'warehouse', level: 2, maxHp: 1625 });
    expect(world.shelter.hp / world.shelter.maxHp).toBeCloseTo(.5, 2);
  });

  it('recruits one time only, conserves recruitment supplies, respects distance and crew capacity', () => {
    const world = setup();
    const rescue = world.rescues[0]!;
    const before = { ...world.players.host!.inventory };
    expect(() => act(world, { type: 'survival_interact', targetId: rescue.id })).toThrow(/within 100/);
    expect(world.players.host!.inventory).toEqual(before);
    Object.assign(world.players.host!, { x: rescue.x, y: rescue.y });
    world.shelter.capacity = 0;
    expect(() => act(world, { type: 'survival_interact', targetId: rescue.id })).toThrow(/no more room/);
    world.shelter.capacity = 6;
    act(world, { type: 'survival_interact', targetId: rescue.id });
    expect(world.players.host!.inventory).toEqual({ ...before, food: 98, medicine: 99 });
    expect(world.survivors).toHaveLength(1);
    expect(world.survivors[0]).toMatchObject({ id: rescue.id, name: rescue.name, role: rescue.role, level: 1 });
    expect(world.players.host!.stats.rescues).toBe(1);
    expect(world.events.find(event => event.kind === 'survivor_dialogue')).toMatchObject({ speakerId: rescue.id });
    expect(world.events.find(event => event.kind === 'survivor_dialogue')!.text).not.toMatch(/inventory|medicine:|food:/);
    expect(() => act(world, { type: 'survival_interact', targetId: rescue.id })).toThrow(/already joined/);
    expect(world.players.host!.inventory.food).toBe(98);
  });

  it('provides distinct medic, engineer and scavenger contributions while leaving guardians to combat', () => {
    const world = setup();
    for (const player of Object.values(world.players)) for (const item of itemIds) player.inventory[item] = item === 'ammo' ? 60 : 0;
    world.players.host!.hp = 60;
    world.shelter.hp = 500;
    for (const [index, role] of (['medic', 'engineer', 'scavenger', 'guardian'] as const).entries()) world.survivors.push({
      id: `crew-${index}`, name: role, role, level: 2, x: world.shelter.x, y: world.shelter.y, hp: 100, nextActionAt: 0,
    });
    world.facilities.push({ id: 'rain', kind: 'rain_collector', level: 2 });
    advance(world, 45_000);
    expect(world.players.host!.hp).toBe(76);
    expect(world.shelter.hp).toBe(516);
    expect(Object.values(world.players).reduce((sum, player) => sum + player.inventory.wood + player.inventory.metal + player.inventory.food, 0)).toBe(2);
    expect(Object.values(world.players).reduce((sum, player) => sum + player.inventory.water, 0)).toBe(2);
    expect(world.survivors.find(survivor => survivor.role === 'guardian')!.nextActionAt).toBe(0);
    const supplies = JSON.stringify(Object.values(world.players).map(player => player.inventory));
    tickProgression(world, 0);
    expect(JSON.stringify(Object.values(world.players).map(player => player.inventory))).toBe(supplies);
  });

  it('refreshes daily, weekly and monthly goals at separate calendar boundaries from an 08:00 start', () => {
    const world = setup();
    expect(survivalCalendarDay(world)).toBe(1);
    expect(world.goals).toHaveLength(9);
    const monthlyId = world.goals.find(goal => goal.period === 'monthly')!.id;
    const weeklyId = world.goals.find(goal => goal.period === 'weekly')!.id;
    recordProgress(world, 'host', 'kills', 2);
    enterDay(world, 2);
    expect(survivalCalendarDay(world)).toBe(2);
    expect(world.goals.find(goal => goal.period === 'daily' && goal.metric === 'kills')!.progress).toBe(0);
    expect(world.goals.find(goal => goal.period === 'weekly')!.id).toBe(weeklyId);
    expect(world.goals.find(goal => goal.period === 'monthly')!.id).toBe(monthlyId);
    expect(world.goals.find(goal => goal.period === 'monthly' && goal.metric === 'kills')!.progress).toBe(2);
    enterDay(world, 8);
    expect(world.goals.find(goal => goal.period === 'weekly')!.id).not.toBe(weeklyId);
    expect(world.goals.find(goal => goal.period === 'monthly')!.id).toBe(monthlyId);
    enterDay(world, 31);
    expect(world.goals.find(goal => goal.period === 'monthly')!.id).not.toBe(monthlyId);
    expect(world.goals).toHaveLength(9);
    expect(world.players.host!.stats.days).toBe(30);
    expect(world.players.guest!.stats.days).toBe(30);
    const ids = world.goals.map(goal => goal.id);
    initializeProgression(world);
    expect(world.goals.map(goal => goal.id)).toEqual(ids);
  });

  it('claims completed shared objectives once without leaking or crediting another player inventory', () => {
    const world = setup();
    const goal = world.goals.find(candidate => candidate.period === 'daily' && candidate.metric === 'loot')!;
    expect(() => act(world, { type: 'survival_claim', goalId: goal.id })).toThrow(/Complete/);
    recordProgress(world, 'guest', 'loot', 99);
    expect(goal.progress).toBe(goal.target);
    expect(world.players.guest!.stats.loot).toBe(99);
    expect(world.players.host!.stats.loot).toBe(0);
    const guestInventory = { ...world.players.guest!.inventory };
    act(world, { type: 'survival_claim', goalId: goal.id });
    expect(world.players.host!.inventory.food).toBe(103);
    expect(world.players.guest!.inventory).toEqual(guestInventory);
    expect(() => act(world, { type: 'survival_claim', goalId: goal.id }, 'guest')).toThrow(/already claimed/);
    expect(world.players.guest!.inventory).toEqual(guestInventory);
  });

  it('freezes project completion when paused and requires live actors and base proximity for investments', () => {
    const world = setup();
    act(world, { type: 'survival_craft', recipeId: 'ammo' });
    world.paused = true;
    world.elapsedMs = 5_000;
    expect(tickProgression(world, 5_000)).toBe(false);
    expect(world.jobs).toHaveLength(1);
    expect(() => act(world, { type: 'survival_craft', recipeId: 'medicine' })).toThrow(/Resume/);
    world.paused = false;
    tickProgression(world, 1);
    expect(world.jobs).toHaveLength(0);
    world.players.host!.hp = 0;
    expect(() => act(world, { type: 'survival_upgrade', kind: 'weapon', targetId: 'pistol' })).toThrow(/Recover/);
    world.players.host!.hp = 100;
    world.players.host!.x = world.shelter.x + 201;
    world.players.host!.y = world.shelter.y;
    expect(() => act(world, { type: 'survival_craft', recipeId: 'ammo' })).toThrow(/200 units/);
  });

  it('repairs shelter with paid timed materials rather than migration or repeated free healing', () => {
    const world = setup();
    expect(() => act(world, { type: 'survival_craft', recipeId: 'repair' })).toThrow(/does not need/);
    world.shelter.hp = 200;
    act(world, { type: 'survival_craft', recipeId: 'repair' });
    expect(world.players.host!.inventory.wood).toBe(96);
    expect(world.players.host!.inventory.metal).toBe(98);
    const recipe = RECIPES.find(candidate => candidate.id === 'repair')!;
    advance(world, recipe.durationMs - 1);
    expect(world.shelter.hp).toBe(200);
    advance(world, 1);
    expect(world.shelter.hp).toBe(450);
    tickProgression(world, 1);
    expect(world.shelter.hp).toBe(450);
  });

  it('uses bounded consumption and passive gear while retaining owner-only weapon equip', () => {
    const world = setup();
    expect(() => act(world, { type: 'survival_consume', item: 'food' })).toThrow(/already full/);
    expect(world.players.host!.inventory.food).toBe(100);
    world.players.host!.hunger = 80;
    act(world, { type: 'survival_consume', item: 'food' });
    expect(world.players.host!.hunger).toBe(100);
    expect(world.players.host!.inventory.food).toBe(99);
    expect(() => act(world, { type: 'survival_equip', kind: 'weapon', targetId: 'rifle' })).toThrow(/do not own/);
    world.players.host!.gear.push({ id: 'backpack', level: 3 });
    world.facilities.push({ id: 'storage', kind: 'storage', level: 2 });
    expect(carryingCapacity(world, 'host')).toBe(160);
    expect(carryingCapacity(world, 'guest')).toBe(100);
    expect(act(world, { type: 'survival_equip', kind: 'gear', targetId: 'backpack' })).toBe(true);
    expect(act(world, { type: 'survival_input', moveX: 0, moveY: 0, aim: 0, fire: false })).toBe(false);
  });

  it('does not grant calendar days, medical aid or generated supplies to disconnected humans', () => {
    const world = setup();
    for (const player of Object.values(world.players)) for (const item of itemIds) player.inventory[item] = item === 'ammo' ? 60 : 0;
    world.players.host!.hp = 20;
    world.players.guest!.hp = 80;
    world.survivors.push({ id: 'medic', name: 'Medic', role: 'medic', level: 1, x: world.shelter.x, y: world.shelter.y, hp: 100, nextActionAt: 0 });
    world.facilities.push({ id: 'rain', kind: 'rain_collector', level: 1 });
    world.elapsedMs = world.dayLengthMs;
    tickProgression(world, world.dayLengthMs, new Set(['guest']));
    expect(world.players.host!.stats.days).toBe(0);
    expect(world.players.guest!.stats.days).toBe(1);
    expect(world.players.host!.hp).toBe(20);
    expect(world.players.guest!.hp).toBe(92);
    expect(world.players.host!.inventory.water).toBe(0);
    expect(world.players.guest!.inventory.water).toBe(20);
  });

  it('replaces exhausted recruitment and upgrade objectives at future refreshes with claimable repeatable goals', () => {
    const world = setup();
    const originalGoalIds = world.goals.map(goal => goal.id);
    world.shelter.level = 5;
    world.facilities = (['workbench', 'storage', 'barricade', 'rain_collector'] as const).map(kind => ({ id: kind, kind, level: 5 }));
    for (const player of Object.values(world.players)) {
      player.weapons = (['pistol', 'rifle', 'shotgun'] as const).map(id => ({ id, level: 5, magazine: 0 }));
      player.gear = (['armor', 'backpack', 'boots'] as const).map(id => ({ id, level: 5 }));
    }
    for (const rescue of world.rescues) rescue.rescued = true;
    world.survivors = world.rescues.map(rescue => ({ id: rescue.id, name: rescue.name, role: rescue.role, level: 5,
      x: world.shelter.x, y: world.shelter.y, hp: 100, nextActionAt: Number.MAX_SAFE_INTEGER }));
    initializeProgression(world);
    expect(world.goals.map(goal => goal.id)).toEqual(originalGoalIds);
    expect(world.goals.some(goal => goal.metric === 'rescues')).toBe(true);
    expect(world.goals.some(goal => goal.metric === 'upgrades')).toBe(true);

    enterDay(world, 8);
    const restock = world.goals.find(goal => goal.period === 'weekly' && goal.metric === 'loot')!;
    expect(restock).toMatchObject({ target: 12, progress: 0, claimed: false });
    expect(world.goals.some(goal => goal.period === 'daily' && goal.metric === 'upgrades')).toBe(false);
    recordProgress(world, 'host', 'loot', 12);
    const before = { ...world.players.host!.inventory };
    act(world, { type: 'survival_claim', goalId: restock.id });
    expect(restock.claimed).toBe(true);
    expect(world.players.host!.inventory.food).toBe(before.food + 6);
    expect(world.players.host!.inventory.medicine).toBe(before.medicine + 3);

    enterDay(world, 31);
    expect(world.goals.every(goal => goal.metric !== 'rescues' && goal.metric !== 'upgrades')).toBe(true);
    const defense = world.goals.find(goal => goal.period === 'monthly' && goal.metric === 'waves')!;
    expect(defense).toMatchObject({ target: 5, progress: 0 });
    recordProgress(world, 'host', 'waves', 5);
    act(world, { type: 'survival_claim', goalId: defense.id });
    expect(defense.claimed).toBe(true);
    expect(world.goals).toHaveLength(9);
  });

  it('keeps future upgrade objectives when missing craftable gear and facilities still provide enough potential', () => {
    const world = setup();
    world.shelter.level = 5;
    for (const player of Object.values(world.players)) for (const weapon of player.weapons) weapon.level = 5;
    for (const rescue of world.rescues) rescue.rescued = true;
    enterDay(world, 31);
    expect(world.goals.find(goal => goal.period === 'monthly' && goal.metric === 'upgrades')).toMatchObject({ target: 12 });
    expect(world.goals.find(goal => goal.period === 'daily' && goal.metric === 'upgrades')).toMatchObject({ target: 1 });
    expect(world.goals.find(goal => goal.period === 'weekly' && goal.metric === 'loot')).toMatchObject({ target: 12 });
  });
});
