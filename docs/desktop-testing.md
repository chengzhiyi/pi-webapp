# macOS 小范围测试安装 / Small-group test installation

适用于 **desktop build 7 起、采用新签名流程构建**的 macOS Apple Silicon / Intel 测试包。
旧包不会因源码更新而自动修复；请安装新构建，不要覆盖发布过的同名安装包。

## 这些测试包能保证什么？

- 默认以 `codesign` 的 ad-hoc 临时签名封装完整应用、Electron helpers 和内置运行时，
  无需 Developer ID 证书。打包和发布准备都要求通过 deep/strict 签名完整性检查。
- **不是 Developer ID 发布者签名，没有 Apple 公证**。这不是面向公众“下载即打开”的发行版。
  Gatekeeper 仍可能拦截；`spctl --assess` 拒绝此包是预期限制，不等于打包签名校验失败。
- SHA-256 只核对发行文件；临时签名只检查包是否符合当前签名，不验证开发者身份，
  二者都不能证明软件安全。只邀请明确知情、愿意信任项目的测试用户。
- 桌面更新菜单可下载、校验并交给 Finder 手动安装 macOS arm64 测试包；不会自动安装 ad-hoc 包。
  Intel macOS、Windows/Linux 的更新菜单打开官方 Releases，选择匹配的安装包。

## 测试用户安装步骤

1. 从项目官方 [GitHub Releases](https://github.com/chengzhiyi/pi-webapp/releases)
   下载明确邀请测试的构建 DMG 和同一 Release 的 `SHA256SUMS`。
   不要使用转发的未知安装包、源码 ZIP 或不匹配版本的校验文件。
2. 在终端运行 `shasum -a 256 <下载的DMG路径>`，与 `SHA256SUMS` 中该 DMG 的一行比较。
   不一致就停止，不要关闭系统保护。`SHA256SUMS` 含四平台安装包；只下载一个 DMG 时，
   逐行比较该文件即可，不要因未下载其他平台文件而误判其校验结果。
3. 退出旧桌面再替换应用。先完成所有聊天/终端任务；若旧桌面使用内置后台，
   从其原入口停止该后台再替换。不要停止仍需使用的外部 Web 后台，也不要删除 `~/.pi`。
   打开 DMG，把 **pi.app** 拖入“应用程序”。旧 **Pi Webapp.app** 不会自动被覆盖，
   请更新 Dock 快捷方式以免打开旧版。
4. 检查安装后的应用完整性：

   ```bash
   codesign --verify --deep --strict --verbose=2 "/Applications/pi.app"
   ```

   **失败就停止**，保存报错、构建号及 DMG 校验结果反馈给维护者。
   不要自行重签，因为那会为可能被修改的内容建立新签名、掩盖原始问题。
5. 尝试打开应用。如果被拦截，可在 macOS 提供该选项时使用
   **系统设置 → 隐私与安全性 → 仍要打开**。
   如果仍因下载隔离无法启动，且你已核对来源、校验和、签名，并明确愿意信任该测试包，
   可以手动运行以下命令，**只针对此应用**移除下载隔离后重试：

   ```bash
   codesign --verify --deep --strict --verbose=2 "/Applications/pi.app" &&
   xattr -dr com.apple.quarantine "/Applications/pi.app"
   ```

   这会跳过该应用的下载隔离检查，**不代表 Apple 已认证其安全**。
   不要对来源不明的软件使用，不要全局关闭 Gatekeeper/SIP；遇到权限错误先反馈，
   不要盲目追加 `sudo`。项目不会自动执行此操作。
6. 在 **pi → 关于 pi** 确认版本、桌面构建号及应用位置，再配置模型并测试聊天和终端。
   若启动失败，反馈系统版本、芯片、构建号及错误；不要上传 API 密钥、`auth.json` 或私钥。

再次安装/更新未公证测试包时，可能需要重复信任步骤。不接受这些限制的用户可继续使用
Web 版，或从可信源码构建运行，不必购买开发者会员。

## Release operator / 维护者验收

- 默认 `mac.identity` 为 `-`；证书自动发现保持关闭。
  正式签名须由有权限的操作员显式配置 `CSC_NAME`，不得把 ad-hoc 宣称为发布者签名。
- electron-builder 在生成 DMG/ZIP **之前**，自内向外签署嵌套代码并做 strict 验证。
  默认 hardened runtime 及 Electron 所需 JIT/library-validation entitlements 由固定版本
  electron-builder 提供；不得在签名后改写应用资源。
- `npm run desktop:package` 与发布准备均拒绝未封装资源或签名校验失败的应用。
  `desktop-release.json` 的 `signing` 记录 `type` 和 `verified`；兼容字段 `unsigned: true`
  表示**没有发布者身份**，即使 ad-hoc 完整性校验通过也保持为 true。
- 打包命令还会只读挂载 DMG、解压 ZIP，自动校验其中实际应用的 deep/strict 签名。
  四平台发布清单可包含 macOS arm64 的可选更新 ZIP；没有发布者身份时仍只走 DMG 手动安装。
  执行 packaged smoke（含 PTY/浏览器共享后台）。
  这些检查不能替代“浏览器下载 → Finder 安装 → 用户明确同意”的隔离场景人工验收。
- 每次交付递增 `desktop/release.json` 的构建号、重新生成校验和。
  不覆盖已有公开 Release，不以移除隔离或本机可启动宣称通过 Gatekeeper。

English summary: These are complete **ad-hoc signed**, **unnotarized** opt-in test builds,
not publisher-authenticated releases. Verify the official DMG checksum and the installed app's
`codesign --verify --deep --strict` result before trusting it. Stop on verification failure;
do not re-sign a downloaded app to hide a failure. Any quarantine exception must be a conscious,
manual, app-scoped tester choice. Never disable system security globally.
