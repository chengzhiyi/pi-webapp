import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HeroShell } from "./ui/conversation/EmptyHero.tsx";
import { StateDot, IconFolderOpen16, IconPlusOutline16 } from "./ui/primitives/index.ts";
import conversationCss from "./ui/conversation/ConversationRoot.module.css";
import inputCss from "./ui/conversation/InputBar.module.css";
import heroCss from "./ui/conversation/HeroShell.module.css";
import chatCss from "./ui/chat/ChatView.module.css";
import messageCss from "./ui/chat/MessageItem.module.css";
import type { AttachmentReceipt, ConnectionState, SessionView, ViewMessage, ViewBlock } from "./pi-bridge.ts";
import type { CommandOption, ModelOption } from "./pi-bridge.ts";
import { PiMarkdown } from "./PiMarkdown.tsx";
import { ReasoningRow } from "./ui/chat/ReasoningRow.tsx";
import { ToolRow, TurnActions, TurnProcess } from "./ui/chat/ProcessRow.tsx";
import { conversationTurns, toolResults, type ConversationTurn } from "./conversation-turns.ts";
import { PiTrajectory } from "./ui/trajectory/PiTrajectory.tsx";
import { PiModelSelect } from "./ui/conversation/PiModelSelect.tsx";
import { PiAttachmentItem } from "./ui/conversation/PiAttachmentItem.tsx";
import { PiHistoryImage } from "./ui/conversation/PiHistoryImage.tsx";
import { PiCommandMenu, builtInCommands } from "./ui/conversation/PiCommandMenu.tsx";
import { IconPaperclipOutline16 } from "./ui/primitives/icons/index.tsx";
import { FileTypeIcon, fileExtension } from "./ui/primitives/FileTypeIcon.tsx";
import { DropOverlay } from "./ui/conversation/DropOverlay.tsx";
import { displayUserMessage } from "../../shared/user-message.ts";
import "./pi-conversation.css";

