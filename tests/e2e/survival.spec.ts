import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { RoomView, ServerMessage } from '../../src/shared/protocol';
import type { SurvivalPublicPlayer } from '../../src/shared/survival';

interface Player {
  context: BrowserContext;
  page: Page;
  nickname: string;
  latest: RoomView | null;
  snapshots: RoomView[];
  errors: string[];
}

async function openPlayer(browser: Browser, mobile = false, auditAudio = false): Promise<Player> {
  const context = await browser.newContext({
    viewport: mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 },
    isMobile: mobile,
    hasTouch: mobile,
    reducedMotion: mobile ? 'reduce' : 'no-preference',
  });
  if (auditAudio) await context.addInitScript(() => {
    const audit = { utterances: [] as string[], contexts: [] as AudioContext[], oscillators: 0, talkingPortraits: 0 };
    Object.defineProperty(window, '__survivalAudioAudit', { value: audit });
    // CI Chromium has no installed voices. This speech-only service records
    // public text and speech lifecycle events; Web Audio itself remains real.
    class TestUtterance extends EventTarget {
      text: string; voice: unknown = null; lang = 'en-US'; rate = 1; pitch = 1; volume = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text = '') { super(); this.text = text; }
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const synthesis = {
      speaking: false, pending: false, paused: false,
      getVoices: () => [{ name: 'Survival test English', lang: 'en-US', localService: true, default: true, voiceURI: 'survival-test' }],
      speak(utterance: TestUtterance) {
        audit.utterances.push(utterance.text);
        this.speaking = true;
        utterance.onstart?.(); utterance.dispatchEvent(new Event('start'));
        setTimeout(() => { audit.talkingPortraits += document.querySelectorAll('.character-portrait.character-speaking').length; }, 60);
        timer = setTimeout(() => { this.speaking = false; utterance.onend?.(); utterance.dispatchEvent(new Event('end')); }, 350);
      },
      cancel() { clearTimeout(timer); this.speaking = false; this.pending = false; },
      pause() { this.paused = true; }, resume() { this.paused = false; },
      addEventListener() {}, removeEventListener() {}, onvoiceschanged: null,
    };
    Object.defineProperty(window, 'speechSynthesis', { value: synthesis, configurable: true });
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: TestUtterance, configurable: true });
    const NativeAudioContext = window.AudioContext;
    class AuditedAudioContext extends NativeAudioContext {
      constructor(options?: AudioContextOptions) { super(options); audit.contexts.push(this); }
      createOscillator() { audit.oscillators++; return super.createOscillator(); }
    }
    Object.defineProperty(window, 'AudioContext', { value: AuditedAudioContext, configurable: true });
  });
  const page = await context.newPage();
  const player: Player = { context, page, nickname: `Survivor-${randomUUID().slice(0, 6)}`, latest: null, snapshots: [], errors: [] };
  page.on('pageerror', error => player.errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const payload = JSON.parse(frame.payload.toString()) as ServerMessage;
      if (payload.type === 'snapshot') {
        player.latest = payload.view;
        player.snapshots.push(payload.view);
        // Keep early and recent wire views without retaining an entire long
        // action-game stream in the browser test runner.
        if (player.snapshots.length > 300) player.snapshots.splice(50, 1);
      }
    } catch { /* Ignore frames which are not JSON game messages. */ }
  }));
  await page.goto('/');
  return player;
}

async function createRoom(player: Player): Promise<string> {
  await player.page.getByLabel('Nickname', { exact: true }).fill(player.nickname);
  await player.page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect.poll(() => player.latest?.status).toBe('lobby');
  return player.latest!.code;
}

async function joinRoom(player: Player, code: string): Promise<void> {
  await player.page.getByRole('tab', { name: 'Join a room', exact: true }).click();
  await player.page.getByLabel('Nickname', { exact: true }).fill(player.nickname);
  await player.page.getByLabel('Room code', { exact: true }).fill(code);
  await player.page.getByRole('button', { name: 'Join room', exact: true }).click();
  await expect.poll(() => player.latest?.code).toBe(code);
}

async function start(player: Player): Promise<void> {
  await player.page.getByRole('button', { name: 'Mark ready', exact: true }).click();
  await player.page.getByRole('button', { name: 'Start survival', exact: true }).click();
  await expect.poll(() => player.latest?.survival?.active).toBe(true);
  await expect(player.page.getByTestId('survival-game')).toBeVisible();
  await expect(player.page.getByTestId('survival-map')).toBeVisible();
}

