export interface HostedBrowserSummary {
  bodyPassed: number;
  cleanPassed: number;
  diagnosticSkipped: number;
  failures: string[];
}
export function verifyHostedBrowserResults(report: unknown, group?: "hosted" | "hosted-ui" | "stress"): HostedBrowserSummary;
