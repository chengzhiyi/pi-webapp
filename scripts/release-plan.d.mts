export function planRelease(sourceVersion: unknown, tags: { latest?: unknown; alpha?: unknown }, channel: unknown): { version: string; tag: "latest" | "alpha"; channel: "stable" | "alpha" };
export function planDesktopVersion(sourceVersion: unknown, tags: { latest?: unknown; alpha?: unknown }): string;
export function assertDesktopVersionCurrent(version: string, tags: { latest?: unknown; alpha?: unknown }): void;
export function releaseChannel(ref: unknown): "stable" | "alpha";
