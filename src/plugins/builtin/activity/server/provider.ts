import type { ActivityDetail, ActivityItem, ActivityProviderView, ActivitySnapshot, ActivitySource } from "../contract/activity.ts";

export interface ActivityEventBus {
  on(event: string, handler: (data: unknown) => void): (() => void) | undefined;
  emit(event: string, data: unknown): void;
}

export interface ActivityProviderResult {
  provider: ActivityProviderView;
  items: ActivityItem[];
}

export interface ActivityProvider {
  readonly source: ActivitySource;
  read(): Promise<ActivityProviderResult>;
  detail(id: string): Promise<ActivityDetail>;
  stop(id: string): Promise<void>;
  rerun?(id: string): Promise<void>;
  close(): void;
}

export class ActivityProviderError extends Error {
  readonly code: string;

  constructor(message: string, code = "OPERATION_FAILED") {
    super(message);
    this.name = "ActivityProviderError";
    this.code = code;
  }
}

export function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.trim() ? value : fallback;
}

export function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

export function errorText(error: unknown): string {
  const value = error instanceof Error ? error.message : String(error);
  return value.replace(/\s+/g, " ").trim().slice(0, 500) || "Activity provider unavailable";
}

export function emptySnapshot(): ActivitySnapshot {
  return { version: 1, revision: 0, observedAt: Date.now(), items: [], providers: [] };
}
