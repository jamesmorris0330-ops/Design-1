import { z } from 'zod';

export const shelterTypes = ['farmhouse', 'bunker', 'warehouse', 'apartment', 'ranger_station'] as const;
export type ShelterType = typeof shelterTypes[number];
export const itemIds = ['wood','metal','cloth','electronics','ammo','food','water','medicine'] as const;
export type ItemId = typeof itemIds[number];
export type Inventory = Record<ItemId, number>;
export type WeaponId = 'pistol' | 'rifle' | 'shotgun';
export type GearId = 'armor' | 'backpack' | 'boots';
export type SurvivorRole = 'guardian' | 'medic' | 'scavenger' | 'engineer';
export type FacilityKind = 'workbench' | 'storage' | 'barricade' | 'rain_collector';
export type ProgressMetric = 'kills' | 'loot' | 'rescues' | 'upgrades' | 'waves' | 'days';
export const positions = ['captain','defender','scout','medic','engineer'] as const;
export type PositionId = typeof positions[number];
export const POSITIONS: Record<PositionId,{name:string;duty:string;metric: DutyMetric;target:number}> = {
 captain:{name:'Captain',duty:'Claim one completed community goal.',metric:'goals',target:1},
 defender:{name:'Defender',duty:'Defeat six infected.',metric:'kills',target:6},
 scout:{name:'Scout',duty:'Fully collect three supply caches.',metric:'loot',target:3},
 medic:{name:'Medic',duty:'Restore 40 health to survivors.',metric:'healing',target:40},
 engineer:{name:'Engineer',duty:'Complete two crafting or upgrade projects.',metric:'projects',target:2},
};
export type DutyMetric = 'contribution'|'kills'|'loot'|'healing'|'projects'|'goals';
export const survivalActions = [
  z.object({type:z.literal('survival_election'),position:z.enum(positions)}).strict(),
  z.object({type:z.literal('survival_ballot'),electionId:z.string().min(1).max(100),candidateId:z.string().min(1).max(100)}).strict(),
  z.object({type:z.literal('survival_deposit'),item:z.enum(itemIds),amount:z.number().int().min(1).max(100)}).strict(),
  z.object({type:z.literal('survival_withdraw'),item:z.enum(itemIds),amount:z.number().int().min(1).max(100)}).strict(),
  z.object({type:z.literal('survival_heal'),targetId:z.string().min(1).max(100)}).strict(),
  z.object({ type: z.literal('survival_start'), shelterType: z.enum(shelterTypes), dayLengthMinutes: z.union([z.literal(60),z.literal(120),z.literal(240)]) }).strict(),
  z.object({ type: z.literal('survival_input'), moveX: z.number().finite().min(-1).max(1), moveY: z.number().finite().min(-1).max(1), aim: z.number().finite().min(-20).max(20), fire: z.boolean() }).strict(),
  z.object({ type: z.literal('survival_interact'), targetId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('survival_craft'), recipeId: z.string().min(1).max(80) }).strict(),
  z.object({ type: z.literal('survival_upgrade'), kind: z.enum(['weapon','gear','survivor','facility','shelter']), targetId: z.string().max(100) }).strict(),
  z.object({ type: z.literal('survival_equip'), kind: z.enum(['weapon','gear']), targetId: z.string().max(100) }).strict(),
  z.object({ type: z.literal('survival_consume'), item: z.enum(['food','water','medicine']) }).strict(),
  z.object({ type: z.literal('survival_shelter'), siteId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('survival_claim'), goalId: z.string().min(1).max(100) }).strict(),
  z.object({ type: z.literal('survival_pause'), paused: z.boolean() }).strict(),
  z.object({ type: z.literal('survival_reload') }).strict(),
  z.object({ type: z.literal('survival_respawn') }).strict(),
] as const;
export type SurvivalAction = z.infer<typeof survivalActions[number]>;

