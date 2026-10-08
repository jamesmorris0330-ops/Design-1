import { useEffect, useRef, useState } from 'react';
import type { Action, PublicMember } from '../shared/protocol';
import { SHELTERS, WEAPONS, type ShelterType, type SurvivalPrivatePlayer, type SurvivalPublicWorld } from '../shared/survival';
import './survival-map.css';

type Props = {
  world: SurvivalPublicWorld;
  me: SurvivalPrivatePlayer | null;
  selfId: string;
  members: PublicMember[];
  send: (action: Action) => boolean;
  online: boolean;
};
type Point = { x: number; y: number };
type Controls = { moveX: number; moveY: number; aim: number; fire: boolean };
type Nearby = { id: string; x: number; y: number; label: string; kind: 'loot' | 'rescue'; distance: number };

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, value));
const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
function hash(value: string): number { let n = 2166136261; for (const c of value) n = Math.imul(n ^ c.charCodeAt(0), 16777619); return n >>> 0; }
function random(seed: number) { let s = seed; return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; }; }
function nearest(world: SurvivalPublicWorld, selfId: string): Nearby | null {
  const player = world.players.find(p => p.id === selfId);
  if (!player || player.downed) return null;
  const candidates: Nearby[] = [
    ...world.containers.filter(c => !c.opened).map(c => ({ ...c, kind: 'loot' as const, distance: distance(player, c) })),
    ...world.rescues.filter(r => !r.rescued).map(r => ({ id: r.id, x: r.x, y: r.y, label: r.name, kind: 'rescue' as const, distance: distance(player, r) })),
  ];
  candidates.sort((a, b) => a.distance - b.distance);
  return candidates[0] ?? null;
}

