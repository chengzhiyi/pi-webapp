import assert from "node:assert/strict";
import test from "node:test";
import { ToolDiagnostics, classifyToolFailure } from "../extension/tool-diagnostics.ts";
import type { DiagnosticFields } from "../shared/telemetry.ts";

const result = (text: string, details?: Record<string, unknown>) => ({ content: [{ type: "text", text }], ...(details ? { details } : {}) });

function harness() {
  let enabled = true;
  let time = 100;
  const events: { cause: unknown; context: DiagnosticFields }[] = [];
  const breadcrumbs: { category: string; context: DiagnosticFields }[] = [];
  const identities = new Map<string, string>();
  const observer = new ToolDiagnostics({
    enabled: () => enabled,
    capture: (cause, context) => { events.push({ cause, context }); return "event-id"; },
    breadcrumb: (category, context) => { breadcrumbs.push({ category, context }); },
    anonymize: (value) => { if (!identities.has(value)) identities.set(value, `anonymous-${identities.size}`); return identities.get(value)!; },
    now: () => time,
  });
  return { observer, events, breadcrumbs, setEnabled: (value: boolean) => { enabled = value; }, setTime: (value: number) => { time = value; } };
}

test("shell failures retain only the final SDK exit status, excluding command output", () => {
  const diagnostic = classifyToolFailure(result("private stdout with secret customer data\n\nCommand exited with code 127"), "bash");
  assert.equal(diagnostic.failureKind, "process_exit");
  assert.equal(diagnostic.exitCode, 127);
  assert.equal(diagnostic.level, "warning");
  assert.equal(diagnostic.originalStackAvailable, false);
  assert.ok(diagnostic.errorSummary?.includes("127"));
  assert.ok(!JSON.stringify(diagnostic).includes("private stdout"));
});

test("shell status-like output before the final line is never interpreted as failure metadata", () => {
  const diagnostic = classifyToolFailure(result("Command exited with code 19\nCommand timed out after 9 seconds\nprivate arbitrary output"), "bash");
  assert.equal(diagnostic.failureKind, "unknown");
  assert.equal(diagnostic.exitCode, undefined);
  assert.equal(diagnostic.timeoutMs, undefined);
  assert.equal(diagnostic.errorSummary, undefined);
  assert.equal(diagnostic.summaryOmitted, true);
  assert.ok(diagnostic.summaryOmittedReason);
});

test("shell timeouts extract the final SDK timeout into milliseconds", () => {
  const diagnostic = classifyToolFailure(result("arbitrary output\n\nCommand timed out after 30 seconds"), "bash");
  assert.equal(diagnostic.failureKind, "timeout");
  assert.equal(diagnostic.timeoutMs, 30_000);
  assert.equal(diagnostic.level, "warning");
  assert.ok(!JSON.stringify(diagnostic).includes("arbitrary output"));
});

test("ENOENT and EACCES diagnostic lines retain codes without filenames or private input", () => {
  for (const [code, kind] of [["ENOENT", "not_found"], ["EACCES", "permission"]]) {
    const text = `${code}: failed to open 'C:\\Users\\jane\\private\\customer.txt' token=private-token jane@example.com https://private.example.com/token\nprivate stdout`;
    const diagnostic = classifyToolFailure(result(text), "read");
    assert.equal(diagnostic.failureKind, kind);
    assert.equal(diagnostic.errorCode, code);
    assert.equal(diagnostic.level, "warning");
    assert.ok(diagnostic.errorSummary?.includes(code!));
    const wire = JSON.stringify(diagnostic);
    for (const secret of ["jane", "customer.txt", "private-token", "private.example.com", "private stdout"]) assert.ok(!wire.includes(secret), secret);
  }
});

test("diagnostic summaries omit relative paths, quoted multi-line text and credentials", () => {
  const diagnostic = classifyToolFailure(result("ENOENT: cannot open ./secrets/customer.json token=private-token \"first private line\nsecond private line\""), "read");
  const wire = JSON.stringify(diagnostic);
  for (const secret of ["customer.json", "secrets", "private-token", "first private line", "second private line"]) assert.ok(!wire.includes(secret), secret);
});

