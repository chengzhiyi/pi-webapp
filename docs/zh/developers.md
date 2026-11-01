# 开发者

本页写给想从源码构建 pi-webapp、编写插件，或为这套文档做贡献的人。用户指南不涉及内部实现，所以这里只指出它们在哪里。

## 从源码运行

需要 Node.js 22.19 或更新版本。

```bash
git clone https://github.com/chengzhiyi/pi-webapp.git
cd pi-webapp
npm ci
npm run check
npm test
npm run start
```

`npm run start` 会构建并启动后台服务。改了扩展代码之后，再次运行 `npm run stop` 和 `npm run start`；单纯刷新浏览器并不会替换后端。用 `pi -e .` 时，重新构建后在 Pi 里输入 `/reload`，再输入 `/web`。`npm run dev` 会强制停止正在运行的服务、重新构建并启动，很方便，但会丢弃未保存的插件修改。见[命令行](./reference/cli)。

桌面应用：

```bash
npm run desktop:prepare
npm run desktop:start
npm run desktop:package   # 在 desktop-release/ 下生成当前系统的安装包
```

## 插件开发

把 `PI_WEBAPP_PLUGIN_DEV_ROOTS` 设为受信任的本地插件源码目录。多个目录之间用你所在平台的路径分隔符隔开（macOS 和 Linux 是 `:`，Windows 是 `;`）。启动器会把它们作为 Pi 扩展加载，并在插件构建出的 `dist/extension.js` 变化时重新加载。只使用你信任的目录：它们以你的权限运行。

## GitHub 上的工程文档

这些文档描述 pi-webapp 是怎么构建和发布的。它们不属于本站，可能提到内部的工作事项，而且是英文的。

- [架构](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/architecture.md)：分层、职责划分和插件生命周期
- [Web 插件](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/web-plugins.md)：插件协议
- [托管插件运行时](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/hosted-plugin-runtime.md)和[安装](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/hosted-plugin-installation.md)
- [发布通道](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/release-channels.md)
- [桌面构建](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop.md)和 [macOS 测试安装](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/desktop-testing.md)
- [Sentry 运维](https://github.com/chengzhiyi/pi-webapp/blob/main/docs/sentry.md)
- [设计决策](https://github.com/chengzhiyi/pi-webapp/tree/main/docs/decisions)

## 参与这套文档

本站用 [VitePress](https://vitepress.dev/) 构建。英文页面是 `docs/en/` 里的 Markdown 文件，发布在站点根路径；中文页面在 `docs/zh/`，发布在 `/zh/` 下。`docs/` 里的其他内容是工程资料，故意不放进构建。

```bash
npm --prefix docs ci      # 只需一次
npm run docs:dev          # 实时预览
npm run docs:build        # 生产构建；页面链接失效时会失败
npm run docs:check        # 校验输出里的每个链接、资源和 #锚点，以及中英文页面是否一一对应
npm run docs:preview      # 在本地提供构建好的站点
```

预览地址以 `/pi-webapp/` 结尾，因为站点是为 GitHub Pages 的项目路径构建的。要构建部署在根路径的版本，请设置 `DOCS_BASE=/`。

页面写作准则：

- 开头用一句话说明这页帮你解决什么，先讲步骤，再讲解释。
- 每条命令、选项、默认值和路径，都要对照代码或亲自运行过来确认。指南和代码不一致时，以代码为准，并修正指南。
- 界面标签要原样引用，用**粗体**，并说明输出是什么样子。
- 用户页面里不要出现内部工作项名称或设计文档编号。
- 页面之间互相链接，不要留下死胡同。
- 英文是源文本。每改一个英文页面，对应的中文页面要同步更新；中文页面里引用的界面标签，要用中文界面里的实际文字。

`docs/` 下的改动会在每个拉取请求上构建；站点从 `main` 部署。