function self(player: Player): SurvivalPublicPlayer {
  return player.latest!.survival!.players.find(member => member.id === player.latest!.selfId)!;
}

async function moveTo(player: Player, destination: { x: number; y: number }, reach = 70): Promise<void> {
  const held = new Set<string>();
  const setKeys = async (wanted: string[]) => {
    for (const key of [...held]) if (!wanted.includes(key)) { await player.page.keyboard.up(key); held.delete(key); }
    for (const key of wanted) if (!held.has(key)) { await player.page.keyboard.down(key); held.add(key); }
  };
  // Only normal keyboard intentions enter the game. Positions are read from
  // the same server projection delivered to every player; there is no test
  // teleport, injected world object, or alternate combat implementation.
  await player.page.getByTestId('survival-map').locator('canvas').focus();
  try {
    await expect.poll(async () => {
      const current = self(player);
      const distance = Math.hypot(destination.x - current.x, destination.y - current.y);
      const keys = distance <= reach ? [] : [
        ...(Math.abs(destination.x - current.x) > Math.min(15, reach / 3) ? [destination.x > current.x ? 'd' : 'a'] : []),
        ...(Math.abs(destination.y - current.y) > Math.min(15, reach / 3) ? [destination.y > current.y ? 's' : 'w'] : []),
      ];
      await setKeys(keys);
      return distance;
    }, { timeout: 15_000, intervals: [100] }).toBeLessThanOrEqual(reach);
  } finally { await setKeys([]); }
}

async function pause(player: Player, paused: boolean): Promise<void> {
  await player.page.getByRole('button', { name: paused ? 'Pause expedition' : 'Resume expedition', exact: true }).click();
  await expect.poll(() => player.latest?.survival?.paused).toBe(paused);
}

async function noOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
}

function assertWirePrivacy(player: Player): void {
  const publicPlayerKeys = ['aim', 'downed', 'firing', 'hp', 'id', 'weapon', 'weaponLevel', 'x', 'y'].sort();
  const containerKeys = ['id', 'label', 'opened', 'x', 'y'].sort();
  const privateKeys = ['equippedWeapon', 'gear', 'hp', 'hunger', 'inventory', 'reloadRemainingMs', 'respawnRemainingMs', 'stamina', 'stats', 'thirst', 'weapons'].sort();
  for (const view of player.snapshots) {
    if (!view.survival) continue;
    expect(view.game).toBeNull();
    expect(view.me).toBeNull();
    for (const member of view.survival.players) expect(Object.keys(member).sort()).toEqual(publicPlayerKeys);
    for (const container of view.survival.containers) expect(Object.keys(container).sort()).toEqual(containerKeys);
    if (view.survivorMe) expect(Object.keys(view.survivorMe).sort()).toEqual([
      ...privateKeys,
      ...(view.survivorMe.electionVotes ? ['electionVotes'] : []),
    ].sort());
    for (const election of view.survival.community?.elections ?? []) {
      expect(Object.keys(election).sort()).toEqual(['ballotsCast', 'candidates', 'eligibleIds', 'endsAt', 'id', 'position'].sort());
      expect(election).not.toHaveProperty('votes');
    }
    expect(view.survival).not.toHaveProperty('lastTickAt');
    expect(view.survival).not.toHaveProperty('tickNumber');
  }
}

async function audioAudit(page: Page): Promise<{ utterances: string[]; contextStates: string[]; oscillators: number; talkingPortraits: number }> {
  return page.evaluate(() => {
    const audit = (window as unknown as { __survivalAudioAudit: { utterances: string[]; contexts: AudioContext[]; oscillators: number; talkingPortraits: number } }).__survivalAudioAudit;
    return { utterances: [...audit.utterances], contextStates: audit.contexts.map(context => context.state), oscillators: audit.oscillators, talkingPortraits: audit.talkingPortraits };
  });
}

