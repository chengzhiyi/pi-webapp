export type ActivitySource = "background-tasks" | "subagents";
export type ActivityStatus = "running" | "paused" | "completed" | "failed" | "stopped";
export type ActivityKind = "shell" | "agent" | "workflow" | "delegate" | "fusion" | "attested" | "managed";

export interface ActivityItem {
  id: string;
  source: ActivitySource;
  kind: ActivityKind;
  title: string;
  status: ActivityStatus;
  startedAt: number | null;
  updatedAt: number | null;
  endedAt: number | null;
  currentAction?: string;
  model?: string;
  tokens?: number;
  error?: string;
  unread?: boolean;
  canStop: boolean;
  canRerun: boolean;
  canOpen: boolean;
}

export interface ActivityProviderView {
  source: ActivitySource;
  available: boolean;
  error?: string;
}

export interface ActivitySnapshot {
  version: 1;
  revision: number;
  observedAt: number;
  items: ActivityItem[];
  providers: ActivityProviderView[];
  /** The owning Pi runtime was replaced; reconnect to the current activation. */
  closed?: boolean;
}

export interface ActivityDetail {
  item: ActivityItem;
  text: string;
  truncated: boolean;
  outputPath?: string;
}

export interface ActivityTarget {
  sessionId: string;
  source: ActivitySource;
  id: string;
}

/** Host-owned session capability. Wire responses contain DTOs, never Pi runtime objects. */
export interface ActivityHostApi {
  snapshot(sessionId: string): Promise<ActivitySnapshot>;
  subscribe(sessionId: string, listener: (snapshot: ActivitySnapshot) => void): () => void;
  detail(target: ActivityTarget): Promise<ActivityDetail>;
  stop(target: ActivityTarget): Promise<ActivitySnapshot>;
  rerun(target: ActivityTarget): Promise<ActivitySnapshot>;
}
