# 开发与历史资料

本轮优先用户指南，不把内部 HTTP 路由承诺为稳定公共 API。下列现有路径保留在仓库，本次**不自动构建成网站页面或搜索索引**，避免把历史/运维内容当用户能力说明。

| 主题 | 原文与当前入口 |
| --- | --- |
| 架构与目录、插件生命周期 | [architecture.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/architecture.md)；用户工具入口见[工具指南](./workspace-tools) |
| Web 插件协议接入与暂停继续 | [web-plugins.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/web-plugins.md)；用户说明见[配置](./configuration)和[对话控制](./conversation) |
| 桌面构建与小范围安装 | [desktop.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop.md)、[desktop-testing.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop-testing.md)；用户入口见[桌面](./desktop) |
| Sentry 运维与诊断 | [sentry.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/sentry.md)、[sentry-triage.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/sentry-triage.md)；默认采集与关闭见[安全](./security) |
| 设计决策与初版规格 | [decisions/](https://github.com/chengzhiyi/pi-webapp/tree/main/docs/decisions)、[spec.md](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/spec.md)；历史资料，不代表当前全部行为 |

开发和产品发布流程仍见[仓库 README](https://github.com/chengzhiyi/pi-webapp#develop-locally)。本地插件联调变量 `PI_WEBAPP_PLUGIN_DEV_ROOTS` 只用于可信源码目录；按上面的插件文档及同级 `pi-extensions` README 操作。

上游 Pi 的能力与插件协议应查各自文档，不在本项目复制完整说明。独立贡献指南、最小插件示例和协议兼容表属于后续阶段 C，当前没有伪造兼容承诺。

文档维护者在仓库 `docs/MAINTAINING.md` 查看构建、预览、内容来源映射与验收命令。GitHub main 链接是开发资料，不是某个已发布版的不可变快照。
