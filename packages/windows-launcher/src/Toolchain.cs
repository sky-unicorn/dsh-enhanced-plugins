using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;
using System.Web.Script.Serialization;

namespace DshEnhanced.WindowsLauncher
{
    // Runtime facts and version choices only; inherited environment variables never cross into UI state.
    internal sealed class ToolchainSnapshot
    {
        public string requestId { get; set; }
        public string requestedNodeVersion { get; set; }
        public string[] installedNodeVersions { get; set; }
        public string mode { get; set; }
        public string phase { get; set; }
        public string nodeVersion { get; set; }
        public string nodeRequirement { get; set; }
        public string nodeSource { get; set; }
        public string nodePath { get; set; }
        public string manager { get; set; }
        public string managerVersion { get; set; }
        public string managerRequirement { get; set; }
        public string managerSource { get; set; }
        public string projectPath { get; set; }
        public string nvmRoot { get; set; }
        public string message { get; set; }
    }

    internal static class ToolchainInspector
    {
        internal static string BundlePath { get { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "DSH-Launcher.Toolchain.cjs"); } }
        internal static string StatePath { get { return Path.Combine(LauncherPaths.Run, "web-toolchain.json"); } }

        private static List<string> SearchRoots()
        {
            List<string> roots = new List<string>();
            foreach (string value in new[] {
                Environment.GetEnvironmentVariable("NVM_HOME"), Environment.GetEnvironmentVariable("NVM_DIR"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "nvm"),
                Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "nvm") })
                if (!String.IsNullOrWhiteSpace(value)) roots.Add(value);
            foreach (string directory in (Environment.GetEnvironmentVariable("PATH") ?? "").Split(Path.PathSeparator))
                if (!String.IsNullOrWhiteSpace(directory)) roots.Add(directory.Trim().Trim('"'));
            return roots;
        }

        internal static bool HasNvm()
        {
            foreach (string root in SearchRoots())
                if (File.Exists(Path.Combine(root, "nvm.exe"))) return true;
            return false;
        }

        // Prefer a modern installed NVM executable to bootstrap inspection even if PATH points to old Node.
        internal static string BootstrapNode()
        {
            List<string> roots = SearchRoots();
            SortedDictionary<Version, string> nodes = new SortedDictionary<Version, string>();
            foreach (string root in roots)
            {
                try
                {
                    if (!File.Exists(Path.Combine(root, "nvm.exe"))) continue;
                    string versionsRoot = root;
                    string settings = Path.Combine(root, "settings.txt");
                    if (File.Exists(settings))
                        foreach (string line in File.ReadAllLines(settings))
                            if (line.StartsWith("root:", StringComparison.OrdinalIgnoreCase)) versionsRoot = line.Substring(5).Trim();
                    if (!Directory.Exists(versionsRoot)) continue;
                    foreach (string directory in Directory.GetDirectories(versionsRoot))
                    {
                        Version version;
                        string node = Path.Combine(directory, "node.exe");
                        if (Version.TryParse(Path.GetFileName(directory).TrimStart('v'), out version)
                            && version.Major >= 16 && File.Exists(node)) nodes[version] = node;
                    }
                }
                catch (IOException) { }
                catch (UnauthorizedAccessException) { }
            }
            string selected = null;
            foreach (string node in nodes.Values) selected = node;
            if (selected != null) return selected;
            foreach (string root in roots)
            {
                string node = Path.Combine(root, "node.exe");
                if (File.Exists(node)) return node;
            }
            return null;
        }

        internal static ToolchainSnapshot Inspect(LauncherRequest request)
        {
            string node = BootstrapNode();
            if (node == null) return new ToolchainSnapshot { mode = HasNvm() ? "sandbox" : "system",
                requestedNodeVersion = request.nodeVersion, installedNodeVersions = new string[0],
                phase = HasNvm() || !String.IsNullOrEmpty(request.nodeVersion) ? "error" : "detected",
                message = HasNvm() || !String.IsNullOrEmpty(request.nodeVersion) ? RuntimeText.NoBootstrap : "未找到可用于检测的 Node；启动时保留原有方式。" };
            string file = Path.Combine(LauncherPaths.Requests, "inspect-" + Guid.NewGuid().ToString("N") + ".json");
            try
            {
                JsonFile.Write(file, request);
                ProcessStartInfo info = new ProcessStartInfo(node, NativeArguments.Quote(BundlePath) + " inspect " + NativeArguments.Quote(file));
                info.UseShellExecute = false;
                info.CreateNoWindow = true;
                info.RedirectStandardOutput = true;
                info.RedirectStandardError = true;
                info.StandardOutputEncoding = System.Text.Encoding.UTF8;
                info.StandardErrorEncoding = System.Text.Encoding.UTF8;
                using (Process process = Process.Start(info))
                {
                    Task<string> output = process.StandardOutput.ReadToEndAsync();
                    Task<string> error = process.StandardError.ReadToEndAsync();
                    if (!process.WaitForExit(45000))
                    {
                        // Inspection's child probes have their own 15-second deadline.
                        process.Kill();
                        throw new IOException("运行环境检测超时。");
                    }
                    Task.WaitAll(output, error);
                    if (process.ExitCode != 0) throw new IOException(error.Result);
                    return new JavaScriptSerializer().Deserialize<ToolchainSnapshot>(output.Result);
                }
            }
            catch (Exception error)
            {
                return new ToolchainSnapshot { mode = "unknown", phase = "error", message = "运行环境检测失败：" + error.Message };
            }
            finally { if (File.Exists(file)) File.Delete(file); }
        }
    }

    // Launcher currently owns a Chinese native UI. Keep all new product copy together.
    internal static class RuntimeText
    {
        internal const string Title = "运行环境";
        internal const string Subtitle = "自动匹配或指定 Node 版本，启动前校验";
        internal const string VersionSelection = "Node 版本选择";
        internal const string Automatic = "自动选择（最高兼容版本）";
        internal const string SelectionHint = "用于后续启动和源码操作；正在运行的进程不变";
        internal const string NoNvm = "未检测到 NVM，自动模式使用系统环境";
        internal const string MissingVersion = "（未安装）";
        internal const string SelectionSaved = "Node 版本选择已保存，将用于后续启动和源码操作。";
        internal const string SelectionFailed = "无法保存 Node 版本选择：";
        internal const string Detecting = "正在检测运行环境…";
        internal const string Sandbox = "NVM 沙盒";
        internal const string System = "系统环境";
        internal const string Preparing = "准备中";
        internal const string Error = "需要处理";
        internal const string Refresh = "重新检测";
        internal const string Node = "Node.js";
        internal const string Manager = "包管理器";
        internal const string Pending = "待检测";
        internal const string Unspecified = "未指定版本";
        internal const string Unverified = "由原启动器决定";
        internal const string Active = "本次启动";
        internal const string Next = "下次启动预检";
        internal const string External = "外部服务 · 无法确认其运行环境";
        internal const string Requirement = "需求 ";
        internal const string Source = "来源 ";
        internal const string Install = "启动时准备";
        internal const string NoBootstrap = "没有可用于检测的 Node；请通过 nvm install 安装所需版本。若已移除 NVM，请恢复系统 Node 并切回自动选择。";
    }
}
