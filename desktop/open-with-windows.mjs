import { execFile } from "node:child_process";
import { win32 } from "node:path";

const limit = 16;
const appIdPattern = /^win:[a-f0-9]{64}$/;
const reservedName = /^(?:CON|PRN|AUX|NUL|CONIN\$|CONOUT\$|COM[0-9¹²³]|LPT[0-9¹²³]) *(?:\.|$)/i;

function localPath(path) {
  // No UNC, device paths, alternate data streams, traversal or shell namespaces.
  if (typeof path !== "string" || path.length > 4096 || !/^[a-z]:[\\/]/i.test(path)) return;
  const rest = path.slice(3).replaceAll("/", "\\");
  if (!rest) return path.slice(0, 2) + "\\";
  const normalized = rest.replace(/\\$/, "");
  if (normalized.split("\\").some(part => !part || /[<>:"|?*\x00-\x1f]|[. ]$|\.\{[0-9a-f-]+\}$/i.test(part) || reservedName.test(part))) return;
  return path.slice(0, 2) + "\\" + normalized;
}

// Fixed, non-interactive STA bridge to Shell32; requests are JSON on stdin, never script
// source or command-line arguments. Use C# supported by inbox Windows PowerShell 5.1.
const script = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Console]::InputEncoding
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
Add-Type -ReferencedAssemblies @('System.dll', 'System.Drawing.dll') -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;

public static class OpenWithWindows {
    [ComImport, Guid("973810ae-9599-4b88-9e4d-6ee98c9552da"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IEnumAssocHandlers {
        [PreserveSig] int Next(uint count, out IAssocHandler handler, out uint fetched);
    }

    [ComImport, Guid("f04061ac-1659-4a3f-a954-775aa57fc083"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAssocHandler {
        [PreserveSig] int GetName(out IntPtr name);
        [PreserveSig] int GetUIName(out IntPtr name);
        [PreserveSig] int GetIconLocation(out IntPtr path, out int index);
        [PreserveSig] int IsRecommended();
        [PreserveSig] int MakeDefault([MarshalAs(UnmanagedType.LPWStr)] string description);
        [PreserveSig] int Invoke(IDataObject selection);
        [PreserveSig] int CreateInvoker(IDataObject selection, out IAssocHandlerInvoker invoker);
    }

    [ComImport, Guid("92218cab-ecaa-4335-8133-807fd234c2ee"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IAssocHandlerInvoker {
        [PreserveSig] int SupportsSelection();
        [PreserveSig] int Invoke();
    }

    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {
        [PreserveSig] int BindToHandler(IntPtr context, ref Guid handler, ref Guid iid,
            [MarshalAs(UnmanagedType.Interface)] out IDataObject result);
        [PreserveSig] int GetParent(out IShellItem parent);
        [PreserveSig] int GetDisplayName(uint format, out IntPtr name);
    }

    [DllImport("shell32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int SHAssocEnumHandlers(string association, int filter, out IEnumAssocHandlers handlers);

    [DllImport("shell32.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int SHCreateItemFromParsingName(string path, IntPtr context, ref Guid iid, out IShellItem item);

    [DllImport("shlwapi.dll", ExactSpelling = true, CharSet = CharSet.Unicode)]
    private static extern int AssocQueryStringW(uint flags, uint query, string association, string extra,
        StringBuilder output, ref uint length);

    private static string DefaultExecutable(string extension) {
        var output = new StringBuilder(4096);
        uint length = (uint)output.Capacity;
        // ASSOCF_NONE (honor user settings), ASSOCSTR_EXECUTABLE, default verb.
        return AssocQueryStringW(0, 2, extension, null, output, ref length) == 0
            ? output.ToString().Replace('/', '\\') : null;
    }

    public sealed class App {
        public string id { get; set; }
        public string name { get; set; }
        public bool isDefault { get; set; }
        public string icon { get; set; }
    }

    private static void Release(object value) {
        if (value != null) Marshal.ReleaseComObject(value);
    }

    private static string TakeString(int hr, IntPtr ptr) {
        try { return hr == 0 ? Marshal.PtrToStringUni(ptr) : null; }
        finally { Marshal.FreeCoTaskMem(ptr); }
    }

    private static IDataObject Selection(string path) {
        IShellItem item;
        Guid iid = typeof(IShellItem).GUID;
        int hr = SHCreateItemFromParsingName(path, IntPtr.Zero, ref iid, out item);
        try {
            if (hr != 0 || item == null) return null;
            IntPtr name;
            string parsed = TakeString(item.GetDisplayName(0x80058000, out name), name); // SIGDN_FILESYSPATH
            if (!String.Equals(parsed, path, StringComparison.OrdinalIgnoreCase)) return null;
            Guid bhid = new Guid("b8c0bd9f-ed24-455c-83e6-d5390c4fe8c4"); // BHID_DataObject
            iid = typeof(IDataObject).GUID;
            IDataObject data;
            if (item.BindToHandler(IntPtr.Zero, ref bhid, ref iid, out data) == 0) return data;
            Release(data);
            return null;
        } finally { Release(item); }
    }

    // Filter by executable identity, not the localized label or the target's extension.
    private static readonly Regex Runner = new Regex(
        @"^(?:explorer|cmd|command|powershell(?:_ise)?|pwsh|wscript|cscript|mshta|rundll32|dllhost|regsvr32|regedit|reg|control|mmc|msiexec|openwith|forfiles|runas|schtasks|wmic|msbuild|installutil|ieexec|hh|msdt|msedge_proxy|applicationframehost|runtimebroker|conhost|openconsole|wt|windowsterminal(?:preview)?|wsl(?:host|config)?|bash|sh|zsh|fish|dash|ksh|busybox|mintty|conemu(?:64)?|cmder|hyper|wezterm(?:-gui)?|alacritty|kitty|tabby|node(?:js)?|bun|deno|pythonw?(?:[0-9]+(?:\.[0-9]+)*)?|pypy(?:[0-9]+)?|pyw?|pymanager|rubyw?|perl|wperl|php(?:-cgi)?|javaw?|javaws|jshell|jjs|csi|dotnet|mono|lua(?:[0-9]+(?:\.[0-9]+)*)?|luajit|tclsh[0-9.]*|wish[0-9.]*|rscript|rterm|gawk|awk|osascript)(?:\.exe)?\z",
        RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);

    private static bool DirectExecutable(string path) {
        if (String.IsNullOrEmpty(path) || path.Length > 4096 || !Regex.IsMatch(path, @"\A[a-zA-Z]:\\")) return false;
        foreach (string component in path.Substring(3).Split('\\')) {
            if (component.Length == 0 || component.EndsWith(".", StringComparison.Ordinal) ||
                component.EndsWith(" ", StringComparison.Ordinal) || component.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0) return false;
        }
        return path.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) && !Runner.IsMatch(Path.GetFileName(path));
    }

    private static App Describe(IAssocHandler handler, out string executable) {
        IntPtr ptr;
        executable = TakeString(handler.GetName(out ptr), ptr);
        if (executable == null) return null;
        executable = executable.Replace('/', '\\');
        if (!DirectExecutable(executable)) return null;
        try {
            FileAttributes attrs = File.GetAttributes(executable);
            if ((attrs & (FileAttributes.Directory | FileAttributes.ReparsePoint)) != 0) return null;
            // Also reject known runners registered under an alternate filename.
            string original = FileVersionInfo.GetVersionInfo(executable).OriginalFilename;
            if (!String.IsNullOrEmpty(original) && Runner.IsMatch(original.Trim())) return null;
        } catch (System.ComponentModel.Win32Exception) { return null; }
          catch (IOException) { return null; }
          catch (UnauthorizedAccessException) { return null; }
        string name = TakeString(handler.GetUIName(out ptr), ptr);
        if (String.IsNullOrWhiteSpace(name) || name.Length > 256) return null;
        using (SHA256 hash = SHA256.Create()) {
            byte[] bytes = Encoding.Unicode.GetBytes(executable.ToUpperInvariant());
            return new App {
                id = "win:" + BitConverter.ToString(hash.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant(),
                name = name.Trim()
            };
        }
    }

    private static string AppIcon(string executable) {
        try {
            using (Icon icon = Icon.ExtractAssociatedIcon(executable)) {
                if (icon == null) return null;
                using (Bitmap bitmap = icon.ToBitmap())
                using (MemoryStream bytes = new MemoryStream()) {
                    if (bitmap.Width > 64 || bitmap.Height > 64) return null;
                    bitmap.Save(bytes, ImageFormat.Png);
                    if (bytes.Length <= 16000) return "data:image/png;base64," + Convert.ToBase64String(bytes.ToArray());
                }
            }
        } catch (Exception) { /* A handler can still be used without an icon. */ }
        return null;
    }

    public static App[] List(string path, string kind, int limit) {
        var apps = new List<App>();
        Visit(path, kind, null, apps, limit);
        return apps.ToArray();
    }

    private static bool Start(string executable, string path) {
        // .NET Framework has no ArgumentList. The path was checked for quotes;
        // double a trailing backslash (drive root) before our closing quote.
        string argument = "\"" + path + (path.EndsWith("\\", StringComparison.Ordinal) ? "\\" : "") + "\"";
        var start = new ProcessStartInfo(executable, argument) { UseShellExecute = false };
        using (Process process = Process.Start(start)) { return process != null; }
    }

    // Enumerate again and launch only the executable of the matching Shell
    // registration. Never invoke registry commands, DDE or a file's default verb.
    public static bool Open(string path, string appId) {
        return Visit(path, null, appId, new List<App>(), 1);
    }

    private static bool Visit(string path, string kind, string appId, List<App> apps, int limit) {
        FileAttributes attrs = File.GetAttributes(path);
        if ((attrs & FileAttributes.ReparsePoint) != 0) return false;
        bool folder = (attrs & FileAttributes.Directory) != 0;
        bool opening = appId != null;
        if (!opening && kind != (folder ? "directory" : "file")) return false;
        string extension = folder ? null : Path.GetExtension(path);
        if (!folder && String.IsNullOrEmpty(extension)) return false;
        // Best effort: accept folder classes only if the Shell returns an actual
        // handler and its invoker declares support for this particular selection.
        string[] associations = folder ? new[] { "Directory", "Folder" } : new[] { extension };
        string defaultExe = (folder || opening) ? null : DefaultExecutable(extension);
        IDataObject selection = folder ? Selection(path) : null;
        if (folder && selection == null) return false;
        try {
            HashSet<string> seen = new HashSet<string>(StringComparer.Ordinal);
            foreach (string association in associations) {
                IEnumAssocHandlers handlers;
                int hr = SHAssocEnumHandlers(association, 0, out handlers); // ASSOC_FILTER_NONE
                try {
                    if (hr != 0 || handlers == null) continue;
                    while (apps.Count < limit) {
                        IAssocHandler handler;
                        uint fetched;
                        hr = handlers.Next(1, out handler, out fetched);
                        try {
                            if (hr != 0 || fetched != 1 || handler == null) break;
                            string executable;
                            App app = Describe(handler, out executable);
                            if (app == null || (opening && appId != app.id) || seen.Contains(app.id)) continue;
                            if (folder) {
                                IAssocHandlerInvoker invoker;
                                hr = handler.CreateInvoker(selection, out invoker);
                                try {
                                    if (hr != 0 || invoker == null || invoker.SupportsSelection() != 0) continue;
                                } finally { Release(invoker); }
                            }
                            if (opening) return Start(executable, path);
                            seen.Add(app.id);
                            app.isDefault = String.Equals(executable, defaultExe, StringComparison.OrdinalIgnoreCase);
                            app.icon = AppIcon(executable);
                            apps.Add(app);
                        } finally { Release(handler); }
                    }
                } finally { Release(handlers); }
            }
            return false;
        } finally { Release(selection); }
    }
}
'@
if ($request.op -eq 'list') {
    $apps = [OpenWithWindows]::List($request.path, $request.kind, ${limit})
    [Console]::WriteLine((ConvertTo-Json -InputObject $apps -Compress))
} elseif ($request.op -eq 'open') {
    $ok = [OpenWithWindows]::Open($request.path, $request.appId)
    [Console]::WriteLine((ConvertTo-Json -InputObject $ok -Compress))
}
`;
// Leave headroom below CreateProcessW's command-line length limit.
const encodedScript = Buffer.from(script.replace(/^ +/gm, ""), "utf16le").toString("base64");
const args = ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-EncodedCommand", encodedScript];

// Dependency injection for isolated tests; normal callers use the two exports below.
export function createWindowsOpenWith({ platform = process.platform, systemRoot = process.env.SystemRoot, exec = execFile } = {}) {
  const root = localPath(systemRoot);
  const system32 = root && win32.join(root, "System32");
  const exe = system32 && win32.join(system32, "WindowsPowerShell", "v1.0", "powershell.exe");

  async function request(input) {
    if (platform !== "win32" || !exe) return;
    try {
      const output = await new Promise((resolve, reject) => {
        const child = exec(exe, args, { cwd: system32, shell: false, windowsHide: true, timeout: 10_000, maxBuffer: 512 * 1024 },
          (error, stdout) => error ? reject(error) : resolve(stdout));
        child.stdin.on("error", reject);
        child.stdin.end(JSON.stringify(input), "utf8");
      });
      return JSON.parse(output);
    } catch {
      // Missing/blocked PowerShell, Shell errors and malformed output fail closed.
    }
  }

  return {
    async listWindowsApps(path, kind) {
      path = localPath(path);
      if (!path || (kind !== "file" && kind !== "directory")) return [];
      const rows = await request({ op: "list", path, kind });
      if (!Array.isArray(rows)) return [];
      const apps = new Map();
      for (const row of rows) {
        if (typeof row?.id !== "string" || !appIdPattern.test(row.id) || apps.has(row.id) ||
            typeof row.name !== "string" || !row.name.trim() || row.name.length > 256) continue;
        const icon = typeof row.icon === "string" && row.icon.length <= 24_000 && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(row.icon) ? row.icon : undefined;
        apps.set(row.id, { id: row.id, name: row.name, ...(icon && { icon }), ...(row.isDefault === true ? { isDefault: true } : {}) });
        if (apps.size === limit) break;
      }
      return [...apps.values()];
    },
    async openWindowsApp(path, appId) {
      path = localPath(path);
      if (!path || typeof appId !== "string" || !appIdPattern.test(appId)) return false;
      return await request({ op: "open", path, appId }) === true;
    },
  };
}

const windows = createWindowsOpenWith();

export async function listWindowsApps(path, kind) {
  return windows.listWindowsApps(path, kind);
}

export async function openWindowsApp(path, appId) {
  return windows.openWindowsApp(path, appId);
}
