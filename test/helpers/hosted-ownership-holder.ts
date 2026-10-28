import { acquireStorageOwnership } from "../../src/host/server/plugins/hosted/storage.ts";

const [root, name] = process.argv.slice(2);
if (!root || (name !== "runtime" && name !== "transaction")) throw new Error("fixture arguments required");
try {
  const release = await acquireStorageOwnership(root, name);
  process.send?.({ owned: true });
  process.on("message", () => { void release().then(() => process.exit(0)); });
  process.on("disconnect", () => process.exit(1));
} catch (error) {
  process.send?.({ code: (error as { code?: string }).code });
  process.disconnect?.();
}