test('solo survival offers five shelters, real movement, scavenging, timed crafting and weapon improvement', async ({ browser }, testInfo) => {
  const player = await openPlayer(browser);
  try {
    await createRoom(player);
    for (const name of ['Farmhouse', 'Bunker', 'Warehouse', 'Apartment', 'Ranger Station']) {
      await expect(player.page.getByRole('radio', { name, exact: true })).toBeVisible();
    }
    await player.page.getByRole('radio', { name: 'Farmhouse', exact: true }).click();
    await start(player);
    expect(player.latest!.survival!.shelter.type).toBe('farmhouse');
    expect(player.latest!.survival!.dayLengthMs).toBe(60 * 60_000);
    expect(player.latest!.survival!.players).toHaveLength(1);
    await expect(player.page.getByTestId('day-counter')).toContainText('DAY 1');

    // Aim at actual public infected, defeat them using real pointer input,
    // and reload through the same controls players use.
    const canvas = player.page.getByTestId('survival-map').locator('canvas');
    await canvas.scrollIntoViewIfNeeded();
    const canvasBounds = await canvas.boundingBox();
    if (!canvasBounds) throw new Error('The survival world must have a visible canvas.');
    const beforeFire = player.latest!.survivorMe!.weapons.find(weapon => weapon.id === 'pistol')!.magazine;
    const scale = canvasBounds.width < 600 ? .74 : .88;
    const aim = async () => {
      const current = self(player);
      const infected = [...player.latest!.survival!.enemies].sort((a, b) => Math.hypot(a.x - current.x, a.y - current.y) - Math.hypot(b.x - current.x, b.y - current.y))[0];
      if (!infected) return;
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error('The survival canvas disappeared during combat.');
      await player.page.mouse.move(
        bounds.x + bounds.width / 2 + (infected.x - current.x) * scale,
        bounds.y + bounds.height / 2 + (infected.y - current.y) * scale,
      );
    };
    await aim();
    await player.page.mouse.down();
    try {
      await expect.poll(() => player.latest!.survivorMe!.weapons.find(weapon => weapon.id === 'pistol')!.magazine).toBeLessThan(beforeFire);
      await expect.poll(async () => {
        if (player.latest!.survivorMe!.weapons.find(weapon => weapon.id === 'pistol')!.magazine === 0
          && player.latest!.survivorMe!.reloadRemainingMs === 0) await player.page.keyboard.press('r');
        await aim();
        return player.latest!.survivorMe!.stats.kills;
      }, { timeout: 18_000, intervals: [100] }).toBeGreaterThanOrEqual(4);
    } finally { await player.page.mouse.up(); }
    const spent = beforeFire - player.latest!.survivorMe!.weapons.find(weapon => weapon.id === 'pistol')!.magazine;
    const reserveBeforeReload = player.latest!.survivorMe!.inventory.ammo;
    await player.page.getByRole('button', { name: 'Reload weapon', exact: true }).click();
    await expect.poll(() => player.latest!.survivorMe!.weapons.find(weapon => weapon.id === 'pistol')!.magazine).toBe(12);
    expect(player.latest!.survivorMe!.inventory.ammo).toBe(reserveBeforeReload - spent);

    const origin = { ...self(player) };
    const crate = player.latest!.survival!.containers.find(container => container.id === 'loot-1')!;
    const beforeLoot = { ...player.latest!.survivorMe!.inventory };
    await moveTo(player, crate, 80);
    expect(Math.hypot(self(player).x - origin.x, self(player).y - origin.y)).toBeGreaterThan(20);
    expect(self(player).x).toBeGreaterThanOrEqual(22);
    expect(self(player).x).toBeLessThanOrEqual(player.latest!.survival!.width - 22);
    await player.page.keyboard.press('e');
    await expect.poll(() => player.latest!.survival!.containers.find(container => container.id === crate.id)?.opened).toBe(true);
    await expect.poll(() => player.latest!.survivorMe!.inventory.ammo).toBe(beforeLoot.ammo + 24);
    expect(player.latest!.survivorMe!.inventory.metal).toBe(beforeLoot.metal + 5);
    expect(player.latest!.survivorMe!.stats.loot).toBe(1);

    await player.page.getByRole('navigation', { name: 'Survival tools' }).getByRole('button', { name: 'Craft', exact: true }).click();
    const beforeCraft = { ...player.latest!.survivorMe!.inventory };
    await player.page.getByRole('button', { name: 'Craft Ammunition', exact: true }).click();
    await expect.poll(() => player.latest!.survival!.jobs.some(job => job.ownerId === player.latest!.selfId && job.targetId === 'ammo')).toBe(true);
    expect(player.latest!.survivorMe!.inventory.metal).toBe(beforeCraft.metal - 2);
    expect(player.latest!.survivorMe!.inventory.cloth).toBe(beforeCraft.cloth - 1);
    expect(player.latest!.survivorMe!.inventory.ammo).toBe(beforeCraft.ammo);
    await expect.poll(() => player.latest!.survivorMe!.inventory.ammo, { timeout: 9_000 }).toBe(beforeCraft.ammo + 12);

    // Boots consume materials as a real useful project and make room in the
    // pack for the electronics needed by the level-two weapon improvement.
    await player.page.getByRole('button', { name: 'Craft Boots', exact: true }).click();
    const electronicsCrate = player.latest!.survival!.containers.find(container => !container.opened && /^loot-/.test(container.id) && (Number(container.id.slice(5)) - 1) % 3 === 1)!;
    await moveTo(player, electronicsCrate, 80);
    await player.page.keyboard.press('e');
    await expect.poll(() => player.latest!.survivorMe!.inventory.electronics).toBeGreaterThanOrEqual(2);
    await moveTo(player, player.latest!.survival!.shelter, 65);

    await player.page.getByRole('navigation', { name: 'Survival tools' }).getByRole('button', { name: 'Inventory', exact: true }).click();
    const beforeUpgrade = { ...player.latest!.survivorMe!.inventory };
    await player.page.getByRole('button', { name: 'Upgrade Pistol', exact: true }).click();
    await expect.poll(() => player.latest!.survival!.jobs.some(job => job.ownerId === player.latest!.selfId && job.kind === 'weapon')).toBe(true);
    expect(player.latest!.survivorMe!.inventory.metal).toBe(beforeUpgrade.metal - 8);
    expect(player.latest!.survivorMe!.inventory.electronics).toBe(beforeUpgrade.electronics - 2);
    expect(player.latest!.survivorMe!.weapons.find(weapon => weapon.id === 'pistol')!.level).toBe(1);
    await canvas.scrollIntoViewIfNeeded();
    const defenseBounds = await canvas.boundingBox();
    if (!defenseBounds) throw new Error('The world must remain available while upgrades finish.');
    await player.page.mouse.move(defenseBounds.x + defenseBounds.width / 2 + 120, defenseBounds.y + defenseBounds.height / 2);
    await player.page.mouse.down();
    try {
      await expect.poll(async () => {
        await aim();
        return player.latest!.survivorMe!.weapons.find(weapon => weapon.id === 'pistol')?.level;
      }, { timeout: 35_000, intervals: [100] }).toBe(2);
    } finally { await player.page.mouse.up(); }
    expect(player.latest!.survivorMe!.gear.some(gear => gear.id === 'boots')).toBe(true);
    expect(player.latest!.survivorMe!.stats.upgrades).toBeGreaterThanOrEqual(1);
    expect(player.latest!.survival!.events.some(event => event.kind === 'loot')).toBe(true);
    await player.page.getByTestId('survival-game').screenshot({ path: testInfo.outputPath('survival-desktop.png') });
    assertWirePrivacy(player);
    expect(player.errors).toEqual([]);
  } finally { await player.context.close(); }
});

