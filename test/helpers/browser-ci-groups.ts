import type { PlaywrightTestConfig } from "@playwright/test";

// Partition by filename, not test title: every default-discovered test belongs
// to exactly one group, including newly added tests. Keep each worker serial:
// hosted tests mutate process.env and include resource/GC measurements.
const hostedFile = /(?:^|[/\\])hosted-[^/\\]+\.(?:spec|test)\.[cm]?[jt]sx?$/;
// Keep all 70 cycles on one isolated runner; do not parallelize GC measurements.
const stressFile = /(?:^|[/\\])hosted-stress\.(?:spec|test)\.[cm]?[jt]sx?$/;
// Workspace files account for ~120s of the former ~210s general group. Keep
// their state isolated without parallelizing hosted/GC tests or dropping cases.
const workspaceFile = /(?:^|[/\\])workspace-[^/\\]+\.(?:spec|test)\.[cm]?[jt]sx?$/;
const groupedFile = /(?:^|[/\\])(?:hosted|workspace)-[^/\\]+\.(?:spec|test)\.[cm]?[jt]sx?$/;

export function browserCIGroup(group: string | undefined): Pick<PlaywrightTestConfig, "testMatch" | "testIgnore"> {
  if (group === "general") return { testIgnore: groupedFile };
  if (group === "workspace") return { testMatch: workspaceFile };
  if (group === "hosted") return { testMatch: hostedFile, testIgnore: stressFile };
  if (group === "stress") return { testMatch: stressFile };
  throw new Error("PI_WEB_BROWSER_GROUP must be general, workspace, hosted or stress");
}
