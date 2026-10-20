const { createRequire } = require("node:module");
const { join } = require("node:path");

// A real terminal must answer cursor/device queries. Windows ConPTY can wait
// for these answers before running cmd; a raw onData collector is not a client.
function checkPty({ pty, Terminal, platform = process.platform, env = process.env, timeoutMs = 12000 }) {
  return new Promise((resolve, reject) => {
    const screen = new Terminal({ cols: 80, rows: 24, allowProposedApi: true });
    const windows = platform === "win32";
    const terminal = pty.spawn(windows ? "cmd.exe" : "/bin/sh", windows ? ["/d", "/q"] : ["-i"], {
      cols: 80, rows: 24, env: { ...env, PI_DESKTOP_PROBE_SUFFIX: "PTY_OK" },
    });
    let text = "", finished = false;
    const timer = setTimeout(() => finish(new Error("PTY command/exit timed out")), timeoutMs);
    function finish(error) {
      if (finished) return;
      finished = true; clearTimeout(timer); screen.dispose();
      if (error) { try { terminal.kill(); } catch {} reject(error); }
      else resolve();
    }
    screen.onData(data => terminal.write(data));
    terminal.onData(data => { text += data; screen.write(data); });
    terminal.onExit(({ exitCode }) => finish(exitCode === 0 && text.includes("PI_DESKTOP_PTY_OK")
      ? null : new Error("PTY command did not complete with expected output and exit status")));
    terminal.write(windows ? "echo PI_DESKTOP_%PI_DESKTOP_PROBE_SUFFIX%\rexit /b 0\r" : "printf 'PI_DESKTOP_%s\\n' PTY_OK\rexit 0\r");
  });
}
module.exports = { checkPty };
if (require.main === module) {
  // Resolve inside the staged backend, never the host build's node_modules.
  const runtimeRequire = createRequire(join(process.cwd(), "package.json"));
  checkPty({ pty: runtimeRequire("node-pty"), Terminal: runtimeRequire("@xterm/headless").Terminal })
    .then(() => { console.log("PI_DESKTOP_PTY_OK (interactive terminal and exit verified)"); process.exit(0); })
    .catch(error => { console.error(error.message); process.exit(1); });
}