interface Props {
  session: SessionView | null;
  streaming: ViewMessage | null;
  connection: ConnectionState;
  error: string;
  onSend: (text: string, attachments: string[]) => Promise<void>;
  onLoadImage: (messageId: string, index: number) => Promise<Blob>;
  onUpload: (file: File, signal?: AbortSignal) => Promise<AttachmentReceipt>;
  onDiscardAttachment: (id: string) => Promise<void>;
  onCompact: () => Promise<void>;
  onNewSession: () => Promise<void>;
  commands: CommandOption[];
  onStop: () => Promise<void>;
  models: ModelOption[];
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
            {images.map(({ index }, ordinal) => <PiHistoryImage key={index} name={imageNames[ordinal]?.name ?? imageFiles?.[ordinal]?.name ?? "图片"} messageId={message.id} index={index} file={imageFiles?.[ordinal]} tile={images.length > 1 || displayed.attachments.length > images.length} loadImage={loadImage} />)}
            {displayed.attachments.filter((attachment) => !attachment.image).map((attachment, index) => <span key={`${attachment.name}-${index}`} className={messageCss.fileCard} title={attachment.name}><FileTypeIcon path={attachment.name} className={messageCss.fileIcon} /><span className={messageCss.fileContent}><span className={messageCss.fileName}>{attachment.name}</span><span className={messageCss.fileMeta}>{fileExtension(attachment.name).toUpperCase()} 文件</span></span></span>)}
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

function PiTurn({ turn, results, model, loadImage, onInspect, running = false, cwd }: {
  turn: ConversationTurn; results: Map<string, ViewMessage>; model: string | null; loadImage: Props["onLoadImage"]; onInspect: (id: string) => void; running?: boolean; cwd?: string;
}) {
  const lastAssistant = [...turn.messages].reverse().find((message) => message.role === "assistant" && message.blocks.some((block) => block.kind === "text" && block.text.trim()));
  const answerBlocks = lastAssistant?.blocks.filter((block) => block.kind === "text") ?? [];
  const process: Array<{ message: ViewMessage; block: ViewBlock; index: number }> = [];
  for (const message of turn.messages) {
    if (message.role !== "assistant") continue;
    message.blocks.forEach((block, index) => {
      if (message === lastAssistant && block.kind === "text") return;
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
    {answerBlocks.length > 0 && lastAssistant && <PiMessage message={{ ...lastAssistant, blocks: answerBlocks }} results={results} loadImage={loadImage} running={lastAssistant.id === "stream"} />}
    {turn.messages.filter((message) => message.role === "tool" && (!message.toolCallId || !results.has(message.toolCallId))).map((message) => <PiMessage key={message.id} message={message} results={results} loadImage={loadImage} />)}
    {failures.map((message) => <div key={`${message.id}-error`} className="pi-model-error" role="alert"><strong>模型请求失败</strong><span>{/usage limit has been reached/i.test(message.error ?? "") ? "模型服务的使用额度已耗尽。请切换模型或等待额度恢复后重试。" : message.error}</span></div>)}
    {!running && failures.length === 0 && (lastAssistant || (turn.usage && turn.usage.totalTokens > 0)) && <TurnActions text={answer} timestamp={lastAssistant?.timestamp} usage={turn.usage} model={lastAssistant?.model ?? model} />}
  </div>;
}

interface PendingAttachment {
  key: string;
  file: File;
  status: "uploading" | "ready" | "error";
  receipt?: AttachmentReceipt;
  error?: string;
}

function PiInputBar({ hero, session, connection, onSend, onUpload, onDiscardAttachment, onStop, onCompact, onNewSession, commands, models, onSetModel, onSetThinkingLevel }: Pick<Props, "session" | "connection" | "onUpload" | "onDiscardAttachment" | "onStop" | "onCompact" | "onNewSession" | "commands" | "models" | "onSetModel" | "onSetThinkingLevel"> & { hero: boolean; onSend: (text: string, attachments: string[], files: File[]) => Promise<void> }) {
  const [draft, setDraft] = useState("");
  const [working, setWorking] = useState(false);
  const [commandMenu, setCommandMenu] = useState<"button" | "slash" | null>(null);
  const [activeCommand, setActiveCommand] = useState(0);
  const [modelOpenSignal, setModelOpenSignal] = useState(0);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState("");
  const [dragActive, setDragActive] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadControllers = useRef(new Map<string, AbortController>());
  const removedKeys = useRef(new Set<string>());
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
  const form = useRef<HTMLFormElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const ready = connection === "connected" && session !== null;
  const canAttach = ready && session.idle && !working;
  const canSend = canAttach && (draft.trim().length > 0 || attachments.length > 0) && attachments.every((item) => item.status === "ready");
  const canStop = ready && !session.idle && !working;
  const availableCommands = useMemo(() => {
    const unique = new Map<string, CommandOption>();
    for (const command of [...builtInCommands, ...commands]) if (!unique.has(command.name)) unique.set(command.name, command);
    return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [commands]);
  const query = commandMenu === "slash" ? draft.slice(1).toLowerCase() : "";
  const visibleCommands = commandMenu === null ? [] : availableCommands.filter((command) => command.name.toLowerCase().includes(query));

  useEffect(() => {
    setAttachments([]); setAttachmentError(""); setCommandMenu(null);
    return () => {
      for (const item of attachmentsRef.current) removedKeys.current.add(item.key);
      for (const controller of uploadControllers.current.values()) controller.abort();
      for (const item of attachmentsRef.current) if (item.receipt) void onDiscardAttachment(item.receipt.id).catch(() => {});
      uploadControllers.current.clear();
    };
  }, [session?.sessionId]);
  useEffect(() => {
    if (commandMenu === null) return;
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !form.current?.contains(event.target)) setCommandMenu(null); };
    document.addEventListener("pointerdown", outside, true);
    return () => document.removeEventListener("pointerdown", outside, true);
  }, [commandMenu]);

  const chooseCommand = async (command: CommandOption) => {
    if (commandMenu === "slash" && ["model", "compact", "new"].includes(command.name)) setDraft("");
    setCommandMenu(null);
    if (command.name === "model") { setModelOpenSignal((value) => value + 1); return; }
    if (command.name === "compact" || command.name === "new") {
      setWorking(true);
      try { await (command.name === "compact" ? onCompact() : onNewSession()); }
      catch { /* The bridge reports the request error next to the composer. */ }
      finally { setWorking(false); }
      return;
    }
    setDraft(`/${command.name} `);
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
      const message = cause instanceof Error ? cause.message : "上传失败";
      setAttachmentError(message);
      setAttachments((current) => current.map((item) => item.key === key ? { ...item, status: "error", error: message } : item));
    }).finally(() => { if (uploadControllers.current.get(key) === controller) uploadControllers.current.delete(key); });
  }, [onUpload, onDiscardAttachment]);

