import { randomUUID } from 'node:crypto';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { PHASE_LABELS, type PhaseType, type RoomView, type ServerMessage } from '../../src/shared/protocol';

interface SubjectBrowser {
  context: BrowserContext;
  page: Page;
  nickname: string;
  latest: RoomView | null;
  snapshots: Array<Extract<ServerMessage, { type: 'snapshot' }>>;
  payloads: unknown[];
  errors: string[];
}

async function openSubject(browser: Browser, nickname: string, mobile = false): Promise<SubjectBrowser> {
  const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1440, height: 900 }, isMobile: mobile, hasTouch: mobile });
  const page = await context.newPage();
  const subject: SubjectBrowser = { context, page, nickname, latest: null, snapshots: [], payloads: [], errors: [] };
  page.on('pageerror', error => subject.errors.push(error.message));
  page.on('websocket', socket => {
    socket.on('framereceived', frame => {
      try {
        const payload = JSON.parse(frame.payload.toString()) as ServerMessage;
        subject.payloads.push(payload);
        if (payload.type === 'snapshot') {
          subject.latest = payload.view;
          subject.snapshots.push(payload);
        }
      } catch { /* Non-JSON heartbeat frames are not game state. */ }
    });
  });
  page.on('response', async response => {
    if (new URL(response.url()).pathname.startsWith('/api/') && response.headers()['content-type']?.includes('application/json')) {
      try { subject.payloads.push(await response.json()); } catch { /* A reload can cancel a response body. */ }
    }
  });
  await page.goto('/');
  return subject;
}

async function createRoom(subject: SubjectBrowser): Promise<string> {
  await subject.page.getByLabel('Nickname', { exact: true }).fill(subject.nickname);
  await subject.page.getByRole('button', { name: 'Create room', exact: true }).click();
  await expect.poll(() => subject.latest?.status).toBe('lobby');
  const code = subject.latest!.code;
  await expect(subject.page.getByTestId('current-room-code')).toContainText(code);
  return code;
}

async function joinRoom(subject: SubjectBrowser, code: string): Promise<void> {
  await subject.page.getByRole('tab', { name: 'Join a room', exact: true }).click();
  await subject.page.getByLabel('Nickname', { exact: true }).fill(subject.nickname);
  await subject.page.getByLabel('Room code', { exact: true }).fill(code);
  await subject.page.getByRole('button', { name: 'Join room', exact: true }).click();
  await expect.poll(() => subject.latest?.code).toBe(code);
}

async function waitPhase(subjects: SubjectBrowser[], phase: PhaseType): Promise<void> {
  await Promise.all(subjects.map(async subject => {
    await expect.poll(() => subject.latest?.game?.phase.type).toBe(phase);
    await expect(subject.page.getByTestId('phase')).toHaveText(PHASE_LABELS[phase]);
  }));
}

async function advance(host: SubjectBrowser, subjects: SubjectBrowser[], next: PhaseType): Promise<void> {
  await openHostControls(host);
  await host.page.getByRole('button', { name: 'Advance phase', exact: true }).click();
  await waitPhase(subjects, next);
}

async function openHostControls(host: SubjectBrowser): Promise<void> {
  const summary = host.page.locator('summary').filter({ hasText: /^Host controls/ });
  if (!await summary.evaluate(element => element.parentElement!.hasAttribute('open'))) await summary.click();
}

async function publicBarrier(host: SubjectBrowser, subjects: SubjectBrowser[]): Promise<void> {
  const text = `Connection check ${randomUUID().slice(0, 8)}`;
  await host.page.getByLabel('Public message', { exact: true }).fill(text);
  await host.page.getByRole('button', { name: 'Send public message', exact: true }).click();
  await expect.poll(() => subjects.every(subject => subject.latest?.chat.some(message => message.text === text))).toBe(true);
}

async function openDossier(subject: SubjectBrowser): Promise<void> {
  const reveal = subject.page.getByRole('button', { name: 'Reveal private dossier', exact: true });
  if (await reveal.isVisible()) await reveal.click();
  await expect(subject.page.getByRole('button', { name: 'Conceal dossier', exact: true })).toBeVisible();
}

