import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { TurnReference, WebSlotName } from "@chengzhiyi/pi-web-protocol";
import type { LoadedPlugin } from "./plugin-runtime.tsx";
import { HeroShell } from "../../../web/src/ui/conversation/EmptyHero.tsx";
import { StateDot, IconFolderOpen16, IconPlusOutline16, dismissToast, showToast } from "../../../web/src/ui/primitives/index.ts";
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
import { conversationActivity, conversationIsWorking } from "./conversation-activity.ts";
import { useActivityElapsed } from "./use-activity-elapsed.ts";
import { ToolRow, TurnActions, TurnProcess } from "../../../web/src/ui/chat/ProcessRow.tsx";
import { useHostedTranscript } from "./hosted/transcript.ts";
import { cardAwaitsUser, conversationTurns, toolResults, toolViewCalls, toolViewTurnKey, type ConversationTurn } from "./conversation-turns.ts";
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
import { displayUserMessage, withWorkspaceContext, type WorkspaceTabContext } from "../../contracts/user-message.ts";
import { FloatingComposer, type FloatingComposerApi, type FloatingIconState } from "../../../web/src/ui/conversation/FloatingComposer.tsx";
import floatingCss from "../../../web/src/ui/conversation/FloatingComposer.module.css";
import { formatElapsedSeconds } from "../../../web/src/ui/chat/format-elapsed.ts";
import type { PromptDelivery, QueuedPromptAction } from "../../contracts/bridge-contract.ts";
import { PiPromptQueue } from "./PiPromptQueue.tsx";
import { PiPromptControls } from "./PiPromptControls.tsx";
import { localize as t, useLocale } from "../../../web/src/ui/locale/preference.ts";
import { randomUUID } from "./random-uuid.ts";
import { useConversationScroll } from "./use-conversation-scroll.ts";
import { parseModelError } from "./model-error.ts";
import "./pi-conversation.css";

/** Where the composer floats while the conversation is hidden behind the workspace panel. */
export interface FloatingTarget {
  /** Overlay layer the floating composer renders into. */
  host: HTMLElement;
  /** The workspace panel whose body bounds the composer. */
  panel: HTMLElement | null;
  /** The active workspace tab, offered as the prompt's context. */
  context: WorkspaceTabContext | null;
  /** Bring the conversation back into view. */
  onShowConversation(): void;
}

/** What the floating composer shows about the agent while the transcript is out of view. */
interface FloatingStatus {
  working: boolean;
  label: string;
  elapsedSeconds: number;
  tail: string;
  queued: number;
  latestReply: { id: string; text: string } | null;
}

type ComposerSend = (text: string, attachments: string[], files: File[], delivery?: PromptDelivery, context?: WorkspaceTabContext | null) => Promise<void>;

interface Props {
  floating?: FloatingTarget | null;
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
  onDismissError: () => void;
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

/** Committed calls and results keep their identity while a reply streams, so settled
 * rows skip re-rendering. Subscribing to the locale keeps their labels current. */
const PiToolRow = memo(function PiToolRow({ block, result, running, cwd, onInspect }: { block: ViewBlock; result?: ViewMessage; running: boolean; cwd?: string; onInspect?: (id: string) => void }) {
  useLocale();
  const id = block.toolCallId;
  return <ToolRow block={block} result={result} running={running} cwd={cwd} onInspect={id && onInspect ? () => onInspect(id) : undefined} />;
});

function PiMessage({ message, results, loadImage, running = false, onInspect, cwd }: { message: ViewMessage; results: Map<string, ViewMessage>; loadImage: Props["onLoadImage"]; running?: boolean; onInspect?: (id: string) => void; cwd?: string }) {
  if (message.role === "tool" && message.toolCallId && results.has(message.toolCallId)) return null;
  if (message.role === "user") {
    const originalText = message.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n");
    const parsed = displayUserMessage(originalText);
    const displayed = message.localFiles
      ? { ...parsed, attachments: message.localFiles.map((file) => ({ name: file.name, image: /\.(?:png|jpe?g|webp|gif)$/iu.test(file.name) || /^image\/(?:png|jpeg|webp|gif)$/.test(file.type) })) }
      : parsed;
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
          {displayed.context && <div className="pi-message-context" data-message-context title={t("发送时正在查看的工作区标签页", "Workspace tab in view when this was sent")}>
            <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M2 6h12" stroke="currentColor" strokeWidth="1.3" /></svg>
            <span>{t(`来自 ${displayed.context.detail ?? displayed.context.title}`, `From ${displayed.context.detail ?? displayed.context.title}`)}</span>
          </div>}
        </div>
      </div>
    );
  }
  return (
    <div className="pi-message" data-message-role={message.role}>
      {message.blocks.map((block, index) => {
        if (block.kind === "thinking") return <ReasoningRow key={index} text={block.text} running={running} />;
        if (block.kind === "toolCall") return <PiToolRow key={block.toolCallId || index} block={block} result={block.toolCallId ? results.get(block.toolCallId) : undefined} running={running} cwd={cwd} onInspect={onInspect} />;
        if (block.kind === "image") return <div className="pi-image-note" key={index}>{block.text}</div>;
        return <PiMarkdown key={index} text={block.text} streaming={running} />;
      })}
    </div>
  );
}