test('independent players inherit CPU seats, keep private packs, and refresh into the same paused world', async ({ browser }) => {
  const host = await openPlayer(browser);
  const friend = await openPlayer(browser);
  const players = [host, friend];
  try {
    const code = await createRoom(host);
    await host.page.getByRole('button', { name: 'Add CPU player', exact: true }).click();
    await expect.poll(() => host.latest!.members.some(member => member.controller === 'cpu')).toBe(true);
    await start(host);
    await pause(host, true);
    const cpu = host.latest!.members.find(member => member.controller === 'cpu')!;
    const cpuPosition = host.latest!.survival!.players.find(player => player.id === cpu.id)!;
    await joinRoom(friend, code);
    await expect.poll(() => friend.latest?.selfId).toBe(cpu.id);
    expect(friend.latest!.survivorMe).not.toBeNull();
    expect(self(friend).x).toBe(cpuPosition.x);
    expect(self(friend).y).toBe(cpuPosition.y);
    await expect.poll(() => host.latest!.members.find(member => member.id === cpu.id)?.controller).toBe('human');
    await expect.poll(() => friend.latest!.survival).toEqual(host.latest!.survival);

    const friendInventory = { ...friend.latest!.survivorMe!.inventory };
    const hostInventory = { ...host.latest!.survivorMe!.inventory };
    const savedWorldId = friend.latest!.survival!.id;
    const friendIdentity = friend.latest!.selfId;
    const savedElapsed = friend.latest!.survival!.elapsedMs;
    await friend.page.reload();
    await expect.poll(() => friend.latest?.selfId).toBe(friendIdentity);
    await expect(friend.page.getByTestId('survival-game')).toBeVisible();
    expect(friend.latest!.survival!.id).toBe(savedWorldId);
    expect(friend.latest!.survivorMe!.inventory).toEqual(friendInventory);
    expect(friend.latest!.survival!.elapsedMs).toBe(savedElapsed);

    // A held key must not advance either positions or the clock while paused.
    const frozen = { ...self(host) };
    await host.page.keyboard.down('d');
    const heldAt = Date.now();
    try {
      await expect.poll(() => Date.now() - heldAt, { intervals: [100] }).toBeGreaterThanOrEqual(500);
    } finally { await host.page.keyboard.up('d'); }
    expect(self(host).x).toBe(frozen.x);
    expect(self(host).y).toBe(frozen.y);
    expect(host.latest!.survival!.elapsedMs).toBe(savedElapsed);
    await pause(host, false);
    await host.page.getByRole('navigation', { name: 'Survival tools' }).getByRole('button', { name: 'Craft', exact: true }).click();
    await host.page.getByRole('button', { name: 'Craft Ammunition', exact: true }).click();
    await expect.poll(() => host.latest!.survivorMe!.inventory.metal).toBe(hostInventory.metal - 2);
    expect(friend.latest!.survivorMe!.inventory).toEqual(friendInventory);
    await pause(host, true);
    await expect.poll(() => friend.latest!.survival).toEqual(host.latest!.survival);
    expect(host.latest!.survivorMe!.inventory).not.toEqual(friend.latest!.survivorMe!.inventory);
    for (const player of players) { assertWirePrivacy(player); expect(player.errors).toEqual([]); }
  } finally { await Promise.all(players.map(player => player.context.close())); }
});

