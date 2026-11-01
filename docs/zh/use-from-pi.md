# 在 Pi 终端里使用

本页写给已经在用 Pi 终端界面、想在浏览器里查看同一个会话的人。

## 设置

把 pi-webapp 作为 Pi 包安装一次，然后照常启动 Pi：

```bash
pi install npm:pi-webapp
cd ~/projects/my-app
pi
```

在 Pi 里输入：

```text
/web
```

Pi 会在浏览器里打开工作台，并在终端里以通知的形式显示地址。状态栏会变成 `Web 已启动 · /web 重新打开`。

如果浏览器没有打开（远程机器、SSH，或没有桌面），请复制打印出的地址。如果你关掉了标签页，再运行一次 `/web` 就能拿回地址。

你需要 Node.js 22.19 或更新版本，以及 Pi 0.87.1 或更新版本（`pi --version`）。这种模式使用的是**你已安装的 Pi**，而不是 Web 启动器自带的那一份。

## 它的行为

- **浏览器镜像那个终端会话。** 你在任一边输入的内容，两边都会显示。代理、工具和会话文件仍然归 Pi 所有。
- **它的寿命和那个 Pi 进程一样长。** 退出 Pi，Web 服务和它的地址就结束了。再次启动 `pi` 并输入 `/web`，会得到带新令牌的新地址。
- **没有后台服务。** `pi-webapp status` 和 `pi-webapp stop` 管理的是*后台启动器*，不管这种模式。同样，设置里的 **升级并重启** 在这里也不可用，见下文。
- **你启动 Pi 的那个目录**会作为工作区出现，和 Pi 已知的其他工作区并列。

## 自动打开浏览器

启动 Pi 之前设置 `PI_WEBAPP_AUTO_OPEN=1`，Pi 在终端界面启动时就会替你运行 `/web`：

```bash
PI_WEBAPP_AUTO_OPEN=1 pi
```

只有这种情况才需要 `1`。对后台启动器来说，阻止浏览器自动打开的办法是 `PI_WEBAPP_AUTO_OPEN=0`（见[环境变量](./reference/environment)）。

## 更新

在普通 shell 里执行，不要在 Pi 里：

```bash
pi update npm:pi-webapp
```

然后重启 Pi 并输入 `/web`。单独的 `pi update` 更新的是 Pi 本身，不是扩展。更多见[更新](./updates#update-from-the-pi-terminal-web)。

## 更想用后台启动器？

随时可以切换。会话文件是同一份，所以你在终端里开始的会话会出现在 Web 启动器的侧栏里，反过来也一样。见[快速开始](./getting-started)。
