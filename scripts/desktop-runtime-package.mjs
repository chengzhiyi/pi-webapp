// The bundled backend is pi-webapp, not the dependency-only runtime manifest.
// Preserve declarative admission metadata without changing its pinned dependencies.
export function applyRuntimePackageIdentity(manifest, source) {
  manifest.name = source.name;
  manifest.version = source.version;
  manifest.type = "module";
  for (const key of ["piWebappDesktopProtocol", "piWebappDataVersion", "piWebappHostedRuntime"]) {
    if (Object.hasOwn(source, key)) manifest[key] = structuredClone(source[key]);
    else delete manifest[key];
  }
  return manifest;
}
