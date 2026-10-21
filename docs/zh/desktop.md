# 桌面测试版

::: warning 不是全平台正式发行
目前验收下载目标仅为 **macOS Apple Silicon（arm64）**。Windows/Linux 配置存在不等于已有验收发行包。本页是用户流程；底层构建和维护者记录留在[原桌面资料](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop.md)。
:::

桌面包名为 **pi**，自带 Node/Pi，支持复用兼容后台、在浏览器打开同一服务和退出时选择是否保留后台任务。不需要为它单独装全局 Node/Pi。

## 下载、校验和安装

1. 从[项目 GitHub Releases](https://github.com/chengzhiyi/pi-webapp/releases) 中选择被明确邀请测试的 `desktop-v...` 预发布版本，下载 arm64 DMG 和**同一发行**的 `SHA256SUMS`。不要用来源不明的转发包或源码 ZIP。
2. 对下载文件运行 `shasum -a 256 <DMG路径>`，比较清单对应行；不一致即停止。只下载 DMG 时，不要因缺少 ZIP 而误判其他文件校验。
3. 结束任务，退出旧桌面。替换自有运行时前停止它的后台；不要停止仍需使用的外部 Web 后台，也不要删除 Pi 数据。把 **pi.app** 拖入「应用程序」。旧 **Pi Webapp.app** 不会自动被覆盖，更新 Dock 快捷方式。
4. 验证安装内容：

   ```bash
   codesign --verify --deep --strict --verbose=2 "/Applications/pi.app"
   ```

   失败就停止并反馈，**不要自行重签掩盖失败**。
5. 尝试打开。构建 7 起使用完整 **ad-hoc 临时签名**，但**没有 Developer ID 发布者身份、没有 Apple 公证**，Gatekeeper 仍可能拦截。仅在已核对来源、校验、签名并愿意信任测试包时，按 macOS 提供的「系统设置 → 隐私与安全性 → 仍要打开」操作。
6. 若仍受下载隔离限制，先阅读[完整测试安装说明](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop-testing.md)后再决定是否手动做**仅限该应用**的例外。不全局关闭 Gatekeeper/SIP，不盲目使用 sudo。校验和与 ad-hoc 都不证明软件安全，也不证明开发者身份。
7. 在 **pi → 关于 pi** 核对版本、桌面构建号和应用位置，然后按[首次对话](./getting-started#_3-配置模型并完成第一轮)配置模型。

旧包不会随源码更新自动修复；不要覆盖发布过的同名包。测试包更新需手动校验安装，不自动安装。不能接受这些限制时使用 Web 版即可。

反馈附系统版本、芯片、构建号、脱敏错误和校验结果，不附令牌、`auth.json`、私钥或完整本机路径。
