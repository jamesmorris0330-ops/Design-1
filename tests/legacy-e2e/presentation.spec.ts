import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import type { PhaseType, RoomView, ServerMessage } from '../../src/shared/protocol';

interface Player {
  context: BrowserContext;
  page: Page;
  latest: RoomView | null;
  errors: string[];
}

async function openPlayer(browser: Browser, mobile = false, instrumentAudio = false): Promise<Player> {
  const context = await browser.newContext({
    viewport: mobile ? { width: 375, height: 812 } : { width: 1440, height: 1000 },
    isMobile: mobile, hasTouch: mobile,
    reducedMotion: mobile ? 'reduce' : 'no-preference',
  });
  if (instrumentAudio) await context.addInitScript(() => {
    const audit = {
      utterances: [] as string[], contexts: [] as AudioContext[], oscillators: 0, cancellations: 0, talkingPortraits: 0,
    };
    Object.defineProperty(window, '__experimentAudioAudit', { value: audit });
    // Chromium in CI has no installed speech voices. A deterministic voice
    // service lets this test inspect exactly what the app asks it to say.
    // Web Audio remains the browser's real implementation below.
    class TestUtterance extends EventTarget {
      text: string; voice: unknown = null; lang = 'en-US'; rate = 1; pitch = 1; volume = 1;
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(text = '') { super(); this.text = text; }
    }
    let currentTimer: ReturnType<typeof setTimeout> | undefined;
    const synthesis = {
      speaking: false, pending: false, paused: false,
      getVoices: () => [
        { name: 'Test English One', lang: 'en-US', localService: true, default: true, voiceURI: 'test-1' },
        { name: 'Test English Two', lang: 'en-GB', localService: true, default: false, voiceURI: 'test-2' },
      ],
      speak(utterance: TestUtterance) {
        audit.utterances.push(utterance.text);
        this.speaking = true;
        utterance.onstart?.();
        utterance.dispatchEvent(new Event('start'));
        setTimeout(() => { audit.talkingPortraits += document.querySelectorAll('.chamber-subject.subject-speaking .character-portrait.character-speaking').length; }, 35);
        currentTimer = setTimeout(() => {
          this.speaking = false;
          utterance.onend?.();
          utterance.dispatchEvent(new Event('end'));
        }, 180);
      },
      cancel() { clearTimeout(currentTimer); this.speaking = false; this.pending = false; audit.cancellations++; },
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
  const player: Player = { context, page, latest: null, errors: [] };
  page.on('pageerror', error => player.errors.push(error.message));
  page.on('websocket', socket => socket.on('framereceived', frame => {
    try {
      const payload = JSON.parse(frame.payload.toString()) as ServerMessage;
      if (payload.type === 'snapshot') player.latest = payload.view;
    } catch { /* Ignore non-JSON transport frames. */ }
  }));
  await page.goto('/');
  return player;
}

async function createRoom(player: Player): Promise<void> {
  await player.page.getByLabel('Nickname', { exact: true }).fill(`Scene-${randomUUID().slice(0, 5)}`);
  await player.page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect.poll(() => player.latest?.status).toBe('lobby');
}

async function startSolo(player: Player): Promise<void> {
  await player.page.getByRole('button', { name: 'Mark ready', exact: true }).click();
  await player.page.getByRole('button', { name: 'Start with CPU players', exact: true }).click();
  await expect.poll(() => player.latest?.game?.phase.type).toBe('crisis');
}

async function hostControl(player: Player, name: string): Promise<void> {
  const summary = player.page.locator('summary').filter({ hasText: /^Host controls/ });
  if (!await summary.evaluate(element => element.parentElement!.hasAttribute('open'))) await summary.click();
  await player.page.getByRole('button', { name, exact: true }).click();
}

async function advance(player: Player, next: PhaseType): Promise<void> {
  await hostControl(player, 'Advance phase');
  await expect.poll(() => player.latest?.game?.phase.type).toBe(next);
}

async function noOverflow(page: Page): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false);
}

async function audioAudit(page: Page): Promise<{ utterances: string[]; contextStates: string[]; oscillators: number; talkingPortraits: number }> {
  return page.evaluate(() => {
    const audit = (window as unknown as { __experimentAudioAudit: { utterances: string[]; contexts: AudioContext[]; oscillators: number; talkingPortraits: number } }).__experimentAudioAudit;
    return { utterances: [...audit.utterances], contextStates: audit.contexts.map(context => context.state), oscillators: audit.oscillators, talkingPortraits: audit.talkingPortraits };
  });
}

test('a phone player talks to a CPU and distributes graphical power cells through a synchronized Trial', async ({ browser }, testInfo) => {
  const player = await openPlayer(browser, true);
  try {
    await noOverflow(player.page);
    await createRoom(player);
    await startSolo(player);
    const chamber = player.page.getByTestId('experiment-chamber');
    await expect(chamber).toBeVisible();
    expect(await chamber.locator('svg').count()).toBeGreaterThanOrEqual(4);
    expect(await player.page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    await advance(player, 'directive');
    await advance(player, 'discussion');
    const cpu = player.latest!.members.find(member => member.controller === 'cpu')!;
    await player.page.getByRole('button', { name: `Talk to ${cpu.nickname}`, exact: true }).click();
    await player.page.getByRole('button', { name: 'Can you help Medical?', exact: true }).click();
    await expect.poll(() => player.latest!.chat.some(message => message.senderId === player.latest!.selfId && message.text.includes('Can you help Medical?'))).toBe(true);
    const request = player.latest!.chat.findLast(message => message.senderId === player.latest!.selfId && message.text.includes('Can you help Medical?'))!;
    const ownNickname = player.latest!.members.find(member => member.id === player.latest!.selfId)!.nickname;
    await expect.poll(() => player.latest!.chat.some(message => message.senderId === cpu.id && message.at >= request.at && message.text.startsWith(`@${ownNickname} — `) && message.text.includes('Medical')), { timeout: 12_000 }).toBe(true);
    await noOverflow(player.page);
    await chamber.screenshot({ path: testInfo.outputPath('chamber-mobile.png') });
    await advance(player, 'decision');
    // These are the visual power cells and station controls, not the fallback
    // arithmetic steppers. The server must receive exactly this private plan.
    await player.page.getByRole('button', { name: 'Energy cell 1, unassigned', exact: true }).click();
    await player.page.getByRole('button', { name: 'Route energy cell to Medical', exact: true }).click();
    await player.page.getByRole('button', { name: 'Energy cell 2, unassigned', exact: true }).click();
    await player.page.getByRole('button', { name: 'Route energy cell to Security', exact: true }).click();
    await player.page.getByRole('button', { name: 'Energy cell 3, unassigned', exact: true }).click();
    await player.page.getByRole('button', { name: 'Route energy cell to Reserve', exact: true }).click();
    await expect(player.page.getByLabel('Medical allocation', { exact: true })).toHaveText('1');
    await expect(player.page.getByLabel('Security allocation', { exact: true })).toHaveText('1');
    await expect(player.page.getByLabel('Reserve allocation', { exact: true })).toHaveText('1');
    await noOverflow(player.page);
    await player.page.getByTestId('resource-station').screenshot({ path: testInfo.outputPath('power-routing-mobile.png') });
    await player.page.getByRole('button', { name: 'Lock allocation', exact: true }).click();
    await expect.poll(() => player.latest?.me?.decision).toEqual({ medical: 1, security: 1, reserve: 1 });
    await expect.poll(() => player.latest?.game?.phase.type).toBe('reveal');
    const totals = player.latest!.game!.allocationTotals!;
    expect(totals.medical + totals.security + totals.reserve).toBe(12);
    await expect(chamber).toBeVisible();
    await noOverflow(player.page);
    expect(player.errors).toEqual([]);
  } finally { await player.context.close(); }
});

test('sound starts on a gesture, speaks public scenes and CPU dialogue, and never reads the private dossier', async ({ browser }) => {
  const player = await openPlayer(browser, false, true);
  try {
    await createRoom(player);
    await startSolo(player);
    expect((await audioAudit(player.page)).utterances).toEqual([]);
    await player.page.getByRole('button', { name: 'Enable sound', exact: true }).click();
    await expect.poll(async () => (await audioAudit(player.page)).contextStates).toContain('running');
    await expect.poll(async () => (await audioAudit(player.page)).oscillators).toBeGreaterThan(0);
    await advance(player, 'directive');
    await expect.poll(async () => (await audioAudit(player.page)).utterances.length).toBeGreaterThan(0);
    const directive = player.latest!.me!.directive!.text;
    await hostControl(player, 'Pause experiment');
    await expect.poll(() => player.latest?.game?.phase.paused).toBe(true);
    const beforeDossier = (await audioAudit(player.page)).utterances;
    await player.page.getByRole('button', { name: 'Reveal private dossier', exact: true }).click();
    await expect(player.page.getByRole('heading', { name: directive, exact: true })).toBeVisible();
    await player.page.getByRole('button', { name: 'Conceal dossier', exact: true }).click();
    expect((await audioAudit(player.page)).utterances).toEqual(beforeDossier);
    expect(beforeDossier.join('\n')).not.toContain(directive);
    await hostControl(player, 'Resume experiment');
    await advance(player, 'discussion');
    await expect.poll(() => player.latest!.chat.filter(message => player.latest!.members.some(member => member.id === message.senderId && member.controller === 'cpu')).length).toBeGreaterThan(0);
    const cpuLine = player.latest!.chat.find(message => player.latest!.members.some(member => member.id === message.senderId && member.controller === 'cpu'))!.text;
    await expect.poll(async () => (await audioAudit(player.page)).utterances.some(text => text.includes(cpuLine)), { timeout: 15_000 }).toBe(true);
    expect((await audioAudit(player.page)).utterances.join('\n')).not.toContain(directive);
    await expect.poll(async () => (await audioAudit(player.page)).talkingPortraits).toBeGreaterThan(0);
    await player.page.getByRole('button', { name: 'Voices on', exact: true }).click();
    const volume = player.page.getByRole('slider', { name: 'Sound volume', exact: true });
    await volume.focus();
    await volume.press('Home');
    for (let step = 0; step < 5; step++) await volume.press('ArrowRight');
    await expect(volume).toHaveValue('25');
    await player.page.getByRole('button', { name: 'Mute sound', exact: true }).click();
    const beforeMute = (await audioAudit(player.page)).utterances;
    await advance(player, 'decision');
    expect((await audioAudit(player.page)).utterances).toEqual(beforeMute);
    await player.page.reload();
    await expect.poll(() => player.latest?.game?.phase.type).toBe('decision');
    await expect(player.page.getByRole('button', { name: 'Enable sound', exact: true })).toBeVisible();
    expect((await audioAudit(player.page)).utterances).toEqual([]);
    await player.page.getByRole('button', { name: 'Enable sound', exact: true }).click();
    await expect(player.page.getByRole('button', { name: 'Voices off', exact: true })).toBeVisible();
    await expect(player.page.getByRole('slider', { name: 'Sound volume', exact: true })).toHaveValue('25');
    expect((await audioAudit(player.page)).utterances).toEqual([]);
    await player.page.getByRole('button', { name: 'Voices off', exact: true }).click();
    for (const system of ['Medical', 'Security', 'Reserve']) {
      await player.page.getByRole('button', { name: `Add ${system} unit`, exact: true }).click();
    }
    await player.page.getByRole('button', { name: 'Lock allocation', exact: true }).click();
    await expect.poll(() => player.latest?.game?.phase.type).toBe('reveal');
    await expect.poll(async () => (await audioAudit(player.page)).utterances.some(text => text.includes('The allocations are revealed.'))).toBe(true);
    const afterReconnect = (await audioAudit(player.page)).utterances.join('\n');
    expect(afterReconnect).not.toContain(cpuLine);
    expect(afterReconnect).not.toContain(directive);
    expect(player.errors).toEqual([]);
  } finally { await player.context.close(); }
});
