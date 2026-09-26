import type { ReactNode } from "react";

export interface LayoutInfo {
  sidebar: number;
  viewportWidth: number;
  narrowExpanded: boolean;
  rightbar: number | null;
  rightbarShown: boolean;
  rightbarTrack: boolean;
  rightbarFullscreen: boolean;
  rightbarInstant: boolean;
}

export interface PanelInfo { activePanelId: string | null }
export interface SessionTitles { current?: string; byId: Record<string, { title: string }> }
export type SelectHook<State> = <T>(select: (state: State) => T) => T;
export type SlotRenderer = (key: string, owner: any, options?: { fallback?: ReactNode; only?: string; entryKey?: string }) => ReactNode;
