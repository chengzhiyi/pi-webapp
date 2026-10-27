/** Both release modes retain the exact tarball hash; disabled mode never invents event IDs. */
export function verifyReleaseReceipt(receipt, filename, digest) {
  if (receipt.filename !== filename || receipt.sha256 !== digest) throw new Error("The package has no matching verification receipt");
  if (receipt.telemetryMode === "disabled-by-default") {
    if (receipt.nodeDisabled !== true || receipt.browserDisabled !== true || receipt.nodeEventId !== undefined || receipt.browserEventId !== undefined) throw new Error("The package has no successful disabled-telemetry verification receipt");
  } else if (receipt.telemetryMode === "sentry-live") {
    if (!/^[a-f0-9]{32}$/.test(receipt.nodeEventId) || !/^[a-f0-9]{32}$/.test(receipt.browserEventId)) throw new Error("The package has no successful Sentry verification receipt");
  } else throw new Error("Unknown release telemetry verification mode");
}
