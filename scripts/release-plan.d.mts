export function planRelease(sourceVersion: unknown, tags: { latest?: unknown; alpha?: unknown }, channel: unknown): { version: string; tag: "latest" | "alpha"; channel: "stable" | "alpha" };
export function releaseChannel(ref: unknown): "stable" | "alpha";
