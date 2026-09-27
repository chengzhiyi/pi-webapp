# pi-webapp

[English](README.md)

![pi-webapp 封面](https://unpkg.com/pi-webapp@0.1.0/assets/cover-webapp.png)

**pi-webapp** 可以在本地浏览器中打开当前活跃的 Pi 编程 Agent 会话。Agent、工具和会话存储仍由 Pi 运行和管理；浏览器提供实时的对话与控制界面。

## 安装与打开

需要 Node.js 22.19 或更新版本，以及 Pi 0.87.1 或更新版本。

```bash
pi install npm:pi-webapp
pi
```

在 Pi 中输入 `/web`，即可在默认浏览器中打开界面。对于远程或无图形界面的环境，Pi 也会输出本地访问地址。该地址包含一个随机令牌，仅在当前 Pi 进程运行期间有效。再次输入 `/web` 可以重新打开界面。

## 功能

- 查看当前对话，包括 Markdown 内容、流式输出、可展开的推理过程与工具调用、Token 用量，以及逐轮执行轨迹。
- 发送消息、停止运行、启动新的 Pi 会话，以及切换当前模型或思考级别。
- 浏览工作区和已保存的会话。环境支持时可通过系统目录选择器添加工作区；通过 SSH 使用时，也可使用内置目录浏览器。
- 通过选择、拖放或粘贴附加文件，最多 20 个，每个不超过 20 MB。图片会显示预览，并作为 Pi 图片内容发送。
- 在设置面板中管理外观、Pi 软件包、扩展、技能和模型。模型提供商的凭据保留在 Pi 本地的身份验证存储中，不会返回给浏览器。

打开 `/web` 的 Pi 终端会话会与浏览器保持同步。在其他工作区打开的会话使用 Pi SDK，并加载该工作区的技能和项目上下文；同一进程中不会再次加载扩展。

工作区记录和附件继续存放在 Pi 现有的 `pi-web/` 数据目录下，以兼容早期版本。从侧边栏移除工作区不会删除其文件或会话。

## 本地开发

```bash
npm install
npm run check
npm run test
npm run build
pi -e .
```

修改扩展后，需要重新构建扩展，再在 Pi 中依次输入 `/reload` 和 `/web`。仅刷新旧的浏览器页面不会替换正在运行的连接桥接代码。

源代码位于 `extension/`、`shared/` 和 `web/src/`。npm 软件包仅包含打包并压缩后的 JavaScript 扩展、构建后的 Web 资源、封面图片，以及英文和中文 README；不会发布 TypeScript 源码或 source map。代码压缩会增加阅读发布版本代码的难度，但不会对 JavaScript 加密。

## 发布

`npm publish` 会运行检查、测试和生产构建。`pi-package` 关键词使发布到 npm 的软件包有资格进入 [Pi 软件包目录](https://pi.dev/packages)；目录更新可能晚于 npm。

GitHub Actions 会在针对 `main` 的拉取请求中运行 `check`、`test` 和 `build`。代码推送到 `main` 后会再次运行这些检查，全部通过才自动发布下一个补丁版本。发布版本根据源码版本和 npm `latest` 版本确定，仅在 CI 中写入包文件，不会提交回 Git。如需开始新的次版本或主版本，请在拉取请求中同步提高 `package.json` 和 `package-lock.json` 的版本。每次发布也会将包内 `pi.image` 的地址更新为该版本。

首次自动发布前，请在 npm 的 `pi-webapp` 包设置中配置 Trusted Publishing：GitHub 所有者为 `chengzhiyi`，仓库为 `pi-webapp`，工作流文件名为 `ci.yml`，不设置环境，并允许直接执行 `npm publish`。工作流通过 GitHub OIDC 认证，无需 npm token。`package.json` 中的仓库地址应与 GitHub 仓库保持一致。

## 许可证

MIT。详见 `LICENSE` 文件。