function ModelErrorCard({ error, onDismiss }: { error: string; onDismiss: () => void }) {
  const [copied, setCopied] = useState(false);
  const parsed = parseModelError(error);
  const meta = [parsed.status && `HTTP ${parsed.status}`, parsed.type].filter(Boolean).join(" · ");
  const copy = () => { void navigator.clipboard?.writeText(parsed.raw).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); };
  return <div className="pi-model-error" role="alert">
    <div className="pi-model-error-title"><strong>{t("模型请求失败", "Model request failed")}</strong>{meta && <span className="pi-model-error-meta">{meta}</span>}<button type="button" className="pi-error-dismiss" aria-label={t("关闭错误", "Dismiss error")} onClick={onDismiss}>×</button></div>
    <p className="pi-model-error-message">{parsed.usageLimit ? t("模型服务的使用额度已耗尽。请切换模型或等待额度恢复后重试。", "The model service usage limit has been reached. Switch models or try again after the limit resets.") : parsed.message}</p>
    <div className="pi-model-error-footer">{parsed.requestId && <span className="pi-model-error-request" title={t("请求 ID", "Request ID")}>{parsed.requestId}</span>}<button type="button" className="pi-model-error-copy" onClick={copy}>{copied ? t("已复制", "Copied") : t("复制详情", "Copy details")}</button></div>
  </div>;
}

