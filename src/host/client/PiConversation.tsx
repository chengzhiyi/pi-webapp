import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TurnReference, WebSlotName } from "@chengzhiyi/pi-web-protocol";
import type { LoadedPlugin } from "./plugin-runtime.tsx";
import { HeroShell } from "../../../web/src/ui/conversation/EmptyHero.tsx";
import { StateDot, IconFolderOpen16, IconPlusOutline16 } from "../../../web/src/ui/primitives/index.ts";
import conversationCss from "../../../web/src/ui/conversation/ConversationRoot.module.css";
import inputCss from "../../../web/src/ui/conversation/InputBar.module.css";
import heroCss from "../../../web/src/ui/conversation/HeroShell.module.css";
import chatCss from "../../../web/src/ui/chat/ChatView.module.css";
import messageCss from "../../../web/src/ui/chat/MessageItem.module.css";
import type { AttachmentReceipt, ConnectionState, ModelsStatus, SessionView, ViewMessage, ViewBlock } from "./pi-bridge.ts";
import type { CommandOption, ModelOption } from "./pi-bridge.ts";
import { PiMarkdown } from "./PiMarkdown.tsx";
import { ReasoningRow } from "../../../web/src/ui/chat/ReasoningRow.tsx";
import { AgentActivity } from "../../../web/src/ui/chat/AgentActivity.tsx";
import { conversationActivity } from "./conversation-activity.ts";
import { ToolRow, TurnActions, TurnProcess } from "../../../web/src/ui/chat/ProcessRow.tsx";
import { conversationTurns, toolResults, toolViewCalls, type ConversationTurn } from "./conversation-turns.ts";
import { PiTrajectory } from "../../../web/src/ui/trajectory/PiTrajectory.tsx";
import { PiModelSelect } from "../../../web/src/ui/conversation/PiModelSelect.tsx";
import { PiAttachmentItem } from "../../../web/src/ui/conversation/PiAttachmentItem.tsx";
import { PiHistoryImage } from "../../../web/src/ui/conversation/PiHistoryImage.tsx";
import { PiComposerEditor, type ComposerEditorHandle } from "../../../web/src/ui/conversation/PiComposerEditor.tsx";
import { buildComposerCommands, commandText, filterComposerCommands, resolveComposerCommand, type ComposerCommand } from "./composer-commands.ts";
import { executeComposerAction, selectComposerAction } from "./composer-action.ts";
import { PiCommandMenu, builtInCommands } from "../../../web/src/ui/conversation/PiCommandMenu.tsx";
import { FileTypeIcon, fileExtension } from "../../../web/src/ui/primitives/FileTypeIcon.tsx";
import { DropOverlay } from "../../../web/src/ui/conversation/DropOverlay.tsx";
import { displayUserMessage } from "../../contracts/user-message.ts";
import type { PromptDelivery, QueuedPromptAction } from "../../contracts/bridge-contract.ts";
import { PiPromptQueue } from "./PiPromptQueue.tsx";
import { PiPromptControls } from "./PiPromptControls.tsx";
import { localize as t, useLocale } from "../../../web/src/ui/locale/preference.ts";
import { randomUUID } from "./random-uuid.ts";
import { useConversationScroll } from "./use-conversation-scroll.ts";
import "./pi-conversation.css";

interface Props {
  composerInteraction?: ReactNode;
  rightbarControl?: ReactNode;
  renderPluginSlot: (slot: WebSlotName, turn?: TurnReference) => ReactNode;
  renderToolView?: (call: ViewBlock, result: ViewMessage | undefined, running: boolean) => ReactNode;
  plugins: LoadedPlugin[];
  onPluginAction: (pluginId: string, action: string, input?: unknown) => Promise<unknown>;
  session: SessionView | null;
  streaming: ViewMessage | null;
  connection: ConnectionState;
  error: string;
  onSend: (text: string, attachments: string[], delivery?: PromptDelivery) => Promise<void>;
  onUpdateQueuedPrompt: (id: string, revision: number, action: QueuedPromptAction) => Promise<void>;
  onLoadImage: (messageId: string, index: number) => Promise<Blob>;
  onUpload: (file: File, signal?: AbortSignal) => Promise<AttachmentReceipt>;
  onDiscardAttachment: (id: string) => Promise<void>;
  onCompact: () => Promise<void>;
  onNewSession: () => Promise<void>;
  commands: CommandOption[];
  onStop: () => Promise<void>;
  onResume: () => Promise<void>;
  models: ModelOption[];
  modelsStatus: ModelsStatus;
  onConfigureModels: () => void;
  onSetModel: (provider: string, id: string) => Promise<void>;
  onSetThinkingLevel: (level: string) => Promise<void>;
}

