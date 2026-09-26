/** Package source syntax cannot be used as an extension or skill path. */
export function isPackageSource(value: string): boolean {
  return /^(?:npm:|git:|https?:\/\/|ssh:\/\/|git@)/i.test(value.trim());
}
