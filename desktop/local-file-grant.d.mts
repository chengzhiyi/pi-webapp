export type LocalFilePlatform = "darwin" | "win32";
export function localFilePlatform(platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, consoleUser?: () => number, uid?: number): LocalFilePlatform | undefined;
export function localFileKey(agentDir: string, create?: boolean): Promise<Buffer | undefined>;
export function matchesLocalFileGrant(key: Buffer | undefined, token: string, input: unknown): boolean;
export function localFileLaunchUrl(url: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, agentDir?: string): Promise<string>;
