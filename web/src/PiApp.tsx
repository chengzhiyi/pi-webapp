import { useCallback, useMemo, useState } from "react";
import { AppFrame } from "./ui/layout/AppFrame.tsx";
import { SidebarRoot } from "./ui/sidebar/SidebarRoot.tsx";
import { PiLogo } from "./ui/primitives/index.ts";
import { IconSettingsOutline14, IconSettingsOutline16 } from "./ui/primitives/icons/index.tsx";
import { PiConversation } from "./PiConversation.tsx";
import { PiWorkspaceBrowser } from "./PiWorkspaceBrowser.tsx";
import { PiSettings } from "./PiSettings.tsx";
import { usePiBridge } from "./pi-bridge.ts";
import type { LayoutInfo, PanelInfo } from "./ui/contract.ts";
import type { SidebarPanelMetadata } from "./ui/sidebar/contract/slots.ts";
import "./pi.css";

const labels: Record<string, string> = {
  "session.new.label": "新会话",
  "session.new": "新会话",
  "toggle.open": "展开侧栏",
  "toggle.collapse": "收起侧栏",
  "panels.label": "面板",
  "brand.localBuild": "pi-webapp",
};

export function PiApp() {
  const bridge = usePiBridge();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => {
    setSettingsOpen(false);
    requestAnimationFrame(() => document.querySelector<HTMLButtonElement>(".pi-settings-sidebar")?.focus());
  }, []);
  const [layout, setLayout] = useState<LayoutInfo>(() => ({
    sidebar: 280,
    viewportWidth: window.innerWidth,
    narrowExpanded: false,
    rightbar: null,
    rightbarShown: false,
    rightbarTrack: false,
    rightbarFullscreen: false,
    rightbarInstant: false,
  }));
  const actions = useMemo(() => ({
    setViewportWidth(width: number) {
      setLayout((previous) => previous.viewportWidth === width ? previous : { ...previous, viewportWidth: width, narrowExpanded: (previous.viewportWidth < 1024) !== (width < 1024) ? false : previous.narrowExpanded });
    },
    setSidebar(width: number) {
      setLayout((previous) => ({ ...previous, sidebar: Math.min(420, Math.max(264, Math.round(width))) }));
    },
    setRightbar(_width: number) {},
  }), []);
  const toggleSidebar = () => setLayout((previous) => previous.viewportWidth < 1024
    ? { ...previous, narrowExpanded: !previous.narrowExpanded }
    : { ...previous, sidebar: previous.sidebar === 0 ? 280 : 0 });
  const useStore = <T,>(select: (state: { layoutInfo: LayoutInfo }) => T): T => select({ layoutInfo: layout });
  const useSessions = <T,>(select: (state: { current?: string; byId: Record<string, { title: string }> }) => T): T => select(bridge.session
    ? { current: bridge.session.sessionId, byId: { [bridge.session.sessionId]: { title: bridge.session.name } } }
    : { byId: {} });
  const usePanelInfo = <T,>(select: (state: PanelInfo) => T): T => select({ activePanelId: null });
  const usePanels = <T,>(select: (value: readonly SidebarPanelMetadata[]) => T): T => select([]);
  const renderSidebarSlot = (key: string, owner: any, options?: { fallback?: React.ReactNode }) => {
    if (key === "sidebar.brand.mark") return <PiLogo size={24} />;
    if (key === "sidebar.brand.name") return <span>pi-webapp</span>;
    if (key === "sidebar.settings") return <div className={`pi-settings-trigger-row ${owner.wide ? "" : "pi-settings-trigger-rail"}`}><button className="pi-settings-sidebar" data-wide={owner.wide} type="button" aria-label="Pi 设置" aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}>{owner.wide ? <IconSettingsOutline16 size={16} /> : <IconSettingsOutline14 size={18} />}{owner.wide && <span>Pi 设置</span>}</button></div>;
    if (key === "sidebar.workspaces") return <PiWorkspaceBrowser
      wide={owner.wide}
      expandSidebar={owner.expandSidebar}
      session={bridge.session}
      workspaces={bridge.workspaces}
      onAdd={bridge.addWorkspace}
      directoryPickerKind={bridge.directoryPickerKind}
      pickDirectory={bridge.pickDirectory}
      listDirectory={bridge.listDirectory}
      createDirectory={bridge.createDirectory}
      onRemove={bridge.removeWorkspace}
      onSelectSession={bridge.selectSession}
      onNewSession={bridge.newSessionInWorkspace}
    />;
    return options?.fallback ?? null;
  };
  const renderSlot = (key: string, owner: any) => {
    if (key === "sidebar") return <SidebarRoot
      collapsed={owner.collapsed}
      width={owner.width}
      startSession={() => { void bridge.newSession().catch(() => {}); }}
      toggleSidebar={toggleSidebar}
      selectPanel={() => {}}
      usePanels={usePanels}
      usePanelInfo={usePanelInfo}
      t={(name: string) => labels[name] ?? name}
      renderSlot={renderSidebarSlot}
    />;
    if (key === "main") return <PiConversation session={bridge.session} streaming={bridge.streaming} connection={bridge.connection} error={bridge.error} onSend={bridge.send} onLoadImage={bridge.loadMessageImage} onUpload={bridge.upload} onDiscardAttachment={bridge.discardAttachment} onStop={bridge.stop} onCompact={bridge.compact} onNewSession={bridge.newSession} commands={bridge.commands} models={bridge.models} onSetModel={bridge.setModel} onSetThinkingLevel={bridge.setThinkingLevel} />;
    return null;
  };
  return <><AppFrame
    useStore={useStore}
    useSessions={useSessions}
    usePanelInfo={usePanelInfo}
    actions={actions}
    renderSlot={renderSlot}
    t={(name: string) => labels[name] ?? name}
  />{settingsOpen && <PiSettings onBack={closeSettings} getConfig={bridge.getConfig} updateConfig={bridge.updateConfig} getProviders={bridge.getProviders} addCustomProvider={bridge.addCustomProvider} startProviderLogin={bridge.startProviderLogin} getProviderLogin={bridge.getProviderLogin} respondProviderLogin={bridge.respondProviderLogin} cancelProviderLogin={bridge.cancelProviderLogin} refreshModels={bridge.refreshModels} />}</>;
}