function assertProjectionPrivacy(subjects: SubjectBrowser[]): void {
  const publicMemberKeys = ['connected', 'controller', 'id', 'nickname', 'ready', 'removed', 'role', 'subjectNumber'];
  for (const subject of subjects) {
    for (const { view } of subject.snapshots) {
      for (const member of view.members) expect(Object.keys(member).sort()).toEqual(publicMemberKeys);
      expect(Object.keys(view).sort()).toEqual(['chat', 'chatMuted', 'code', 'events', 'game', 'hostId', 'id', 'me', 'members', 'selfId', 'settings', 'status']);
      if (view.game && view.game.phase.type !== 'full_reveal') {
        expect(view.game.results).toEqual([]);
        expect(view.game.fullReveal).toEqual([]);
      }
      if (view.game) {
        expect(Object.keys(view.game).sort()).toEqual(['allocationTotals', 'extension', 'fullReveal', 'id', 'initialRounds', 'maxStability', 'outcome', 'phase', 'results', 'round', 'roundCap', 'stability', 'totalRounds', 'trial', 'voteTargets', 'voteType']);
        expect(Object.keys(view.game.phase).sort()).toEqual(['deadline', 'eligibleIds', 'id', 'pauseReason', 'paused', 'remainingMs', 'speakerId', 'type']);
      }
      const self = view.members.find(member => member.id === view.selfId);
      if (self?.role === 'spectator') expect(view.me).toBeNull();
    }
    // Authentication and canonical secret collections must never occur in HTTP or WebSocket bodies.
    for (const payload of subject.payloads) {
      const text = JSON.stringify(payload);
      expect(text).not.toMatch(/"(?:tokenDigest|sessionDigest|sessionId|sessionToken|canonicalRevision|secretDecisions|privatePlayers|ballots)"\s*:/);
    }
    expect(subject.errors).toEqual([]);
  }
}

async function prepareGame(browser: Browser, count = 4): Promise<{ subjects: SubjectBrowser[]; host: SubjectBrowser; code: string }> {
  const suffix = randomUUID().slice(0, 5);
  const subjects = await Promise.all(Array.from({ length: count }, (_, index) => openSubject(browser, `Subject-${index + 1}-${suffix}`, index === count - 1)));
  const host = subjects[0];
  const code = await createRoom(host);
  await Promise.all(subjects.slice(1).map(subject => joinRoom(subject, code)));
  await expect.poll(() => host.latest?.members.length).toBe(count);
  await Promise.all(subjects.map(subject => subject.page.getByRole('button', { name: 'Mark ready', exact: true }).click()));
  await expect(host.page.getByRole('button', { name: 'Start experiment', exact: true })).toBeEnabled();
  await host.page.getByRole('button', { name: 'Start experiment', exact: true }).click();
  await waitPhase(subjects, 'crisis');
  return { subjects, host, code };
}