function PiMessage({ message, results, loadImage, running = false, onInspect, cwd }: { message: ViewMessage; results: Map<string, ViewMessage>; loadImage: Props["onLoadImage"]; running?: boolean; onInspect?: (id: string) => void; cwd?: string }) {
  if (message.role === "tool" && message.toolCallId && results.has(message.toolCallId)) return null;
  if (message.role === "user") {
    const originalText = message.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n");
    const displayed = message.localFiles
      ? { text: originalText, attachments: message.localFiles.map((file) => ({ name: file.name, image: /\.(?:png|jpe?g|webp|gif)$/iu.test(file.name) || /^image\/(?:png|jpeg|webp|gif)$/.test(file.type) })) }
      : displayUserMessage(originalText);
    const images = message.blocks.map((block, index) => ({ block, index })).filter(({ block }) => block.kind === "image");
    const imageNames = displayed.attachments.filter((attachment) => attachment.image);
    const imageFiles = message.localFiles?.filter((file) => /\.(?:png|jpe?g|webp|gif)$/iu.test(file.name) || /^image\/(?:png|jpeg|webp|gif)$/.test(file.type));
    return (
      <div className={messageCss.userRow} data-message-role="user">
        <div className={messageCss.userStack}>
          {(images.length > 0 || displayed.attachments.some((attachment) => !attachment.image)) && <div className={messageCss.attachmentRow} data-message-attachments>
            {images.map(({ index }, ordinal) => <PiHistoryImage key={index} name={imageNames[ordinal]?.name ?? imageFiles?.[ordinal]?.name ?? t("图片", "Image")} messageId={message.id} index={index} file={imageFiles?.[ordinal]} tile={images.length > 1 || displayed.attachments.length > images.length} loadImage={loadImage} />)}
            {displayed.attachments.filter((attachment) => !attachment.image).map((attachment, index) => <span key={`${attachment.name}-${index}`} className={messageCss.fileCard} title={attachment.name}><FileTypeIcon path={attachment.name} className={messageCss.fileIcon} /><span className={messageCss.fileContent}><span className={messageCss.fileName}>{attachment.name}</span><span className={messageCss.fileMeta}>{fileExtension(attachment.name).toUpperCase()} {t("文件", "file")}</span></span></span>)}
          </div>}
          {displayed.text && <div className={messageCss.bubble}>{displayed.text}</div>}
        </div>
      </div>
    );
  }
  return (
    <div className="pi-message" data-message-role={message.role}>
      {message.blocks.map((block, index) => {
        if (block.kind === "thinking") return <ReasoningRow key={index} text={block.text} running={running} />;
        if (block.kind === "toolCall") return <ToolRow key={block.toolCallId || index} block={block} result={block.toolCallId ? results.get(block.toolCallId) : undefined} running={running} cwd={cwd} onInspect={block.toolCallId && onInspect ? () => onInspect(block.toolCallId!) : undefined} />;
        if (block.kind === "image") return <div className="pi-image-note" key={index}>{block.text}</div>;
        return <PiMarkdown key={index} text={block.text} />;
      })}
    </div>
  );
}

function PiTurn({ turn, results, model, loadImage, onInspect, renderPluginSlot, renderToolView, artifactTools, viewTools, running = false, cwd }: {
  turn: ConversationTurn; results: Map<string, ViewMessage>; model: string | null; loadImage: Props["onLoadImage"]; onInspect: (id: string) => void; renderPluginSlot: Props["renderPluginSlot"]; renderToolView: Props["renderToolView"]; artifactTools: readonly string[]; viewTools: readonly string[]; running?: boolean; cwd?: string;
}) {
  const lastAssistant = [...turn.messages].reverse().find((message) => message.role === "assistant" && message.blocks.some((block) => block.kind === "text" && block.text.trim()));
  const answerBlocks = lastAssistant?.blocks.filter((block) => block.kind === "text") ?? [];
  const process: Array<{ message: ViewMessage; block: ViewBlock; index: number }> = [];
  for (const message of turn.messages) {
    if (message.role !== "assistant") continue;
    message.blocks.forEach((block, index) => {
      if (message === lastAssistant && block.kind === "text") return;
      if (block.kind === "toolCall" && (viewTools.includes(block.toolName ?? "") || artifactTools.includes(block.toolName ?? ""))) return;
      process.push({ message, block, index });
    });
  }
  const [open, setOpen] = useState(false);
  const toolCount = process.filter(({ block }) => block.kind === "toolCall").length;
  const messageCount = new Set(process.filter(({ block }) => block.kind !== "toolCall").map(({ message }) => message.id)).size;
  const answer = answerBlocks.map((block) => block.text).join("\n");
  const expanded = running || open;
  const failures = turn.messages.filter((message) => message.role === "assistant" && message.error);
  return <div className="pi-turn" data-turn={turn.index}>
    {turn.messages.filter((message) => message.role === "user" || message.role === "notice").map((message) => <PiMessage key={message.id} message={message} results={results} loadImage={loadImage} />)}
    {process.length > 0 && <>
      {answerBlocks.length > 0 && <TurnProcess toolCount={toolCount} messageCount={messageCount} open={expanded} onToggle={() => setOpen((value) => !value)} />}
      {(expanded || answerBlocks.length === 0) && <div className="pi-turn-process-content">
        {process.map(({ message, block, index }) => <PiMessage key={`${message.id}-${index}`} message={{ ...message, blocks: [block] }} results={results} loadImage={loadImage} running={message.id === "stream"} cwd={cwd} onInspect={onInspect} />)}
      </div>}
    </>}
    {toolViewCalls(turn.messages, viewTools).map(({ key, call }) => <div key={key} data-tool-view={call.toolName}>{renderToolView?.(call, call.toolCallId ? results.get(call.toolCallId) : undefined, running && !results.has(call.toolCallId ?? ""))}</div>)}
    {answerBlocks.length > 0 && lastAssistant && <PiMessage message={{ ...lastAssistant, blocks: answerBlocks }} results={results} loadImage={loadImage} running={lastAssistant.id === "stream"} />}
    {turn.messages.filter((message) => message.role === "tool" && (!message.toolCallId || !results.has(message.toolCallId))).map((message) => <PiMessage key={message.id} message={message} results={results} loadImage={loadImage} />)}
    {failures.map((message) => <div key={`${message.id}-error`} className="pi-model-error" role="alert"><strong>{t("模型请求失败", "Model request failed")}</strong><span>{/usage limit has been reached/i.test(message.error ?? "") ? t("模型服务的使用额度已耗尽。请切换模型或等待额度恢复后重试。", "The model service usage limit has been reached. Switch models or try again after the limit resets.") : message.error}</span></div>)}
    {!running && failures.length === 0 && (lastAssistant || (turn.usage && turn.usage.totalTokens > 0)) && <TurnActions text={answer} timestamp={lastAssistant?.timestamp} usage={turn.usage} model={lastAssistant?.model ?? model} />}
    {renderPluginSlot("turn.tail", { id: turn.id, completed: !running, messageIds: turn.messages.map((message) => message.id), toolCallIds: turn.messages.flatMap((message) => message.blocks.filter((block) => block.kind === "toolCall" && block.toolCallId).map((block) => block.toolCallId!)) })}
  </div>;
}

