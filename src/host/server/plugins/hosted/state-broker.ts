import { lstat, mkdir, open, realpath, readdir, link, rename, unlink, copyFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import type { HostedInvocation, HostedStateRecord } from "@chengzhiyi/pi-web-protocol";
import { HostedPluginError, isMissing } from "./errors.ts";
import { sha256 } from "./resources.ts";
import { atomicJson, boundedRead, privateDirectory, readJson, readJournal, withStorageLock } from "./storage.ts";

const MAX_STATE = 192 * 1024 * 1024;
const MAX_FILE = 512 * 1024;
export interface ActiveHostedPlugin { version: string; generation: number; stateRef: string; schema: number; enabled: boolean; operationId: string }
export type ActivationTarget = Omit<ActiveHostedPlugin, "generation" | "operationId">;
interface StateEnvelope extends HostedStateRecord { requestId: string; inputHash: string }
interface FileIntent { requestId: string; inputHash: string; nextHash: string; committed: boolean }
interface TransitionJournal { version?: number; before: ActiveHostedPlugin | null; next: ActiveHostedPlugin }
const refValid = (ref: unknown): ref is string => typeof ref === "string" && /^[a-f0-9-]{36}$/.test(ref);
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new HostedPluginError("invalid_input", "Expected object input");
  return input as Record<string, unknown>;
}
function keyOf(input: unknown): string {
  if (typeof input !== "string" || !/^[\w.-]{1,160}$/.test(input) || input === "." || input === "..") throw new HostedPluginError("invalid_input", "Invalid state key");
  return input;
}
function validateActive(value: ActiveHostedPlugin | null): ActiveHostedPlugin | null {
  if (value && (!refValid(value.stateRef) || typeof value.version !== "string" || !Number.isSafeInteger(value.generation) || value.generation < 1 || !Number.isSafeInteger(value.schema) || value.schema < 1 || typeof value.enabled !== "boolean" || typeof value.operationId !== "string")) throw new HostedPluginError("invalid_storage", "Invalid active plugin record");
  return value;
}
/** Owns the only commit path. Every write AND generation transition takes the same disk lock. */
export class HostedStateBroker {
  readonly root: string;
  readonly pluginId: string;
  private readonly legacy?: (invocation: HostedInvocation) => Promise<unknown>;
  private readonly checkpoint?: (stage: "forked" | "prepared" | "committed" | "cleaned") => Promise<void>;
  constructor(storageRoot: string, pluginId: string, legacy?: (invocation: HostedInvocation) => Promise<unknown>,
    checkpoint?: (stage: "forked" | "prepared" | "committed" | "cleaned") => Promise<void>) {
    this.root = join(storageRoot, sha256(pluginId)); this.pluginId = pluginId; this.legacy = legacy; this.checkpoint = checkpoint;
  }
  active(): Promise<ActiveHostedPlugin | null> { return readJson<ActiveHostedPlugin>(join(this.root, "active.json")).then(validateActive); }
  async recover(): Promise<{ active: ActiveHostedPlugin | null; recovered: "none" | "committed" | "not_committed" }> {
    return withStorageLock(this.root, async () => {
      const active = await this.active();
      const journal = await readJournal<TransitionJournal>(join(this.root, "transition.json"));
      if (!journal) return { active, recovered: "none" };
      if (!journal.next || !Object.hasOwn(journal, "before") || Object.keys(journal).some(k => !["version", "before", "next"].includes(k)) || (Object.hasOwn(journal, "version") && journal.version !== 1)) throw new HostedPluginError("invalid_storage", "Invalid activation journal; stop all owners and inspect transition.json");
      validateActive(journal.next);
      validateActive(journal.before);
      const recovered = active?.operationId === journal.next.operationId ? "committed" : "not_committed";
      const same = (a: ActiveHostedPlugin | null, b: ActiveHostedPlugin | null) => a === null || b === null ? a === b :
        (["version", "generation", "stateRef", "schema", "enabled", "operationId"] as const).every(key => a[key] === b[key]);
      if (!same(active, recovered === "committed" ? journal.next : journal.before)) throw new HostedPluginError("gc_recovery_required", "Activation journal does not match the active pointer; original bytes preserved");
      // Active is the atomic source of truth. Never restore an old snapshot over accepted newer edits.
      const before = journal.before;
      if (recovered === "committed" && before && before.stateRef !== active!.stateRef) await atomicJson(join(this.root, "previous.json"), before);
      if (recovered === "committed") {
        const fork = await readJournal<{ version: number; stateRef: string }>(join(this.root, "fork.json"));
        if (fork?.version === 1 && fork.stateRef === active!.stateRef && Object.keys(fork).every(k => ["version", "stateRef"].includes(k))) await unlink(join(this.root, "fork.json"));
      }
      await unlink(join(this.root, "transition.json"));
      return { active, recovered };
    });
  }
  async activate(expectedGeneration: number, target: ActivationTarget): Promise<ActiveHostedPlugin> {
    return withStorageLock(this.root, async () => {
      const before = await this.active();
      if ((before?.generation ?? 0) !== expectedGeneration) throw new HostedPluginError("stale_generation", "Plugin activation changed concurrently");
      const reservation = await readJournal<{ version: number; stateRef: string }>(join(this.root, "fork.json"));
      if (reservation && (reservation.version !== 1 || reservation.stateRef !== target.stateRef || Object.keys(reservation).some(k => !["version", "stateRef"].includes(k)))) throw new HostedPluginError("gc_recovery_required", "Activation refused: unresolved fork.json belongs to another target; stop all owners and inspect it");
      const next = validateActive({ ...target, generation: expectedGeneration + 1, operationId: randomUUID() })!;
      await privateDirectory(join(this.root, "states"));
      await privateDirectory(join(this.root, "states", next.stateRef));
      await atomicJson(join(this.root, "transition.json"), { version: 1, before, next });
      await this.checkpoint?.("prepared");
      try { await atomicJson(join(this.root, "active.json"), next); }
      catch (error) {
        // A directory-fsync error after rename is an ambiguous success, not permission to roll back.
        if ((await this.active())?.operationId !== next.operationId) throw error;
      }
      await this.checkpoint?.("committed");
      // Journal retains before until rollback metadata is durable. Same-state disable preserves it.
      try {
        if (before && before.stateRef !== next.stateRef) await atomicJson(join(this.root, "previous.json"), before);
        await unlink(join(this.root, "transition.json"));
        await unlink(join(this.root, "fork.json")).catch(() => {});
      } catch { /* Active committed: recovery completes metadata; never resume the old generation. */ }
      await this.checkpoint?.("cleaned");
      return next;
    });
  }
  async forkState(expectedGeneration: number): Promise<string> {
    return withStorageLock(this.root, async () => {
      const current = await this.assertGeneration(expectedGeneration, false);
      const next = randomUUID(), directory = join(this.root, "states", next);
      if (await readJournal(join(this.root, "fork.json"))) throw new HostedPluginError("gc_recovery_required", "Unresolved fork.json; stop all owners and inspect the reserved state before retrying");
      await atomicJson(join(this.root, "fork.json"), { version: 1, stateRef: next });
      await privateDirectory(directory);
      const source = join(this.root, "states", current.stateRef);
      for (const name of await readdir(source)) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) throw new HostedPluginError("invalid_storage", "Unexpected state file");
        const bytes = await boundedRead(join(source, name), MAX_STATE);
        if (!bytes) throw new HostedPluginError("invalid_storage", "Missing state file");
        await copyFile(join(source, name), join(directory, name));
      }
      await this.checkpoint?.("forked");
      return next;
    });
  }
  /** Manager calls only after settled replacement; the disk lock excludes every actual commit.
   * Unknown/interrupted transactions block cleanup rather than guessing their references.
   */
  async collect<T>(operation: (references: ActiveHostedPlugin[]) => Promise<T>): Promise<T> {
    return withStorageLock(this.root, async () => {
      for (const name of ["transition.json", "fork.json"]) {
        if (await boundedRead(join(this.root, name), 2 * 1024 * 1024)) throw new HostedPluginError("gc_recovery_required", `GC refused: unresolved ${name}; stop all owners and inspect recovery references`);
      }
      const active = await this.active(), previous = validateActive(await readJournal<ActiveHostedPlugin>(join(this.root, "previous.json")));
      if (!active && await boundedRead(join(this.root, "active.json"), 2 * 1024 * 1024)) throw new HostedPluginError("gc_recovery_required", "GC refused: null active pointer; restore activation metadata before cleanup");
      const references = [active, previous].filter((v): v is ActiveHostedPlugin => !!v);
      const states = join(this.root, "states"); await privateDirectory(states);
      const names = await readdir(states), keep = new Set(references.map(v => v.stateRef));
      // Validate the whole deletion set before touching anything. Never traverse a linked tree.
      for (const name of names) {
        if (!refValid(name)) throw new HostedPluginError("gc_recovery_required", "GC refused: unexpected state directory; inspect states before cleanup");
        const directory = join(states, name), info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new HostedPluginError("gc_recovery_required", "GC refused: linked/non-directory state snapshot");
        for (const file of await readdir(directory)) {
          const stat = await lstat(join(directory, file));
          if (!/^[a-f0-9]{64}\.json$/.test(file) || !stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new HostedPluginError("gc_recovery_required", "GC refused: unexpected snapshot content; original bytes preserved");
          if (!keep.has(name)) {
            const value = await readJson<StateEnvelope | FileIntent>(join(directory, file), MAX_STATE);
            if (!value) throw new HostedPluginError("gc_recovery_required", "GC refused: missing snapshot record");
            if (Object.hasOwn(value, "committed")) {
              const intent = value as FileIntent;
              if (Object.keys(intent).some(k => !["requestId", "inputHash", "nextHash", "committed"].includes(k)) || intent.committed !== true || !/^[a-f0-9]{64}$/.test(intent.inputHash) || !/^[a-f0-9]{64}$/.test(intent.nextHash) || typeof intent.requestId !== "string") throw new HostedPluginError("gc_recovery_required", `GC refused: unresolved file intent in states/${name}; reconcile the workspace save before cleanup`);
            } else {
              if (Object.keys(value).some(k => !["revision", "schema", "value", "requestId", "inputHash"].includes(k))) throw new HostedPluginError("gc_recovery_required", "GC refused: unknown snapshot envelope; original bytes preserved");
              this.validateState(value as StateEnvelope);
            }
          }
        }
      }
      for (const ref of keep) if (!names.includes(ref)) throw new HostedPluginError("gc_recovery_required", "GC refused: referenced snapshot is missing; restore recovery data first");
      const result = await operation(references);
      // A crash can only partially delete unreferenced snapshots; rerunning is idempotent.
      for (const name of names) if (!keep.has(name)) await rm(join(states, name), { recursive: true, force: true });
      return result;
    });
  }
  private async assertGeneration(generation: number, requireEnabled = true): Promise<ActiveHostedPlugin> {
    const active = await this.active();
    if (!active || active.generation !== generation || requireEnabled && !active.enabled) throw new HostedPluginError("stale_generation", "Plugin generation is no longer active");
    return active;
  }
  private scopeKey(request: HostedInvocation): string {
    if (!request.scope || typeof request.scope.cwd !== "string" || !request.scope.cwd || typeof request.scope.sessionId !== "string" || !request.scope.sessionId || typeof request.scope.workspaceId !== "string" || !request.scope.workspaceId) throw new HostedPluginError("invalid_scope", "Missing authenticated plugin scope");
    return JSON.stringify([request.scope.workspaceId, request.scope.cwd, request.scope.sessionId]);
  }
  private statePath(active: ActiveHostedPlugin, request: HostedInvocation, key: string): string {
    return join(this.root, "states", active.stateRef, `${sha256(this.scopeKey(request) + ":state:" + key)}.json`);
  }
  async call(request: HostedInvocation, method: string, raw: unknown): Promise<unknown> {
    if (!Number.isSafeInteger(request.generation) || !/^[\w-]{1,160}$/.test(request.requestId)) throw new HostedPluginError("invalid_lease", "Invalid invocation lease");
    this.scopeKey(request);
    const input = object(raw);
    return withStorageLock(this.root, async () => {
      const active = await this.assertGeneration(request.generation);
      switch (method) {
        case "state.read": {
          const value = await readJson<StateEnvelope>(this.statePath(active, request, keyOf(input.key)), MAX_STATE);
          if (!value) return null;
          this.validateState(value);
          return { revision: value.revision, schema: value.schema, value: value.value };
        }
        case "state.compareAndSwap": {
          const path = this.statePath(active, request, keyOf(input.key));
          if (!Number.isSafeInteger(input.expectedRevision) || (input.expectedRevision as number) < 0 || input.schema !== active.schema || !Object.hasOwn(input, "value")) throw new HostedPluginError("invalid_input", "Invalid state revision or schema");
          if (JSON.stringify(input.value) === undefined) throw new HostedPluginError("invalid_input", "State value must be JSON serializable");
          const bytes = JSON.stringify(input);
          if (Buffer.byteLength(bytes) > MAX_STATE) throw new HostedPluginError("state_too_large", "Plugin state exceeds limit");
          const previous = await readJson<StateEnvelope>(path, MAX_STATE);
          if (previous) this.validateState(previous);
          const inputHash = sha256(bytes);
          if (previous?.requestId === request.requestId && previous.inputHash === inputHash) return { revision: previous.revision, schema: previous.schema, value: previous.value };
          if ((previous?.revision ?? 0) !== input.expectedRevision) throw new HostedPluginError("revision_conflict", "Plugin state changed concurrently");
          const next: StateEnvelope = { revision: (input.expectedRevision as number) + 1, schema: active.schema, value: input.value, requestId: request.requestId, inputHash };
          await atomicJson(path, next);
          return { revision: next.revision, schema: next.schema, value: next.value };
        }
        case "workspace.read": {
          const { target } = await this.fileTarget(request.scope.cwd, input.path);
          const max = input.maxBytes === undefined ? MAX_FILE : input.maxBytes;
          if (!Number.isSafeInteger(max) || (max as number) <= 0 || (max as number) > MAX_FILE) throw new HostedPluginError("invalid_input", "Invalid workspace read limit");
          const bytes = await boundedRead(target, max as number);
          if (!bytes) return null;
          return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes), hash: sha256(bytes) };
        }
        case "workspace.commit": return this.commitFile(active, request, input);
        case "legacy.read": return this.legacy ? this.legacy(request) : null;
        default: throw new HostedPluginError("method_denied", "Unknown host broker method");
      }
    });
  }
  private validateState(value: StateEnvelope) {
    if (!Number.isSafeInteger(value.revision) || value.revision < 1 || !Number.isSafeInteger(value.schema) || value.schema < 1 || !Object.hasOwn(value, "value") || typeof value.requestId !== "string" || !/^[a-f0-9]{64}$/.test(value.inputHash)) throw new HostedPluginError("invalid_storage", "Invalid plugin state; original bytes preserved");
  }
  private async fileTarget(cwd: string, path: unknown, createParent = false): Promise<{ target: string; parent: string }> {
    if (typeof path !== "string" || path.length > 4096 || !path.endsWith(".excalidraw") || path.includes("\\") || path.includes("\0") || isAbsolute(path) || win32.isAbsolute(path)) throw new HostedPluginError("invalid_path", "Use a workspace-relative .excalidraw path");
    const root = await realpath(cwd), target = resolve(root, path), rel = relative(root, target);
    if (!rel || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new HostedPluginError("invalid_path", "Workspace path escapes root");
    let current = root;
    const parts = rel.split(sep);
    for (let i = 0; i < parts.length; i++) {
      current = join(current, parts[i]!);
      let info;
      try { info = await lstat(current); }
      catch (error) {
        if (!isMissing(error)) throw error;
        if (i < parts.length - 1) {
          if (!createParent || relative(root, current) !== "diagrams") throw new HostedPluginError("invalid_path", "Workspace directory does not exist");
          try { await mkdir(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
          info = await lstat(current);
        }
      }
      if (info && (info.isSymbolicLink() || (i < parts.length - 1 ? !info.isDirectory() : !info.isFile() || info.nlink !== 1))) throw new HostedPluginError("invalid_path", "Workspace path contains a link or non-regular file");
    }
    const parent = await realpath(dirname(target));
    if (parent !== root && !parent.startsWith(root + sep)) throw new HostedPluginError("invalid_path", "Workspace directory changed");
    return { target, parent };
  }
  private async commitFile(active: ActiveHostedPlugin, request: HostedInvocation, input: Record<string, unknown>): Promise<{ hash: string }> {
    if (typeof input.text !== "string" || Buffer.byteLength(input.text) > MAX_FILE || !(input.expectedHash === null || typeof input.expectedHash === "string" && /^[a-f0-9]{64}$/.test(input.expectedHash))) throw new HostedPluginError("invalid_input", "Invalid file content or expected hash");
    const { target, parent } = await this.fileTarget(request.scope.cwd, input.path, true);
    const path = join(this.root, "states", active.stateRef, `${sha256(this.scopeKey(request) + ":file:" + request.requestId + ":" + String(input.path))}.json`);
    const inputHash = sha256(JSON.stringify(input)), nextHash = sha256(input.text);
    const intent = await readJson<FileIntent>(path);
    if (intent && (intent.requestId !== request.requestId || intent.inputHash !== inputHash || intent.nextHash !== nextHash)) throw new HostedPluginError("duplicate_request", "Request ID was reused with different content");
    let lock;
    try { lock = await open(`${target}.lock`, "wx", 0o600); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HostedPluginError("file_busy", "Workspace file is locked; original file preserved"); throw error; }
    let temp: string | undefined;
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, requestId: request.requestId }));
      const before = await boundedRead(target, MAX_FILE), beforeHash = before ? sha256(before) : null;
      if (intent && beforeHash === nextHash) return { hash: nextHash }; // Recover a committed intent after a lost response.
      if (intent?.committed || beforeHash !== input.expectedHash) throw new HostedPluginError("file_conflict", "Workspace file already exists or changed externally");
      await atomicJson(path, { requestId: request.requestId, inputHash, nextHash, committed: false } satisfies FileIntent);
      temp = join(parent, `.plugin-${randomUUID()}.tmp`);
      const file = await open(temp, "wx", 0o600);
      try { await file.writeFile(input.text); await file.sync(); } finally { await file.close(); }
      const checked = await this.fileTarget(request.scope.cwd, input.path);
      if (checked.parent !== parent) throw new HostedPluginError("file_conflict", "Workspace directory changed during save");
      const latest = await boundedRead(target, MAX_FILE);
      if ((latest ? sha256(latest) : null) !== input.expectedHash) throw new HostedPluginError("file_conflict", "Workspace file changed during save");
      await this.assertGeneration(request.generation); // Still inside the shared activation/commit lock.
      if (input.expectedHash === null) {
        try { await link(temp, target); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new HostedPluginError("file_conflict", "Workspace file was created concurrently"); throw error; }
        await unlink(temp); temp = undefined;
      } else { await rename(temp, target); temp = undefined; }
      await atomicJson(path, { requestId: request.requestId, inputHash, nextHash, committed: true } satisfies FileIntent);
      return { hash: nextHash };
    } finally { if (temp) await unlink(temp).catch(() => {}); await lock.close(); await unlink(`${target}.lock`); }
  }
}