function rounded(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
}
function tree(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, pine: boolean) {
  ctx.save(); ctx.translate(x, y);
  ctx.fillStyle = '#0c171850'; ctx.beginPath(); ctx.ellipse(9, 13, size * .86, size * .57, -.3, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#5b4932'; ctx.lineWidth = 5; ctx.beginPath(); ctx.moveTo(0, 13); ctx.lineTo(0, -10); ctx.stroke();
  if (pine) {
    for (let i = 0; i < 3; i++) {
      ctx.fillStyle = ['#294640', '#365347', '#43604b'][i]; ctx.beginPath();
      ctx.moveTo(0, -size - i * 7); ctx.lineTo(size * (1 - i * .2), 6 - i * 12); ctx.lineTo(-size * (1 - i * .2), 6 - i * 12); ctx.closePath(); ctx.fill();
    }
  } else {
    for (let i = 0; i < 5; i++) {
      const a = i * 1.256; ctx.fillStyle = ['#354d38', '#43563b', '#3b5036', '#516040', '#3b543d'][i];
      ctx.beginPath(); ctx.arc(Math.cos(a) * size * .34, Math.sin(a) * size * .3 - 9, size * .67, 0, Math.PI * 2); ctx.fill();
    }
  }
  ctx.restore();
}

/** Static world detail is painted once; live actors remain authoritative snapshots. */
function terrain(world: SurvivalPublicWorld): HTMLCanvasElement {
  const canvas = document.createElement('canvas'); canvas.width = world.width; canvas.height = world.height;
  const ctx = canvas.getContext('2d')!;
  const rand = random(hash(world.id));
  ctx.fillStyle = '#4a5543'; ctx.fillRect(0, 0, world.width, world.height);
  for (let i = 0; i < 3600; i++) {
    const x = rand() * world.width, y = rand() * world.height, r = 1 + rand() * 28;
    ctx.fillStyle = ['#52604850', '#7d795530', '#233d3230', '#8c886225'][i % 4];
    ctx.beginPath(); ctx.ellipse(x, y, r * 1.5, r, rand() * Math.PI, 0, Math.PI * 2); ctx.fill();
  }
  // Broken arterial roads connect every shelter, making the world readable.
  const hub = { x: world.width * .5, y: world.height * .5 };
  for (const site of world.sites) {
    ctx.lineCap = 'round'; ctx.strokeStyle = '#736a54'; ctx.lineWidth = 100;
    ctx.beginPath(); ctx.moveTo(site.x, site.y); ctx.lineTo(site.x, hub.y); ctx.lineTo(hub.x, hub.y); ctx.stroke();
    ctx.strokeStyle = '#343d3c'; ctx.lineWidth = 78; ctx.stroke();
    ctx.strokeStyle = '#aa9b6270'; ctx.lineWidth = 2; ctx.setLineDash([15, 17]); ctx.stroke(); ctx.setLineDash([]);
  }
  // Terrain landmarks give each shelter neighbourhood its own character.
  for (const site of world.sites) {
    ctx.save(); ctx.translate(site.x, site.y);
    if (site.type === 'farmhouse') {
      ctx.fillStyle = '#6e6843'; ctx.fillRect(-310, -235, 170, 320);
      ctx.strokeStyle = '#a294575e'; ctx.lineWidth = 6;
      for (let x = -301; x < -140; x += 17) { ctx.beginPath(); ctx.moveTo(x, -230); ctx.lineTo(x, 80); ctx.stroke(); }
      ctx.fillStyle = '#6d7c6580'; ctx.beginPath(); ctx.ellipse(235, -195, 85, 44, -.4, 0, Math.PI * 2); ctx.fill();
    } else if (site.type === 'bunker') {
      ctx.strokeStyle = '#6d7766'; ctx.lineWidth = 8; ctx.beginPath(); ctx.arc(0, 0, 146, -.6, 3.8); ctx.stroke();
      ctx.strokeStyle = '#b3b59a'; ctx.lineWidth = 2; ctx.stroke();
      for (let i = 0; i < 12; i++) { const a = i * .31; ctx.fillStyle = '#3e4d4190'; ctx.fillRect(Math.cos(a) * 180 - 10, Math.sin(a) * 180 - 10, 20, 20); }
    } else if (site.type === 'warehouse') {
      ctx.fillStyle = '#65716860'; ctx.fillRect(-180, -150, 360, 310);
      for (let i = 0; i < 5; i++) {
        ctx.fillStyle = i % 2 ? '#746a47' : '#50716a'; rounded(ctx, 120 + i % 2 * 42, -120 + i * 44, 32, 34, 2); ctx.fill();
        ctx.strokeStyle = '#293b3590'; ctx.lineWidth = 2; ctx.stroke();
        for (let x = 125 + i % 2 * 42; x < 150 + i % 2 * 42; x += 6) { ctx.beginPath(); ctx.moveTo(x, -117 + i * 44); ctx.lineTo(x, -88 + i * 44); ctx.stroke(); }
      }
    } else if (site.type === 'apartment') {
      ctx.fillStyle = '#7e796960'; ctx.fillRect(-210, -220, 440, 440);
      ctx.strokeStyle = '#344a3d'; ctx.lineWidth = 3;
      for (let x = -190; x < 190; x += 42) { ctx.beginPath(); ctx.moveTo(x, -210); ctx.lineTo(x, 210); ctx.stroke(); }
      for (let y = -210; y < 210; y += 42) { ctx.beginPath(); ctx.moveTo(-190, y); ctx.lineTo(190, y); ctx.stroke(); }
      ctx.fillStyle = '#4a5f4780'; ctx.beginPath(); ctx.arc(-145, 115, 44, 0, Math.PI * 2); ctx.fill();
      tree(ctx, -145, 115, 30, false);
    } else {
      ctx.fillStyle = '#91856550'; ctx.beginPath(); ctx.ellipse(0, 0, 170, 123, -.25, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = '#8f8761'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(-165, -88); ctx.lineTo(-165, 110); ctx.lineTo(150, 110); ctx.stroke();
      for (let x = -160; x < 150; x += 30) { ctx.beginPath(); ctx.moveTo(x, 103); ctx.lineTo(x, 118); ctx.stroke(); }
      for (let i = 0; i < 4; i++) tree(ctx, 140 + i % 2 * 36, -80 + i * 32, 24, true);
    }
    ctx.restore();
  }
  ctx.lineWidth = 2;
  for (let i = 0; i < 110; i++) {
    const x = rand() * world.width, y = rand() * world.height;
    if (world.sites.some(s => distance(s, { x, y }) < 180)) continue;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rand() * Math.PI);
    ctx.fillStyle = '#21353665'; ctx.beginPath(); ctx.ellipse(0, 0, 12 + rand() * 30, 5 + rand() * 12, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#b2aa8a30'; ctx.beginPath(); ctx.ellipse(0, -2, 7 + rand() * 12, 3, 0, 0, Math.PI * 1.4); ctx.stroke(); ctx.restore();
  }
  // Fallen branches, stones, cracked asphalt, and ruined cars.
  for (let i = 0; i < 280; i++) {
    const x = rand() * world.width, y = rand() * world.height;
    ctx.strokeStyle = i % 3 ? '#263d2b70' : '#85836d'; ctx.lineWidth = 1 + rand() * 2;
    ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rand() * 15 - 7, y + 6); ctx.lineTo(x + rand() * 20, y + 12); ctx.stroke();
  }
  for (let i = 0; i < 17; i++) {
    const x = rand() * world.width, y = rand() * world.height;
    if (world.sites.some(s => distance(s, { x, y }) < 200)) continue;
    ctx.save(); ctx.translate(x, y); ctx.rotate(rand() * Math.PI);
    ctx.fillStyle = '#17222090'; rounded(ctx, -20, -10, 43, 23, 5); ctx.fill();
    ctx.fillStyle = ['#647576', '#866c4d', '#806157'][i % 3]; rounded(ctx, -20, -14, 40, 23, 4); ctx.fill();
    ctx.fillStyle = '#334445'; ctx.fillRect(-9, -11, 14, 17); ctx.fillStyle = '#bcc8aa'; ctx.fillRect(14, -11, 4, 4);
    ctx.strokeStyle = '#383d31'; ctx.lineWidth = 2; ctx.strokeRect(-20, -14, 40, 23); ctx.restore();
  }
  for (let i = 0; i < 220; i++) {
    const x = rand() * world.width, y = rand() * world.height;
    if (world.sites.some(s => distance(s, { x, y }) < 160) || Math.abs(y - hub.y) < 70) continue;
    tree(ctx, x, y, 17 + rand() * 20, x < world.width * .42 || rand() > .55);
  }
  // A map-edge river and abandoned industrial district.
  ctx.strokeStyle = '#264e57'; ctx.lineWidth = 65; ctx.beginPath();
  for (let y = 0; y <= world.height; y += 60) { const x = world.width - 130 + Math.sin(y / 180) * 65; if (!y) ctx.moveTo(x, y); else ctx.lineTo(x, y); } ctx.stroke();
  ctx.strokeStyle = '#658e8430'; ctx.lineWidth = 2; ctx.stroke();
  ctx.fillStyle = '#17282b'; ctx.fillRect(0, 0, world.width, 12); ctx.fillRect(0, world.height - 12, world.width, 12); ctx.fillRect(0, 0, 12, world.height); ctx.fillRect(world.width - 12, 0, 12, world.height);
  return canvas;
}

function shelter(ctx: CanvasRenderingContext2D, x: number, y: number, type: ShelterType, occupied: boolean, level: number, time: number) {
  ctx.save(); ctx.translate(x, y);
  const sizes: Record<ShelterType, [number, number]> = { farmhouse: [142, 110], bunker: [150, 112], warehouse: [176, 125], apartment: [120, 145], ranger_station: [135, 98] };
  const [w, h] = sizes[type];
  if (occupied) {
    const g = ctx.createRadialGradient(0, 0, 50, 0, 0, 140); g.addColorStop(0, '#ddba5430'); g.addColorStop(1, '#ddba5400');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 140, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = '#f8cc6460'; ctx.lineWidth = 2; ctx.setLineDash([5, 9]); ctx.beginPath(); ctx.arc(0, 0, 114, time * .03, Math.PI * 2 + time * .03); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.fillStyle = '#0e1e2070'; rounded(ctx, -w / 2 + 8, -h / 2 + 11, w, h, 6); ctx.fill();
  if (type === 'farmhouse') {
    ctx.fillStyle = '#c0a07c'; ctx.fillRect(-w / 2, -h / 2 + 17, w, h - 17);
    ctx.fillStyle = '#664949'; ctx.beginPath(); ctx.moveTo(-w / 2 - 5, -h / 2 + 18); ctx.lineTo(0, -h / 2 - 20); ctx.lineTo(w / 2 + 5, -h / 2 + 18); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#956860'; ctx.lineWidth = 2; for (let i = -50; i < 65; i += 12) { ctx.beginPath(); ctx.moveTo(i, -h / 2 + 14); ctx.lineTo(0, -h / 2 - 18); ctx.stroke(); }
    ctx.fillStyle = '#3c5148'; ctx.fillRect(-53, -9, 25, 28); ctx.fillRect(29, -9, 25, 28);
    ctx.fillStyle = occupied ? '#e5b36d' : '#566566'; ctx.fillRect(-48, -5, 15, 20); ctx.fillRect(34, -5, 15, 20);
    ctx.fillStyle = '#665339'; ctx.fillRect(-13, 15, 26, 40);
    ctx.strokeStyle = '#a99d74'; ctx.lineWidth = 4; ctx.beginPath(); ctx.moveTo(-88, 69); ctx.lineTo(88, 69); ctx.stroke();
    for (let i = -80; i <= 80; i += 20) { ctx.beginPath(); ctx.moveTo(i, 59); ctx.lineTo(i, 79); ctx.stroke(); }
  } else if (type === 'bunker') {
    ctx.fillStyle = '#657363'; rounded(ctx, -w / 2 - 14, -h / 2 - 10, w + 28, h + 20, 27); ctx.fill();
    ctx.fillStyle = '#3e4945'; rounded(ctx, -w / 2, -h / 2, w, h, 20); ctx.fill();
    ctx.strokeStyle = '#899585'; ctx.lineWidth = 4; ctx.stroke();
    ctx.fillStyle = '#2c3736'; ctx.fillRect(-40, -25, 80, 55);
    ctx.strokeStyle = '#829180'; ctx.lineWidth = 3; ctx.strokeRect(-40, -25, 80, 55);
    ctx.fillStyle = occupied ? '#bece8a' : '#626e64'; ctx.fillRect(-4, -20, 8, 38);
    ctx.fillStyle = '#303d37'; ctx.fillRect(51, -16, 10, 33); ctx.fillRect(-62, -16, 10, 33);
    ctx.strokeStyle = '#92a081'; ctx.lineWidth = 2; for (let i = -12; i < 17; i += 5) { ctx.beginPath(); ctx.moveTo(52, i); ctx.lineTo(60, i); ctx.moveTo(-61, i); ctx.lineTo(-53, i); ctx.stroke(); }
    ctx.fillStyle = '#998762'; for (let i = -4; i < 5; i++) { rounded(ctx, i * 18 - 8, 52, 17, 10, 3); ctx.fill(); }
  } else if (type === 'warehouse') {
    ctx.fillStyle = '#75766c'; rounded(ctx, -w / 2, -h / 2, w, h, 5); ctx.fill();
    ctx.fillStyle = '#859087'; ctx.fillRect(-w / 2 + 5, -h / 2 + 5, w - 10, 68);
    ctx.strokeStyle = '#515e57'; ctx.lineWidth = 3; for (let i = -w / 2 + 9; i < w / 2; i += 12) { ctx.beginPath(); ctx.moveTo(i, -h / 2 + 5); ctx.lineTo(i, 7); ctx.stroke(); }
    ctx.fillStyle = '#2e4240'; ctx.fillRect(-36, 18, 72, 43);
    ctx.strokeStyle = '#6b7770'; ctx.lineWidth = 2; for (let i = 22; i < 60; i += 7) { ctx.beginPath(); ctx.moveTo(-35, i); ctx.lineTo(35, i); ctx.stroke(); }
    ctx.fillStyle = '#958465'; ctx.fillRect(-79, 38, 28, 23); ctx.fillRect(53, 36, 27, 25);
    ctx.fillStyle = '#496768'; ctx.fillRect(-50, -34, 28, 18); ctx.fillRect(23, -34, 28, 18);
  } else if (type === 'apartment') {
    ctx.fillStyle = '#9a8974'; ctx.fillRect(-w / 2, -h / 2, w, h);
    ctx.fillStyle = '#637266'; ctx.fillRect(-w / 2 + 5, -h / 2 + 5, w - 10, 20);
    for (let row = 0; row < 3; row++) for (let col = 0; col < 3; col++) {
      ctx.fillStyle = occupied && (row + col) % 2 ? '#e9ba76' : '#344b4c'; ctx.fillRect(-46 + col * 34, -33 + row * 35, 22, 23);
      ctx.strokeStyle = '#c1af91'; ctx.lineWidth = 2; ctx.strokeRect(-46 + col * 34, -33 + row * 35, 22, 23);
    }
    ctx.fillStyle = '#343c35'; ctx.fillRect(-12, 44, 24, 28);
    ctx.fillStyle = '#797f66'; ctx.fillRect(-64, 68, 128, 12);
    ctx.fillStyle = '#515e56'; ctx.fillRect(43, -74, 15, -14);
  } else {
    ctx.fillStyle = '#987c53'; ctx.fillRect(-w / 2, -h / 2 + 10, w, h - 10);
    ctx.fillStyle = '#355a4c'; ctx.beginPath(); ctx.moveTo(-w / 2 - 7, -h / 2 + 12); ctx.lineTo(0, -h / 2 - 23); ctx.lineTo(w / 2 + 7, -h / 2 + 12); ctx.closePath(); ctx.fill();
    ctx.strokeStyle = '#b49c70'; ctx.lineWidth = 3; for (let yy = -25; yy < 49; yy += 10) { ctx.beginPath(); ctx.moveTo(-w / 2 + 3, yy); ctx.lineTo(w / 2 - 3, yy); ctx.stroke(); }
    ctx.fillStyle = occupied ? '#e5b767' : '#3e5750'; ctx.fillRect(-48, -12, 29, 24); ctx.fillRect(21, -12, 29, 24);
    ctx.fillStyle = '#58472f'; ctx.fillRect(-11, 12, 24, 36);
    ctx.strokeStyle = '#adb49c'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(80, 43); ctx.lineTo(80, -74); ctx.moveTo(66, -57); ctx.lineTo(95, -57); ctx.stroke();
    ctx.fillStyle = '#c3ac6b'; ctx.beginPath(); ctx.arc(80, -75, 5, 0, Math.PI * 2); ctx.fill();
  }
  if (occupied && level > 1) {
    ctx.strokeStyle = '#bb9a69'; ctx.lineWidth = 7;
    ctx.beginPath(); ctx.moveTo(-w / 2 - 15, h / 2 + 19); ctx.lineTo(w / 2 + 15, h / 2 + 19); ctx.stroke();
    for (let i = -w / 2; i < w / 2; i += 25) { ctx.beginPath(); ctx.moveTo(i, h / 2 + 10); ctx.lineTo(i, h / 2 + 26); ctx.stroke(); }
  }
  ctx.font = '600 10px system-ui'; ctx.textAlign = 'center';
  ctx.fillStyle = occupied ? '#172b2a' : '#142523cc'; rounded(ctx, -73, -h / 2 - 48, 146, 23, 6); ctx.fill();
  ctx.fillStyle = occupied ? '#f7d584' : '#e0e4c9'; ctx.fillText(`${occupied ? 'HOME · ' : ''}${SHELTERS[type].name.toUpperCase()}`, 0, -h / 2 - 32);
  ctx.restore();
}

function person(ctx: CanvasRenderingContext2D, x: number, y: number, angle: number, palette: string, time: number, moving: boolean, infected = false, brute = false, down = false) {
  ctx.save(); ctx.translate(x, y); const size = brute ? 1.45 : 1; ctx.scale(size, size);
  ctx.fillStyle = '#07181866'; ctx.beginPath(); ctx.ellipse(3, 10, 14, 8, 0, 0, Math.PI * 2); ctx.fill();
  ctx.rotate(angle); if (down) ctx.rotate(.9);
  const step = moving ? Math.sin(time * (infected ? 6 : 12)) * 3 : 0;
  ctx.strokeStyle = infected ? '#535948' : '#273939'; ctx.lineWidth = 5; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(-5, -5); ctx.lineTo(-12 - step, -5); ctx.moveTo(-5, 5); ctx.lineTo(-12 + step, 5); ctx.stroke();
  ctx.strokeStyle = infected ? '#9bab6c' : '#b7966e'; ctx.lineWidth = infected ? 5 : 4;
  ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(12 + (infected ? step : 0), -9); ctx.moveTo(0, 8); ctx.lineTo(12 - (infected ? step : 0), 7); ctx.stroke();
  ctx.fillStyle = palette; rounded(ctx, -7, -9, 16, 18, 5); ctx.fill();
  ctx.strokeStyle = infected ? '#526443' : '#b5baa185'; ctx.lineWidth = 1.5; ctx.stroke();
  if (!infected) { ctx.fillStyle = '#314843'; rounded(ctx, -9, -6, 5, 12, 2); ctx.fill(); }
  ctx.fillStyle = infected ? '#b2c47b' : '#c9a681'; ctx.beginPath(); ctx.ellipse(3, 0, 6, 7, 0, 0, Math.PI * 2); ctx.fill();
  ctx.fillStyle = infected ? '#496148' : '#423f32'; ctx.beginPath(); ctx.arc(0, 0, 5, Math.PI / 2, Math.PI * 1.5); ctx.fill();
  if (infected) {
    ctx.fillStyle = '#d9fa9f'; ctx.fillRect(7, -4, 2, 2); ctx.fillRect(7, 2, 2, 2);
    ctx.strokeStyle = '#6c362c'; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(3, 7); ctx.lineTo(7, 11); ctx.stroke();
  } else {
    ctx.fillStyle = '#233033'; rounded(ctx, 7, -3, 17, 5, 1); ctx.fill();
    ctx.fillStyle = '#8c9690'; ctx.fillRect(21, -2, 5, 3);
  }
  ctx.restore();
}

function healthBar(ctx: CanvasRenderingContext2D, x: number, y: number, hp: number, max: number, color: string, width = 30) {
  ctx.fillStyle = '#162727cc'; rounded(ctx, x - width / 2, y, width, 4, 2); ctx.fill();
  ctx.fillStyle = color; rounded(ctx, x - width / 2, y, width * clamp(hp / max, 0, 1), 4, 2); ctx.fill();
}

export function SurvivalMap({ world, me, selfId, members, send, online }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stateRef = useRef({ world, me, selfId, members, send, online });
  stateRef.current = { world, me, selfId, members, send, online };
  const input = useRef<Controls>({ moveX: 0, moveY: 0, aim: 0, fire: false });
  const keys = useRef(new Set<string>());
  const pointerFire = useRef(false);
  const touchMove = useRef<Point>({ x: 0, y: 0 });
  const camera = useRef({ x: 0, y: 0, scale: .8, width: 800, height: 560 });
  const [moveStick, setMoveStick] = useState<Point>({ x: 0, y: 0 });
  const [fireStick, setFireStick] = useState<Point>({ x: 0, y: 0 });
  const [firing, setFiring] = useState(false);
  const player = world.players.find(p => p.id === selfId);
  const canAct = !!player && !player.downed && !!me && online && world.active && !world.paused;
  const target = nearest(world, selfId);
  const inReach = !!target && target.distance <= 100;
  const ownWeapon = me?.weapons.find(w => w.id === me.equippedWeapon);
  const activeRef = useRef(canAct); activeRef.current = canAct;

  const stop = () => {
    keys.current.clear(); touchMove.current = { x: 0, y: 0 }; pointerFire.current = false;
    input.current = { ...input.current, moveX: 0, moveY: 0, fire: false };
    setMoveStick({ x: 0, y: 0 }); setFireStick({ x: 0, y: 0 }); setFiring(false);
    const s = stateRef.current;
    if (s.online && s.world.active && s.me) s.send({ type: 'survival_input', ...input.current });
  };
  const interact = () => { const s = stateRef.current; const n = nearest(s.world, s.selfId); if (activeRef.current && n && n.distance <= 100) s.send({ type: 'survival_interact', targetId: n.id }); };
  const reload = () => { if (activeRef.current) stateRef.current.send({ type: 'survival_reload' }); };

  useEffect(() => {
    let previous = '';
    const tick = window.setInterval(() => {
      if (!activeRef.current || document.hidden) return;
      const keyX = Number(keys.current.has('d') || keys.current.has('arrowright')) - Number(keys.current.has('a') || keys.current.has('arrowleft'));
      const keyY = Number(keys.current.has('s') || keys.current.has('arrowdown')) - Number(keys.current.has('w') || keys.current.has('arrowup'));
      let x = keyX || touchMove.current.x, y = keyY || touchMove.current.y;
      const magnitude = Math.hypot(x, y); if (magnitude > 1) { x /= magnitude; y /= magnitude; }
      input.current.moveX = x; input.current.moveY = y; input.current.fire = pointerFire.current || keys.current.has(' ');
      const stamp = JSON.stringify(input.current);
      if (stamp !== previous || x || y || input.current.fire) {
        stateRef.current.send({ type: 'survival_input', ...input.current }); previous = stamp;
      }
    }, 100);
    const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input,textarea,select,[contenteditable=true]');
    const down = (event: KeyboardEvent) => {
      if (!activeRef.current || isTyping(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      const key = event.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', ' '].includes(key)) { event.preventDefault(); keys.current.add(key); }
      if (!event.repeat && key === 'e') { event.preventDefault(); interact(); }
      if (!event.repeat && key === 'r') { event.preventDefault(); reload(); }
    };
    const up = (event: KeyboardEvent) => { keys.current.delete(event.key.toLowerCase()); };
    const visibility = () => { if (document.hidden) stop(); };
    window.addEventListener('keydown', down); window.addEventListener('keyup', up); window.addEventListener('blur', stop); document.addEventListener('visibilitychange', visibility);
    return () => {
      window.clearInterval(tick); window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); window.removeEventListener('blur', stop); document.removeEventListener('visibilitychange', visibility); stop();
    };
  }, [world.id]);

  useEffect(() => { if (!canAct) stop(); }, [canAct]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const ground = terrain(stateRef.current.world);
    const positions = new Map<string, Point>();
    const previousPositions = new Map<string, Point>();
    const initial = stateRef.current.world.players.find(p => p.id === stateRef.current.selfId) ?? stateRef.current.world.shelter;
    camera.current.x = initial.x; camera.current.y = initial.y;
    let frame = 0, lastAt = performance.now();
    let reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    const motion = () => { reducedMotion = motionQuery.matches; };
    motionQuery.addEventListener('change', motion);
    const resize = () => {
      const bounds = canvas.getBoundingClientRect(); const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(bounds.width * dpr); canvas.height = Math.round(bounds.height * dpr);
      camera.current.width = bounds.width; camera.current.height = bounds.height; camera.current.scale = bounds.width < 600 ? .74 : .88;
    };
    const observer = new ResizeObserver(resize); observer.observe(canvas); resize();
    const position = (id: string, x: number, y: number, dt: number): Point => {
      const old = positions.get(id) ?? { x, y }; previousPositions.set(id, { ...old });
      const alpha = 1 - Math.exp(-dt / .045); old.x += (x - old.x) * alpha; old.y += (y - old.y) * alpha;
      if (Math.hypot(x - old.x, y - old.y) > 200) { old.x = x; old.y = y; }
      positions.set(id, old); return old;
    };
    const draw = (now: number) => {
      const dt = Math.min((now - lastAt) / 1000, .1); lastAt = now;
      const s = stateRef.current, w = s.world, self = w.players.find(p => p.id === s.selfId);
      const view = camera.current, width = view.width, height = view.height, scale = view.scale;
      if (!width || !height) { frame = requestAnimationFrame(draw); return; }
      const focus = self ?? w.shelter;
      const follow = 1 - Math.exp(-dt / .11); view.x += (focus.x - view.x) * follow; view.y += (focus.y - view.y) * follow;
      view.x = clamp(view.x, width / (2 * scale), w.width - width / (2 * scale)); view.y = clamp(view.y, height / (2 * scale), w.height - height / (2 * scale));
      const dpr = canvas.width / width; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
      ctx.save(); ctx.translate(width / 2, height / 2); ctx.scale(scale, scale); ctx.translate(-view.x, -view.y);
      ctx.drawImage(ground, 0, 0);
      const time = reducedMotion ? 0 : now / 1000;
      for (const site of w.sites) shelter(ctx, site.x, site.y, site.type, site.id === w.shelter.siteId, site.id === w.shelter.siteId ? w.shelter.level : 1, time);
      healthBar(ctx, w.shelter.x, w.shelter.y + 103, w.shelter.hp, w.shelter.maxHp, '#e9cb75', 110);
      // Base facilities read as physical improvements, rather than menu icons.
      w.facilities.forEach((facility, i) => {
        const x = w.shelter.x - 72 + i * 47, y = w.shelter.y + 91;
        ctx.fillStyle = '#243c35'; rounded(ctx, x - 16, y - 11, 32, 22, 3); ctx.fill();
        ctx.strokeStyle = '#b5aa7d'; ctx.lineWidth = 2; ctx.stroke();
        ctx.fillStyle = '#ddcb86'; ctx.font = 'bold 10px system-ui'; ctx.textAlign = 'center'; ctx.fillText(facility.kind === 'rain_collector' ? 'H₂O' : facility.kind.slice(0, 3).toUpperCase(), x, y + 4);
      });
      for (const loot of w.containers) {
        const selected = nearest(w, s.selfId)?.id === loot.id && !!self && distance(self, loot) <= 100;
        ctx.save(); ctx.translate(loot.x, loot.y);
        if (!loot.opened) {
          const pulse = reducedMotion ? 1 : 1 + Math.sin(time * 3 + hash(loot.id) % 10) * .12;
          ctx.strokeStyle = selected ? '#ffdb83' : '#b8b56d66'; ctx.lineWidth = selected ? 2 : 1; ctx.beginPath(); ctx.arc(0, 0, 25 * pulse, 0, Math.PI * 2); ctx.stroke();
          ctx.fillStyle = selected ? '#e2c270' : '#a28b51'; rounded(ctx, -13, -10, 26, 20, 3); ctx.fill();
          ctx.strokeStyle = '#614f32'; ctx.lineWidth = 2; ctx.stroke(); ctx.beginPath(); ctx.moveTo(-8, -9); ctx.lineTo(-8, 10); ctx.moveTo(8, -9); ctx.lineTo(8, 10); ctx.moveTo(-12, 0); ctx.lineTo(12, 0); ctx.stroke();
          ctx.fillStyle = '#f2e1a0'; ctx.fillRect(-3, -3, 6, 6);
        } else {
          ctx.fillStyle = '#6d624288'; ctx.fillRect(-13, -8, 26, 16); ctx.strokeStyle = '#393e2f'; ctx.lineWidth = 2; ctx.strokeRect(-13, -8, 26, 16); ctx.beginPath(); ctx.moveTo(-12, -10); ctx.lineTo(7, -15); ctx.stroke();
        }
        ctx.restore();
      }
      for (const rescue of w.rescues.filter(r => !r.rescued)) {
        const bob = reducedMotion ? 0 : Math.sin(time * 2) * 3;
        person(ctx, rescue.x, rescue.y, -.4, '#bc8a60', time, false);
        ctx.strokeStyle = '#93dfc5'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(rescue.x, rescue.y, 26, 0, Math.PI * 2); ctx.stroke();
        ctx.fillStyle = '#153a32'; rounded(ctx, rescue.x - 14, rescue.y - 49 + bob, 28, 20, 5); ctx.fill();
        ctx.fillStyle = '#aaf0cf'; ctx.font = 'bold 15px system-ui'; ctx.textAlign = 'center'; ctx.fillText('+', rescue.x, rescue.y - 34 + bob);
      }
      for (const ally of w.survivors) {
        const p = position(`ally:${ally.id}`, ally.x, ally.y, dt), old = previousPositions.get(`ally:${ally.id}`)!;
        const moving = distance(old, p) > .3;
        const targetEnemy = w.enemies.find(e => distance(e, p) < 200);
        const angle = targetEnemy ? Math.atan2(targetEnemy.y - p.y, targetEnemy.x - p.x) : Math.atan2(p.y - old.y, p.x - old.x);
        person(ctx, p.x, p.y, angle, ally.role === 'medic' ? '#8bada0' : '#558c87', time, moving);
        healthBar(ctx, p.x, p.y - 23, ally.hp, 100, '#93ddbf');
        ctx.fillStyle = '#cde9d9'; ctx.font = '600 9px system-ui'; ctx.textAlign = 'center'; ctx.fillText(ally.name, p.x, p.y - 31);
      }
      for (const enemy of w.enemies) {
        const p = position(`enemy:${enemy.id}`, enemy.x, enemy.y, dt), old = previousPositions.get(`enemy:${enemy.id}`)!;
        const victim = w.players.filter(v => !v.downed).sort((a, b) => distance(a, enemy) - distance(b, enemy))[0] ?? w.shelter;
        const angle = Math.atan2(victim.y - p.y, victim.x - p.x);
        person(ctx, p.x, p.y, angle, enemy.kind === 'brute' ? '#667648' : '#697345', time + hash(enemy.id) % 20, distance(old, p) > .1, true, enemy.kind === 'brute');
        if (enemy.hp < enemy.maxHp || enemy.kind === 'brute') healthBar(ctx, p.x, p.y - (enemy.kind === 'brute' ? 30 : 22), enemy.hp, enemy.maxHp, '#c7df74');
        if (enemy.horde) { ctx.fillStyle = '#d56653'; ctx.beginPath(); ctx.arc(p.x, p.y - 33, 3, 0, Math.PI * 2); ctx.fill(); }
      }
      for (const p of w.players) {
        const pos = position(`player:${p.id}`, p.x, p.y, dt), old = previousPositions.get(`player:${p.id}`)!;
        const isSelf = p.id === s.selfId;
        const angle = isSelf && activeRef.current ? input.current.aim : p.aim;
        if (isSelf) { ctx.strokeStyle = '#d9cf996e'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(pos.x, pos.y, 23, 0, Math.PI * 2); ctx.stroke(); }
        person(ctx, pos.x, pos.y, angle, isSelf ? '#d1a15d' : '#748fba', time, distance(old, pos) > .3, false, false, p.downed);
        healthBar(ctx, pos.x, pos.y - 25, p.hp, 100, p.hp < 30 ? '#ed8a71' : '#c5dc9b', 34);
        const member = s.members.find(m => m.id === p.id);
        ctx.fillStyle = isSelf ? '#ffe1a1' : '#e3e8e2'; ctx.font = '600 10px system-ui'; ctx.textAlign = 'center'; ctx.fillText(isSelf ? 'YOU' : member?.nickname ?? 'Survivor', pos.x, pos.y + (distance(pos, w.shelter) < 100 && pos.y < w.shelter.y ? 35 : -32));
        const publicShooting = p.firing && !p.downed;
        if (isSelf && activeRef.current) {
          const range = 118, tx = pos.x + Math.cos(angle) * range, ty = pos.y + Math.sin(angle) * range;
          ctx.strokeStyle = '#fbe8b489'; ctx.lineWidth = 1.3;
          ctx.beginPath(); ctx.arc(tx, ty, 7, 0, Math.PI * 2);
          ctx.moveTo(tx - 12, ty); ctx.lineTo(tx - 8, ty); ctx.moveTo(tx + 8, ty); ctx.lineTo(tx + 12, ty);
          ctx.moveTo(tx, ty - 12); ctx.lineTo(tx, ty - 8); ctx.moveTo(tx, ty + 8); ctx.lineTo(tx, ty + 12); ctx.stroke();
        }
        if (publicShooting && !w.paused) {
          const cadence = WEAPONS[p.weapon].cooldownMs; const firingFrame = now % cadence < Math.min(65, cadence / 2);
          if (firingFrame) {
            ctx.save(); ctx.translate(pos.x, pos.y); ctx.rotate(angle);
            ctx.strokeStyle = '#f8d37d90'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(26, 0); ctx.lineTo(Math.min(WEAPONS[p.weapon].range, 280), 0); ctx.stroke();
            ctx.fillStyle = '#ffe29d'; ctx.beginPath(); ctx.moveTo(25, -3); ctx.lineTo(41, -8); ctx.lineTo(35, 0); ctx.lineTo(44, 5); ctx.lineTo(25, 3); ctx.closePath(); ctx.fill(); ctx.restore();
          }
        }
      }
      const n = nearest(w, s.selfId);
      if (n && self && n.distance <= 100) {
        ctx.strokeStyle = '#f9d686a0'; ctx.lineWidth = 1.5; ctx.setLineDash([3, 5]); ctx.beginPath(); ctx.moveTo(self.x, self.y); ctx.lineTo(n.x, n.y); ctx.stroke(); ctx.setLineDash([]);
      }
      // World lighting is driven by the canonical clock; no private values enter it.
      if (w.night) {
        ctx.fillStyle = '#03122287'; ctx.fillRect(view.x - width / scale, view.y - height / scale, width * 2 / scale, height * 2 / scale);
        if (self && !self.downed) {
          const light = ctx.createRadialGradient(self.x, self.y, 0, self.x, self.y, 150);
          light.addColorStop(0, '#ffd89330'); light.addColorStop(1, '#ffd89300'); ctx.fillStyle = light; ctx.beginPath(); ctx.arc(self.x, self.y, 150, 0, Math.PI * 2); ctx.fill();
          const angle = input.current.aim; ctx.save(); ctx.translate(self.x, self.y); ctx.rotate(angle);
          const beam = ctx.createLinearGradient(0, 0, 260, 0); beam.addColorStop(0, '#ffeeb742'); beam.addColorStop(1, '#ffeeb700'); ctx.fillStyle = beam;
          ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 260, -.3, .3); ctx.closePath(); ctx.fill(); ctx.restore();
        }
      }
      ctx.restore();
      const vignette = ctx.createRadialGradient(width / 2, height / 2, width * .12, width / 2, height / 2, Math.max(width, height) * .7);
      vignette.addColorStop(0, '#07181b00'); vignette.addColorStop(1, '#07181b80'); ctx.fillStyle = vignette; ctx.fillRect(0, 0, width, height);
      // Compact minimap shows exploration targets without showing container contents.
      const mapWidth = width < 500 ? 110 : 144, mapHeight = mapWidth * w.height / w.width;
      const mapX = width - mapWidth - 14, mapY = 16;
      ctx.fillStyle = '#0d2428e8'; rounded(ctx, mapX - 5, mapY - 5, mapWidth + 10, mapHeight + 10, 8); ctx.fill();
      ctx.strokeStyle = '#bac6a840'; ctx.lineWidth = 1; ctx.stroke();
      ctx.save(); ctx.beginPath(); ctx.rect(mapX, mapY, mapWidth, mapHeight); ctx.clip();
      ctx.globalAlpha = .65; ctx.drawImage(ground, mapX, mapY, mapWidth, mapHeight); ctx.globalAlpha = 1;
      const mapPoint = (p: Point) => ({ x: mapX + p.x / w.width * mapWidth, y: mapY + p.y / w.height * mapHeight });
      for (const site of w.sites) { const p = mapPoint(site); ctx.fillStyle = site.id === w.shelter.siteId ? '#f4ce75' : site.discovered ? '#bac4a8' : '#a2b39b77'; ctx.fillRect(p.x - 2, p.y - 2, 4, 4); }
      for (const loot of w.containers.filter(c => !c.opened)) { const p = mapPoint(loot); ctx.fillStyle = '#dfba6d'; ctx.fillRect(p.x - 1, p.y - 1, 2, 2); }
      for (const rescue of w.rescues.filter(r => !r.rescued)) { const p = mapPoint(rescue); ctx.fillStyle = '#87e2ba'; ctx.fillRect(p.x - 1.5, p.y - 1.5, 3, 3); }
      for (const e of w.enemies) { const p = mapPoint(e); ctx.fillStyle = '#ea8576'; ctx.fillRect(p.x - 1, p.y - 1, 2, 2); }
      for (const p of w.players) { const mp = mapPoint(p); ctx.fillStyle = p.id === s.selfId ? '#ffffff' : '#95b9e9'; ctx.beginPath(); ctx.arc(mp.x, mp.y, p.id === s.selfId ? 3 : 2, 0, Math.PI * 2); ctx.fill(); }
      ctx.strokeStyle = '#eef3d260'; ctx.strokeRect(mapX + (view.x - width / (2 * scale)) / w.width * mapWidth, mapY + (view.y - height / (2 * scale)) / w.height * mapHeight, width / scale / w.width * mapWidth, height / scale / w.height * mapHeight);
      ctx.restore();
      frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(frame); observer.disconnect(); motionQuery.removeEventListener('change', motion); };
  }, [world.id, world.width, world.height]);

  const aimAt = (clientX: number, clientY: number) => {
    const canvas = canvasRef.current, p = stateRef.current.world.players.find(p => p.id === stateRef.current.selfId);
    if (!canvas || !p) return;
    const rect = canvas.getBoundingClientRect(), view = camera.current;
    const x = view.x + (clientX - rect.left - view.width / 2) / view.scale;
    const y = view.y + (clientY - rect.top - view.height / 2) / view.scale;
    input.current.aim = Math.atan2(y - p.y, x - p.x);
  };
  const padMove = (event: React.PointerEvent<HTMLDivElement>, pad: 'move' | 'fire') => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId) || !activeRef.current) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const x = clamp((event.clientX - bounds.left - bounds.width / 2) / 38, -1, 1);
    const y = clamp((event.clientY - bounds.top - bounds.height / 2) / 38, -1, 1);
    const magnitude = Math.hypot(x, y), factor = magnitude > 1 ? 1 / magnitude : 1;
    if (pad === 'move') { touchMove.current = { x: x * factor, y: y * factor }; setMoveStick({ x: x * factor * 27, y: y * factor * 27 }); }
    else { if (magnitude > .15) input.current.aim = Math.atan2(y, x); pointerFire.current = true; setFiring(true); setFireStick({ x: x * factor * 25, y: y * factor * 25 }); }
  };
  const padRelease = (pad: 'move' | 'fire') => {
    if (pad === 'move') { touchMove.current = { x: 0, y: 0 }; setMoveStick({ x: 0, y: 0 }); }
    else { pointerFire.current = false; setFiring(false); setFireStick({ x: 0, y: 0 }); }
  };
  const disabledReason = !online ? 'Reconnecting · movement stopped' : world.paused ? 'The world is paused' : player?.downed ? 'You are down · recover at your shelter' : !me ? 'Watching the survivors' : !world.active ? 'Expedition ended' : null;
  const homeDistance = player ? Math.round(distance(player, world.shelter)) : 0;
  const homeAngle = player ? Math.atan2(world.shelter.y - player.y, world.shelter.x - player.x) * 180 / Math.PI : 0;

  return <section className="survival-map-shell" data-testid="survival-map" aria-label="Live survival world">
    <div className="survival-map-stage">
      <canvas ref={canvasRef} className="survival-map-canvas" tabIndex={0} role="img" aria-label="Live survival world: explore terrain, collect supply crates, rescue survivors, and aim at infected" aria-describedby="survival-map-controls"
        onPointerDown={event => { if (!canAct || event.button !== 0) return; event.preventDefault(); event.currentTarget.focus(); event.currentTarget.setPointerCapture(event.pointerId); aimAt(event.clientX, event.clientY); pointerFire.current = true; setFiring(true); }}
        onPointerMove={event => { if (canAct) aimAt(event.clientX, event.clientY); }}
        onPointerUp={() => { pointerFire.current = false; setFiring(false); }}
        onPointerCancel={() => { pointerFire.current = false; setFiring(false); }}
        onLostPointerCapture={() => { pointerFire.current = false; setFiring(false); }}
        onContextMenu={event => event.preventDefault()} />
      <div className="survival-map-location"><span className="survival-map-live-dot" /> LIVE FIELD <small>{player ? `${Math.round(player.x)} E · ${Math.round(player.y)} N` : 'Observer camera'}</small></div>
      <div className="survival-map-legend"><i className="loot" /> Supplies <i className="rescue" /> Survivors <i className="infected" /> Infected</div>
      {world.wave.active && <div className="survival-map-horde"><span>HORDE {world.wave.number}</span><strong>{world.enemies.filter(e => e.horde).length + world.wave.remainingSpawns} infected remaining</strong></div>}
      {disabledReason && <div className="survival-map-status" role="status"><span>{disabledReason}</span>{world.paused && <small>Your supplies and progress are safe while paused.</small>}</div>}
      <div className="survival-map-bottom-hud">
        {me && <div className="survival-map-weapon"><span className="survival-map-weapon-icon">⌁</span><div><strong>{WEAPONS[me.equippedWeapon].name} <small>LV {ownWeapon?.level ?? 1}</small></strong><span>{me.reloadRemainingMs > 0 ? 'RELOADING…' : `${ownWeapon?.magazine ?? 0} / ${WEAPONS[me.equippedWeapon].magazine}`} <small>· {me.inventory.ammo} reserve</small></span></div></div>}
        {player && <div className="survival-map-home" title="Direction and distance to your shelter"><span style={{ transform: `rotate(${homeAngle}deg)` }}>➜</span><div><small>HOME</small><strong>{homeDistance < 100 ? 'At shelter' : `${homeDistance} m`}</strong></div></div>}
      </div>
      <div className="survival-map-touch-controls" aria-label="Touch movement and aim controls">
        <div className="survival-map-pad survival-map-move-pad" role="button" tabIndex={0} aria-label="Movement joystick: drag to move" aria-disabled={!canAct}
          onPointerDown={event => { if (!canAct) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); padMove(event, 'move'); }}
          onPointerMove={event => padMove(event, 'move')} onPointerUp={() => padRelease('move')} onPointerCancel={() => padRelease('move')} onLostPointerCapture={() => padRelease('move')}>
          <span className="survival-map-pad-rim" /><span className="survival-map-pad-knob" style={{ transform: `translate(${moveStick.x}px, ${moveStick.y}px)` }}>✥</span><small>MOVE</small>
        </div>
        <div className={`survival-map-pad survival-map-fire-pad${firing ? ' firing' : ''}`} role="button" tabIndex={0} aria-label="Aim and fire: hold and drag toward infected" aria-disabled={!canAct}
          onPointerDown={event => { if (!canAct) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); padMove(event, 'fire'); }}
          onPointerMove={event => padMove(event, 'fire')} onPointerUp={() => padRelease('fire')} onPointerCancel={() => padRelease('fire')} onLostPointerCapture={() => padRelease('fire')}>
          <span className="survival-map-pad-rim" /><span className="survival-map-pad-knob" style={{ transform: `translate(${fireStick.x}px, ${fireStick.y}px)` }}>⌖</span><small>AIM / FIRE</small>
        </div>
      </div>
    </div>
    <div className="survival-map-toolbar">
      <div className="survival-map-nearby">{target ? <><span>{target.kind === 'rescue' ? 'Survivor signal' : 'Supply cache'}</span><strong>{target.label}</strong><small>{inReach ? 'Within reach' : `${Math.round(target.distance)} m away · ${target.kind === 'rescue' ? 'green' : 'gold'} map marker`}</small></> : <><span>FIELD SCAN</span><strong>Search the world</strong><small>Explore for supplies and survivors.</small></>}</div>
      <div className="survival-map-actions"><button type="button" className="survival-map-interact" disabled={!canAct || !inReach} onClick={interact} aria-label={target ? `${target.kind === 'rescue' ? 'Rescue' : 'Collect'} ${target.label}` : 'Interact with nearby object'}><kbd>E</kbd> {target?.kind === 'rescue' ? 'Rescue' : 'Collect'}</button><button type="button" disabled={!canAct || !!me?.reloadRemainingMs} onClick={reload} aria-label="Reload weapon"><kbd>R</kbd> Reload</button></div>
    </div>
    <p id="survival-map-controls" className="survival-map-instructions"><span className="survival-map-desktop-guide"><kbd>W A S D</kbd> / arrows to move · Mouse to aim · Hold click to fire · <kbd>E</kbd> collect / rescue · <kbd>R</kbd> reload</span><span className="survival-map-touch-guide">Drag the left stick to move. Hold and drag the right stick to aim and fire. Collect supplies when you’re close.</span></p>
  </section>;
}
