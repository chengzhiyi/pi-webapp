# 配置与版本参考

本页仅列已核实的用户入口，不把所有 `PI_WEBAPP_*` 内部控制变量当作公共 API。环境变化需要重启实际 Pi 后台；已有服务不会因再次运行启动器就自动继承新环境。

| 配置 | 用途 |
| --- | --- |
| `PI_WEBAPP_AUTO_OPEN=0` | 禁止启动时自动打开浏览器，仍可查看本机地址 |
| `PI_CODING_AGENT_DIR` | 改变 Pi Agent 数据根目录；默认 `~/.pi/agent`，Web 数据位于其 `pi-web/` 下。不要在不清楚数据迁移影响时切换 |
| `PI_WEB_SENTRY_ENABLED=false` | 关闭前后端错误上报；见[安全与隐私](./security) |
| `PI_WEB_SENTRY_DSN` | 替换内置公共上报目标；更多边界见[专题](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/sentry.md) |

提供方认证和模型配置应优先使用「设置 → 模型」；不要把配置文件内容当作反馈材料。插件开发变量只在[开发资料](./resources)说明。

## 版本边界

- 本站是**开发版文档**，页脚版本来自仓库根 `package.json`，不是 npm latest 检测结果。
- Web：Node.js ≥ **22.19.0**，已有 Pi ≥ **0.87.1**。Pi、pi-webapp、外部协议包与桌面构建号是不同维度，不可互相替代。
- npm 托管升级后的运行版本可能不同于全局安装版本，以实际运行信息为准。
- 桌面：仅 macOS arm64 有已验收测试下载；构建 **7 起的新签名流程**不意味着旧包已修复或已有发布者签名。
- 当前不提供多版本快照；对较旧版本应以对应发行提交的 README/源码为准。公开稳定站的发行来源与部署仍待阶段 B 单独核验。

## 常用命令

```bash
npx pi-webapp          # 启动或重新打开
npx pi-webapp status   # 状态 / 本机地址（不要分享令牌）
npx pi-webapp stop     # 全部后台任务结束，先完成工作
```

源码和 `/web` 模式的区别见[升级指南](./updates)。文档站独立于产品服务运行，站点故障不应影响 Agent。