async function completeTrial(host: SubjectBrowser, subjects: SubjectBrowser[], refreshDecision = false): Promise<void> {
  await advance(host, subjects, 'directive');
  await host.page.getByRole('button', { name: 'Pause experiment', exact: true }).click();
  await expect.poll(() => subjects.every(subject => subject.latest?.game?.phase.paused)).toBe(true);
  await Promise.all(subjects.map(async subject => {
    await openDossier(subject);
    await expect(subject.page.getByRole('heading', { name: subject.latest!.me!.directive!.text, exact: true })).toBeVisible();
  }));
  for (const subject of subjects) {
    const ownDirective = subject.latest!.me!.directive!.text;
    const viewText = JSON.stringify(subject.latest);
    for (const other of subjects.filter(other => other !== subject)) {
      const otherDirective = other.latest!.me!.directive!.text;
      if (otherDirective !== ownDirective && subject.latest!.game!.round === 1) {
        await expect(subject.page.getByText(otherDirective, { exact: true })).toHaveCount(0);
        expect(viewText).not.toContain(otherDirective);
      }
      for (const entry of other.latest!.me!.dossier) expect(viewText).not.toContain(entry.id);
    }
  }
  await host.page.getByRole('button', { name: 'Resume experiment', exact: true }).click();
  await expect.poll(() => subjects.every(subject => subject.latest?.game?.phase.paused === false)).toBe(true);
  await advance(host, subjects, 'discussion');
  await advance(host, subjects, 'decision');
  await Promise.all(subjects.map(async subject => {
    await subject.page.getByRole('button', { name: 'Add Medical unit', exact: true }).click();
    await subject.page.getByRole('button', { name: 'Add Security unit', exact: true }).click();
    await subject.page.getByRole('button', { name: 'Add Reserve unit', exact: true }).click();
  }));

  if (refreshDecision) {
    const returning = subjects[subjects.length - 1];
    const original = structuredClone(returning.latest!);
    const otherSnapshotCounts = subjects.slice(0, -1).map(subject => subject.snapshots.length);
    await returning.page.getByRole('button', { name: 'Lock allocation', exact: true }).click();
    await expect.poll(() => returning.latest?.me?.decisionSubmitted).toBe(true);
    await publicBarrier(host, subjects);
    expect(subjects.slice(0, -1).map(subject => subject.snapshots.length)).toEqual(otherSnapshotCounts.map(count => count + 1));
    const previousSnapshots = returning.snapshots.length;
    await returning.page.reload();
    await expect.poll(() => returning.snapshots.length).toBeGreaterThan(previousSnapshots);
    await expect.poll(() => returning.latest?.selfId).toBe(original.selfId);
    await expect.poll(() => returning.latest?.me?.decisionSubmitted).toBe(true);
    expect(returning.latest!.me!.directive).toEqual(original.me!.directive);
    expect(returning.latest!.me!.dossier).toEqual(original.me!.dossier);
    expect(returning.latest!.me!.compliance).toBe(original.me!.compliance);
    expect(returning.latest!.game!.id).toBe(original.game!.id);
    expect(returning.latest!.game!.phase.id).toBe(original.game!.phase.id);
    expect(returning.latest!.members).toHaveLength(original.members.length);
    expect(returning.latest!.me!.decision).toEqual({ medical: 1, security: 1, reserve: 1 });
    await expect(returning.page.getByText('Allocation locked. Other Subjects cannot see your contribution.', { exact: true })).toBeVisible();
    await expect(returning.page.getByRole('button', { name: 'Add Medical unit', exact: true })).toBeDisabled();
    await Promise.all(subjects.slice(0, -1).map(subject => subject.page.getByRole('button', { name: 'Lock allocation', exact: true }).click()));
  } else {
    await Promise.all(subjects.map(subject => subject.page.getByRole('button', { name: 'Lock allocation', exact: true }).click()));
  }
  await waitPhase(subjects, 'reveal');
  for (const subject of subjects) {
    expect(subject.latest!.game!.allocationTotals).toEqual({ medical: subjects.length, security: subjects.length, reserve: subjects.length });
    expect(subject.latest!.game!.stability).toBe(host.latest!.game!.stability);
  }
  await advance(host, subjects, 'vote');
  await Promise.all(subjects.map(async subject => {
    const target = subject === host ? subjects[1] : host;
    const member = target.latest!.members.find(item => item.id === target.latest!.selfId)!;
    await subject.page.getByRole('radio', { name: new RegExp(`${member.nickname}$`) }).check();
    await subject.page.getByRole('button', { name: 'Lock vote', exact: true }).click();
  }));
  await waitPhase(subjects, 'consequences');
  await advance(host, subjects, 'dossier');
}

