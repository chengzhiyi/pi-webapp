import { defineConfig } from "@playwright/test";
import base from "./playwright.config.ts";
import { browserCIGroup } from "./test/helpers/browser-ci-groups.ts";

// CI jobs have independent filesystems, processes, reports and browser instances.
// The default local config still discovers the complete suite unchanged.
export default defineConfig(base, browserCIGroup(process.env.PI_WEB_BROWSER_GROUP));