  const removeAttachment = (item: PendingAttachment) => {
    removedKeys.current.add(item.key);
    uploadControllers.current.get(item.key)?.abort();
    if (item.receipt) void onDiscardAttachment(item.receipt.id).catch(() => {});
    if (item.status === "error" && !attachments.some((entry) => entry.key !== item.key && entry.status === "error")) setAttachmentError("");
    setAttachments((current) => current.filter((entry) => entry.key !== item.key));
  };

  const addFiles = useCallback((files: File[]) => {
    if (!canAttach || files.length === 0) return;
    const available = Math.max(0, 20 - attachments.length);
    const accepted = files.slice(0, available).filter((file) => file.size > 0 && file.size <= 20 * 1024 * 1024);
    if (accepted.length !== files.length) setAttachmentError("最多添加 20 个文件，单个文件不得超过 20 MB 且不能为空");
    else setAttachmentError("");
    const pending = accepted.map((file) => ({ key: crypto.randomUUID(), file, status: "uploading" as const }));
    setAttachments((current) => [...current, ...pending]);
    pending.forEach((item) => uploadAttachment(item.key, item.file));
  }, [attachments.length, canAttach, uploadAttachment]);

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

  const submit = async () => {
    if (!canSend) return;
    setWorking(true);
    const text = draft.trim();
    const sentAttachments = attachments;
    const localCommand = attachments.length === 0 && ["/compact", "/new", "/model"].includes(text);
    if (!localCommand) {
      setDraft("");
      setAttachments([]);
      if (textarea.current) textarea.current.style.height = "";
    }
    try {
      if (localCommand) {
        if (text === "/model") setModelOpenSignal((value) => value + 1);
        else await (text === "/compact" ? onCompact() : onNewSession());
        setDraft("");
      } else await onSend(text, sentAttachments.map((item) => item.receipt!.id), sentAttachments.map((item) => item.file));
    } catch {
      if (!localCommand) { setDraft(text); setAttachments(sentAttachments); }
      // The bridge displays request errors next to the composer.
    } finally {
      setWorking(false);
    }
  };
  const stop = async () => {
    if (!canStop) return;
    setWorking(true);
    try { await onStop(); }
    catch { /* The bridge displays request errors next to the composer. */ }
    finally { setWorking(false); }
  };

