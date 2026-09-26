import type { PanelInfo, SelectHook, SlotRenderer } from "../../contract.ts";

export interface SidebarPanelMetadata {
  id: string;
  label: string;
}

export interface SidebarSectionOwnerProps {
  wide: boolean;
  expandSidebar: () => void;
}

export interface SidebarRootComponentProps {
  collapsed: boolean;
  width: number;
  startSession: () => void;
  toggleSidebar: () => void;
  selectPanel: (id: string) => void;
  usePanels: SelectHook<readonly SidebarPanelMetadata[]>;
  usePanelInfo: SelectHook<PanelInfo>;
  t: (name: string) => string;
  renderSlot: SlotRenderer;
}
