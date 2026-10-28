import { createContext, useContext, type ReactNode } from "react";
import { useAppUpdate, type AppUpdateActions } from "./useAppUpdate.ts";

export type AppUpdateController = ReturnType<typeof useAppUpdate>;
const AppUpdateContext = createContext<AppUpdateController | null>(null);

/** The application owns installation and restart observation. Settings and the
 * sidebar only render/control this owner; leaving either surface cannot stop it.
 */
export function AppUpdateProvider({ actions, children }: { actions: AppUpdateActions; children: ReactNode }) {
  const controller = useAppUpdate(actions);
  return <AppUpdateContext.Provider value={controller}>{children}</AppUpdateContext.Provider>;
}

export function useAppUpdateContext(): AppUpdateController | null { return useContext(AppUpdateContext); }
