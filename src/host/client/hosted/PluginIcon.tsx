import type { HostedPluginCard } from "../../../contracts/hosted-plugins.ts";
import { OFFICIAL_HOSTED_PLUGIN } from "../../../contracts/hosted-plugins.ts";
import { ExcalidrawIcon } from "../../../../web/src/ui/primitives/ExcalidrawIcon.tsx";
import { OpenPencilIcon } from "../../../../web/src/ui/primitives/OpenPencilIcon.tsx";
import { IconPluginPinwheelOutlineRegular } from "../../../../web/src/ui/shared/primitives/icons/index.tsx";

/** Host artwork only. The offline catalog also supports older servers with no icon key. */
export function HostedPluginIcon({ card, size = 24 }: { card: Pick<HostedPluginCard, "pluginId" | "icon">; size?: number }) {
  const icon = card.icon ?? (card.pluginId === OFFICIAL_HOSTED_PLUGIN.pluginId ? OFFICIAL_HOSTED_PLUGIN.icon : undefined);
  const Icon = icon === "drawing" ? ExcalidrawIcon : icon === "design" ? OpenPencilIcon : IconPluginPinwheelOutlineRegular;
  return <Icon size={size} />;
}
