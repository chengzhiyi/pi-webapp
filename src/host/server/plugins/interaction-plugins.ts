import { BUILTIN_IDS } from "../../../contracts/plugins.ts";

/**
 * Whether a plugin may ask the user through the session's interaction host, and have the answer
 * accepted: enabled web extension plugins, plus the built-in plugins (the terminal's input
 * approval), which are not in the web extension catalog. Disabled built-ins never get this far:
 * their agent actions are refused before they can ask.
 */
export function acceptsInteraction(catalog: { has(id: string): boolean } | null | undefined, pluginId: string): boolean {
  return !!catalog?.has(pluginId) || (Object.values(BUILTIN_IDS) as string[]).includes(pluginId);
}
