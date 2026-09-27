import { useCallback, useEffect, useMemo, useState } from "react";
import { AppFrame } from "./ui/layout/AppFrame.tsx";
import { SidebarRoot } from "./ui/sidebar/SidebarRoot.tsx";
import { PiLogo } from "./ui/primitives/index.ts";
import { IconSettingsOutline14, IconSettingsOutline16 } from "./ui/primitives/icons/index.tsx";
import { PiConversation } from "./PiConversation.tsx";
import { PiWorkspaceBrowser } from "./PiWorkspaceBrowser.tsx";
import { PiSettings } from "./PiSettings.tsx";
import { usePiBridge } from "./pi-bridge.ts";
import { useLocale, localize as t } from "./ui/locale/preference.ts";
import type { LayoutInfo, PanelInfo } from "./ui/contract.ts";
import type { SidebarPanelMetadata } from "./ui/sidebar/contract/slots.ts";
import "./pi.css";

export function PiApp() {
  useLocale();
  const labels: Record<string, string> = {
    "session.new.label": t("新会话", "New session"),
    "session.new": t("新会话", "New session"),
    "toggle.open": t("展开侧栏", "Expand sidebar"),
    "toggle.collapse": t("收起侧栏", "Collapse sidebar"),
    "panels.label": t("面板", "Panels"),
    "brand.localBuild": "pi-webapp",
  };
  const bridge = usePiBridge();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const needsModelSetup = bridge.connection === "connected" && bridge.session !== null && bridge.modelsStatus === "ready" && bridge.models.length === 0;
  useEffect(() => {
    if (needsModelSetup) setSettingsOpen(true);
  }, [needsModelSetup]);
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
  const usePanelInfo = <T,>(select: (state: PanelInfo) => T): T => select({ activePanelId: null });
  const usePanels = <T,>(select: (value: readonly SidebarPanelMetadata[]) => T): T => select([]);
  const renderSidebarSlot = (key: string, owner: any, options?: { fallback?: React.ReactNode }) => {
    if (key === "sidebar.brand.mark") return <PiLogo size={24} />;
    if (key === "sidebar.brand.name") return <span>pi-webapp</span>;
    if (key === "sidebar.settings") return <div className={`pi-settings-trigger-row ${owner.wide ? "" : "pi-settings-trigger-rail"}`}><button className="pi-settings-sidebar" data-wide={owner.wide} type="button" aria-label={t("Pi 设置", "Pi Settings")} aria-haspopup="dialog" aria-expanded={settingsOpen} onClick={() => setSettingsOpen(true)}>{owner.wide ? <IconSettingsOutline16 size={16} /> : <IconSettingsOutline14 size={18} />}{owner.wide && <span>{t("Pi 设置", "Pi Settings")}</span>}</button></div>;
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
    if (key === "main") return <PiConversation session={bridge.session} streaming={bridge.streaming} connection={bridge.connection} error={bridge.error} onSend={bridge.send} onLoadImage={bridge.loadMessageImage} onUpload={bridge.upload} onDiscardAttachment={bridge.discardAttachment} onStop={bridge.stop} onCompact={bridge.compact} onNewSession={bridge.newSession} commands={bridge.commands} models={bridge.models} modelsStatus={bridge.modelsStatus} onConfigureModels={() => setSettingsOpen(true)} onSetModel={bridge.setModel} onSetThinkingLevel={bridge.setThinkingLevel} />;
    return null;
  };
  return <><AppFrame
    useStore={useStore}
    usePanelInfo={usePanelInfo}
    actions={actions}
    renderSlot={renderSlot}
    t={(name: string) => labels[name] ?? name}
  />{settingsOpen && <PiSettings onBack={closeSettings} setupMode={needsModelSetup} getConfig={bridge.getConfig} updateConfig={bridge.updateConfig} getUpdate={bridge.getUpdate} getRunningVersion={bridge.getRunningVersion} update={bridge.update} getProviders={bridge.getProviders} getProviderModels={bridge.getProviderModels} updateProviderModel={bridge.updateProviderModel} logoutProvider={bridge.logoutProvider} addCustomProvider={bridge.addCustomProvider} startProviderLogin={bridge.startProviderLogin} getProviderLogin={bridge.getProviderLogin} getActiveProviderLogin={bridge.getActiveProviderLogin} respondProviderLogin={bridge.respondProviderLogin} cancelProviderLogin={bridge.cancelProviderLogin} refreshModels={bridge.refreshModels} />}</>;
}