test('a phone survivor has usable movement controls and calendar goals without horizontal overflow', async ({ browser }, testInfo) => {
  const player = await openPlayer(browser, true);
  try {
    await noOverflow(player.page);
    await createRoom(player);
    await player.page.getByRole('radio', { name: 'Bunker', exact: true }).click();
    await start(player);
    await noOverflow(player.page);
    expect(player.latest!.survival!.shelter.type).toBe('bunker');
    expect(await player.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    const move = player.page.getByRole('button', { name: 'Movement joystick: drag to move', exact: true });
    await expect(move).toBeVisible();
    await move.scrollIntoViewIfNeeded();
    const position = await move.boundingBox();
    if (!position) throw new Error('The phone direction control must have an on-screen hit area.');
    const startingX = self(player).x;
    await player.page.mouse.move(position.x + position.width / 2, position.y + position.height / 2);
    await player.page.mouse.down();
    await player.page.mouse.move(position.x + position.width - 4, position.y + position.height / 2);
    try { await expect.poll(() => self(player).x).toBeGreaterThan(startingX + 15); }
    finally { await player.page.mouse.up(); }
    await player.page.getByRole('navigation', { name: 'Survival tools' }).getByRole('button', { name: 'Goals', exact: true }).click();
    for (const period of ['daily', 'weekly', 'monthly']) await expect(player.page.getByRole('heading', { name: new RegExp(`^${period} goals`) })).toBeVisible();
    await noOverflow(player.page);
    await player.page.getByRole('navigation', { name: 'Survival tools' }).getByRole('button', { name: 'Shelter', exact: true }).click();
    await noOverflow(player.page);
    await player.page.getByTestId('survival-game').screenshot({ path: testInfo.outputPath('survival-mobile.png') });
    assertWirePrivacy(player);
    expect(player.errors).toEqual([]);
  } finally { await player.context.close(); }
});

test('a recruited survivor speaks public dialogue with gesture-enabled audio while personal supplies stay silent', async ({ browser }) => {
  const player = await openPlayer(browser, false, true);
  try {
    await createRoom(player);
    expect((await audioAudit(player.page)).contextStates).toEqual([]);
    expect((await audioAudit(player.page)).utterances).toEqual([]);
    await player.page.getByRole('button', { name: 'Enable sound', exact: true }).click();
    await expect.poll(async () => (await audioAudit(player.page)).contextStates).toContain('running');
    await expect.poll(async () => (await audioAudit(player.page)).oscillators).toBeGreaterThan(0);
    await start(player);
    await expect.poll(async () => (await audioAudit(player.page)).utterances.some(line => line.includes('Day 1'))).toBe(true);

    const survivor = player.latest!.survival!.rescues.find(rescue => rescue.name === 'Mara')!;
    const beforeRecruit = { ...player.latest!.survivorMe!.inventory };
    await moveTo(player, survivor, 20);
    await player.page.getByRole('button', { name: 'Rescue Mara', exact: true }).click();
    await expect.poll(() => player.latest!.survival!.survivors.some(recruit => recruit.id === survivor.id)).toBe(true);
    expect(player.latest!.survivorMe!.inventory.food).toBe(beforeRecruit.food - 2);
    expect(player.latest!.survivorMe!.inventory.medicine).toBe(beforeRecruit.medicine - 1);
    await player.page.getByRole('navigation', { name: 'Survival tools' }).getByRole('button', { name: 'Crew', exact: true }).click();
    const spokenGreeting = player.latest!.survival!.events.find(event => event.kind === 'survivor_dialogue' && event.speakerId === survivor.id)!.text;
    await expect.poll(async () => (await audioAudit(player.page)).utterances).toContain(spokenGreeting);
    await expect.poll(async () => (await audioAudit(player.page)).talkingPortraits).toBeGreaterThan(0);
    await pause(player, true);
    const beforeInventory = (await audioAudit(player.page)).utterances;
    await player.page.getByRole('navigation', { name: 'Survival tools' }).getByRole('button', { name: 'Inventory', exact: true }).click();
    expect((await audioAudit(player.page)).utterances).toEqual(beforeInventory);

    await player.page.getByRole('button', { name: 'Voices on', exact: true }).click();
    const volume = player.page.getByRole('slider', { name: 'Sound volume', exact: true });
    await volume.focus(); await volume.press('Home');
    for (let step = 0; step < 5; step++) await volume.press('ArrowRight');
    await expect(volume).toHaveValue('25');
    await player.page.getByRole('button', { name: 'Mute sound', exact: true }).click();
    const savedId = player.latest!.selfId;
    await player.page.reload();
    await expect(player.page.getByTestId('survival-game')).toBeVisible();
    expect(player.latest!.selfId).toBe(savedId);
    expect((await audioAudit(player.page)).utterances).toEqual([]);
    await player.page.getByRole('button', { name: 'Enable sound', exact: true }).click();
    await expect(player.page.getByRole('button', { name: 'Voices off', exact: true })).toBeVisible();
    await expect(player.page.getByRole('slider', { name: 'Sound volume', exact: true })).toHaveValue('25');
    expect((await audioAudit(player.page)).utterances).toEqual([]);
    assertWirePrivacy(player);
    expect(player.errors).toEqual([]);
  } finally { await player.context.close(); }
});

test('the shared shelter elects officers with private ballots and conserves communal supplies', async ({ browser }) => {
  const host = await openPlayer(browser);
  const friend = await openPlayer(browser);
  const players = [host, friend];
  try {
    const code = await createRoom(host);
    await joinRoom(friend, code);
    await friend.page.getByRole('button', { name: 'Mark ready', exact: true }).click();
    await start(host);
    await expect(friend.page.getByTestId('survival-game')).toBeVisible();
    const hostId = host.latest!.selfId;
    const friendId = friend.latest!.selfId;
    await expect.poll(() => host.latest!.survival!.community?.duties.filter(duty => duty.position === 'crew').map(duty => duty.memberId).sort()).toEqual([hostId, friendId].sort());

    for (const player of players) {
      await player.page.getByRole('navigation', { name: 'Survival tools' }).getByRole('button', { name: 'Duties', exact: true }).click();
    }
    await host.page.getByRole('button', { name: 'Elect Captain', exact: true }).click();
    await expect.poll(() => host.latest!.survival!.community?.elections.length).toBe(1);
    const electionId = host.latest!.survival!.community!.elections[0]!.id;
    await host.page.getByLabel('Role candidate captain', { exact: true }).selectOption(hostId);
    await host.page.getByRole('button', { name: 'Vote for Captain', exact: true }).click();
    await expect.poll(() => host.latest!.survivorMe!.electionVotes?.[electionId]).toBe(hostId);
    await expect.poll(() => friend.latest!.survival!.community!.elections[0]?.ballotsCast).toBe(1);
    expect(friend.latest!.survivorMe!.electionVotes).toEqual({});
    await expect(friend.page.getByRole('button', { name: 'Vote for Captain', exact: true })).toBeEnabled();
    await pause(host, true);
    await expect.poll(() => friend.latest!.survival).toEqual(host.latest!.survival);

    // A refresh restores the voter's own lock without disclosing it to the
    // other participant, and pausing preserves the authoritative deadline.
    await host.page.reload();
    await expect(host.page.getByTestId('survival-game')).toBeVisible();
    expect(host.latest!.selfId).toBe(hostId);
    expect(host.latest!.survivorMe!.electionVotes?.[electionId]).toBe(hostId);
    await host.page.getByRole('navigation', { name: 'Survival tools' }).getByRole('button', { name: 'Duties', exact: true }).click();
    await expect(host.page.getByTestId('shelter-role-captain').getByRole('status')).toContainText(`Your vote: ${host.nickname}`);
    await pause(host, false);
    await friend.page.getByLabel('Role candidate captain', { exact: true }).selectOption(hostId);
    await friend.page.getByRole('button', { name: 'Vote for Captain', exact: true }).click();
    for (const player of players) {
      await expect.poll(() => player.latest!.survival!.community!.officers.captain).toBe(hostId);
      await expect(player.page.getByTestId('shelter-role-captain')).toContainText(host.nickname);
      expect(player.latest!.survival!.community!.duties.some(duty => duty.memberId === hostId && duty.position === 'captain')).toBe(true);
    }

    const beforeHost = host.latest!.survivorMe!.inventory.wood;
    const beforeFriend = friend.latest!.survivorMe!.inventory.wood;
    await host.page.getByLabel('Stash item', { exact: true }).selectOption('wood');
    await host.page.getByLabel('Stash amount', { exact: true }).fill('2');
    await host.page.getByRole('button', { name: 'Deposit supplies', exact: true }).click();
    await expect.poll(() => host.latest!.survival!.community!.supplies.wood).toBe(2);
    expect(host.latest!.survivorMe!.inventory.wood).toBe(beforeHost - 2);
    expect(friend.latest!.survivorMe!.inventory.wood).toBe(beforeFriend);
    await friend.page.getByLabel('Stash item', { exact: true }).selectOption('wood');
    await friend.page.getByLabel('Stash amount', { exact: true }).fill('1');
    await friend.page.getByRole('button', { name: 'Withdraw supplies', exact: true }).click();
    await expect.poll(() => friend.latest!.survivorMe!.inventory.wood).toBe(beforeFriend + 1);
    await expect.poll(() => host.latest!.survival!.community!.supplies.wood).toBe(1);
    expect(host.latest!.survivorMe!.inventory.wood + friend.latest!.survivorMe!.inventory.wood + host.latest!.survival!.community!.supplies.wood).toBe(beforeHost + beforeFriend);
    await pause(host, true);
    await expect.poll(() => friend.latest!.survival).toEqual(host.latest!.survival);
    for (const player of players) { assertWirePrivacy(player); expect(player.errors).toEqual([]); }
  } finally { await Promise.all(players.map(player => player.context.close())); }
});

test('one human and three CPU companions prepare in real time, defeat a horde, and repair their shared shelter', async ({ browser }, testInfo) => {
  test.setTimeout(180_000);
  const player = await openPlayer(browser);
  let firing = false;
  try {
    await createRoom(player);
    for (let count = 0; count < 3; count++) {
      await player.page.getByRole('button', { name: 'Add CPU player', exact: true }).click();
      await expect.poll(() => player.latest!.members.filter(member => member.controller === 'cpu').length).toBe(count + 1);
    }
    await start(player);
    expect(player.latest!.survival!.players).toHaveLength(4);
    const startedAt = Date.now();
    const canvas = player.page.getByTestId('survival-map').locator('canvas');
    await canvas.scrollIntoViewIfNeeded();
    const defend = async () => {
      const world = player.latest!.survival!;
      const current = self(player);
      const owned = player.latest!.survivorMe!.weapons.find(weapon => weapon.id === 'pistol')!;
      if (owned.magazine === 0 && player.latest!.survivorMe!.reloadRemainingMs === 0) await player.page.keyboard.press('r');
      const enemy = world.enemies
        .filter(enemy => Math.hypot(enemy.x - current.x, enemy.y - current.y) < 340)
        .sort((a, b) => Number(b.horde) - Number(a.horde)
          || Math.hypot(a.x - current.x, a.y - current.y) - Math.hypot(b.x - current.x, b.y - current.y))[0];
      if (!enemy) {
        if (firing) { await player.page.mouse.up(); firing = false; }
        return;
      }
      const bounds = await canvas.boundingBox();
      if (!bounds) throw new Error('The defense canvas must stay visible through the horde.');
      const scale = bounds.width < 600 ? .74 : .88;
      await player.page.mouse.move(bounds.x + bounds.width / 2 + (enemy.x - current.x) * scale,
        bounds.y + bounds.height / 2 + (enemy.y - current.y) * scale);
      if (!firing) { await player.page.mouse.down(); firing = true; }
    };

    // The server's actual 90-second preparation period passes while the
    // human defends against real roaming infected. No fake timers, injected
    // commands, accelerated clock, or altered save file starts the wave.
    await expect.poll(async () => { await defend(); return player.latest!.survival!.wave.active; }, {
      timeout: 110_000, intervals: [150],
    }).toBe(true);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(89_000);
    expect(player.latest!.survival!.elapsedMs).toBeGreaterThanOrEqual(90_000);
    expect(player.latest!.survival!.wave.number).toBe(1);
    expect(player.latest!.survival!.hour).toBeGreaterThan(8);
    await expect(player.page.getByText('HORDE WAVE 1', { exact: true })).toBeVisible();

    await expect.poll(async () => { await defend(); return player.latest!.survival!.wave.completed; }, {
      timeout: 45_000, intervals: [150],
    }).toBe(1);
    if (firing) { await player.page.mouse.up(); firing = false; }
    expect(player.latest!.survival!.wave.active).toBe(false);
    expect(player.latest!.survival!.enemies.some(enemy => enemy.horde)).toBe(false);
    expect(player.latest!.survival!.wave.remainingSpawns).toBe(0);
    expect(player.latest!.survival!.active).toBe(true);
    expect(player.latest!.survival!.shelter.hp).toBeGreaterThan(0);
    expect(player.latest!.survivorMe!.stats.kills).toBeGreaterThan(0);
    expect(player.latest!.survivorMe!.stats.waves).toBe(1);
    expect(player.latest!.survival!.events.some(event => event.kind === 'horde-complete')).toBe(true);

    if (player.latest!.survival!.shelter.hp < player.latest!.survival!.shelter.maxHp) {
      await player.page.getByRole('navigation', { name: 'Survival tools' }).getByRole('button', { name: 'Craft', exact: true }).click();
      const inventory = { ...player.latest!.survivorMe!.inventory };
      const hp = player.latest!.survival!.shelter.hp;
      await player.page.getByRole('button', { name: 'Craft Repair shelter', exact: true }).click();
      await expect.poll(() => player.latest!.survival!.jobs.some(job => job.ownerId === player.latest!.selfId && job.targetId === 'repair')).toBe(true);
      expect(player.latest!.survivorMe!.inventory.wood).toBe(inventory.wood - 4);
      expect(player.latest!.survivorMe!.inventory.metal).toBe(inventory.metal - 2);
      const repair = player.latest!.survival!.jobs.find(job => job.ownerId === player.latest!.selfId && job.targetId === 'repair')!;
      expect(repair.finishAt - player.latest!.survival!.elapsedMs).toBeGreaterThan(11_000);
      await canvas.scrollIntoViewIfNeeded();
      await expect.poll(async () => { await defend(); return player.latest!.survival!.jobs.some(job => job.id === repair.id); }, {
        timeout: 16_000, intervals: [150],
      }).toBe(false);
      if (firing) { await player.page.mouse.up(); firing = false; }
      expect(player.latest!.survival!.shelter.hp).toBeGreaterThan(hp);
    }
    await pause(player, true);
    await player.page.getByTestId('survival-game').screenshot({ path: testInfo.outputPath('survival-horde-defeated.png') });
    assertWirePrivacy(player);
    expect(player.errors).toEqual([]);
  } finally {
    if (firing) await player.page.mouse.up();
    await player.context.close();
  }
});
