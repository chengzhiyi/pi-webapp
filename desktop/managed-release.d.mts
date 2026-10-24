export const desktopProtocolVersion: 1;
export interface DesktopRelease { version: string; launcher: string; piCli: string; desktopProtocolVersion: 1; fallbackVersion?: string }
export function dependencyRoot(packageRoot: string, name: string): Promise<string>;
export const desktopUpdatePath: (agentDir: string) => string;
export function validateDesktopRelease(agentDir: string, release: unknown): Promise<DesktopRelease>;
export function readDesktopRelease(agentDir: string, minimumVersion: string): Promise<DesktopRelease | null>;
export function writeDesktopRelease(agentDir: string, release: DesktopRelease & { previous?: DesktopRelease }): Promise<void>;
export function rollbackDesktopRelease(agentDir: string, failedLauncher: string): Promise<void>;
