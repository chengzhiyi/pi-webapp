export const upgradeSchema: 1;
export const candidateTtlMs: number;
export interface UpgradeCandidate { schema: 1; id: string; version: string; launcher: string; packageRoot: string; channel: "stable" | "alpha"; downgrade: boolean; createdAt: string }
export interface UpgradeTransactionRecord { schema: 1; id: string; phase: "selected" | "committed" | "rolled-back"; version: string; from: string; message?: string; updatedAt: string }
export interface UpgradeSelection { path: string; before: Buffer | null; after: Buffer | null }
export const upgradeRoot: (agentDir: string) => string;
export const candidatePath: (agentDir: string) => string;
export const upgradeTransactionPath: (agentDir: string) => string;
export function validCandidate(value: unknown): value is UpgradeCandidate;
export function readCandidate(agentDir: string, now?: number): Promise<UpgradeCandidate | null>;
export function writeCandidate(agentDir: string, candidate: Omit<UpgradeCandidate, "schema" | "createdAt"> & { createdAt?: string }): Promise<UpgradeCandidate>;
export function retireCandidate(agentDir: string, id: string | undefined, outcome: string): Promise<void>;
export function validUpgradeTransaction(value: unknown): value is UpgradeTransactionRecord;
export function readUpgradeTransaction(agentDir: string): Promise<UpgradeTransactionRecord | null>;
export function recordUpgradeTransaction(agentDir: string, transaction: Omit<UpgradeTransactionRecord, "schema" | "updatedAt">): Promise<UpgradeTransactionRecord>;
export function selectCandidate(options: { agentDir: string; desktop: boolean; currentVersion: string; candidate: UpgradeCandidate }): Promise<UpgradeSelection>;
export function rollbackSelection(selection: UpgradeSelection): Promise<boolean>;