test("Pi edit matching diagnostics are validation failures without uploading paths or input", () => {
  const path = "C:\\Users\\private-person\\private-token@example.com.txt";
  // Verified against the published Pi 1.0.2 edit-diff diagnostic contract.
  const cases = [
    [`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`, "edit_text_not_found"],
    [`Could not find edits[1] in ${path}. The oldText must match exactly including all whitespace and newlines.`, "edit_text_not_found"],
    [`Found 2 occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`, "edit_text_ambiguous"],
    [`Found 3 occurrences of edits[1] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`, "edit_text_ambiguous"],
    [`oldText must not be empty in ${path}.`, "invalid_arguments"],
    [`edits[1].oldText must not be empty in ${path}.`, "invalid_arguments"],
    [`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`, "edit_no_change"],
    [`No changes made to ${path}. The replacements produced identical content.`, "edit_no_change"],
    [`edits[0] and edits[1] overlap in ${path}. Merge them into one edit or target disjoint regions.`, "edit_overlap"],
  ];
  for (const [message, code] of cases) {
    const diagnostic = classifyToolFailure(result(message!), "edit");
    assert.equal(diagnostic.failureKind, "validation", message);
    assert.equal(diagnostic.errorCode, code);
    assert.equal(diagnostic.level, "warning");
    assert.equal(diagnostic.summaryOmitted, false);
    assert.ok(diagnostic.errorSummary);
    assert.ok(!JSON.stringify(diagnostic).includes("private"));
    assert.equal(classifyToolFailure(result(message!), "bash").failureKind, "unknown");
    const exception = classifyToolFailure(new Error(message), "edit");
    assert.equal(exception.level, "error");
    assert.equal(exception.originalStackAvailable, true);
  }
  for (const message of ["Could not find the exact text in private-file.txt. Unrecognized reason.", `${cases[0]![0]}\nprivate conversation`]) {
    const diagnostic = classifyToolFailure(result(message), "edit");
    assert.equal(diagnostic.failureKind, "unknown");
    assert.equal(diagnostic.errorSummary, undefined);
  }
});

test("arbitrary error output is explicitly unknown and omitted instead of uploaded", () => {
  const diagnostic = classifyToolFailure(result("private conversation and the command supplied by the user"), "custom_tool");
  assert.equal(diagnostic.failureKind, "unknown");
  assert.equal(diagnostic.level, "error");
  assert.equal(diagnostic.originalStackAvailable, false);
  assert.equal(diagnostic.summaryOmitted, true);
  assert.equal(diagnostic.errorSummary, undefined);
  assert.ok(diagnostic.summaryOmittedReason);
});

test("diagnostic summaries remain at most two lines and 512 characters", () => {
  const diagnostic = classifyToolFailure(result(`ENOENT: ${"x ".repeat(1000)}\nEACCES: permission denied\nENOENT: no such file`), "read");
  assert.ok((diagnostic.errorSummary?.length ?? 0) <= 512);
  assert.ok((diagnostic.errorSummary?.split("\n").length ?? 0) <= 2);
});

test("tool end keeps the start correlation snapshot when another operation becomes current", () => {
  const h = harness();
  const startContext = { requestId: "request-a", operationId: "operation-a", session: "session-a" };
  h.observer.start({ toolCallId: "private-call", toolName: "bash", args: { command: "private command" } }, startContext);
  startContext.operationId = "mutated-after-start";
  h.setTime(150);
  h.observer.end({ toolCallId: "private-call", toolName: "bash", isError: true, result: result("Command exited with code 1") }, { requestId: "request-b", operationId: "operation-b", session: "session-b" });
  assert.equal(h.events.length, 1);
  const event = h.events[0]!.context;
  assert.equal(event.operationId, "operation-a");
  assert.equal(event.requestId, "request-a");
  assert.equal(event.session, "session-a");
  assert.equal(event.durationMs, 50);
  assert.equal(event.diagnosticSource, "tool_execution_end");
  assert.ok(event.toolCallId);
  assert.notEqual(event.toolCallId, "private-call");
  assert.ok(!JSON.stringify([...h.events, ...h.breadcrumbs]).includes("private command"));
});

test("tool end and subsequent toolResult message produce only one failure event", () => {
  const h = harness();
  h.observer.start({ toolCallId: "call-a", toolName: "bash" });
  h.observer.end({ toolCallId: "call-a", toolName: "bash", isError: true, result: result("Command exited with code 1") });
  h.observer.message({ role: "toolResult", toolCallId: "call-a", toolName: "bash", isError: true, content: result("Command exited with code 1").content });
  h.observer.end({ toolCallId: "call-a", toolName: "bash", isError: true, result: result("Command exited with code 1") });
  assert.equal(h.events.length, 1);
});

test("message fallback diagnoses missing execution end without inventing timing or a stack", () => {
  const h = harness();
  h.observer.message({ role: "toolResult", toolCallId: "call-fallback", toolName: "read", isError: true, content: result("ENOENT: no such file or directory, open '/tmp/private/file'").content }, { operationId: "fallback-operation" });
  assert.equal(h.events.length, 1);
  const event = h.events[0]!;
  assert.equal(event.context.diagnosticSource, "message_end");
  assert.equal(event.context.originalStackAvailable, false);
  assert.equal(event.context.durationMs, undefined);
  assert.equal(event.context.operationId, "fallback-operation");
  assert.ok(!(event.cause instanceof Error && event.cause.stack));
});

