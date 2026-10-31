/** Display and navigation hints only; never a backend capability or authorization. */
export function desktopClient(userAgent: string) {
  const match = /(?:^| )PiDesktop\/(\d+\.\d+\.\d+(?:-[\w.-]+)?) PiDesktopBuild\/(\d+)(?: |$)/.exec(userAgent);
  if (!match || match[1]!.length > 80 || !Number.isSafeInteger(Number(match[2]))) return null;
  return { version: match[1]!, build: Number(match[2]), handoff: Number(match[2]) >= 13 };
}