interface PendingAttachment {
  key: string;
  file: File;
  discard: (id: string) => Promise<void>;
  status: "uploading" | "ready" | "error";
  receipt?: AttachmentReceipt;
  error?: string;
}

interface ComposerDraft {
  text: string;
  attachments: PendingAttachment[];
  error: string;
}

function PiInputBar({ hero, suspended = false, session, connection, onSend, onUpload, onDiscardAttachment, onStop, onResume, onCompact, onNewSession, commands, models, modelsStatus, onConfigureModels, onSetModel, onSetThinkingLevel, onUpdateQueuedPrompt, renderPluginSlot, plugins, onPluginAction }: Pick<Props, "session" | "connection" | "onUpdateQueuedPrompt" | "onUpload" | "onDiscardAttachment" | "onStop" | "onResume" | "onCompact" | "onNewSession" | "commands" | "models" | "modelsStatus" | "onConfigureModels" | "onSetModel" | "onSetThinkingLevel" | "renderPluginSlot" | "plugins" | "onPluginAction"> & { hero: boolean; suspended?: boolean; onSend: (text: string, attachments: string[], files: File[], delivery?: PromptDelivery) => Promise<void> }) {
  const locale = useLocale();
  // Keep unsent text and uploads scoped to their session for this tab's lifetime.
  // Setters capture the originating key, so late async replies cannot edit another chat.
  const draftKey = session?.sessionId ?? "";
  const [drafts, setDrafts] = useState<Record<string, ComposerDraft>>({});
  const currentDraft = drafts[draftKey];
  const draft = currentDraft?.text ?? "";
  const attachments = currentDraft?.attachments ?? [];
  const attachmentError = currentDraft?.error ?? "";
  const updateDraft = (update: (value: ComposerDraft) => ComposerDraft) => {
    setDrafts(current => ({ ...current, [draftKey]: update(current[draftKey] ?? { text: "", attachments: [], error: "" }) }));
  };
  const setDraft = (text: string) => updateDraft(value => ({ ...value, text }));
  const setAttachments = (value: PendingAttachment[] | ((current: PendingAttachment[]) => PendingAttachment[])) => updateDraft(current => ({ ...current, attachments: typeof value === "function" ? value(current.attachments) : value }));
  const setAttachmentError = (error: string) => updateDraft(value => ({ ...value, error }));
  const draftsRef = useRef(drafts);
  draftsRef.current = drafts;
  const [working, setWorking] = useState(false);
  const [commandMenu, setCommandMenu] = useState<"button" | "slash" | null>(null);
  const [activeCommand, setActiveCommand] = useState(0);
  const [modelOpenSignal, setModelOpenSignal] = useState(0);
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const removedKeys = useRef(new Set<string>());
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<ComposerEditorHandle>(null);
  const currentSessionId = useRef(session?.sessionId);
  currentSessionId.current = session?.sessionId;
  const primaryInFlight = useRef(false);
  const previouslySuspended = useRef(suspended);
  useEffect(() => {
    if (previouslySuspended.current && !suspended) textarea.current?.focus();
    previouslySuspended.current = suspended;
  }, [suspended]);
  const ready = connection === "connected" && session !== null;
  const noModels = ready && modelsStatus === "ready" && models.length === 0;
  const modelSelected = ready && models.some((model) => `${model.provider}/${model.id}` === session.model);
  const running = ready && !session.idle;
  const canAttach = ready && !working && !suspended;
  const canCommand = canAttach && !running;
  const localCommand = attachments.length === 0 && ["/compact", "/new", "/model"].includes(draft.trim());
  const availableCommands = useMemo(() => buildComposerCommands(builtInCommands(), commands, plugins, locale), [commands, plugins, locale]);
  const commandMatch = resolveComposerCommand(draft, availableCommands);
  const pluginCommand = commandMatch?.command.pluginId ? commandMatch.command : undefined;
  const claimToken = commandMatch?.command.input ? `${commandMatch.token}${/\s$/.test(draft) || commandMatch.text ? " " : ""}` : null;
  const claimHint = commandMatch?.command.input && !commandMatch.text ? commandText(commandMatch.command.input.hint, locale) ?? null : null;
  const canSend = canAttach && !session?.interactions?.length && !(running && draft.trimStart().startsWith("/"))
    && (modelsStatus === "ready" && modelSelected || !running && (localCommand || !!pluginCommand))
    && (draft.trim().length > 0 || attachments.length > 0) && attachments.every((item) => item.status === "ready")
    && (!pluginCommand || attachments.length === 0 || pluginCommand.input?.attachments === true);
  const primaryAction = selectComposerAction(plugins, session, locale, draft, attachments.length);
  const PrimaryIcon = primaryAction?.icon;
  const canInvokePrimary = canCommand && (primaryAction?.kind === "resume" || primaryAction?.kind === "invoke")
    && (primaryAction.kind === "invoke" && !primaryAction.sendResultMessage || modelsStatus === "ready" && modelSelected);
  const canStop = running && !working && !suspended;
  const query = commandMenu === "slash" ? draft.slice(1).toLowerCase() : "";
  const visibleCommands = commandMenu === null ? [] : filterComposerCommands(
    running ? availableCommands.filter(command => !command.pluginId && command.name === "file") : availableCommands,
    query, commandMenu === "slash");

  useEffect(() => { setCommandMenu(null); }, [session?.sessionId, running]);
  useEffect(() => () => {
    for (const entry of Object.values(draftsRef.current)) {
      for (const item of entry.attachments) {
        removedKeys.current.add(item.key);
        if (item.receipt) void item.discard(item.receipt.id).catch(() => {});
      }
    }
    for (const controller of uploadControllers.current.values()) controller.abort();
    uploadControllers.current.clear();
  }, []);
  useEffect(() => {
    if (commandMenu === null) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !form.current?.contains(event.target)) setCommandMenu(null); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [commandMenu]);

  const chooseCommand = async (command: ComposerCommand) => {
    if (!canAttach || !canCommand && (command.pluginId || command.name !== "file")) return;
    if (commandMenu === "slash" && ["file", "model", "compact", "new"].includes(command.name)) setDraft("");
    setCommandMenu(null);
    if (!command.pluginId && command.name === "file") { fileInput.current?.click(); return; }
    if (command.pluginId && command.action && command.menuOnly) {
      setWorking(true);
      try { await onPluginAction(command.pluginId, command.action, { args: [] }); setAttachmentError(""); }
      catch (cause) { setAttachmentError(cause instanceof Error ? cause.message : String(cause)); }
      finally { setWorking(false); }
      return;
    }
    if (!command.pluginId && command.name === "model") { setModelOpenSignal((value) => value + 1); return; }
    if (!command.pluginId && (command.name === "compact" || command.name === "new")) {
      setWorking(true);
      try { await (command.name === "compact" ? onCompact() : onNewSession()); }
      catch { /* The bridge reports the request error next to the composer. */ }
      finally { setWorking(false); }
      return;
    }
    setDraft(`/${commandText(command.input?.token, locale) ?? command.name} `);
    textarea.current?.focus();
  };

  const uploadAttachment = useCallback((key: string, file: File) => {
    const controller = new AbortController();
    uploadControllers.current.set(key, controller);
    void onUpload(file, controller.signal).then((receipt) => {
      if (removedKeys.current.has(key)) { void onDiscardAttachment(receipt.id).catch(() => {}); return; }
      setAttachments((current) => current.map((item) => item.key === key ? { ...item, status: "ready", receipt, error: undefined } : item));
    }).catch((cause) => {
      if (removedKeys.current.has(key)) return;
      const message = cause instanceof Error ? cause.message : t("上传失败", "Upload failed");
      setAttachmentError(message);
      setAttachments((current) => current.map((item) => item.key === key ? { ...item, status: "error", error: message } : item));
    }).finally(() => { if (uploadControllers.current.get(key) === controller) uploadControllers.current.delete(key); });
  }, [onUpload, onDiscardAttachment, draftKey]);

  const previousDraftKey = useRef(draftKey);
  useEffect(() => {
    const previous = previousDraftKey.current;
    if (previous === draftKey) return;
    previousDraftKey.current = draftKey;
    // The bridge invalidates receipts on a session switch. Keep the original
    // Files, cancel old uploads, and obtain fresh receipts only on return.
    const outgoing = draftsRef.current[previous];
    for (const item of outgoing?.attachments ?? []) {
      removedKeys.current.add(item.key);
      uploadControllers.current.get(item.key)?.abort();
    }
    const incoming = draftsRef.current[draftKey];
    const restored = (incoming?.attachments ?? []).map(item => ({
      key: randomUUID(), file: item.file, discard: onDiscardAttachment, status: "uploading" as const,
    }));
    setDrafts(current => ({
      ...current,
      ...(outgoing ? { [previous]: { ...outgoing, attachments: outgoing.attachments.map(item => ({ ...item, receipt: undefined, status: "error" as const })) } } : {}),
      ...(incoming ? { [draftKey]: { ...incoming, attachments: restored, error: "" } } : {}),
    }));
    restored.forEach(item => uploadAttachment(item.key, item.file));
  }, [draftKey]);

  const removeAttachment = (item: PendingAttachment) => {
    removedKeys.current.add(item.key);
    uploadControllers.current.get(item.key)?.abort();
    if (item.receipt) void item.discard(item.receipt.id).catch(() => {});
    if (item.status === "error" && !attachments.some((entry) => entry.key !== item.key && entry.status === "error")) setAttachmentError("");
    setAttachments((current) => current.filter((entry) => entry.key !== item.key));
  };

  const addFiles = useCallback((files: File[]) => {
    if (!canAttach || files.length === 0) return;
    const available = Math.max(0, 20 - attachments.length);
    const accepted = files.slice(0, available).filter((file) => file.size > 0 && file.size <= 20 * 1024 * 1024);
    if (accepted.length !== files.length) setAttachmentError(t("最多添加 20 个文件，单个文件不得超过 20 MB 且不能为空", "Add up to 20 nonempty files, each no larger than 20 MB"));
    else setAttachmentError("");
    const pending = accepted.map((file) => ({ key: randomUUID(), file, discard: onDiscardAttachment, status: "uploading" as const }));
    setAttachments((current) => [...current, ...pending]);
    pending.forEach((item) => uploadAttachment(item.key, item.file));
  }, [attachments.length, canAttach, uploadAttachment, onDiscardAttachment]);

  useEffect(() => {
    const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes("Files") ?? false;
    const reset = () => { dragDepth.current = 0; setDragActive(false); };
    const onEnter = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); dragDepth.current++; setDragActive(true); };
    const onOver = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); if (event.dataTransfer) event.dataTransfer.dropEffect = canAttach ? "copy" : "none"; };
    const onLeave = (event: DragEvent) => { if (!hasFiles(event)) return; dragDepth.current = Math.max(0, dragDepth.current - 1); if (dragDepth.current === 0) setDragActive(false); };
    const onDrop = (event: DragEvent) => { if (!hasFiles(event)) return; event.preventDefault(); const files = [...(event.dataTransfer?.files ?? [])]; reset(); addFiles(files); };
    document.addEventListener("dragenter", onEnter);
    document.addEventListener("dragover", onOver);
    document.addEventListener("dragleave", onLeave);
    document.addEventListener("drop", onDrop);
    window.addEventListener("dragend", reset);
    return () => { document.removeEventListener("dragenter", onEnter); document.removeEventListener("dragover", onOver); document.removeEventListener("dragleave", onLeave); document.removeEventListener("drop", onDrop); window.removeEventListener("dragend", reset); };
  }, [canAttach, addFiles]);

  const submit = async (delivery: PromptDelivery | undefined = running ? "followUp" : undefined) => {
    if (!canSend || primaryInFlight.current) return;
    primaryInFlight.current = true;
    setWorking(true);
    const text = draft.trim();
    const sentAttachments = attachments;
    if (!localCommand) {
      setDraft("");
      setAttachments([]);
    }
    try {
      if (localCommand) {
        if (text === "/model") setModelOpenSignal((value) => value + 1);
        else await (text === "/compact" ? onCompact() : onNewSession());
        setDraft("");
      } else if (pluginCommand?.pluginId && pluginCommand.action && commandMatch) {
        setAttachmentError("");
        const result = await onPluginAction(pluginCommand.pluginId, pluginCommand.action, {
          args: commandMatch.text.split(/\s+/).filter(Boolean), text: commandMatch.text,
          attachments: sentAttachments.map(item => item.receipt!.id),
        }) as { message?: string };
        if (typeof result?.message === "string" && result.message) await onSend(result.message, sentAttachments.map(item => item.receipt!.id), sentAttachments.map(item => item.file));
        else if (sentAttachments.length) { setAttachments(sentAttachments); setAttachmentError(t("指令未发送附件，文件仍保留在输入框", "The command did not send the files; they remain in the composer")); }
        setDraft("");
      } else await onSend(text, sentAttachments.map((item) => item.receipt!.id), sentAttachments.map((item) => item.file), delivery);
    } catch {
      if (!localCommand) { setDraft(text); setAttachments(sentAttachments); }
      // The bridge displays request errors next to the composer.
    } finally {
      primaryInFlight.current = false;
      setWorking(false);
    }
  };
  const stop = async () => {
    if (!canStop || primaryInFlight.current) return;
    primaryInFlight.current = true;
    setWorking(true);
    try { await onStop(); }
    catch { /* The bridge displays request errors next to the composer. */ }
    finally { primaryInFlight.current = false; setWorking(false); }
  };

  const invokePrimary = async () => {
    if (!canInvokePrimary || !primaryAction || primaryInFlight.current) return;
    primaryInFlight.current = true;
    setWorking(true);
    setAttachmentError("");
    try {
      await executeComposerAction(primaryAction, onPluginAction, message => onSend(message, [], []), onStop, () => currentSessionId.current, onResume);
    } catch (error) {
      if (primaryAction.kind !== "resume" && currentSessionId.current === primaryAction.sessionId) setAttachmentError(error instanceof Error ? error.message : String(error));
    } finally {
      primaryInFlight.current = false;
      setWorking(false);
    }
  };

  return (
    <div hidden={suspended} className={`${inputCss.root} ${hero ? inputCss.hero : ""} ${suspended ? inputCss.suspended : ""}`}>
      {dragActive && <DropOverlay disabled={!canAttach} labels={{ title: canAttach ? t("松开以上传文件", "Drop to upload files") : t("当前无法上传文件", "Files cannot be uploaded now"), desc: canAttach ? t("最多 20 个文件，每个不超过 20 MB", "Up to 20 files, 20 MB each") : undefined }} />}
      <PiPromptQueue key={session?.sessionId} session={session} onUpdate={onUpdateQueuedPrompt} connected={ready} />
      <form ref={form} className={inputCss.card} data-composer-card onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {commandMenu !== null && <PiCommandMenu commands={visibleCommands} active={activeCommand} grouped={!query} onHover={setActiveCommand} onPick={(command) => { void chooseCommand(command); }} />}
        <input ref={fileInput} className="pi-file-input" type="file" multiple tabIndex={-1} aria-label={t("选择要上传的文件", "Choose files to upload")} onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
        {attachments.length > 0 && <div className="pi-attachment-rail" role="group" aria-label={t("待发送附件", "Pending attachments")}>
          {attachments.map((item) => <PiAttachmentItem key={item.key} file={item.file} status={item.status} error={item.error} onRemove={() => removeAttachment(item)} onRetry={() => { setAttachmentError(""); setAttachments((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: "uploading", error: undefined } : entry)); uploadAttachment(item.key, item.file); }} />)}
        </div>}
        <PiComposerEditor ref={textarea} value={draft} claimToken={claimToken} hint={claimHint}
          editable={ready && !working && !suspended} placeholder={noModels ? t("先连接模型，再开始对话", "Connect a model to start chatting") : ready && modelsStatus === "ready" && !modelSelected ? t("先选择模型，再开始对话", "Choose a model to start chatting") : ready ? (session && plugins.map((plugin) => plugin.definition.composerPlaceholder?.(session, locale)).find(Boolean) || t("给 Pi 发送消息", "Message Pi")) : t("打开 Pi 中 /web 给出的完整地址", "Open the full address provided by /web in Pi")}
          ariaLabel={t("给当前 Pi 会话发送消息", "Send a message to the current Pi session")}
          menuOpen={commandMenu !== null} activeOption={commandMenu !== null && visibleCommands[activeCommand] ? `pi-command-${activeCommand}` : undefined}
          onChange={(next) => {
            setDraft(next);
            if (canCommand && /^\/[^\s]*$/.test(next)) { setCommandMenu("slash"); setActiveCommand(0); }
            else if (commandMenu === "slash") setCommandMenu(null);
          }}
          onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); addFiles(files); } }}
          onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (commandMenu !== null) {
                  if (event.key === "Escape") { event.preventDefault(); setCommandMenu(null); return; }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveCommand((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + visibleCommands.length) % Math.max(visibleCommands.length, 1));
                    return;
                  }
                  if ((event.key === "Enter" || event.key === "Tab") && visibleCommands[activeCommand]) { event.preventDefault(); void chooseCommand(visibleCommands[activeCommand]); return; }
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit(running && (event.ctrlKey || event.metaKey) ? "steer" : running ? "followUp" : undefined);
                }
              }}
        />
        <div className={inputCss.row}>
          <div className={inputCss.tools}>
            <button className={inputCss.add} type="button" aria-label={t("添加指令", "Add command")} title={t("添加指令", "Add command")} aria-haspopup="listbox" aria-expanded={commandMenu !== null} disabled={!canAttach} onMouseDown={(event) => event.preventDefault()} onClick={() => { setCommandMenu(commandMenu === null ? "button" : null); setActiveCommand(0); textarea.current?.focus(); }}><IconPlusOutline16 size={16} /></button>
            {renderPluginSlot("composer.controls")}
          </div>
          <div className={inputCss.trailing}>
            {noModels ? <button className="pi-model-setup-trigger" type="button" onClick={onConfigureModels}>{t("配置模型", "Set up a model")}</button> : <PiModelSelect openSignal={modelOpenSignal} current={session?.model ?? null} models={models} disabled={!ready || !session?.idle} onSelect={onSetModel} thinkingLevel={session?.thinkingLevel ?? null} thinkingLevels={session?.thinkingLevels ?? []} onSelectThinkingLevel={onSetThinkingLevel} />}
            {running
              ? <PiPromptControls hasDraft={draft.trim().length > 0 || attachments.length > 0} canSend={canSend} canStop={canStop}
                  pauseLabel={primaryAction?.label ?? t("暂停执行", "Pause")} pauseTitle={primaryAction?.title} pauseIcon={PrimaryIcon ? <PrimaryIcon size={16} /> : undefined}
                  onStop={() => { void stop(); }} />
              : primaryAction?.kind === "invoke" || primaryAction?.kind === "resume" ? <button className={inputCss.primary} type="button" aria-label={primaryAction.label} title={primaryAction.title} disabled={!canInvokePrimary} onClick={() => { void invokePrimary(); }}>{PrimaryIcon ? <PrimaryIcon size={16} /> : <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5 2.5 13 8l-8 5.5z" fill="currentColor" /></svg>}</button>
              : <button className={inputCss.primary} type="submit" aria-label={t("发送消息", "Send message")} disabled={!canSend}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" /></svg></button>}
          </div>
        </div>
        {running && draft.trimStart().startsWith("/") && <div className="pi-prompt-hint">{t("运行中不执行斜杠指令，请等待当前回复结束", "Wait for the current reply before running slash commands")}</div>}
      </form>
      {attachmentError && <div className="pi-error" role="alert">{attachmentError}</div>}
    </div>
  );
}

