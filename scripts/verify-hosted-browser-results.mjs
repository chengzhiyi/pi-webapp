import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const legacyDiagnostic = "diagnostic: HTTP/1.1 socket-pool evidence for the legacy per-view long polls";
const production = [1440, 390].map(width => `real hosted archive + complete host UI + retained SDK hot lifecycle at ${width}px`);

/** Playwright's body-pass count alone is not full hosted lifecycle acceptance. */
export function verifyHostedBrowserResults(report) {
  const summary = { bodyPassed: 0, cleanPassed: 0, diagnosticSkipped: 0, failures: [] };
  const seen = new Set();
  if (!report || !Array.isArray(report.suites)) throw new Error("Expected a Playwright JSON report with suites");
  if (report.errors?.length) summary.failures.push("Playwright reported global errors");
  function visit(suites) {
    for (const suite of suites) {
      visit(suite.suites ?? []);
      for (const spec of suite.specs ?? []) for (const test of spec.tests ?? []) {
        const title = spec.title, results = test.results ?? [];
        seen.add(title);
        const last = results.at(-1);
        if (last?.status === "skipped" && title === legacyDiagnostic && /(?:^|\/)hosted-transport\.spec\.ts$/.test(spec.file ?? suite.file ?? "")) {
          summary.diagnosticSkipped++; continue;
        }
        if (last?.status === "passed") summary.bodyPassed++;
        const annotations = [...(test.annotations ?? []), ...results.flatMap(result => result.annotations ?? [])];
        if (annotations.some(annotation => annotation.type === "shutdown-failed-closed")) {
          summary.failures.push(`${title}: shutdown was not acknowledged`);
        } else if (!results.length || results.some(result => result.status !== "passed")) {
          summary.failures.push(`${title}: failed, skipped, incomplete or retried body`);
        } else summary.cleanPassed++;
      }
    }
  }
  visit(report.suites);
  for (const title of production) if (!seen.has(title)) summary.failures.push(`Required production lifecycle missing: ${title}`);
  return summary;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error("Usage: node scripts/verify-hosted-browser-results.mjs <playwright-report.json>");
    const summary = verifyHostedBrowserResults(JSON.parse(await readFile(process.argv[2], "utf8")));
    console.log(JSON.stringify(summary, null, 2));
    if (summary.failures.length) process.exitCode = 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
