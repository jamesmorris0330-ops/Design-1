import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PHASE_LABELS, type PhaseType, type RoomView, type ServerMessage } from '../../src/shared/protocol';

interface PlayerBrowser {
  context: BrowserContext;
  page: Page;
  nickname: string;
  latest: RoomView | null;
  snapshots: RoomView[];
  payloads: ServerMessage[];
  errors: string[];
}

async function openPlayer(browser: Browser, nickname: string, mobile = false): Promise<PlayerBrowser> {
  const context = await browser.newContext({
    viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 },
    isMobile: mobile,
    hasTouch: mobile,
  });
  const page = await context.newPage();
  const player: PlayerBrowser = { context, page, nickname, latest: null, snapshots: [], payloads: [], errors: [] };
  page.on('pageerror', error => player.errors.push(error.message));
  page.on('websocket', socket => {
    socket.on('framereceived', frame => {
      try {
        const payload = JSON.parse(frame.payload.toString()) as ServerMessage;
        player.payloads.push(payload);
        if (payload.type === 'snapshot') {
          player.latest = payload.view;
          player.snapshots.push(payload.view);
        }
      } catch { /* Non-JSON transport frames are not game state. */ }
    });
  });
  await page.goto('/');
  return player;
}

async function createRoom(host: PlayerBrowser): Promise<string> {
  await host.page.getByLabel('Nickname', { exact: true }).fill(host.nickname);
  await host.page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect.poll(() => host.latest?.status).toBe('lobby');
  return host.latest!.code;
}

async function joinRoom(player: PlayerBrowser, code: string): Promise<void> {
  await player.page.getByRole('tab', { name: 'Join a room', exact: true }).click();
  await player.page.getByLabel('Nickname', { exact: true }).fill(player.nickname);
  await player.page.getByLabel('Room code', { exact: true }).fill(code);
  await player.page.getByRole('button', { name: 'Join room', exact: true }).click();
  await expect.poll(() => player.latest?.code).toBe(code);
}

async function waitPhase(players: PlayerBrowser[], phase: PhaseType, timeout = 10_000): Promise<void> {
  await Promise.all(players.map(async player => {
    await expect.poll(() => player.latest?.game?.phase.type, { timeout }).toBe(phase);
    await expect(player.page.getByTestId('phase')).toHaveText(PHASE_LABELS[phase]);
  }));
}

async function openHostControls(host: PlayerBrowser): Promise<void> {
  const summary = host.page.locator('summary').filter({ hasText: /^Host controls/ });
  if (!await summary.evaluate(element => element.parentElement!.hasAttribute('open'))) await summary.click();
}

async function advance(host: PlayerBrowser, players: PlayerBrowser[], next: PhaseType): Promise<void> {
  await openHostControls(host);
  await host.page.getByRole('button', { name: 'Advance phase', exact: true }).click();
  await waitPhase(players, next);
}

