export default function (pi: any) {
  pi.on("session_start", () => {
    (globalThis as any).__PI_NESTED_EXTENSION_PROBE__.push("self");
  });
}
