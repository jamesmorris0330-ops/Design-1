import { z } from 'zod';
import { survivalActions, type SurvivalPublicWorld, type SurvivalPrivatePlayer } from './survival';

export const settingsSchema = z.object({
  rounds: z.number().int().min(3).max(20),
  roundCap: z.union([z.literal(15), z.literal(20)]),
  extensions: z.boolean(),
  allowSpectators: z.boolean(),
}).strict().refine(s => s.rounds <= s.roundCap, 'Round count exceeds the room cap');
export type RoomSettings = z.infer<typeof settingsSchema>;
export const DEFAULT_SETTINGS: RoomSettings = { rounds: 3, roundCap: 20, extensions: true, allowSpectators: true };

export const actionSchema = z.discriminatedUnion('type', [
  ...survivalActions,
  z.object({ type: z.literal('ready'), ready: z.boolean() }).strict(),
  z.object({ type: z.literal('settings'), settings: settingsSchema }).strict(),
  z.object({ type: z.literal('start') }).strict(),
  z.object({ type: z.literal('add_cpu') }).strict(),
  z.object({ type: z.literal('decision'), allocation: z.object({ medical: z.number().int().min(0).max(3), security: z.number().int().min(0).max(3), reserve: z.number().int().min(0).max(3) }).strict() }).strict(),
  z.object({ type: z.literal('vote'), targetId: z.string().max(100).nullable() }).strict(),
  z.object({ type: z.literal('chat'), text: z.string().trim().min(1).max(500) }).strict(),
  z.object({ type: z.literal('statement'), text: z.string().trim().min(1).max(500) }).strict(),
  z.object({ type: z.literal('advance') }).strict(),
  z.object({ type: z.literal('pause') }).strict(),
  z.object({ type: z.literal('resume') }).strict(),
  z.object({ type: z.literal('transfer_host'), targetId: z.string().max(100) }).strict(),
  z.object({ type: z.literal('remove'), targetId: z.string().max(100) }).strict(),
  z.object({ type: z.literal('set_role'), targetId: z.string().max(100), role: z.enum(['subject', 'spectator']) }).strict(),
  z.object({ type: z.literal('mute_chat'), muted: z.boolean() }).strict(),
  z.object({ type: z.literal('end') }).strict(),
  z.object({ type: z.literal('extension'), additionalRounds: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5)]) }).strict(),
  z.object({ type: z.literal('extension_vote'), yes: z.boolean() }).strict(),
  z.object({ type: z.literal('continue') }).strict(),
  z.object({ type: z.literal('final_choice'), choice: z.enum(['group', 'self']) }).strict(),
  z.object({ type: z.literal('rematch') }).strict(),
]);
export const commandSchema = z.object({
  commandId: z.string().uuid(), gameId: z.string().max(100).nullable(),
  phaseId: z.string().max(100).nullable(), action: actionSchema,
}).strict();
export type Action = z.infer<typeof actionSchema>;
export type CommandEnvelope = z.infer<typeof commandSchema>;

export type PhaseType = 'crisis' | 'directive' | 'discussion' | 'decision' | 'reveal' | 'vote' | 'consequences' | 'dossier' | 'extension_offer' | 'extension_vote' | 'final_interrogation' | 'final_directive' | 'final_choice' | 'final_resolution' | 'personal_results' | 'full_reveal' | 'aborted';
export type VoteType = 'exposure' | 'restriction' | 'trust';
export type Allocation = { medical: number; security: number; reserve: number };
export interface PublicMember { id: string; nickname: string; subjectNumber: number | null; role: 'subject' | 'spectator'; controller: 'human' | 'cpu'; ready: boolean; removed: boolean; connected: boolean }
export interface DirectiveView { id: string; text: string; reward: number }
export interface DossierEntry { id: string; round: number; title: string; text: string; complianceDelta: number; at: number }
export interface PublicEvent { id: string; at: number; round: number; title: string; detail: string; type: string }
export interface ChatMessage { id: string; senderId: string; nickname: string; text: string; at: number; type: 'chat' | 'statement' }
export interface PersonalResult { memberId: string; nickname: string; subjectNumber: number; compliance: number; requirement: number; qualified: boolean; directivesCompleted: number; trustVotes: number; trustRank: number; classification: string; removed: boolean }
export interface RevealEntry { id: string; round: number; memberId: string | null; title: string; detail: string }
export interface PrivatePlayer {
  compliance: number; requirement: number; directive: DirectiveView | null; finalDirective: DirectiveView | null;
  dossier: DossierEntry[]; decision: Allocation | null; decisionSubmitted: boolean; voteSubmitted: boolean;
  extensionVote: boolean | null; finalChoice: 'group' | 'self' | null; restriction: boolean; result: PersonalResult | null;
}
export interface PublicGame {
  id: string; round: number; initialRounds: number; totalRounds: number; roundCap: 15 | 20;
  stability: number; maxStability: number; outcome: 'active' | 'survived' | 'failed' | 'aborted';
  phase: { id: string; type: PhaseType; deadline: number | null; paused: boolean; remainingMs: number | null; eligibleIds: string[]; speakerId: string | null; pauseReason?: string | null };
  trial: { id: string; title: string; narrative: string; medicalTarget: number; securityTarget: number } | null;
  voteType: VoteType | null; voteTargets: string[];
  allocationTotals: Allocation | null;
  extension: { additionalRounds: number; proposedTotal: number } | null;
  results: PersonalResult[]; fullReveal: RevealEntry[];
}
export interface RoomView {
  id: string; code: string; hostId: string; status: 'lobby' | 'running' | 'postgame';
  settings: RoomSettings; members: PublicMember[]; game: PublicGame | null;
  events: PublicEvent[]; chat: ChatMessage[]; chatMuted: boolean;
  selfId: string; me: PrivatePlayer | null;
  survival?: SurvivalPublicWorld; survivorMe?: SurvivalPrivatePlayer | null;
}
export type ServerMessage =
  | { type: 'snapshot'; view: RoomView; serverTime: number; viewVersion: number }
  | { type: 'ack'; commandId: string; ok: boolean; error?: { code: string; message: string } }
  | { type: 'superseded' }
  | { type: 'error'; message: string };

export const PHASE_LABELS: Record<PhaseType, string> = {
  crisis: 'Public crisis', directive: 'Private directive', discussion: 'Discussion', decision: 'Secret decision',
  reveal: 'Trial reveal', vote: 'Mixed vote', consequences: 'Consequences', dossier: 'Dossier update',
  extension_offer: 'Continue the experiment?', extension_vote: 'Extension consent',
  final_interrogation: 'Final interrogation', final_directive: 'Final directive', final_choice: 'The final choice',
  final_resolution: 'Stability resolution', personal_results: 'Personal results', full_reveal: 'Full reveal', aborted: 'Experiment aborted',
};