function PiTurn({ turn, results, model, loadImage, onInspect, renderPluginSlot, renderToolView, artifactTools, viewTools, running = false, cwd, superseded = false }: {
  turn: ConversationTurn; results: Map<string, ViewMessage>; model: string | null; loadImage: Props["onLoadImage"]; onInspect: (id: string) => void; renderPluginSlot: Props["renderPluginSlot"]; renderToolView: Props["renderToolView"]; artifactTools: readonly string[]; viewTools: readonly string[]; running?: boolean; cwd?: string; superseded?: boolean;
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
  const [dismissedFailures, setDismissedFailures] = useState<ReadonlySet<string>>(new Set());
  const failedMessages = turn.messages.filter((message) => message.role === "assistant" && message.error);
  const latestAssistant = [...turn.messages].reverse().find((message) => message.role === "assistant");
  const recovered = superseded || Boolean(latestAssistant && !latestAssistant.error && latestAssistant.id !== failedMessages.at(-1)?.id);
  const failures = recovered ? [] : failedMessages.filter((message) => !dismissedFailures.has(message.id));
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
    {failures.map((message) => <ModelErrorCard key={`${message.id}-error`} error={message.error!} onDismiss={() => setDismissedFailures(current => new Set(current).add(message.id))} />)}
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

/**
 * The one composer. While the conversation is hidden it renders the same state
 * (draft, uploads, commands, send rules) into the floating shell instead of the
 * docked card, so nothing is copied between two composers.
 */
function PiInputBar({ hero, suspended = false, floating = null, floatingStatus, renderTranscript, latestTurnHasCard = false, session, connection, onSend, onUpload, onDiscardAttachment, onStop, onResume, onCompact, onNewSession, commands, models, modelsStatus, onConfigureModels, onSetModel, onSetThinkingLevel, onUpdateQueuedPrompt, renderPluginSlot, plugins, onPluginAction }: Pick<Props, "session" | "connection" | "onUpdateQueuedPrompt" | "onUpload" | "onDiscardAttachment" | "onStop" | "onResume" | "onCompact" | "onNewSession" | "commands" | "models" | "modelsStatus" | "onConfigureModels" | "onSetModel" | "onSetThinkingLevel" | "renderPluginSlot" | "plugins" | "onPluginAction"> & { hero: boolean; suspended?: boolean; floating?: FloatingTarget | null; floatingStatus: FloatingStatus; renderTranscript?: () => ReactNode; latestTurnHasCard?: boolean; onSend: ComposerSend }) {
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
  // Composer failures float as a toast so they never push the input bar around.
  useEffect(() => { if (attachmentError) showToast({ key: "composer-error", message: attachmentError }); else dismissToast("composer-error"); }, [attachmentError]);
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

  // Floating placement: the same draft, drawn over the workspace panel.
  const isFloating = floating !== null;
  const hasDraft = draft.trim().length > 0 || attachments.length > 0;
  // The chip follows the active tab until typing starts, then stays pinned to
  // what the user was looking at; sending (an emptied draft) releases it.
  const [pinnedContext, setPinnedContext] = useState<WorkspaceTabContext | null>(null);
  const [contextRemoved, setContextRemoved] = useState(false);
  const hadDraft = useRef(hasDraft);
  useEffect(() => {
    if (hadDraft.current && !hasDraft) { setPinnedContext(null); setContextRemoved(false); }
    else if (hasDraft && !pinnedContext && floating?.context) setPinnedContext(floating.context);
    hadDraft.current = hasDraft;
  }, [hasDraft, floating?.context, pinnedContext]);
  useEffect(() => { setPinnedContext(null); setContextRemoved(false); }, [draftKey]);
  // The pin holds the tab; its live report (selection, open file) still updates while it is in view.
  const sameTab = (a: WorkspaceTabContext | null, b: WorkspaceTabContext | null) => !!a && !!b && a.kind === b.kind && a.contentId === b.contentId && a.title === b.title;
  const chipContext = floating === null || contextRemoved ? null
    : hasDraft && pinnedContext ? sameTab(pinnedContext, floating.context) ? floating.context : pinnedContext
    : floating.context;
  const chipLabel = chipContext ? chipContext.detail ?? chipContext.title : "";
  // The floating composer can unfold the conversation itself; it starts folded.
  const [transcriptOpen, setTranscriptOpen] = useState(false);
  // A turn that ends while the transcript is hidden leaves a reply card.
  const [reply, setReply] = useState<{ id: string; compact: boolean } | null>(null);
  const wasRunning = useRef(running);
  const revealCard = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !running && isFloating) {
      if (latestTurnHasCard) { revealCard.current = true; setReply(null); setTranscriptOpen(true); }
      else if (!transcriptOpen && floatingStatus.latestReply) setReply({ id: floatingStatus.latestReply.id, compact: false });
    }
    wasRunning.current = running;
  }, [running, isFloating, transcriptOpen, latestTurnHasCard, floatingStatus.latestReply]);
  const transcriptScroll = useRef<HTMLDivElement>(null);
  const followTranscript = useRef(true);
  // Keep the newest tool card's end (where plugins put Apply/Keep) in view while it loads and
  // grows, until the user scrolls or interacts; otherwise follow the latest message.
  const alignTranscript = useCallback(() => {
    const element = transcriptScroll.current;
    if (!element) return;
    const card = revealCard.current ? [...element.querySelectorAll<HTMLElement>("[data-tool-view]")].at(-1) : undefined;
    if (card) {
      followTranscript.current = false;
      const view = element.getBoundingClientRect(), box = card.getBoundingClientRect();
      element.scrollTop = box.bottom - view.top + element.scrollTop - view.height + 12;
    } else if (followTranscript.current) element.scrollTop = element.scrollHeight;
  }, []);
  useLayoutEffect(alignTranscript);
  useEffect(() => {
    const content = transcriptScroll.current?.firstElementChild;
    if (!transcriptOpen || !content) return;
    const observer = new ResizeObserver(alignTranscript);
    observer.observe(content);
    const stop = window.setTimeout(() => { revealCard.current = false; }, 8_000);
    return () => { observer.disconnect(); window.clearTimeout(stop); };
  }, [transcriptOpen, alignTranscript]);
  useEffect(() => { if (!isFloating) { setReply(null); setTranscriptOpen(false); } }, [isFloating, draftKey]);
  const openTranscript = (open: boolean) => { followTranscript.current = true; setTranscriptOpen(open); if (open) setReply(null); };
  const needsInput = suspended || !!session?.interactions?.length;
  const floatingApi = useRef<FloatingComposerApi | null>(null);
  // Focus follows the draft across the handoff: the editor remounts in its new place.
  const lastFloating = useRef(isFloating);
  const handoffFocus = useRef(false);
  if (lastFloating.current !== isFloating) {
    handoffFocus.current = !!form.current?.contains(document.activeElement);
    lastFloating.current = isFloating;
  }
  useEffect(() => {
    if (!handoffFocus.current) return;
    handoffFocus.current = false;
    const frame = requestAnimationFrame(() => textarea.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [isFloating]);
  const showConversationThen = (action?: () => void) => {
    floating?.onShowConversation();
    if (action) requestAnimationFrame(action);
  };

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
    // The floating bar carries no model picker: bring the conversation back and open it there.
    if (!command.pluginId && command.name === "model") { if (isFloating) showConversationThen(() => setModelOpenSignal((value) => value + 1)); else setModelOpenSignal((value) => value + 1); return; }
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
    // Floating, the panel underneath (a canvas) keeps its own drops; only the bar accepts files.
    if (isFloating) return;
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
  }, [canAttach, addFiles, isFloating]);

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
        if (text === "/model") { if (isFloating) showConversationThen(() => setModelOpenSignal((value) => value + 1)); else setModelOpenSignal((value) => value + 1); }
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
      } else {
        setReply(null);
        await onSend(text, sentAttachments.map((item) => item.receipt!.id), sentAttachments.map((item) => item.file), delivery, chipContext);
      }
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

  const menuView = commandMenu !== null && <PiCommandMenu commands={visibleCommands} active={activeCommand} grouped={!query} onHover={setActiveCommand} onPick={(command) => { void chooseCommand(command); }} />;
  const fileInputView = <input ref={fileInput} className="pi-file-input" type="file" multiple tabIndex={-1} aria-label={t("选择要上传的文件", "Choose files to upload")} onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />;
  const railView = attachments.length > 0 && <div className="pi-attachment-rail" role="group" aria-label={t("待发送附件", "Pending attachments")}>
          {attachments.map((item) => <PiAttachmentItem key={item.key} file={item.file} status={item.status} error={item.error} onRemove={() => removeAttachment(item)} onRetry={() => { setAttachmentError(""); setAttachments((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: "uploading", error: undefined } : entry)); uploadAttachment(item.key, item.file); }} />)}
        </div>;
  const editorView = <PiComposerEditor ref={textarea} value={draft} claimToken={claimToken} hint={claimHint}
          editable={ready && !working && !suspended} placeholder={ready && !noModels && modelsStatus === "ready" && modelSelected && isFloating ? (chipContext ? t(`询问 Pi 关于「${chipLabel}」…`, `Ask Pi about ${chipLabel}…`) : t("询问 Pi…", "Ask Pi…")) : noModels ? t("先连接模型，再开始对话", "Connect a model to start chatting") : ready && modelsStatus === "ready" && !modelSelected ? t("先选择模型，再开始对话", "Choose a model to start chatting") : ready ? (session && plugins.map((plugin) => plugin.definition.composerPlaceholder?.(session, locale)).find(Boolean) || t("给 Pi 发送消息", "Message Pi")) : t("打开 Pi 中 /web 给出的完整地址", "Open the full address provided by /web in Pi")}
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
                if (event.key === "Escape" && isFloating) { event.preventDefault(); floatingApi.current?.releaseFocus(); return; }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit(running && (event.ctrlKey || event.metaKey) ? "steer" : running ? "followUp" : undefined);
                }
              }}
        />;
  const sendControls = running
              ? <PiPromptControls hasDraft={draft.trim().length > 0 || attachments.length > 0} canSend={canSend} canStop={canStop}
                  pauseLabel={primaryAction?.label ?? t("暂停执行", "Pause")} pauseTitle={primaryAction?.title} pauseIcon={PrimaryIcon ? <PrimaryIcon size={16} /> : undefined}
                  onStop={() => { void stop(); }} />
              : primaryAction?.kind === "invoke" || primaryAction?.kind === "resume" ? <button className={inputCss.primary} type="button" aria-label={primaryAction.label} title={primaryAction.title} disabled={!canInvokePrimary} onClick={() => { void invokePrimary(); }}>{PrimaryIcon ? <PrimaryIcon size={16} /> : <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M5 2.5 13 8l-8 5.5z" fill="currentColor" /></svg>}</button>
              : <button className={inputCss.primary} type="submit" aria-label={t("发送消息", "Send message")} disabled={!canSend}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" /></svg></button>;
  const slashHint = running && draft.trimStart().startsWith("/") && <div className="pi-prompt-hint">{t("运行中不执行斜杠指令，请等待当前回复结束", "Wait for the current reply before running slash commands")}</div>;

  if (floating) {
    const latest = floatingStatus.latestReply;
    const replyText = reply && latest?.id === reply.id ? latest.text : null;
    const iconState: FloatingIconState = !ready ? "offline" : needsInput ? "input" : running ? "running" : replyText ? "unread" : attachmentError ? "error" : "idle";
    const iconLabel = {
      offline: t("Pi 未连接", "Pi is disconnected"), input: t("Pi 需要你的输入", "Pi needs your input"), running: t("Pi 正在处理", "Pi is working"),
      unread: t("Pi 已回复", "Pi replied"), error: t("发送遇到问题", "Something went wrong"), idle: t("询问 Pi", "Ask Pi"),
    }[iconState] + ` · ${/Mac|iPhone|iPad/u.test(navigator.platform) ? "⌘J" : "Ctrl+J"}`;
    const workingLine = <div className={floatingCss.statusLine}>
      <span className={floatingCss.pulse} aria-hidden="true" />
      <span className={floatingCss.statusLabel} role="status" aria-live="polite">{floatingStatus.label}</span>
      <span className={floatingCss.statusMeta} aria-hidden="true">{formatElapsedSeconds(floatingStatus.elapsedSeconds)}{floatingStatus.queued > 0 ? ` · ${t(`排队 ${floatingStatus.queued}`, `+${floatingStatus.queued} queued`)}` : ""}</span>
    </div>;
    const needsInputLine = <div className={floatingCss.statusLine}>
      <svg className={floatingCss.warn} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M8 4.5v4.2M8 10.8v.7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
      <span role="status" aria-live="polite" className={floatingCss.replyTitle}>{t("Pi 需要你的输入", "Pi needs your input")}</span>
      <span className={floatingCss.replyActions}><button type="button" className={floatingCss.textButton} onClick={() => showConversationThen()}>{t("去回答", "Answer")}</button></span>
    </div>;
    const openChat = <button type="button" className={floatingCss.action} aria-label={t("在完整对话中打开", "Open the full chat")} title={t("在完整对话中打开", "Open the full chat")} onClick={() => { setReply(null); showConversationThen(); }}>
      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 8 8M6.5 3.5h-2a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-2" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>;
    const status = transcriptOpen
      ? <div className={floatingCss.transcript} data-floating-transcript>
          <div className={floatingCss.transcriptHead}>
            <span className={floatingCss.replyTitle}>{t("对话", "Conversation")}</span>
            {running && !needsInput && <span className={floatingCss.transcriptState}><span className={floatingCss.pulse} aria-hidden="true" /><span role="status" aria-live="polite">{floatingStatus.label}</span></span>}
            <span className={floatingCss.replyActions}>
              {openChat}
              <button type="button" className={floatingCss.action} aria-label={t("收起对话", "Hide conversation")} title={t("收起对话", "Hide conversation")} aria-expanded onClick={() => openTranscript(false)}>
                <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </button>
            </span>
          </div>
          {needsInput && <div className={floatingCss.transcriptBanner}>{needsInputLine}</div>}
          <div ref={transcriptScroll} className={floatingCss.transcriptBody} data-floating-transcript-body
            onWheel={() => { revealCard.current = false; }} onPointerDown={() => { revealCard.current = false; }} onKeyDown={() => { revealCard.current = false; }}
            onScroll={(event) => { if (revealCard.current) return; const element = event.currentTarget; followTranscript.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24; }}>
            {renderTranscript?.() ?? null}
          </div>
        </div>
      : needsInput ? needsInputLine
      : running
        ? <>
            {workingLine}
            {floatingStatus.tail && <div className={floatingCss.tail}>{floatingStatus.tail}</div>}
          </>
        : replyText !== null && reply
          ? reply.compact
            ? <button type="button" className={floatingCss.summary} onClick={() => setReply({ ...reply, compact: false })}>
                <span role="status" aria-live="polite">{t("Pi 已回复", "Pi replied")}</span><span>{t("查看", "View")}</span>
              </button>
            : <>
                <div className={floatingCss.replyHead}>
                  <span className={floatingCss.replyTitle} role="status" aria-live="polite">{t("Pi 已回复", "Pi replied")}</span>
                  <span className={floatingCss.replyActions}>
                    <button type="button" className={floatingCss.action} aria-label={t("复制回复", "Copy reply")} title={t("复制回复", "Copy reply")} onClick={() => { void navigator.clipboard?.writeText(replyText).catch(() => {}); }}>
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="5" y="5" width="8.5" height="8.5" rx="2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M3.5 10.5h-.2A1.3 1.3 0 0 1 2 9.2V3.3A1.3 1.3 0 0 1 3.3 2h5.9a1.3 1.3 0 0 1 1.3 1.3v.2" fill="none" stroke="currentColor" strokeWidth="1.3" /></svg>
                    </button>
                    {openChat}
                    <button type="button" className={floatingCss.action} aria-label={t("关闭回复", "Dismiss reply")} title={t("关闭回复", "Dismiss reply")} onClick={() => setReply(null)}>
                      <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
                    </button>
                  </span>
                </div>
                <div className={floatingCss.replyBody}><PiMarkdown text={replyText} streaming={false} /></div>
                <div className={floatingCss.replyFoot}><button type="button" className={floatingCss.textButton} onClick={() => openTranscript(true)}>{t("展开对话", "Show conversation")}</button></div>
              </>
          : null;
    const hasFiles = (event: React.DragEvent) => event.dataTransfer.types.includes("Files");
    return <FloatingComposer host={floating.host} bounds={floating.panel} status={status} iconState={iconState} iconLabel={iconLabel}
      labels={{ region: t("询问 Pi", "Ask Pi"), grip: t("移动输入框：方向键移动，Home 复位", "Move composer: arrow keys move, Home resets"), snapHint: t("拖动以移动，双击复位", "Drag to move, double-click to reset") }}
      focusInput={() => textarea.current?.focus()}
      onContentPointerDown={() => setReply(current => current && !current.compact ? { ...current, compact: true } : current)}>
      {api => {
        floatingApi.current = api;
        return <form ref={form} className={floatingCss.form} data-composer-card data-floating-form onSubmit={(event) => { event.preventDefault(); void submit(); }}
          onDragOver={(event) => { if (!hasFiles(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = canAttach ? "copy" : "none"; }}
          onDrop={(event) => { if (!hasFiles(event)) return; event.preventDefault(); addFiles([...event.dataTransfer.files]); }}>
          {menuView}
          {fileInputView}
          {railView}
          <div className={floatingCss.line}>
            {chipContext && <span className={floatingCss.chip} data-pinned={hasDraft || undefined} data-floating-context title={hasDraft ? t(`本条消息会附带「${chipContext.title} · ${chipLabel}」`, `This message is about ${chipContext.title} · ${chipLabel}`) : t(`当前标签页：${chipContext.title}`, `Tab in view: ${chipContext.title}`)}>
              {chipContext.kind === "files" || chipContext.kind === "file-preview"
                ? <FileTypeIcon {...(chipContext.detail ? { path: chipContext.detail.split(" · ")[0]! } : { kind: "folder" as const })} size={14} className={floatingCss.chipIcon} />
                : <svg className={floatingCss.chipIcon} viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M2 6.2h12" stroke="currentColor" strokeWidth="1.3" /></svg>}
              <span className={floatingCss.chipLabel}>{chipLabel}</span>
              <button type="button" className={floatingCss.chipRemove} aria-label={t("不附带标签页上下文", "Remove tab context")} onClick={() => { setContextRemoved(true); textarea.current?.focus(); }}>
                <svg viewBox="0 0 16 16" width="10" height="10" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
              </button>
            </span>}
            <div className={floatingCss.editor}>{editorView}</div>
            <button className={floatingCss.action} type="button" data-active={transcriptOpen || undefined} aria-expanded={transcriptOpen}
              aria-label={transcriptOpen ? t("收起对话", "Hide conversation") : t("展开对话", "Show conversation")} title={transcriptOpen ? t("收起对话", "Hide conversation") : t("展开对话", "Show conversation")}
              onMouseDown={(event) => event.preventDefault()} onClick={() => openTranscript(!transcriptOpen)}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M3 4.6A1.6 1.6 0 0 1 4.6 3h6.8A1.6 1.6 0 0 1 13 4.6v4.8A1.6 1.6 0 0 1 11.4 11H7.2L4.4 13.2V11h0A1.6 1.6 0 0 1 3 9.4z" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
            </button>
            <button className={floatingCss.action} type="button" aria-label={t("添加指令", "Add command")} title={t("添加指令", "Add command")} aria-haspopup="listbox" aria-expanded={commandMenu !== null} disabled={!canAttach} onMouseDown={(event) => event.preventDefault()} onClick={() => { setCommandMenu(commandMenu === null ? "button" : null); setActiveCommand(0); textarea.current?.focus(); }}><IconPlusOutline16 size={16} /></button>
            <button className={floatingCss.action} type="button" aria-label={t("收起输入框", "Collapse composer")} title={t("收起输入框", "Collapse composer")} onMouseDown={(event) => event.preventDefault()} onClick={api.collapse}>
              <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="m4 6 4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <span className={floatingCss.send}>{sendControls}</span>
          </div>
          {slashHint}
        </form>;
      }}
    </FloatingComposer>;
  }

  return (
    <div hidden={suspended} className={`${inputCss.root} ${hero ? inputCss.hero : ""} ${suspended ? inputCss.suspended : ""}`}>
      {dragActive && <DropOverlay disabled={!canAttach} labels={{ title: canAttach ? t("松开以上传文件", "Drop to upload files") : t("当前无法上传文件", "Files cannot be uploaded now"), desc: canAttach ? t("最多 20 个文件，每个不超过 20 MB", "Up to 20 files, 20 MB each") : undefined }} />}
      <PiPromptQueue key={session?.sessionId} session={session} onUpdate={onUpdateQueuedPrompt} connected={ready} />
      <form ref={form} className={inputCss.card} data-composer-card onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {menuView}
        {fileInputView}
        {railView}
        {editorView}
        <div className={inputCss.row}>
          <div className={inputCss.tools}>
            <button className={inputCss.add} type="button" aria-label={t("添加指令", "Add command")} title={t("添加指令", "Add command")} aria-haspopup="listbox" aria-expanded={commandMenu !== null} disabled={!canAttach} onMouseDown={(event) => event.preventDefault()} onClick={() => { setCommandMenu(commandMenu === null ? "button" : null); setActiveCommand(0); textarea.current?.focus(); }}><IconPlusOutline16 size={16} /></button>
            {renderPluginSlot("composer.controls")}
          </div>
          <div className={inputCss.trailing}>
            {noModels ? <button className="pi-model-setup-trigger" type="button" onClick={onConfigureModels}>{t("配置模型", "Set up a model")}</button> : <PiModelSelect openSignal={modelOpenSignal} current={session?.model ?? null} models={models} disabled={!ready || !session?.idle} onSelect={onSetModel} thinkingLevel={session?.thinkingLevel ?? null} thinkingLevels={session?.thinkingLevels ?? []} onSelectThinkingLevel={onSetThinkingLevel} />}
            {sendControls}
          </div>
        </div>
        {slashHint}
      </form>
    </div>
  );
}

/** Condense the live turn for the floating composer: one activity label, the reply's tail, the last answer. */
function floatingSummary(session: SessionView | null, streaming: ViewMessage | null, pending: boolean, working: boolean, elapsedSeconds: number): FloatingStatus {
  const last = streaming?.blocks.at(-1);
  const label = pending && !streaming ? t("正在发送", "Sending")
    : last?.kind === "toolCall" ? t(`正在运行 ${last.toolName ?? "工具"}`, `Running ${last.toolName ?? "a tool"}`)
    : last?.kind === "thinking" ? t("正在思考", "Thinking")
    : last?.kind === "text" && last.text.trim() ? t("正在回复", "Writing a reply")
    : t("正在处理", "Working");
  const streamed = streaming?.blocks.filter(block => block.kind === "text").map(block => block.text).join("\n").trim() ?? "";
  const tail = streamed.length > 240 ? `…${streamed.slice(-240)}` : streamed;
  const queued = (session?.promptQueue?.steering.length ?? 0) + (session?.promptQueue?.followUp.length ?? 0) + (session?.queuedPrompts?.length ?? 0);
  let latestReply: FloatingStatus["latestReply"] = null;
  for (const message of [...(session?.messages ?? [])].reverse()) {
    if (message.role === "user") break;
    if (message.role !== "assistant") continue;
    const text = message.blocks.filter(block => block.kind === "text").map(block => block.text).join("\n\n").trim();
    if (text) { latestReply = { id: message.id, text }; break; }
  }
  return { working, label, elapsedSeconds, tail, queued, latestReply };
}

export function PiConversation({ floating = null, rightbarControl, composerInteraction, session, streaming, connection, error, onDismissError, onSend, onLoadImage, onUpload, onDiscardAttachment, onStop, onResume, onCompact, onNewSession, commands, models, modelsStatus, onConfigureModels, onSetModel, onSetThinkingLevel, onUpdateQueuedPrompt, renderPluginSlot, renderToolView, plugins, onPluginAction }: Props) {
  const [activeTab, setActiveTab] = useState<"chat" | "trajectory">("chat");
  const [inspectCallId, setInspectCallId] = useState<string | null>(null);
  const [optimistic, setOptimistic] = useState<{ id: string; sessionId: string; text: string; wire: string; files: File[]; knownIds: Set<string>; timestamp: string } | null>(null);
  const confirmed = optimistic && session?.sessionId === optimistic.sessionId && session.messages.some((message) => message.role === "user" && !optimistic.knownIds.has(message.id) && displayUserMessage(message.blocks.filter((block) => block.kind === "text").map((block) => block.text).join("\n")).text === optimistic.text);
  useEffect(() => {
    if (optimistic && (confirmed || (session && session.sessionId !== optimistic.sessionId))) setOptimistic(null);
  }, [optimistic, confirmed, session?.sessionId]);
  const pending = optimistic && !confirmed && session?.sessionId === optimistic.sessionId ? {
    id: optimistic.id, role: "user" as const, timestamp: optimistic.timestamp,
    blocks: [{ kind: "text" as const, text: optimistic.wire }, ...optimistic.files.filter((file) => /\.(?:png|jpe?g|webp|gif)$/iu.test(file.name) || /^image\/(?:png|jpeg|webp|gif)$/.test(file.type)).map(() => ({ kind: "image" as const, text: "" }))],
    localFiles: optimistic.files,
  } : null;
  const activity = conversationActivity(session, streaming, connection, pending !== null);
  const working = conversationIsWorking(session, streaming, connection, pending !== null);
  const elapsedSeconds = useActivityElapsed(working, session?.sessionId, session?.activityId);
  const sending = pending !== null;
  const floatingStatus = useMemo(() => floatingSummary(session, streaming, sending, working, elapsedSeconds), [session, streaming, sending, working, elapsedSeconds]);
  const viewTools = useMemo(() => plugins.flatMap(plugin => plugin.definition.workbench?.toolViews?.flatMap(view => view.tools) ?? []), [plugins]);
  const artifactTools = useMemo(() => plugins.flatMap((plugin) => plugin.definition.artifactTools ?? []), [plugins]);
  const inspect = useCallback((id: string) => { setInspectCallId(id); setActiveTab("trajectory"); }, []);
  const transcript = useHostedTranscript(session?.sessionId, [...(session?.messages ?? []), ...(pending ? [pending] : []), ...(streaming ? [streaming] : [])], viewTools);
  const empty = session === null || (transcript.messages.length === 0 && activity === null);
  const dismissError = useRef(onDismissError);
  dismissError.current = onDismissError;
  // Hand each failure to the app-wide toast stack, then clear it so a repeat raises a fresh toast.
  useEffect(() => {
    if (!error) return;
    const parsed = parseModelError(error);
    showToast({ key: "conversation-error", message: parsed.message, detail: parsed.raw !== parsed.message ? parsed.raw : undefined, detailLabel: t("诊断信息", "Diagnostics") });
    dismissError.current();
  }, [error]);
  const retryCleanup = useRef(transcript.retry);
  retryCleanup.current = transcript.retry;
  useEffect(() => {
    if (transcript.error) showToast({ key: "transcript-cleanup", message: transcript.error, action: { label: t("重试视图清理", "Retry view cleanup"), onClick: () => retryCleanup.current() } });
    else dismissToast("transcript-cleanup");
  }, [transcript.error]);
  const sendWithEcho: ComposerSend = async (text, attachments, files, delivery, context) => {
    if (!session) return;
    // The tab reference rides after the user's text; the transcript hides it again.
    const wire = withWorkspaceContext(text, context);
    // Queued prompts stay out of the transcript until Pi actually consumes them.
    if (delivery) { await onSend(wire, attachments, delivery); return; }
    const id = `pending-${randomUUID()}`;
    setOptimistic({ id, sessionId: session.sessionId, text, wire, files, knownIds: new Set(session.messages.map((message) => message.id)), timestamp: new Date().toISOString() });
    try { await onSend(wire, attachments); }
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
  const liveMessages = transcript.messages;
  const results = toolResults(liveMessages);
  const turns = conversationTurns(liveMessages);
  // The floating composer's unfolded conversation renders the same turns as the chat, tool cards
  // included: a plugin's "apply this change" lives in its card, so hiding it would strand the edit.
  // Hosted tool views support several mounts of one call. Recent turns keep it light.
  const renderFloatingTranscript = () => {
    const recent = turns.slice(-20);
    if (recent.length === 0 && !activity) return <p className="pi-floating-transcript-empty">{t("还没有对话。", "No messages yet.")}</p>;
    return <div className="pi-floating-transcript">
      {recent.map((turn) => <PiTurn turn={turn} key={toolViewTurnKey(turn, viewTools)} results={results} model={session?.model ?? null} loadImage={onLoadImage} cwd={session?.cwd} renderPluginSlot={renderPluginSlot} renderToolView={renderToolView} viewTools={viewTools} artifactTools={artifactTools} running={turn === turns.at(-1) && !session?.idle || turn.messages.some((message) => message.id === "stream")} superseded={turn !== turns.at(-1)} onInspect={inspect} />)}
      {activity && <AgentActivity state={activity} elapsedSeconds={elapsedSeconds} />}
    </div>;
  };
  // A finished turn whose tool card still awaits the user (a proposal to apply) opens to that card;
  // an edit already applied in place (on the canvas) leaves the canvas uncovered.
  const latestTurnHasCard = toolViewCalls(turns.at(-1)?.messages ?? [], viewTools)
    .some(({ call }) => cardAwaitsUser(call.toolCallId ? results.get(call.toolCallId) : undefined));
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
              <span className={`${conversationCss.crumb} ${conversationCss.crumbCurrent}`}>{session.name || t("新会话", "New chat")}</span>
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
              {turns.map((turn) => <PiTurn turn={turn} key={toolViewTurnKey(turn, viewTools)} results={results} model={session?.model ?? null} loadImage={onLoadImage} cwd={session?.cwd} renderPluginSlot={renderPluginSlot} renderToolView={renderToolView} viewTools={viewTools} artifactTools={artifactTools} running={turn === turns.at(-1) && !session?.idle || turn.messages.some((message) => message.id === "stream")} superseded={turn !== turns.at(-1)} onInspect={inspect} />)}
              {activity && <AgentActivity state={activity} elapsedSeconds={elapsedSeconds} />}
            </>
          </div></div></div> : <PiTrajectory messages={liveMessages} inspectCallId={inspectCallId} />}</div>}
          <div ref={composer} className={conversationCss.composerSeat} data-composer-seat="">
            <div className={`${conversationCss.composerStack} ${empty ? conversationCss.composerHero : ""}`}>
              {empty && <HeroShell t={heroText} renderSlot={(_key: string, _props: unknown, options?: { fallback?: React.ReactNode }) => options?.fallback ?? null} />}
              {empty && <div className={conversationCss.heroWorkspaceRow}><span className={heroCss.workspace}><IconFolderOpen16 size={16} /><span className={heroCss.workspaceLabel}>{workspace}</span></span></div>}
              {composerInteraction}
              <PiInputBar floating={floating} floatingStatus={floatingStatus} renderTranscript={renderFloatingTranscript} latestTurnHasCard={latestTurnHasCard} suspended={composerInteraction !== undefined && composerInteraction !== null} hero={empty} session={session} connection={connection} onSend={sendWithEcho} onUpdateQueuedPrompt={onUpdateQueuedPrompt} onUpload={onUpload} onDiscardAttachment={onDiscardAttachment} onStop={onStop} onResume={onResume} onCompact={onCompact} onNewSession={onNewSession} commands={commands} models={models} modelsStatus={modelsStatus} onConfigureModels={onConfigureModels} onSetModel={onSetModel} onSetThinkingLevel={onSetThinkingLevel} renderPluginSlot={renderPluginSlot} plugins={plugins} onPluginAction={onPluginAction} />
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