async function completeFinale(host: SubjectBrowser, subjects: SubjectBrowser[]): Promise<void> {
  await waitPhase(subjects, 'final_interrogation');
  for (let index = 0; index < subjects.length; index++) {
    const speakerId = host.latest!.game!.phase.speakerId;
    const speaker = subjects.find(subject => subject.latest!.selfId === speakerId)!;
    await speaker.page.getByLabel('Final statement', { exact: true }).fill(`I ask the group to survive. Statement ${index + 1}.`);
    await speaker.page.getByRole('button', { name: 'Submit statement', exact: true }).click();
    if (index < subjects.length - 1) await expect.poll(() => host.latest?.game?.phase.speakerId).not.toBe(speakerId);
  }
  await waitPhase(subjects, 'final_directive');
  await advance(host, subjects, 'final_choice');
  const beforeFinal = subjects.map(subject => ({ compliance: subject.latest!.me!.compliance, directive: subject.latest!.me!.finalDirective! }));
  await Promise.all(subjects.map(subject => subject.page.getByRole('radio', { name: /Protect the Group/ }).check()));
  await Promise.all(subjects.slice(0, -1).map(subject => subject.page.getByRole('button', { name: 'Lock final choice', exact: true }).click()));
  await expect.poll(() => subjects.slice(0, -1).every(subject => subject.latest?.me?.finalChoice === 'group')).toBe(true);
  expect(host.latest!.game!.phase.type).toBe('final_choice');
  expect(subjects[subjects.length - 1].latest!.me!.finalChoice).toBeNull();
  // Even the host cannot advance before the last real Subject locks in.
  await expect(host.page.getByRole('button', { name: 'Advance phase', exact: true })).toBeDisabled();
  expect(host.latest!.game!.phase.type).toBe('final_choice');
  await subjects[subjects.length - 1].page.getByRole('button', { name: 'Lock final choice', exact: true }).click();
  await waitPhase(subjects, 'final_resolution');
  expect(host.latest!.game!.outcome).toBe('survived');
  for (const [index, subject] of subjects.entries()) {
    const prior = beforeFinal[index]!;
    expect(subject.latest!.me!.compliance).toBe(prior.compliance + (prior.directive.text === 'Choose Protect the Group.' ? prior.directive.reward : 0));
  }
  await advance(host, subjects, 'personal_results');
  for (const subject of subjects) {
    expect(subject.latest!.me!.result!.qualified).toBe(subject.latest!.me!.compliance >= subject.latest!.me!.requirement);
    expect(subject.latest!.game!.results).toEqual([]);
  }
  await advance(host, subjects, 'full_reveal');
  for (const subject of subjects) {
    expect(subject.latest!.status).toBe('postgame');
    expect(subject.latest!.game!.results).toEqual(host.latest!.game!.results);
    expect(subject.latest!.game!.fullReveal.length).toBeGreaterThan(0);
    expect(subject.latest!.game!.results).toHaveLength(subjects.length);
  }
}

test('four independent Subjects play a private, reconnectable mobile-compatible match and rematch', async ({ browser }) => {
  const { subjects, host, code } = await prepareGame(browser);
  const spectator = await openSubject(browser, `Observer-${randomUUID().slice(0, 5)}`);
  try {
    await joinRoom(spectator, code);
    expect(spectator.latest!.members.find(member => member.id === spectator.latest!.selfId)!.role).toBe('spectator');
    expect(spectator.latest!.me).toBeNull();
    for (const subject of subjects) {
      const sessionMetadata = (await subject.context.cookies()).filter(cookie => cookie.name === 'experiment_session').map(cookie => ({ httpOnly: cookie.httpOnly, sameSite: cookie.sameSite }));
      expect(sessionMetadata).toEqual([{ httpOnly: true, sameSite: 'Strict' }]);
      expect(await subject.page.evaluate(() => document.cookie)).not.toContain('experiment_session');
    }
    await completeTrial(host, subjects, true);
    expect(new Set(subjects.map(subject => subject.latest!.selfId)).size).toBe(4);
    const mobile = subjects[subjects.length - 1];
    const overflow = await mobile.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(overflow).toBe(false);
    expect(host.latest!.game!.stability).toBe(80);
    await advance(host, subjects, 'crisis');
    await completeTrial(host, subjects);
    expect(host.latest!.game!.stability).toBe(100);
    await advance(host, subjects, 'extension_offer');
    await host.page.getByRole('button', { name: 'Continue to finale', exact: true }).click();
    await completeFinale(host, subjects);
    assertProjectionPrivacy([...subjects, spectator]);
    const completedGameId = host.latest!.game!.id;
    await host.page.getByRole('button', { name: 'Return to lobby', exact: true }).click();
    await expect.poll(() => subjects.every(subject => subject.latest?.status === 'lobby')).toBe(true);
    for (const subject of subjects) {
      expect(subject.latest!.code).toBe(code);
      expect(subject.latest!.game).toBeNull();
    }
    await Promise.all(subjects.map(subject => subject.page.getByRole('button', { name: 'Mark ready', exact: true }).click()));
    await host.page.getByRole('button', { name: 'Start experiment', exact: true }).click();
    await waitPhase(subjects, 'crisis');
    expect(host.latest!.game!.id).not.toBe(completedGameId);
    for (const subject of subjects) {
      expect(subject.latest!.me!.compliance).toBe(0);
      expect(subject.latest!.me!.dossier).toEqual([]);
    }
  } finally {
    await Promise.all([...subjects, spectator].map(subject => subject.context.close()));
  }
});

