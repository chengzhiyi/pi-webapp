import type { PlaywrightTestConfig } from "@playwright/test";

// Partition by filename, not test title: every default-discovered test belongs
// to exactly one group, including newly added tests. Keep each worker serial:
// hosted tests mutate process.env and include resource/GC measurements.
const hostedFile = /(?:^|[/\\])hosted-[^/\\]+\.(?:spec|test)\.[cm]?[jt]sx?$/;

export function browserCIGroup(group: string | undefined): Pick<PlaywrightTestConfig, "testMatch" | "testIgnore"> {
  if (group === "general") return { testIgnore: hostedFile };
  if (group === "hosted") return { testMatch: hostedFile };
  throw new Error("PI_WEB_BROWSER_GROUP must be general or hosted");
}