test("concurrent tools keep separate identities, reasons and operation snapshots", () => {
  const h = harness();
  h.observer.start({ toolCallId: "a", toolName: "bash" }, { operationId: "operation-a" });
  h.observer.start({ toolCallId: "b", toolName: "read" }, { operationId: "operation-b" });
  h.observer.end({ toolCallId: "b", toolName: "read", isError: true, result: result("EACCES: permission denied") });
  h.observer.end({ toolCallId: "a", toolName: "bash", isError: true, result: result("Command exited with code 2") });
  assert.deepEqual(h.events.map(({ context }) => [context.toolName, context.failureKind, context.operationId]), [["read", "permission", "operation-b"], ["bash", "process_exit", "operation-a"]]);
  assert.notEqual(h.events[0]!.context.toolCallId, h.events[1]!.context.toolCallId);
});

test("custom tools expose only a stable anonymous identity", () => {
  const h = harness();
  for (const toolCallId of ["one", "two"]) h.observer.end({ toolCallId, toolName: "company-private-tool", isError: true, result: result("private tool output") });
  assert.equal(h.events.length, 2);
  assert.equal(h.events[0]!.context.toolName, "custom");
  assert.ok(h.events[0]!.context.toolId);
  assert.equal(h.events[0]!.context.toolId, h.events[1]!.context.toolId);
  assert.ok(!JSON.stringify([...h.events, ...h.breadcrumbs]).includes("company-private-tool"));
});

test("explicit cancellation suppresses the marked call but clear never implies cancellation", () => {
  const cancelled = harness();
  cancelled.observer.start({ toolCallId: "cancelled", toolName: "bash" });
  cancelled.observer.cancel();
  cancelled.observer.end({ toolCallId: "cancelled", toolName: "bash", isError: true, result: result("private unknown failure") });
  assert.equal(cancelled.events.length, 0);
  assert.ok(cancelled.breadcrumbs.some(({ context }) => context.failureKind === "cancelled"));

  const cleared = harness();
  cleared.observer.start({ toolCallId: "cleared", toolName: "bash" });
  cleared.observer.clear();
  cleared.observer.end({ toolCallId: "cleared", toolName: "bash", isError: true, result: result("private unknown failure") });
  assert.equal(cleared.events.length, 1);
  assert.equal(cleared.events[0]!.context.failureKind, "unknown");
  assert.equal(cleared.events[0]!.context.durationMs, undefined);
});

test("disabled diagnostics neither inspect results nor retain a start snapshot", () => {
  const h = harness();
  h.setEnabled(false);
  h.observer.start({ toolCallId: "disabled", toolName: "bash" }, { operationId: "private-operation" });
  const unreadable = { get content() { throw new Error("result was inspected while disabled"); } };
  assert.doesNotThrow(() => h.observer.end({ toolCallId: "unused", toolName: "bash", isError: true, result: unreadable }));
  assert.equal(h.events.length, 0);
  assert.equal(h.breadcrumbs.length, 0);
  h.setEnabled(true);
  h.observer.end({ toolCallId: "disabled", toolName: "bash", isError: true, result: result("Command exited with code 1") }, { operationId: "current-operation" });
  assert.equal(h.events[0]!.context.operationId, "current-operation");
  assert.equal(h.events[0]!.context.durationMs, undefined);
});

test("real exceptions retain their original cause and stack and stay error level", () => {
  const h = harness();
  const cause = new Error("underlying failure");
  const error = new TypeError("program failure", { cause });
  const diagnostic = classifyToolFailure(error, "read");
  assert.equal(diagnostic.level, "error");
  assert.equal(diagnostic.originalStackAvailable, true);
  h.observer.end({ toolCallId: "exception", toolName: "read", isError: true, result: error });
  assert.equal(h.events.length, 1);
  const captured = h.events[0]!.cause;
  assert.ok(captured instanceof Error);
  assert.equal(captured.name, "TypeError");
  assert.ok(captured.stack?.includes("tool-diagnostics.test.ts"));
  assert.ok(captured.cause instanceof Error);
  assert.equal(h.events[0]!.context.originalStackAvailable, true);
});

test("telemetry sink exceptions do not escape the observer", () => {
  const observer = new ToolDiagnostics({ enabled: () => true, anonymize: () => "anonymous", capture: () => { throw new Error("capture unavailable"); }, breadcrumb: () => { throw new Error("breadcrumb unavailable"); } });
  assert.doesNotThrow(() => observer.start({ toolCallId: "one", toolName: "bash" }));
  assert.doesNotThrow(() => observer.end({ toolCallId: "one", toolName: "bash", isError: true, result: result("Command exited with code 1") }));
  assert.doesNotThrow(() => observer.cancel());
  assert.doesNotThrow(() => observer.clear());
});

