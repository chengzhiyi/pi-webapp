export const docsOrigin: string;
export const issuesUrl: string;
export type DocsPage = "home" | "quickStart" | "troubleshooting";
export function docsUrl(page: DocsPage, locale: string): string;
export function isDocsAddress(value: unknown): boolean;
