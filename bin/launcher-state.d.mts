export function observeStopOutcome(activeState: () => Promise<{ nonce?: string } | null>, stopPath: string, nonce: string): Promise<"stopped" | "pending" | "refused">;