test("only the newest 256 in-progress snapshots are retained", () => {
  const h = harness();
  for (let i = 0; i < 257; i++) h.observer.start({ toolCallId: `call-${i}`, toolName: "bash" }, { operationId: `operation-${i}` });
  h.setTime(500);
  h.observer.end({ toolCallId: "call-0", toolName: "bash", isError: true, result: result("Command exited with code 1") }, { operationId: "current-operation" });
  h.observer.end({ toolCallId: "call-256", toolName: "bash", isError: true, result: result("Command exited with code 1") }, { operationId: "current-operation" });
  assert.equal(h.events[0]!.context.operationId, "current-operation");
  assert.equal(h.events[0]!.context.durationMs, undefined);
  assert.equal(h.events[1]!.context.operationId, "operation-256");
  assert.equal(h.events[1]!.context.durationMs, 400);
});

test("completed-call deduplication retains exactly the newest 256 markers", () => {
  const h = harness();
  for (let i = 0; i < 257; i++) h.observer.end({ toolCallId: `completed-${i}`, toolName: "bash", isError: true, result: result("Command exited with code 1") });
  h.observer.message({ role: "toolResult", toolCallId: "completed-256", toolName: "bash", isError: true, content: result("Command exited with code 1").content });
  assert.equal(h.events.length, 257);
  h.observer.message({ role: "toolResult", toolCallId: "completed-0", toolName: "bash", isError: true, content: result("Command exited with code 1").content });
  assert.equal(h.events.length, 258);
});

test("successful execution end remains authoritative over later fallback messages", () => {
  const h = harness();
  h.observer.start({ toolCallId: "successful", toolName: "read" });
  h.observer.end({ toolCallId: "successful", toolName: "read", isError: false, result: result("private file contents") });
  h.observer.message({ role: "toolResult", toolCallId: "successful", toolName: "read", isError: true, content: result("private fallback failure").content });
  assert.equal(h.events.length, 0);
  assert.ok(!JSON.stringify(h.breadcrumbs).includes("private file contents"));
});

test("SDK abort status is cancellation but an arbitrary mention of aborted is unknown", () => {
  const aborted = classifyToolFailure(result("private stdout\n\nCommand aborted"), "bash");
  assert.equal(aborted.failureKind, "cancelled");
  const arbitrary = classifyToolFailure(result("a task was aborted according to private conversation"), "bash");
  assert.equal(arbitrary.failureKind, "unknown");
  const h = harness();
  h.observer.end({ toolCallId: "aborted", toolName: "bash", isError: true, result: result("Command aborted") });
  assert.equal(h.events.length, 0);
});

test("SDK shell validation messages retain the reason without echoed arguments", () => {
  const diagnostic = classifyToolFailure(result('Validation failed for tool "bash":\nprivate schema details\n\nReceived arguments:\n{"command":"private command","token":"private token"}'), "bash");
  assert.equal(diagnostic.failureKind, "validation");
  assert.equal(diagnostic.errorSummary, "Invalid tool arguments");
  assert.ok(!JSON.stringify(diagnostic).includes("private"));
});

test("large shell output is bounded while preserving the final failure status", () => {
  const diagnostic = classifyToolFailure(result(`${"private output ".repeat(100_000)}\n\nCommand exited with code 2`), "bash");
  assert.equal(diagnostic.exitCode, 2);
  assert.equal(diagnostic.errorSummary, "Command exited with code 2");
});

test("structured exception code wins over message text and arbitrary exception messages are omitted", () => {
  const error = Object.assign(new Error("private unquoted user input token=private-token"), { code: "EACCES" });
  assert.equal(classifyToolFailure(error, "read").failureKind, "permission");
  assert.equal(classifyToolFailure(error, "read").level, "error");
  const h = harness();
  h.observer.end({ toolCallId: "real-error", toolName: "read", result: new TypeError("private unquoted user input"), isError: true });
  const captured = h.events[0]!.cause as Error;
  assert.ok(!captured.message.includes("private"));
  assert.equal(captured.name, "TypeError");
});

test("cancellation does not suppress an independent program exception", () => {
  const h = harness();
  h.observer.start({ toolCallId: "race", toolName: "bash" });
  h.observer.cancel();
  h.observer.end({ toolCallId: "race", toolName: "bash", isError: true, result: new TypeError("private exception") });
  assert.equal(h.events.length, 1);
  assert.equal(h.events[0]!.context.level, "error");
  assert.equal(h.events[0]!.context.originalStackAvailable, true);
});
