export const launcherHandoffProtocol: 1;
export interface HandoffReceipt {
  protocol: 1; nonce: string; requestId: string; pid: number;
  phase: "requested" | "draining" | "stopped" | "refused" | "failed";
}
export function handoffPath(agentDir: string): string;
export function validHandoff(value: unknown): value is HandoffReceipt;
export function readHandoff(agentDir: string): Promise<HandoffReceipt | null>;
export function writeHandoff(agentDir: string, value: unknown): Promise<void>;

export interface HandoffIntent extends HandoffReceipt { phase: "requested"; version: string; url: string; completed?: true; cancelled?: true }
export function validHandoffIntent(value: unknown): value is HandoffIntent;
export function readHandoffIntent(agentDir: string): Promise<HandoffIntent | null>;
export function writeHandoffIntent(agentDir: string, value: unknown): Promise<void>;
