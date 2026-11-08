# 文件与目录

本页梳理 pi-webapp 和 Pi 在磁盘上把数据放在哪里、哪些文件是敏感的，以及该备份什么。

## 数据目录

一切都在 Pi 的数据目录下：macOS 和 Linux 上是 `~/.pi/agent`，Windows 上是 `%USERPROFILE%\.pi\agent`。[`PI_CODING_AGENT_DIR`](./environment) 可以移动它。下面的路径都是相对于它的。

```text
~/.pi/agent/
├── auth.json                   凭据
├── models.json                 自定义提供方和模型设置
├── models-store.json           由 Pi 管理
├── settings.json               Pi 设置，包括包和技能
├── sessions/
│   └── --Users-you-projects-my-app--/
│       └── 2026-11-01T10-28-05-873Z_<id>.jsonl
└── pi-web/                     pi-webapp 自己的状态
    ├── launcher.json
    ├── launcher.log
    ├── workspaces.json
    ├── trash/
    ├── plugins.json
    ├── attachments/
    ├── hosted/
    └── releases/
```

| 路径 | 内容 | 敏感吗？ |
| --- | --- | --- |
| `auth.json` | API Key 和登录令牌。权限 `600`（仅你的用户可读）。 | **是。绝对不要分享。** |
| `models.json` | 自定义提供方和每个模型的设置。不含 Key。 | 可能：里面可能有私有地址。 |
| `models-store.json` | 由 Pi 管理的模型数据。不要动它。 | 否 |
| `settings.json` | Pi 的全局设置，包括你添加的包、扩展和技能。需要时才创建。 | 低 |
| `sessions/<工作区>/<时间>_<id>.jsonl` | 每个已保存的会话一个文件，JSON Lines 格式：消息、工具调用和结果。目录名是工作区路径，其中的 `/` 换成了 `-`。 | **是**：你的完整对话。 |
| `pi-web/launcher.json` | 运行中服务的状态：PID、版本，以及**带访问令牌的完整地址**。权限 `600`。正常停止时会被删除。 | **是。绝对不要分享。** |
| `pi-web/launcher.log` | 只追加的启动器事件日志，每行一个 JSON 对象。权限 `600`。 | 分享前请先检查。 |
| `pi-web/workspaces.json` | 工作区列表，以及你隐藏的工作区。 | 会暴露项目路径。 |
| `pi-web/trash/` | 你在侧栏里删除的会话，会带着时间戳前缀移到这里，而不是被抹掉。把文件移回 `sessions/` 下即可恢复。 | **是** |
| `pi-web/plugins.json` | 哪些内置工具开着或关着。你改动开关时创建。 | 否 |
| `pi-web/attachments/` | 你在会话里上传的文件。 | **是** |
| `pi-web/hosted/` | 已下载的插件（比如 Excalidraw 和 OpenPencil）、它们的数据和策略。 | 图稿和设计稿数据可能敏感。 |
| `pi-web/diagrams/` | Excalidraw 成为插件之前创建的图的原始数据。迁移后仍保留。 | 可能 |
| `pi-web/releases/`、`update.json`、`update-preferences.json` | **升级并重启** 下载的版本、当前选中的是哪个，以及你选的稳定版/体验版。 | 否 |
| `pi-web/launcher.stop`、`launcher.restart` | 用来请求停止或重启服务的短暂文件。你可能会短暂看到它们。 | 否 |

项目本地的 Pi 设置，比如用 `pi install -l` 安装的包，保存在项目里的 `.pi/settings.json`。

## 该备份什么

要保留你的工作，请复制 `sessions/`、`auth.json`、`models.json`、`settings.json`、`pi-web/workspaces.json` 和 `pi-web/hosted/`。请先停止服务，避免写到一半。把这份备份当作密码库来对待。

## 哪些可以放心删除

- 单个会话：使用侧栏里的 **删除会话**，它会被移到 `pi-web/trash/`。要彻底删除，再删掉那里的文件。
- 整个 `pi-web/`：只有当你接受忘掉工作区、附件、已下载的插件和更新状态时才可以。你的会话和凭据在它之外。
- **不要**为了“修好”问题而手动删除整个数据目录、`pi-web/releases/` 或 `pi-web/hosted/`，见[排错](../troubleshooting)。

## 桌面应用

桌面应用使用同一个数据目录。**窗口 → 打开日志目录** 会打开 `pi-web/`，里面有 `launcher.log`。