  return (
    <div className={`${inputCss.root} ${hero ? inputCss.hero : ""}`}>
      {dragActive && <DropOverlay disabled={!canAttach} labels={{ title: canAttach ? "松开以上传文件" : "当前无法上传文件", desc: canAttach ? "最多 20 个文件，每个不超过 20 MB" : undefined }} />}
      <form ref={form} className={inputCss.card} data-composer-card onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {commandMenu !== null && <PiCommandMenu commands={visibleCommands} active={activeCommand} onHover={setActiveCommand} onPick={(command) => { void chooseCommand(command); }} />}
        <input ref={fileInput} className="pi-file-input" type="file" multiple tabIndex={-1} aria-label="选择要上传的文件" onChange={(event) => { addFiles([...(event.target.files ?? [])]); event.target.value = ""; }} />
        {attachments.length > 0 && <div className="pi-attachment-rail" role="group" aria-label="待发送附件">
          {attachments.map((item) => <PiAttachmentItem key={item.key} file={item.file} status={item.status} error={item.error} onRemove={() => removeAttachment(item)} onRetry={() => { setAttachmentError(""); setAttachments((current) => current.map((entry) => entry.key === item.key ? { ...entry, status: "uploading", error: undefined } : entry)); uploadAttachment(item.key, item.file); }} />)}
        </div>}
        <div className={inputCss.scroll} data-input-scroll>
          <div className={inputCss.grow}>
            <textarea
              ref={textarea}
              className="pi-editor"
              aria-label="给当前 Pi 会话发送消息"
              placeholder={ready ? "给 Pi 发送消息" : "打开 Pi 中 /web 给出的完整地址"}
              value={draft}
              onChange={(event) => {
                const next = event.target.value;
                setDraft(next);
                if (/^\/[^\s]*$/.test(next)) { setCommandMenu("slash"); setActiveCommand(0); }
                else if (commandMenu === "slash") setCommandMenu(null);
                event.target.style.height = "auto";
                event.target.style.height = `${Math.min(event.target.scrollHeight, 336)}px`;
              }}
              onPaste={(event) => { const files = [...event.clipboardData.files]; if (files.length) { event.preventDefault(); addFiles(files); } }}
              onKeyDown={(event) => {
                if (commandMenu !== null) {
                  if (event.key === "Escape") { event.preventDefault(); setCommandMenu(null); return; }
                  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                    event.preventDefault();
                    setActiveCommand((index) => (index + (event.key === "ArrowDown" ? 1 : -1) + visibleCommands.length) % Math.max(visibleCommands.length, 1));
                    return;
                  }
                  if (event.key === "Enter" && visibleCommands[activeCommand]) { event.preventDefault(); void chooseCommand(visibleCommands[activeCommand]); return; }
                }
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  void submit();
                }
              }}
            />
          </div>
        </div>
        <div className={inputCss.row}>
          <div className={inputCss.tools}>
            <button className={inputCss.add} type="button" aria-label="添加指令" title="添加指令" aria-haspopup="listbox" aria-expanded={commandMenu !== null} disabled={!canAttach} onMouseDown={(event) => event.preventDefault()} onClick={() => { setCommandMenu(commandMenu === null ? "button" : null); setActiveCommand(0); textarea.current?.focus(); }}><IconPlusOutline16 size={16} /></button>
            <button className={inputCss.add} type="button" aria-label="添加文件" title="添加文件" disabled={!canAttach} onClick={() => fileInput.current?.click()}><IconPaperclipOutline16 size={16} /></button>
            <span className="pi-input-context">当前 Pi 会话</span>
          </div>
          <div className={inputCss.trailing}>
            <PiModelSelect openSignal={modelOpenSignal} current={session?.model ?? null} models={models} disabled={!ready || !session?.idle} onSelect={onSetModel} thinkingLevel={session?.thinkingLevel ?? null} thinkingLevels={session?.thinkingLevels ?? []} onSelectThinkingLevel={onSetThinkingLevel} />
            {canStop
              ? <button className={inputCss.primary} type="button" aria-label="停止运行" onClick={() => { void stop(); }}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><rect x="3" y="3" width="10" height="10" rx="3" fill="currentColor" /></svg></button>
              : <button className={inputCss.primary} type="submit" aria-label="发送消息" disabled={!canSend}><svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><path d="M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z" fill="currentColor" /></svg></button>}
          </div>
        </div>
      </form>
      {attachmentError && <div className="pi-error" role="alert">{attachmentError}</div>}
    </div>
  );
}