async function startSolo(host: PlayerBrowser): Promise<void> {
  await host.page.getByRole('button', { name: 'Mark ready', exact: true }).click();
  const start = host.page.getByRole('button', { name: 'Start with CPU players', exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await waitPhase([host], 'crisis');
  expect(host.latest!.members.filter(member => !member.removed && member.role === 'subject')).toHaveLength(4);
  expect(host.latest!.members.filter(member => member.controller === 'cpu')).toHaveLength(3);
  expect(host.latest!.members.find(member => member.id === host.latest!.selfId)!.controller).toBe('human');
  expect(host.latest!.members.filter(member => member.controller === 'cpu').every(member => member.connected)).toBe(true);
}

async function reachDecision(host: PlayerBrowser): Promise<void> {
  await advance(host, [host], 'directive');
  expect(host.latest!.me!.directive).not.toBeNull();
  await advance(host, [host], 'discussion');
  await advance(host, [host], 'decision');
}

async function submitAllocation(player: PlayerBrowser): Promise<void> {
  await player.page.getByRole('button', { name: 'Add Reserve unit', exact: true }).click();
  await player.page.getByRole('button', { name: 'Add Security unit', exact: true }).click();
  await player.page.getByRole('button', { name: 'Add Medical unit', exact: true }).click();
  await player.page.getByRole('button', { name: 'Lock allocation', exact: true }).click();
}

async function completeSoloTrial(host: PlayerBrowser): Promise<void> {
  await reachDecision(host);
  await submitAllocation(host);
  // Only the human acts through the browser. CPU allocations and ballots must
  // arrive from the real server scheduler, rather than host-forced timeouts.
  await waitPhase([host], 'reveal');
  const totals = host.latest!.game!.allocationTotals!;
  expect(totals.medical + totals.security + totals.reserve).toBe(12);
  await advance(host, [host], 'vote');
  await host.page.getByRole('radio', { name: 'Abstain', exact: true }).check();
  await host.page.getByRole('button', { name: 'Lock vote', exact: true }).click();
  await waitPhase([host], 'consequences');
  const record = host.latest!.events.findLast(event => event.type === 'vote_resolution');
  expect(record).toBeDefined();
  await advance(host, [host], 'dossier');
  expect(host.latest!.me!.dossier.length).toBeGreaterThan(0);
}

function assertPrivacy(players: PlayerBrowser[]): void {
  const memberKeys = ['connected', 'controller', 'id', 'nickname', 'ready', 'removed', 'role', 'subjectNumber'];
  for (const player of players) {
    for (const view of player.snapshots) {
      for (const member of view.members) expect(Object.keys(member).sort()).toEqual(memberKeys);
      const self = view.members.find(member => member.id === view.selfId)!;
      if (self.role === 'spectator') expect(view.me).toBeNull();
      if (view.game && view.game.phase.type !== 'full_reveal') {
        expect(view.game.results).toEqual([]);
        expect(view.game.fullReveal).toEqual([]);
      }
    }
    for (const payload of player.payloads) {
      expect(JSON.stringify(payload)).not.toMatch(/"(?:tokenDigest|sessionDigest|sessionId|sessionToken|canonicalRevision|secretDecisions|privatePlayers|subjects|ballots)"\s*:/);
    }
    const ownDossierIds = new Set(player.snapshots.flatMap(view => view.me?.dossier.map(entry => entry.id) ?? []));
    for (const other of players.filter(other => other !== player)) {
      const text = JSON.stringify(other.snapshots);
      for (const id of ownDossierIds) expect(text).not.toContain(id);
    }
    expect(player.errors).toEqual([]);
  }
}

test('one human completes the Experiment with three autonomous CPU Subjects and rematches in the same room', async ({ browser }) => {
  const host = await openPlayer(browser, `Solo-${randomUUID().slice(0, 5)}`, true);
  try {
    const code = await createRoom(host);
    const addCpu = host.page.getByRole('button', { name: 'Add CPU player', exact: true });
    await expect(addCpu).toBeVisible();
    expect((await addCpu.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await startSolo(host);
    const firstGameId = host.latest!.game!.id;
    const seats = host.latest!.members.map(member => member.id);
    await completeSoloTrial(host);
    await advance(host, [host], 'crisis');
    await completeSoloTrial(host);
    await advance(host, [host], 'extension_offer');
    await host.page.getByRole('button', { name: 'Continue to finale', exact: true }).click();
    await waitPhase([host], 'final_interrogation');
    expect(host.latest!.game!.phase.speakerId).toBe(host.latest!.selfId);
    await host.page.getByLabel('Final statement', { exact: true }).fill('I ask every Subject to protect the group.');
    await host.page.getByRole('button', { name: 'Submit statement', exact: true }).click();
    await waitPhase([host], 'final_directive', 25_000);
    const cpuIds = new Set(host.latest!.members.filter(member => member.controller === 'cpu').map(member => member.id));
    expect(host.latest!.chat.filter(message => message.type === 'statement' && cpuIds.has(message.senderId))).toHaveLength(3);
    await advance(host, [host], 'final_choice');
    await host.page.getByRole('radio', { name: /Protect the Group/ }).check();
    await host.page.getByRole('button', { name: 'Lock final choice', exact: true }).click();
    await waitPhase([host], 'final_resolution');
    await advance(host, [host], 'personal_results');
    const own = host.latest!.me!;
    expect(own.result!.qualified).toBe(host.latest!.game!.outcome === 'survived' && own.compliance >= own.requirement);
    await advance(host, [host], 'full_reveal');
    expect(host.latest!.status).toBe('postgame');
    expect(host.latest!.game!.results).toHaveLength(4);
    for (const result of host.latest!.game!.results) {
      expect(result.qualified).toBe(host.latest!.game!.outcome === 'survived' && result.compliance >= result.requirement && !result.removed);
    }
    expect(host.latest!.game!.fullReveal.length).toBeGreaterThan(0);
    await host.page.getByRole('button', { name: 'Return to lobby', exact: true }).click();
    await expect.poll(() => host.latest?.status).toBe('lobby');
    expect(host.latest!.code).toBe(code);
    expect(host.latest!.members.map(member => member.id)).toEqual(seats);
    expect(host.latest!.members.filter(member => member.controller === 'cpu').every(member => member.ready)).toBe(true);
    await host.page.getByRole('button', { name: 'Mark ready', exact: true }).click();
    await host.page.getByRole('button', { name: 'Start experiment', exact: true }).click();
    await waitPhase([host], 'crisis');
    expect(host.latest!.game!.id).not.toBe(firstGameId);
    expect(host.latest!.game!.round).toBe(1);
    expect(host.latest!.me!.compliance).toBe(0);
    expect(host.latest!.me!.dossier).toEqual([]);
    expect(await host.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
    assertPrivacy([host]);
  } finally {
    await host.context.close();
  }
});

test('players inherit locked CPU seats, reconnect privately, and concurrent joins claim distinct Subjects', async ({ browser }) => {
  const suffix = randomUUID().slice(0, 5);
  const host = await openPlayer(browser, `Host-${suffix}`);
  const guest = await openPlayer(browser, `Return-${suffix}`, true);
  const peers = await Promise.all([openPlayer(browser, `Peer-A-${suffix}`), openPlayer(browser, `Peer-B-${suffix}`)]);
  const spectator = await openPlayer(browser, `Observer-${suffix}`);
  const players = [host, guest, ...peers, spectator];
  try {
    const code = await createRoom(host);
    await host.page.getByRole('button', { name: 'Add CPU player', exact: true }).click();
    await expect.poll(() => host.latest?.members.filter(member => member.controller === 'cpu').length).toBe(1);
    expect(host.latest!.members.find(member => member.controller === 'cpu')!.ready).toBe(true);
    await startSolo(host);
    await completeSoloTrial(host);
    await advance(host, [host], 'crisis');
    await reachDecision(host);
    const cpuSeats = host.latest!.members.filter(member => member.controller === 'cpu');
    const gameId = host.latest!.game!.id;
    const phaseId = host.latest!.game!.phase.id;
    expect(host.latest!.me!.decisionSubmitted).toBe(false);
    // CPU responses take at most five seconds plus the 500 ms server tick.
    // Keep the human unsubmitted so the secret-decision phase cannot finish.
    await host.page.waitForTimeout(6_000);
    await openHostControls(host);
    await host.page.getByRole('button', { name: 'Pause experiment', exact: true }).click();
    await expect.poll(() => host.latest?.game?.phase.paused).toBe(true);
    await joinRoom(guest, code);
    const inherited = structuredClone(guest.latest!);
    const inheritedSeat = cpuSeats.find(member => member.id === inherited.selfId)!;
    expect(inheritedSeat).toBeDefined();
    expect(inherited.members.find(member => member.id === inherited.selfId)).toMatchObject({
      nickname: guest.nickname, controller: 'human', role: 'subject', subjectNumber: inheritedSeat.subjectNumber,
    });
    expect(inherited.game!.id).toBe(gameId);
    expect(inherited.game!.phase.id).toBe(phaseId);
    expect(inherited.me!.decisionSubmitted).toBe(true);
    expect(inherited.me!.decision).not.toBeNull();
    expect(inherited.me!.dossier.length).toBeGreaterThan(0);
    expect(inherited.me!.dossier.some(entry => entry.round === 1 && entry.title === 'Resolution')).toBe(true);
    expect(inherited.me!.dossier.reduce((score, entry) => score + entry.complianceDelta, 0)).toBe(inherited.me!.compliance);
    await expect(guest.page.getByText('CPU Subject inherited.', { exact: true })).toBeVisible();
    await expect(guest.page.getByText('Allocation locked. Other Subjects cannot see your contribution.', { exact: true })).toBeVisible();
    const beforeReload = guest.snapshots.length;
    await guest.page.reload();
    await expect.poll(() => guest.snapshots.length).toBeGreaterThan(beforeReload);
    expect(guest.latest!.selfId).toBe(inherited.selfId);
    expect(guest.latest!.me).toEqual(inherited.me);
    expect(guest.latest!.game!.phase.id).toBe(phaseId);
    expect(guest.latest!.members).toHaveLength(4);
    await Promise.all(peers.map(peer => joinRoom(peer, code)));
    await expect.poll(() => host.latest?.members.filter(member => member.controller === 'cpu').length).toBe(0);
    const claimed = [guest, ...peers].map(player => player.latest!.selfId);
    expect(new Set(claimed).size).toBe(3);
    expect(new Set(claimed)).toEqual(new Set(cpuSeats.map(member => member.id)));
    for (const player of [guest, ...peers]) {
      expect(player.latest!.me!.decisionSubmitted).toBe(true);
      expect(player.latest!.game!.id).toBe(gameId);
      expect(player.latest!.members.find(member => member.id === player.latest!.selfId)!.controller).toBe('human');
    }
    await joinRoom(spectator, code);
    expect(spectator.latest!.members.find(member => member.id === spectator.latest!.selfId)!.role).toBe('spectator');
    expect(spectator.latest!.me).toBeNull();
    expect(spectator.latest!.game!.phase.id).toBe(phaseId);
    await expect(spectator.page.getByRole('button', { name: 'Reveal private dossier', exact: true })).toHaveCount(0);
    await host.page.getByRole('button', { name: 'Resume experiment', exact: true }).click();
    await expect.poll(() => host.latest?.game?.phase.paused).toBe(false);
    await submitAllocation(host);
    await waitPhase(players, 'reveal');
    const totals = host.latest!.game!.allocationTotals!;
    expect(totals.medical + totals.security + totals.reserve).toBe(12);
    for (const player of players) expect(player.latest!.game!.allocationTotals).toEqual(totals);
    assertPrivacy(players);
  } finally {
    await Promise.all(players.map(player => player.context.close()));
  }
});
