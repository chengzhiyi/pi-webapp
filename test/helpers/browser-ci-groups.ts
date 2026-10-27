import type { PlaywrightTestConfig } from "@playwright/test";

// Partition by filename, not test title: every default-discovered test belongs
// to exactly one group, including newly added tests. Keep each worker serial:
// hosted tests mutate process.env and include resource/GC measurements.
const hostedFile = /(?:^|[/\\])hosted-[^/\\]+\.(?:spec|test)\.[cm]?[jt]sx?$/;
// Keep all 70 cycles on one isolated runner; do not parallelize GC measurements.
const stressFile = /(?:^|[/\\])hosted-stress\.(?:spec|test)\.[cm]?[jt]sx?$/;

export function browserCIGroup(group: string | undefined): Pick<PlaywrightTestConfig, "testMatch" | "testIgnore"> {
  if (group === "general") return { testIgnore: hostedFile };
  if (group === "hosted") return { testMatch: hostedFile, testIgnore: stressFile };
  if (group === "stress") return { testMatch: stressFile };
  throw new Error("PI_WEB_BROWSER_GROUP must be general, hosted or stress");
}
