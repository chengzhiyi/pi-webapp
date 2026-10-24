export function parseVersion(value: unknown): { core: number[]; prerelease: string[] };
export function compareVersions(a: string, b: string): number;
export function isStableVersion(value: unknown): value is string;
export function isAlphaVersion(value: unknown): value is string;
