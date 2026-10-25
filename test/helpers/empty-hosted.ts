import type { BridgeHost } from "../../src/host/server/transport/bridge.ts";

/** Explicit no-plugin inventory for fake hosts, not a fallback for production. */
export const emptyHosted: NonNullable<BridgeHost["hosted"]> = {
  inventory: async () => ({ plugins: [] }),
  manage: async () => { throw new Error("No hosted fixture management"); },
  action: async () => { throw new Error("No hosted fixture actions"); },
  views: async () => { throw new Error("No hosted fixture views"); },
  asset: async () => null,
};
