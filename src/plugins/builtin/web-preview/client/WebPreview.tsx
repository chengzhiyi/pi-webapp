import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ComponentProps } from "react";
import { Button } from "../../../../../web/src/ui/shared/primitives/Button.tsx";
import {
  IconCheckOutlineRegular,
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconCloseOutlineRegular,
  IconCodeOutlineRegular,
  IconCopyOutlineRegular,
  IconGlobeOutlineRegular,
  IconLoadingOutlineRegular,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
  IconSearchOutlineRegular,
  IconWarningTriangleOutlineRegular,
} from "../../../../../web/src/ui/shared/primitives/icons/index.tsx";
import type { PreviewModel } from "./preview-model.ts";
import { watchPreviewLayout } from "./preview-layout.ts";
import css from "./WebPreview.module.css";

type ButtonProps = ComponentProps<typeof Button>;
const localExample = "localhost:3000";

function ToolbarButton({ label, ...props }: ButtonProps & { label: string }) {
  return <Button size="sm" aria-label={label} title={label} className={css.iconButton} {...props} />;
}

export function WebPreview({ model, visible, locale }: { model: PreviewModel; visible: boolean; locale: "zh" | "en" }) {
  const { state, draft, submitted, pending, ipcFailed } = useSyncExternalStore(model.subscribe, model.getSnapshot);
  const anchor = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const failureId = useId();
  const [copiedUrl, setCopiedUrl] = useState("");
  const t = (zh: string, en: string) => locale === "zh" ? zh : en;
  const address = draft ?? (state.url || submitted);
  const canSubmit = !pending && Boolean(address.trim());
  const invalid = state.status === "failed" && (state.error === "address" || state.error === "navigation") && draft === null;
  const attach = visible && state.status === "ready";
  useLayoutEffect(() => {
    // The watcher publishes layout(null) on cleanup, detaching rather than closing the guest.
    if (attach && anchor.current) return watchPreviewLayout(anchor.current, bounds => model.layout(bounds));
  }, [attach, model]);
  useEffect(() => {
    if (!copiedUrl) return;
    const timer = window.setTimeout(() => setCopiedUrl(""), 2000);
    return () => window.clearTimeout(timer);
  }, [copiedUrl]);

  const submit = () => { if (canSubmit) void model.open(address); };
  const copy = async () => { setCopiedUrl(await model.command("copy") ? state.url : ""); };
  const copied = Boolean(copiedUrl && copiedUrl === state.url);
  const emptyQuery = state.error === "address" && submitted.trim() === "?";
  const failure = emptyQuery
    ? t("请输入搜索关键词", "Enter a search term")
    : state.error === "address"
      ? t("请输入 HTTP 或 HTTPS 地址", "Enter an HTTP or HTTPS address")
      : state.error === "navigation"
        ? t("此地址无法在网页预览中打开", "This address is blocked in Web Preview")
        : t("页面加载失败", "The page failed to load");
  const failureHint = emptyQuery
    ? t("在 ? 后输入要搜索的内容。", "Type what you’d like to search for after the ?.")
    : state.error === "address"
      ? t("网址不能包含用户名或密码。若要搜索，请在关键词前加 ?。", "URLs can’t include a username or password. To search, start with ? followed by your terms.")
      : state.error === "navigation"
        ? t("请尝试其他地址。", "Try a different address.")
        : t("请检查地址和网络连接。如果是本地服务，请确认它正在运行。", "Check the address and your connection. If it’s a local server, make sure it’s running.");
  const focusAddress = () => { input.current?.focus(); };

  return <section className={css.panel} aria-label={t("网页预览", "Web Preview")}>
    <div className={css.toolbar}>
      <fieldset className={css.controls} aria-label={t("页面导航", "Page navigation")}>
        <ToolbarButton label={t("后退", "Back")} icon={<IconChevronLeftOutlineRegular aria-hidden="true" />}
          disabled={pending || !state.canGoBack} onClick={() => void model.command("back")} />
        <ToolbarButton label={t("前进", "Forward")} icon={<IconChevronRightOutlineRegular aria-hidden="true" />}
          disabled={pending || !state.canGoForward} onClick={() => void model.command("forward")} />
        <ToolbarButton label={t("重新加载", "Reload")} icon={<IconRefreshOutlineRegular aria-hidden="true" />}
          disabled={pending || !state.url || state.status === "loading"} onClick={() => void model.command("reload")} />
      </fieldset>
      <form className={css.address} onSubmit={event => { event.preventDefault(); submit(); }}>
        <div className={css.location} data-invalid={invalid}>
          <IconSearchOutlineRegular aria-hidden="true" className={css.locationIcon} />
          <input ref={input} aria-label={t("搜索或输入网址", "Search or enter a URL")} type="text" dir="auto"
            autoCapitalize="none" autoComplete="off" spellCheck={false}
            placeholder={t("使用 Google 搜索或输入网址", "Search Google or enter a URL")}
            value={address} aria-invalid={invalid || undefined} aria-describedby={invalid ? failureId : undefined}
            onFocus={event => event.currentTarget.select()} onChange={event => model.edit(event.currentTarget.value)} />
          {address && <ToolbarButton label={t("清除地址", "Clear address")} icon={<IconCloseOutlineRegular aria-hidden="true" />}
            onClick={() => { model.edit(""); focusAddress(); }} />}
          <Button className={css.go} type="submit" variant="primary" size="sm" disabled={!canSubmit}>{t("打开", "Go")}</Button>
        </div>
      </form>
      <fieldset className={css.controls} aria-label={t("页面操作", "Page actions")}>
        <ToolbarButton label={t("复制地址", "Copy URL")}
          icon={copied ? <IconCheckOutlineRegular aria-hidden="true" /> : <IconCopyOutlineRegular aria-hidden="true" />}
          disabled={pending || !state.url} onClick={() => void copy()} />
        <ToolbarButton label={t("在系统浏览器中打开", "Open in system browser")} icon={<IconRightUpOutlineRegular aria-hidden="true" />}
          disabled={pending || !state.url} onClick={() => void model.command("external")} />
      </fieldset>
    </div>
    {ipcFailed && <div className={css.notice} role="alert">
      <IconWarningTriangleOutlineRegular size={16} aria-hidden="true" />
      <span>{t("桌面预览操作失败，请重试。", "The desktop preview action failed. Try again.")}</span>
    </div>}
    <div className={css.srOnly} role="status">{copied ? t("地址已复制。", "URL copied.") : ""}</div>
    <div ref={anchor} className={css.viewport} data-web-preview-state={state.status}>
      {state.status === "idle" && <div className={css.message}>
        <div className={css.badge}><IconGlobeOutlineRegular size={24} aria-hidden="true" /></div>
        <p className={css.messageTitle}>{t("打开网页开始预览", "Open a page to preview")}</p>
        <p>{t("打开网站、本机服务或局域网地址，也可以使用 Google 搜索。", "Open a website, preview a local or LAN server, or search Google.")}</p>
        <div className={css.suggestions}>
          <Button size="sm" variant="outline" icon={<IconSearchOutlineRegular aria-hidden="true" />} onClick={focusAddress}>
            {t("Google 搜索", "Search Google")}
          </Button>
          <Button size="sm" variant="outline" icon={<IconCodeOutlineRegular aria-hidden="true" />}
            onClick={() => { model.edit(localExample); focusAddress(); }}>
            <code dir="ltr">{localExample}</code>
          </Button>
        </div>
        <p className={css.tip}>{t("以 ? 开头可强制搜索，例如", "To search instead of opening an address, try")} <code dir="ltr">{t("? 网页设计", "? web design")}</code></p>
      </div>}
      {state.status === "loading" && <div className={css.message} role="status">
        <div className={css.badge}><IconLoadingOutlineRegular className={css.spinner} size={24} aria-hidden="true" /></div>
        <p className={css.messageTitle}>{t("正在加载网页…", "Loading page…")}</p>
        {state.url && <p className={css.loadingAddress} title={state.url} dir="ltr">{state.url}</p>}
      </div>}
      {state.status === "ready" && <span className={css.srOnly} role="status">{t("预览已就绪", "Preview ready")}</span>}
      {state.status === "failed" && <div className={css.message}>
        <div className={css.badge}><IconWarningTriangleOutlineRegular size={24} aria-hidden="true" /></div>
        <div role="alert" id={failureId}>
          <p className={css.messageTitle}>{failure}</p>
          <p>{failureHint}</p>
        </div>
        {invalid
          ? <Button className={css.recovery} size="sm" variant="outline" onClick={focusAddress}>{t("编辑输入", "Edit input")}</Button>
          : <Button className={css.recovery} size="sm" variant="outline" disabled={!canSubmit} onClick={submit}>{t("重试", "Retry")}</Button>}
      </div>}
    </div>
  </section>;
}
