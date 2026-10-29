import type { HostedPluginCard } from "../../../contracts/hosted-plugins.ts";
/** Pending-version/check/status refreshes must never remount an old editor or reset native undo. */
export function retainHostedCards(incoming: HostedPluginCard[], previous: HostedPluginCard[]): HostedPluginCard[] {
  const next = incoming.filter(card => card.enabled && card.generation !== undefined && card.contribution && card.documentUrl && card.controllerUrl).map(card => {
    const old = previous.find(value => value.pluginId === card.pluginId);
    return old && old.generation === card.generation && old.name === card.name && old.icon === card.icon && old.documentUrl === card.documentUrl && old.controllerUrl === card.controllerUrl
      && JSON.stringify(old.contribution) === JSON.stringify(card.contribution) ? old : card;
  });
  return next.length === previous.length && next.every((card, index) => card === previous[index]) ? previous : next;
}