export const SHELTERS: Record<ShelterType, {name:string;description:string;health:number;defense:number;capacity:number}> = {
 farmhouse:{name:'Farmhouse',description:'Open farmland, sturdy walls, room for a growing crew.',health:1100,defense:16,capacity:6},
 bunker:{name:'Bunker',description:'Heavy protection and limited space underground.',health:1600,defense:32,capacity:4},
 warehouse:{name:'Warehouse',description:'Large storage floor; reinforce its broad entrances.',health:1300,defense:12,capacity:10},
 apartment:{name:'Apartment',description:'Urban shelter with room for a larger community.',health:950,defense:20,capacity:8},
 ranger_station:{name:'Ranger Station',description:'A balanced outpost near scavenging routes.',health:1200,defense:23,capacity:6},
};
export const WEAPONS: Record<WeaponId,{name:string;damage:number;range:number;cooldownMs:number;magazine:number;spread:number}> = {
 pistol:{name:'Pistol',damage:26,range:360,cooldownMs:340,magazine:12,spread:.07},
 rifle:{name:'Rifle',damage:22,range:470,cooldownMs:170,magazine:24,spread:.05},
 shotgun:{name:'Shotgun',damage:65,range:240,cooldownMs:800,magazine:6,spread:.24},
};
export const emptyInventory = (): Inventory => ({wood:0,metal:0,cloth:0,electronics:0,ammo:0,food:0,water:0,medicine:0});
export interface OwnedWeapon {id:WeaponId;level:number;magazine:number}
export interface OwnedGear {id:GearId;level:number}
export interface PlayerStats {kills:number;loot:number;rescues:number;upgrades:number;waves:number;days:number}
export interface SurvivalPlayer {
 id:string;x:number;y:number;aim:number;hp:number;hunger:number;thirst:number;stamina:number;
 inventory:Inventory;weapons:OwnedWeapon[];gear:OwnedGear[];equippedWeapon:WeaponId;stats:PlayerStats;
 input:{moveX:number;moveY:number;aim:number;fire:boolean;receivedAt:number};
 nextShotAt:number;reloadUntil:number;downUntil:number;lastDamageAt:number;
}
export interface Enemy {id:string;x:number;y:number;hp:number;maxHp:number;kind:'infected'|'brute';horde:boolean;attackAt:number}
export interface LootContainer {id:string;x:number;y:number;label:string;opened:boolean;contents:Partial<Inventory>;weapon?:WeaponId;gear?:GearId;respawnDay:number;respawnAt?:number}
export interface ShelterSite {id:string;type:ShelterType;x:number;y:number;discovered:boolean}
export interface ShelterState {siteId:string;type:ShelterType;x:number;y:number;level:number;hp:number;maxHp:number;defense:number;capacity:number}
export interface RescueSite {id:string;x:number;y:number;name:string;role:SurvivorRole;rescued:boolean}
export interface RecruitedSurvivor {id:string;name:string;role:SurvivorRole;level:number;x:number;y:number;hp:number;nextActionAt:number}
export interface Facility {id:string;kind:FacilityKind;level:number}
export interface UpgradeJob {id:string;ownerId:string;kind:'weapon'|'gear'|'survivor'|'facility'|'shelter'|'craft';targetId:string;level:number;finishAt:number;label:string}
export interface CalendarGoal {id:string;title:string;period:'daily'|'weekly'|'monthly';metric:ProgressMetric;target:number;progress:number;claimed:boolean;expiresDay:number;reward:Partial<Inventory>}
export interface SurvivalEvent {id:string;at:number;text:string;kind:string;speakerId?:string}
export interface PlayerDuty {id:string;memberId:string;day:number;position:PositionId|'crew';title:string;metric:DutyMetric;target:number;progress:number;completed:boolean}
export interface ShelterElection {id:string;position:PositionId;candidates:string[];eligibleIds:string[];votes:Record<string,string>;endsAt:number}
export interface CommunityState {officers:Record<PositionId,string|null>;duties:PlayerDuty[];elections:ShelterElection[];supplies:Inventory;lastDay:number}
export interface CommunityPublic {officers:Record<PositionId,string|null>;duties:PlayerDuty[];elections:{id:string;position:PositionId;candidates:string[];eligibleIds:string[];ballotsCast:number;endsAt:number}[];supplies:Inventory}
export interface SurvivalWorld {
 id:string;active:boolean;paused:boolean;elapsedMs:number;dayLengthMs:number;lastTickAt:number;tickNumber:number;
 width:number;height:number;players:Record<string,SurvivalPlayer>;shelter:ShelterState;sites:ShelterSite[];
 containers:LootContainer[];enemies:Enemy[];rescues:RescueSite[];survivors:RecruitedSurvivor[];facilities:Facility[];jobs:UpgradeJob[];goals:CalendarGoal[];events:SurvivalEvent[];
 wave:{active:boolean;number:number;completed:number;nextAt:number;remainingSpawns:number;nextSpawnAt:number};
 nextRoamerAt:number;lastDay:number;community?:CommunityState;
}
export interface SurvivalPublicPlayer {id:string;x:number;y:number;aim:number;hp:number;downed:boolean;weapon:WeaponId;weaponLevel:number;firing:boolean}
export interface SurvivalPublicWorld {
 id:string;active:boolean;paused:boolean;elapsedMs:number;dayLengthMs:number;day:number;hour:number;week:number;month:number;night:boolean;community?:CommunityPublic;
 width:number;height:number;players:SurvivalPublicPlayer[];shelter:ShelterState;sites:ShelterSite[];
 containers:{id:string;x:number;y:number;label:string;opened:boolean}[];enemies:{id:string;x:number;y:number;hp:number;maxHp:number;kind:'infected'|'brute';horde:boolean}[];
 rescues:RescueSite[];survivors:{id:string;name:string;role:SurvivorRole;level:number;x:number;y:number;hp:number}[];facilities:Facility[];jobs:UpgradeJob[];goals:CalendarGoal[];events:SurvivalEvent[];
 wave:{active:boolean;number:number;completed:number;nextAt:number;remainingSpawns:number};
}
export interface SurvivalPrivatePlayer {electionVotes?:Record<string,string>;hp:number;hunger:number;thirst:number;stamina:number;inventory:Inventory;weapons:OwnedWeapon[];gear:OwnedGear[];equippedWeapon:WeaponId;stats:PlayerStats;reloadRemainingMs:number;respawnRemainingMs:number}
export interface Recipe {id:string;name:string;description:string;cost:Partial<Inventory>;durationMs:number;output?:{item:ItemId;amount:number};weapon?:WeaponId;gear?:GearId;facility?:FacilityKind;repairShelterHp?:number}
export const RECIPES: Recipe[] = [
 {id:'repair',name:'Repair shelter',description:'Restore 250 shelter health',cost:{wood:4,metal:2},durationMs:12000,repairShelterHp:250},
 {id:'ammo',name:'Ammunition',description:'12 rounds',cost:{metal:2,cloth:1},durationMs:5000,output:{item:'ammo',amount:12}},
 {id:'medicine',name:'Medicine',description:'A field dressing',cost:{cloth:2,water:1},durationMs:10000,output:{item:'medicine',amount:1}},
 {id:'rifle',name:'Rifle',description:'Rapid fire, greater range',cost:{metal:12,wood:4,electronics:3},durationMs:30000,weapon:'rifle'},
 {id:'shotgun',name:'Shotgun',description:'Powerful close defense',cost:{metal:10,wood:6},durationMs:25000,weapon:'shotgun'},
 {id:'armor',name:'Body armor',description:'Reduce infected damage',cost:{metal:8,cloth:6},durationMs:20000,gear:'armor'},
 {id:'backpack',name:'Backpack',description:'Increase carrying capacity',cost:{cloth:6,wood:2},durationMs:15000,gear:'backpack'},
 {id:'boots',name:'Boots',description:'Faster movement',cost:{cloth:4,metal:2},durationMs:15000,gear:'boots'},
 {id:'workbench',name:'Workbench',description:'A base crafting facility',cost:{wood:8,metal:4},durationMs:20000,facility:'workbench'},
 {id:'storage',name:'Storage',description:'Improve supply capacity',cost:{wood:8,metal:2},durationMs:18000,facility:'storage'},
 {id:'barricade',name:'Barricade',description:'Reinforce shelter defense',cost:{wood:10,metal:4},durationMs:20000,facility:'barricade'},
 {id:'rain_collector',name:'Rain collector',description:'Produce water at your shelter',cost:{wood:6,metal:6,cloth:2},durationMs:22000,facility:'rain_collector'},
];
export const UPGRADE_RULES: Record<'weapon'|'gear'|'survivor'|'facility'|'shelter',{cost:Partial<Inventory>;durationMs:number}> = {
 weapon:{cost:{metal:4,electronics:1,cloth:1},durationMs:15000},
 gear:{cost:{cloth:3,metal:2},durationMs:15000},
 survivor:{cost:{food:2,medicine:1},durationMs:20000},
 facility:{cost:{wood:4,metal:3},durationMs:20000},
 shelter:{cost:{wood:12,metal:8,electronics:2},durationMs:30000},
};
