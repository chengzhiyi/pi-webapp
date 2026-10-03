export function resolveNpmCli(options?: { execPath?: string; env?: NodeJS.ProcessEnv }): string;
export function npmCommand(args: readonly string[]): { file: string; args: string[] };