test('eight Subjects approve another Trial without moving their qualification targets, then finish the single finale', async ({ browser }) => {
  const { subjects, host } = await prepareGame(browser, 8);
  try {
    await completeTrial(host, subjects);
    await advance(host, subjects, 'crisis');
    await completeTrial(host, subjects);
    await advance(host, subjects, 'extension_offer');
    const initialGameId = host.latest!.game!.id;
    const previousPrivate = subjects.map(subject => structuredClone(subject.latest!.me!));
    await host.page.getByRole('button', { name: 'Propose +1 round', exact: true }).click();
    await waitPhase(subjects, 'extension_vote');
    expect(host.latest!.game!.extension).toEqual({ additionalRounds: 1, proposedTotal: 4 });
    const otherSnapshots = subjects.slice(1).map(subject => subject.snapshots.length);
    await host.page.getByRole('button', { name: 'Vote to extend', exact: true }).click();
    await expect.poll(() => host.latest?.me?.extensionVote).toBe(true);
    await publicBarrier(host, subjects);
    expect(subjects.slice(1).map(subject => subject.snapshots.length)).toEqual(otherSnapshots.map(count => count + 1));
    await Promise.all(subjects.slice(1).map((subject, index) => subject.page.getByRole('button', { name: index < 4 ? 'Vote to extend' : 'Vote to continue to finale', exact: true }).click()));
    await waitPhase(subjects, 'crisis');
    for (const [index, subject] of subjects.entries()) {
      expect(subject.latest!.game!.id).toBe(initialGameId);
      expect(subject.latest!.game!.initialRounds).toBe(3);
      expect(subject.latest!.game!.totalRounds).toBe(4);
      expect(subject.latest!.game!.round).toBe(3);
      expect(subject.latest!.me!.requirement).toBe(previousPrivate[index]!.requirement);
      expect(subject.latest!.me!.compliance).toBe(previousPrivate[index]!.compliance);
      expect(subject.latest!.me!.dossier).toEqual(previousPrivate[index]!.dossier);
    }
    await completeTrial(host, subjects);
    await advance(host, subjects, 'extension_offer');
    await host.page.getByRole('button', { name: 'Continue to finale', exact: true }).click();
    await completeFinale(host, subjects);
    assertProjectionPrivacy(subjects);
    const finaleRounds = new Set(host.latest!.game!.fullReveal.filter(entry => /final/i.test(entry.title)).map(entry => entry.round));
    expect(finaleRounds.size).toBe(1);
    expect(host.latest!.game!.round).toBe(4);
  } finally {
    await Promise.all(subjects.map(subject => subject.context.close()));
  }
});

test('the lobby synchronizes custom round lengths and enforces the selected 15 or 20 round cap', async ({ browser }) => {
  const host = await openSubject(browser, `Planner-${randomUUID().slice(0, 5)}`);
  const guest = await openSubject(browser, `Guest-${randomUUID().slice(0, 5)}`, true);
  try {
    const code = await createRoom(host);
    await joinRoom(guest, code);
    await host.page.getByLabel('Maximum session length', { exact: true }).selectOption('15');
    await expect(host.page.getByRole('button', { name: '20', exact: true })).toBeDisabled();
    await host.page.getByRole('button', { name: '15', exact: true }).click();
    await host.page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect.poll(() => guest.latest?.settings).toEqual({ rounds: 15, roundCap: 15, extensions: true, allowSpectators: true });
    await host.page.getByLabel('Maximum session length', { exact: true }).selectOption('20');
    await host.page.getByRole('button', { name: '20', exact: true }).click();
    await host.page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect.poll(() => guest.latest?.settings.rounds).toBe(20);
    expect(guest.latest!.settings.roundCap).toBe(20);
    await host.page.getByLabel('Total rounds, including the finale', { exact: true }).fill('18');
    await host.page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect.poll(() => guest.latest?.settings.rounds).toBe(18);
    await host.page.getByLabel('Maximum session length', { exact: true }).selectOption('15');
    await host.page.getByRole('button', { name: 'Save settings', exact: true }).click();
    await expect.poll(() => guest.latest?.settings.rounds).toBe(15);
    expect(guest.latest!.settings.roundCap).toBe(15);
    await expect(guest.page.getByLabel('Total rounds, including the finale', { exact: true })).toBeDisabled();
    assertProjectionPrivacy([host, guest]);
  } finally {
    await Promise.all([host.context.close(), guest.context.close()]);
  }
});
