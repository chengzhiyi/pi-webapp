import type { PromptDelivery, SessionView } from "../../../contracts/bridge-contract.ts";

/** Check again at the runtime boundary: uploads/navigation may have awaited I/O. */
export function assertPromptDelivery(session: SessionView, text: string, delivery?: PromptDelivery): void {
  if (delivery !== undefined && delivery !== "steer" && delivery !== "followUp") throw new Error("追加方式无效");
  if (session.interactions?.length) throw new Error("请先完成当前交互或审批");
  if (!session.idle && !delivery) throw new Error("Pi 正在运行，请选择引导或排队");
  // Pi dispatches extension commands immediately, before applying streamingBehavior.
  // Do not disguise those actions as queued prompts (including a stale busy UI).
  if (delivery && text.trimStart().startsWith("/")) throw new Error("追加提示词不支持斜杠指令，请等待当前回复结束后执行");
}