export function PiConversation({ rightbarControl, composerInteraction, session, streaming, connection, error, onSend, onLoadImage, onUpload, onDiscardAttachment, onStop, onResume, onCompact, onNewSession, commands, models, modelsStatus, onConfigureModels, onSetModel, onSetThinkingLevel, onUpdateQueuedPrompt, renderPluginSlot, renderToolView, plugins, onPluginAction }: Props) {
  const [activeTab, setActiveTab] = useState<"chat" | "trajectory">("chat");
  const [inspectCallId, setInspectCallId] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<{ id: string; sessionId: string; text: string; files: File[]; knownIds: Set<string>; timestamp: string } | null>(null);
  const confirmed = optimistic && session?.sessionId === optimistic.sessionId && session.messages.some((message) => message.role === "user" && !optimistic.knownIds.has(message.id) && displayUserMessage(message.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n")).text === optimistic.text);
  useEffect(() => {
    if (optimistic && (confirmed || (session && session.sessionId !== optimistic.sessionId))) setOptimistic(null);
  }, [optimistic, confirmed, session?.sessionId]);
  const pending = optimistic && !confirmed && session?.sessionId === optimistic.sessionId ? {
    id: optimistic.id, role: "user" as const, timestamp: optimistic.timestamp,
    blocks: [{ kind: "text" as const, text: optimistic.text }, ...optimistic.files.filter((file) => /\.(?:png|jpe?g|webp|gif)$/iu.test(file.name) || /^image\/(?:png|jpeg|webp|gif)$/.test(file.type)).map(() => ({ kind: "image" as const, text: "" }))],
    localFiles: optimistic.files,
  } : null;
  const activity = conversationActivity(session, streaming, connection, pending !== null);
  const empty = session === null || (session.messages.length === 0 && streaming === null && pending === null && activity === null);
  const sendWithEcho = async (text: string, attachments: string[], files: File[], delivery?: PromptDelivery) => {
    if (!session) return;
    // Queued prompts stay out of the transcript until Pi actually consumes them.
    if (delivery) { await onSend(text, attachments, delivery); return; }
    const id = `pending-${randomUUID()}`;
    setOptimistic({ id, sessionId: session.sessionId, text, files, knownIds: new Set(session.messages.map((message) => message.id)), timestamp: new Date().toISOString() });
    try { await onSend(text, attachments); }
    catch (cause) { setOptimistic((current) => current?.id === id ? null : current); throw cause; }
  };
  const root = useRef<HTMLDivElement>(null);
  const { scroll, content, composer, onScroll, onWheel, showLatest, returnToLatest } = useConversationScroll(session?.sessionId, !empty && activeTab === "chat", pending?.id);
  const [columnWidth, setColumnWidth] = useState(0);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    const measure = () => setColumnWidth(element.getBoundingClientRect().width);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const workspace = session?.cwd.split(/[\\/]/).filter(Boolean).at(-1) || t("Pi 工作区", "Pi workspace");
  const liveMessages = [...(session?.messages ?? []), ...(pending ? [pending] : []), ...(streaming ? [streaming] : [])];
  const results = toolResults(liveMessages);
  const turns = conversationTurns(liveMessages);
  const heroText = (key: string) => ({
    "hero.headline": t("有什么可以帮你？", "How can I help?"),
    "hero.preview": "Pi",
  })[key] ?? key;

  return (
    <div ref={root} className={conversationCss.root} data-phase={empty ? "hero" : "active"} style={{ "--piw-conversation-column-width": `${columnWidth}px` } as React.CSSProperties}>
      {empty && <div className={conversationCss.heroTools}>{rightbarControl}</div>}
      {session && !empty && <header className={conversationCss.header}>
        <div className={conversationCss.titleRow}>
          <div className={conversationCss.titleCluster}>
            <div className={conversationCss.crumbs}>
              <span className={`${conversationCss.crumb} ${conversationCss.crumbCurrent}`}>{session.name}</span>
            </div>
          </div>
          <div className={conversationCss.headerActions}>{rightbarControl}<StateDot state={connection === "connected" ? session.idle ? "done" : "ongoing" : "error"} /><span className="pi-header-state">{connection === "connected" ? session.idle ? t("已连接", "Connected") : t("运行中", "Running") : t("已断开", "Disconnected")}</span></div>
        </div>
        <div className={conversationCss.tabs} role="tablist" aria-label={t("会话视图", "Session views")}>
          <button className={`${conversationCss.tab} ${activeTab === "chat" ? conversationCss.tabActive : ""}`} role="tab" aria-selected={activeTab === "chat"} type="button" onClick={() => setActiveTab("chat")}>{t("对话", "Chat")}</button>
          <button className={`${conversationCss.tab} ${activeTab === "trajectory" ? conversationCss.tabActive : ""}`} role="tab" aria-selected={activeTab === "trajectory"} type="button" onClick={() => setActiveTab("trajectory")}>{t("轨迹", "Trajectory")}</button>
        </div>
      </header>}
      <div className={conversationCss.body}>
        <div ref={scroll} className={conversationCss.scrollBody} data-conversation-scroll="" onScroll={onScroll} onWheel={onWheel}>
          {!empty && <div ref={content} className={conversationCss.viewArea}>{activeTab === "chat" ? <div className={chatCss.root}><div className={chatCss.scroll}><div className={chatCss.column}>
            <>
              {turns.map((turn) => <PiTurn turn={turn} key={turn.id} results={results} model={session?.model ?? null} loadImage={onLoadImage} cwd={session?.cwd} renderPluginSlot={renderPluginSlot} renderToolView={renderToolView} viewTools={plugins.flatMap(plugin => plugin.definition.workbench?.toolViews?.flatMap(view => view.tools) ?? [])} artifactTools={plugins.flatMap((plugin) => plugin.definition.artifactTools ?? [])} running={turn === turns.at(-1) && !session?.idle || turn.messages.some((message) => message.id === "stream")} onInspect={(id) => { setInspectCallId(id); setActiveTab("trajectory"); }} />)}
              {activity && <AgentActivity state={activity} />}
            </>
          </div></div></div> : <PiTrajectory messages={liveMessages} inspectCallId={inspectCallId} />}</div>}
          <div ref={composer} className={conversationCss.composerSeat} data-composer-seat="">
            <div className={`${conversationCss.composerStack} ${empty ? conversationCss.composerHero : ""}`}>
              {empty && <HeroShell t={heroText} renderSlot={(_key: string, _props: unknown, options?: { fallback?: React.ReactNode }) => options?.fallback ?? null} />}
              {empty && <div className={conversationCss.heroWorkspaceRow}><span className={heroCss.workspace}><IconFolderOpen16 size={16} /><span className={heroCss.workspaceLabel}>{workspace}</span></span></div>}
              {composerInteraction}
              <PiInputBar suspended={composerInteraction !== undefined && composerInteraction !== null} hero={empty} session={session} connection={connection} onSend={sendWithEcho} onUpdateQueuedPrompt={onUpdateQueuedPrompt} onUpload={onUpload} onDiscardAttachment={onDiscardAttachment} onStop={onStop} onResume={onResume} onCompact={onCompact} onNewSession={onNewSession} commands={commands} models={models} modelsStatus={modelsStatus} onConfigureModels={onConfigureModels} onSetModel={onSetModel} onSetThinkingLevel={onSetThinkingLevel} renderPluginSlot={renderPluginSlot} plugins={plugins} onPluginAction={onPluginAction} />
              {error && <div className="pi-error" role="alert">{error}</div>}
            </div>
          </div>
          {showLatest && <div className={chatCss.toBottomSlot}>
            <button className={chatCss.toBottom} type="button" aria-label={t("回到最新", "Back to latest")} title={t("回到最新并继续跟随", "Back to latest and resume following")} onClick={returnToLatest}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8 2v12m-5-5 5 5 5-5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>}
        </div>
      </div>
    </div>
  );
}
