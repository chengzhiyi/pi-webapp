export type OpenPageRunner = (command: string, args: readonly string[]) => Promise<void>;
export declare function openWebPage(url: string, platform?: NodeJS.Platform, env?: NodeJS.ProcessEnv, run?: OpenPageRunner): Promise<boolean>;
