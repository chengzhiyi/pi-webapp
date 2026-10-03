import { Component, type ErrorInfo, type ReactNode } from "react";
import { reportError } from "./telemetry.ts";
import { localize as t } from "./ui/locale/preference.ts";

export class TelemetryBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  componentDidCatch(error: Error, info: ErrorInfo) { reportError(error, { stage: "react", componentStack: info.componentStack ?? "" }); }
  render() {
    if (this.state.failed) return <main role="alert"><p>{t("页面遇到错误，请刷新后重试。", "The page encountered an error. Refresh to try again.")}</p><button type="button" onClick={() => location.reload()}>{t("刷新页面", "Refresh page")}</button></main>;
    return this.props.children;
  }
}