export function PiConversation({ session, streaming, connection, error, onSend, onLoadImage, onUpload, onDiscardAttachment, onStop, onCompact, onNewSession, commands, models, onSetModel, onSetThinkingLevel }: Props) {
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
  const empty = session === null || (session.messages.length === 0 && streaming === null && pending === null);
  const sendWithEcho = async (text: string, attachments: string[], files: File[]) => {
    if (!session) return;
    const id = `pending-${crypto.randomUUID()}`;
    setOptimistic({ id, sessionId: session.sessionId, text, files, knownIds: new Set(session.messages.map((message) => message.id)), timestamp: new Date().toISOString() });
    try { await onSend(text, attachments); }
    catch (cause) { setOptimistic((current) => current?.id === id ? null : current); throw cause; }
  };
  const root = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
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
  useEffect(() => { if (!empty && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; }, [empty, session?.messages.length, streaming?.blocks, pending?.id]);
  const workspace = session?.cwd.split(/[\\/]/).filter(Boolean).at(-1) || "Pi 工作区";
  const liveMessages = [...(session?.messages ?? []), ...(pending ? [pending] : []), ...(streaming ? [streaming] : [])];
  const results = toolResults(liveMessages);
  const turns = conversationTurns(liveMessages);
  const heroText = (key: string) => ({
    "hero.headline": "有什么可以帮你？",
    "hero.preview": "Pi",
  })[key] ?? key;

  return (
    <div ref={root} className={conversationCss.root} data-phase={empty ? "hero" : "active"} style={{ "--piw-conversation-column-width": `${columnWidth}px` } as React.CSSProperties}>
      {session && !empty && <header className={conversationCss.header}>
        <div className={conversationCss.titleRow}>
          <div className={conversationCss.titleCluster}>
            <div className={conversationCss.crumbs}>
              <span className={`${conversationCss.crumb} ${conversationCss.crumbCurrent}`}>{session.name}</span>
            </div>
          </div>
          <div className={conversationCss.headerActions}><StateDot state={connection === "connected" ? session.idle ? "done" : "ongoing" : "error"} /><span className="pi-header-state">{connection === "connected" ? session.idle ? "已连接" : "运行中" : "已断开"}</span></div>
        </div>
        <div className={conversationCss.tabs} role="tablist" aria-label="会话视图">
          <button className={`${conversationCss.tab} ${activeTab === "chat" ? conversationCss.tabActive : ""}`} role="tab" aria-selected={activeTab === "chat"} type="button" onClick={() => setActiveTab("chat")}>对话</button>
          <button className={`${conversationCss.tab} ${activeTab === "trajectory" ? conversationCss.tabActive : ""}`} role="tab" aria-selected={activeTab === "trajectory"} type="button" onClick={() => setActiveTab("trajectory")}>轨迹</button>
        </div>
      </header>}
      <div className={conversationCss.body}>
        <div ref={scroll} className={conversationCss.scrollBody} data-conversation-scroll="">
          {!empty && <div className={conversationCss.viewArea}>{activeTab === "chat" ? <div className={chatCss.root}><div className={chatCss.scroll}><div className={chatCss.column}>
            <>
              {turns.map((turn) => <PiTurn turn={turn} key={turn.id} results={results} model={session?.model ?? null} loadImage={onLoadImage} cwd={session?.cwd} running={turn.messages.some((message) => message.id === "stream")} onInspect={(id) => { setInspectCallId(id); setActiveTab("trajectory"); }} />)}
            </>
          </div></div></div> : <PiTrajectory messages={liveMessages} inspectCallId={inspectCallId} />}</div>}
          <div className={conversationCss.composerSeat} data-composer-seat="">
            <div className={`${conversationCss.composerStack} ${empty ? conversationCss.composerHero : ""}`}>
              {empty && <HeroShell t={heroText} renderSlot={(_key: string, _props: unknown, options?: { fallback?: React.ReactNode }) => options?.fallback ?? null} />}
              {empty && <div className={conversationCss.heroWorkspaceRow}><span className={heroCss.workspace}><IconFolderOpen16 size={16} /><span className={heroCss.workspaceLabel}>{workspace}</span></span></div>}
              <PiInputBar hero={empty} session={session} connection={connection} onSend={sendWithEcho} onUpload={onUpload} onDiscardAttachment={onDiscardAttachment} onStop={onStop} onCompact={onCompact} onNewSession={onNewSession} commands={commands} models={models} onSetModel={onSetModel} onSetThinkingLevel={onSetThinkingLevel} />
              {error && <div className="pi-error" role="alert">{error}</div>}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
