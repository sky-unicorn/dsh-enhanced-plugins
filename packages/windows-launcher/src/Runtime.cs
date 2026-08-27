using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using Microsoft.Win32;

namespace DshEnhanced.WindowsLauncher
{
    internal sealed class LauncherSettings
    {
        public int Port { get; set; }
        public bool NoOpen { get; set; }
        public string DshCommand { get; set; }
        public string DshSourceDirectory { get; set; }
        public string WorkingDirectory { get; set; }
        public LauncherWindowPlacement WindowPlacement { get; set; }

        internal static LauncherSettings Defaults()
        {
            return new LauncherSettings
            {
                Port = 3080,
                NoOpen = false,
                DshCommand = String.Empty,
                DshSourceDirectory = String.Empty,
                WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                WindowPlacement = null,
            };
        }
    }

    internal sealed class LauncherWindowPlacement
    {
        public string ScreenDeviceName { get; set; }
        public int ScreenWorkingLeft { get; set; }
        public int ScreenWorkingTop { get; set; }
        public int ScreenWorkingWidth { get; set; }
        public int ScreenWorkingHeight { get; set; }
        public int Left { get; set; }
        public int Top { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public int Dpi { get; set; }
        public bool Maximized { get; set; }
    }

    internal sealed class LauncherRequest
    {
        public string requestId { get; set; }
        public string mode { get; set; }
        public string dshCommand { get; set; }
        public string workingDirectory { get; set; }
        public int port { get; set; }
        public bool noOpen { get; set; }
        public string logPath { get; set; }
        public string statePath { get; set; }
        public string stopPath { get; set; }
        public string task { get; set; }
        public string profile { get; set; }
        public string sourceDirectory { get; set; }
        public bool updateSource { get; set; }
    }

    internal sealed class LauncherState
    {
        public string requestId { get; set; }
        public string status { get; set; }
        public int supervisorPid { get; set; }
        public int runnerPid { get; set; }
        public string startedAtUtc { get; set; }
        public string stoppedAtUtc { get; set; }
        public int exitCode { get; set; }
        public bool stoppedByLauncher { get; set; }
        public int port { get; set; }
        public string logPath { get; set; }
    }

    internal enum WebOwnership
    {
        Stopped,
        Starting,
        Owned,
        External
    }

    internal enum LoginStartupMode
    {
        Disabled,
        LauncherOnly,
        LauncherAndDsh
    }

    internal static class StartupRegistration
    {
        internal const string StartDshArgument = "--start-dsh";

        internal static string BuildCommand(string executable, LoginStartupMode mode)
        {
            if (mode == LoginStartupMode.Disabled) return String.Empty;
            string quotedExecutable = NativeArguments.Quote(executable);
            if (!quotedExecutable.StartsWith("\"", StringComparison.Ordinal))
                quotedExecutable = "\"" + quotedExecutable + "\"";
            string command = quotedExecutable + " --tray";
            if (mode == LoginStartupMode.LauncherAndDsh) command += " " + StartDshArgument;
            return command;
        }

        internal static LoginStartupMode ParseMode(string command)
        {
            if (String.IsNullOrWhiteSpace(command)) return LoginStartupMode.Disabled;
            return System.Text.RegularExpressions.Regex.IsMatch(command,
                @"(?:^|\s)--start-dsh(?:\s|$)",
                System.Text.RegularExpressions.RegexOptions.IgnoreCase)
                ? LoginStartupMode.LauncherAndDsh
                : LoginStartupMode.LauncherOnly;
        }

        internal static bool HasArgument(string[] args, string expected)
        {
            foreach (string argument in args)
            {
                if (String.Equals(argument, expected, StringComparison.OrdinalIgnoreCase)) return true;
            }
            return false;
        }

        internal static bool SelfTest()
        {
            const string executable = @"C:\Program Files\DeepSeek Harness\DSH-Launcher.exe";
            string launcher = BuildCommand(executable, LoginStartupMode.LauncherOnly);
            string dsh = BuildCommand(executable, LoginStartupMode.LauncherAndDsh);
            return launcher == @"""C:\Program Files\DeepSeek Harness\DSH-Launcher.exe"" --tray"
                && dsh == @"""C:\Program Files\DeepSeek Harness\DSH-Launcher.exe"" --tray --start-dsh"
                && ParseMode(launcher) == LoginStartupMode.LauncherOnly
                && ParseMode(dsh) == LoginStartupMode.LauncherAndDsh
                && ParseMode(null) == LoginStartupMode.Disabled;
        }
    }

    internal sealed class WebStatusSnapshot
    {
        internal WebOwnership Ownership { get; set; }
        internal int Port { get; set; }
        internal string RequestId { get; set; }
        internal string Detail { get; set; }
        internal bool CanStop { get; set; }
    }

    internal sealed class OperationResult
    {
        internal bool Success { get; private set; }
        internal string Message { get; private set; }

        private OperationResult(bool success, string message)
        {
            Success = success;
            Message = message;
        }

        internal static OperationResult Ok(string message)
        {
            return new OperationResult(true, message);
        }

        internal static OperationResult Fail(string message)
        {
            return new OperationResult(false, message);
        }
    }

    internal static class LauncherPaths
    {
        internal static readonly string DataRoot = ResolveDataRoot();
        internal static readonly string Requests = Path.Combine(DataRoot, "requests");
        internal static readonly string Updates = Path.Combine(DataRoot, "updates");
        internal static readonly string Logs = Path.Combine(DataRoot, "logs");
        internal static readonly string Run = Path.Combine(DataRoot, "run");
        internal static readonly string Settings = Path.Combine(DataRoot, "settings.json");
        internal static readonly string State = Path.Combine(Run, "web-state.json");
        internal static readonly string Stop = Path.Combine(Run, "web-stop.txt");
        internal static readonly string ServerLog = Path.Combine(Logs, "dsh-web.log");
        internal static readonly string BuildLog = Path.Combine(Logs, "dsh-build.log");
        internal static readonly string LauncherLog = Path.Combine(Logs, "launcher.log");

        internal static string ProfileLog(string profile)
        {
            return Path.Combine(Logs, "profile-" + profile + ".log");
        }

        private static string ResolveDataRoot()
        {
            string configured = Environment.GetEnvironmentVariable("DEEPSEEK_HARNESS_LAUNCHER_HOME");
            if (!String.IsNullOrWhiteSpace(configured)) return Path.GetFullPath(configured);
            return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "DeepSeekHarness", "Launcher");
        }

        internal static void Ensure()
        {
            Directory.CreateDirectory(DataRoot);
            Directory.CreateDirectory(Requests);
            Directory.CreateDirectory(Updates);
            Directory.CreateDirectory(Logs);
            Directory.CreateDirectory(Run);
        }
    }

    internal static class JsonFile
    {
        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer();

        internal static T Read<T>(string path) where T : class
        {
            try
            {
                if (!File.Exists(path)) return null;
                return Serializer.Deserialize<T>(File.ReadAllText(path, Encoding.UTF8));
            }
            catch
            {
                return null;
            }
        }

        internal static void Write(string path, object value)
        {
            string directory = Path.GetDirectoryName(path);
            if (!String.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);
            string temporary = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            File.WriteAllText(temporary, Serializer.Serialize(value), new UTF8Encoding(false));
            try
            {
                if (File.Exists(path)) File.Replace(temporary, path, null, true);
                else File.Move(temporary, path);
            }
            catch (PlatformNotSupportedException)
            {
                File.Copy(temporary, path, true);
                File.Delete(temporary);
            }
        }
    }

    internal sealed class SettingsStore
    {
        internal LauncherSettings Load()
        {
            LauncherSettings settings = JsonFile.Read<LauncherSettings>(LauncherPaths.Settings);
            if (settings == null) settings = LauncherSettings.Defaults();
            if (settings.Port < 1 || settings.Port > 65535) settings.Port = 3080;
            if (String.IsNullOrWhiteSpace(settings.WorkingDirectory) || !Directory.Exists(settings.WorkingDirectory))
            {
                settings.WorkingDirectory = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            }
            if (settings.DshCommand == null) settings.DshCommand = String.Empty;
            if (settings.DshSourceDirectory == null) settings.DshSourceDirectory = String.Empty;
            LauncherWindowPlacement placement = settings.WindowPlacement;
            if (placement != null && (placement.Width < 240 || placement.Height < 180
                || placement.Width > 32768 || placement.Height > 32768
                || placement.ScreenWorkingWidth < 1 || placement.ScreenWorkingHeight < 1))
            {
                settings.WindowPlacement = null;
            }
            return settings;
        }

        internal void Save(LauncherSettings settings)
        {
            JsonFile.Write(LauncherPaths.Settings, settings);
        }
    }

    internal static class LauncherLog
    {
        private static readonly object Gate = new object();

        internal static void Write(string message)
        {
            try
            {
                LauncherPaths.Ensure();
                lock (Gate)
                {
                    File.AppendAllText(LauncherPaths.LauncherLog,
                        "[" + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + "] " + message + Environment.NewLine,
                        new UTF8Encoding(false));
                }
            }
            catch
            {
                // Diagnostics must never make the launcher unavailable.
            }
        }
    }

    internal static class DshLocator
    {
        internal static string Resolve(string configured)
        {
            List<string> candidates = new List<string>();
            AddCandidate(candidates, configured);
            AddCandidate(candidates, Environment.GetEnvironmentVariable("DSH_CMD"));

            string appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
            AddCandidate(candidates, Path.Combine(appData, "npm", "dsh.ps1"));
            AddCandidate(candidates, Path.Combine(appData, "npm", "dsh.exe"));
            AddCandidate(candidates, Path.Combine(appData, "npm", "dsh.cmd"));

            string path = Environment.GetEnvironmentVariable("PATH") ?? String.Empty;
            foreach (string rawDirectory in path.Split(Path.PathSeparator))
            {
                string directory = rawDirectory.Trim().Trim('"');
                if (directory.Length == 0) continue;
                AddCandidate(candidates, Path.Combine(directory, "dsh.ps1"));
                AddCandidate(candidates, Path.Combine(directory, "dsh.exe"));
                AddCandidate(candidates, Path.Combine(directory, "dsh.cmd"));
            }

            foreach (string candidate in candidates)
            {
                if (!File.Exists(candidate)) continue;
                if (String.Equals(Path.GetExtension(candidate), ".cmd", StringComparison.OrdinalIgnoreCase))
                {
                    string shim = Path.ChangeExtension(candidate, ".ps1");
                    if (File.Exists(shim)) return Path.GetFullPath(shim);
                }
                return Path.GetFullPath(candidate);
            }
            return null;
        }

        private static void AddCandidate(ICollection<string> values, string value)
        {
            if (String.IsNullOrWhiteSpace(value)) return;
            try
            {
                string full = Path.GetFullPath(Environment.ExpandEnvironmentVariables(value.Trim().Trim('"')));
                if (!values.Contains(full)) values.Add(full);
            }
            catch
            {
                // Ignore malformed configured or inherited paths.
            }
        }
    }

    internal static class NativeArguments
    {
        internal static string Quote(string value)
        {
            if (value == null) return "\"\"";
            if (value.Length > 0 && value.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return value;
            StringBuilder result = new StringBuilder();
            result.Append('"');
            int backslashes = 0;
            foreach (char character in value)
            {
                if (character == '\\')
                {
                    backslashes++;
                    continue;
                }
                if (character == '"')
                {
                    result.Append('\\', backslashes * 2 + 1);
                    result.Append('"');
                    backslashes = 0;
                    continue;
                }
                result.Append('\\', backslashes);
                backslashes = 0;
                result.Append(character);
            }
            result.Append('\\', backslashes * 2);
            result.Append('"');
            return result.ToString();
        }
    }

    internal sealed class LauncherRuntime
    {
        private const string RunKey = @"Software\Microsoft\Windows\CurrentVersion\Run";
        private const string RunName = "DeepSeekHarnessLauncher";
        private const string PluginManagementMutex = @"Local\DSH.Enhanced.WindowsLauncher.PluginManagement";
        private readonly SettingsStore settingsStore = new SettingsStore();
        private LauncherSettings settings;

        internal LauncherRuntime()
        {
            LauncherPaths.Ensure();
            settings = settingsStore.Load();
        }

        private static bool PluginManagementBusy()
        {
            bool acquired = false;
            using (Mutex mutex = new Mutex(false, PluginManagementMutex))
            {
                try
                {
                    acquired = mutex.WaitOne(0);
                    return !acquired;
                }
                catch (AbandonedMutexException)
                {
                    acquired = true;
                    return false;
                }
                finally
                {
                    if (acquired) mutex.ReleaseMutex();
                }
            }
        }

        private static OperationResult PluginManagementConflict()
        {
            return OperationResult.Fail("插件管理正在构建或提交更新；完成前不能启动新的 DSH 操作。");
        }

        internal LauncherSettings Settings
        {
            get { return settings; }
        }

        internal void SaveSettings()
        {
            settingsStore.Save(settings);
        }

        internal string ResolveDsh()
        {
            return DshLocator.Resolve(settings.DshCommand);
        }

        internal string ResolveDshSource()
        {
            if (String.IsNullOrWhiteSpace(settings.DshSourceDirectory)) return null;
            try
            {
                string source = Path.GetFullPath(Environment.ExpandEnvironmentVariables(
                    settings.DshSourceDirectory.Trim().Trim('"')));
                string packagePath = Path.Combine(source, "package.json");
                if (!Directory.Exists(source) || !File.Exists(packagePath)) return null;
                Dictionary<string, object> manifest = new JavaScriptSerializer()
                    .Deserialize<Dictionary<string, object>>(File.ReadAllText(packagePath, Encoding.UTF8));
                object name;
                object scriptsValue;
                if (manifest == null || !manifest.TryGetValue("name", out name)
                    || !String.Equals(name as string, "@deepseek-ai/dsh-root", StringComparison.Ordinal)
                    || !manifest.TryGetValue("scripts", out scriptsValue)) return null;
                Dictionary<string, object> scripts = scriptsValue as Dictionary<string, object>;
                object build;
                if (scripts == null || !scripts.TryGetValue("build", out build)
                    || String.IsNullOrWhiteSpace(build as string)) return null;
                return source;
            }
            catch
            {
                return null;
            }
        }

        internal WebStatusSnapshot Snapshot()
        {
            int port = settings.Port;
            bool open = IsPortOpen(port, 220);
            LauncherState state = JsonFile.Read<LauncherState>(LauncherPaths.State);
            bool supervisor = state != null && ProcessMatches(state);
            if (supervisor && state.port == port)
            {
                return new WebStatusSnapshot
                {
                    Ownership = open ? WebOwnership.Owned : WebOwnership.Starting,
                    Port = port,
                    RequestId = state.requestId,
                    Detail = open ? "由 Launcher 管理" : "正在等待 Web 就绪",
                    CanStop = true,
                };
            }
            if (open)
            {
                return new WebStatusSnapshot
                {
                    Ownership = WebOwnership.External,
                    Port = port,
                    RequestId = null,
                    Detail = "检测到外部服务；Launcher 不会接管或终止它",
                    CanStop = false,
                };
            }
            return new WebStatusSnapshot
            {
                Ownership = WebOwnership.Stopped,
                Port = port,
                RequestId = null,
                Detail = "可以安全启动",
                CanStop = false,
            };
        }

        internal OperationResult StartWeb()
        {
            if (PluginManagementBusy()) return PluginManagementConflict();
            if (settings.Port < 1 || settings.Port > 65535) return OperationResult.Fail("端口必须在 1 到 65535 之间。");
            WebStatusSnapshot current = Snapshot();
            if (current.Ownership == WebOwnership.Owned || current.Ownership == WebOwnership.Starting)
            {
                return OperationResult.Ok("Web 已由 Launcher 管理。");
            }
            if (current.Ownership == WebOwnership.External)
            {
                return OperationResult.Fail("该端口上已有外部服务；为避免误操作，Launcher 不会接管它。");
            }
            string dsh = ResolveDsh();
            if (dsh == null) return OperationResult.Fail("未找到 dsh。请先安装 DSH，或在设置文件中指定 DshCommand。");
            if (!Directory.Exists(settings.WorkingDirectory)) return OperationResult.Fail("工作目录不存在。");

            string requestId = Guid.NewGuid().ToString("D");
            string requestPath = Path.Combine(LauncherPaths.Requests, "web-" + requestId + ".json");
            LauncherRequest request = BaseRequest("web", dsh);
            request.requestId = requestId;
            request.port = settings.Port;
            request.noOpen = settings.NoOpen;
            request.logPath = LauncherPaths.ServerLog;
            request.statePath = LauncherPaths.State;
            request.stopPath = LauncherPaths.Stop;
            JsonFile.Write(requestPath, request);
            TryDelete(LauncherPaths.Stop);

            LauncherState pending = new LauncherState
            {
                requestId = requestId,
                status = "starting",
                supervisorPid = 0,
                runnerPid = 0,
                startedAtUtc = DateTime.UtcNow.ToString("o"),
                port = settings.Port,
                logPath = LauncherPaths.ServerLog,
            };
            JsonFile.Write(LauncherPaths.State, pending);

            string supervisor = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "DSH-Launcher.Supervisor.ps1");
            if (!File.Exists(supervisor)) return OperationResult.Fail("Launcher supervisor 组件缺失。");
            ProcessStartInfo startInfo = PowerShellStartInfo(supervisor, requestPath, true, false);
            // A long-lived supervisor must not inherit a caller's redirected
            // stdout/stderr handles (for example the install verifier's pipes).
            startInfo.UseShellExecute = true;
            startInfo.CreateNoWindow = false;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            Process process = Process.Start(startInfo);
            if (process == null) return OperationResult.Fail("无法启动 Launcher supervisor。");
            LauncherState observed = JsonFile.Read<LauncherState>(LauncherPaths.State);
            if (observed == null || !String.Equals(observed.requestId, requestId, StringComparison.Ordinal)
                || observed.supervisorPid <= 0)
            {
                pending.supervisorPid = process.Id;
                JsonFile.Write(LauncherPaths.State, pending);
            }
            LauncherLog.Write("start web request=" + requestId + " port=" + settings.Port.ToString());
            process.Dispose();
            return OperationResult.Ok("Web 启动请求已提交。");
        }

        internal OperationResult StopWeb()
        {
            return RequestWebStop(Snapshot());
        }

        private OperationResult RequestWebStop(WebStatusSnapshot status)
        {
            if (!status.CanStop || String.IsNullOrEmpty(status.RequestId))
            {
                if (status.Ownership == WebOwnership.External)
                    return OperationResult.Fail("这是外部启动的服务，Launcher 不会终止它。");
                return OperationResult.Ok("Web 当前未由 Launcher 运行。");
            }
            File.WriteAllText(LauncherPaths.Stop, status.RequestId, new UTF8Encoding(false));
            LauncherLog.Write("stop web request=" + status.RequestId);
            return OperationResult.Ok("正在安全停止 Web。");
        }

        internal OperationResult StopWebAndWait()
        {
            WebStatusSnapshot status = Snapshot();
            OperationResult stop = RequestWebStop(status);
            if (!stop.Success) return stop;
            if (!status.CanStop)
                return OperationResult.Ok("DSH 当前未运行，正在退出 Launcher。");

            OperationResult wait = WaitForWebStop();
            if (!wait.Success) return wait;
            return OperationResult.Ok("DSH 已停止，正在退出 Launcher。");
        }

        internal OperationResult RestartWeb()
        {
            WebStatusSnapshot status = Snapshot();
            if (status.Ownership == WebOwnership.External)
                return OperationResult.Fail("端口由外部服务占用，无法重启。");
            if (status.CanStop)
            {
                OperationResult stop = StopWeb();
                if (!stop.Success) return stop;
                OperationResult wait = WaitForWebStop();
                if (!wait.Success)
                    return OperationResult.Fail("等待 Web 停止超时；没有启动第二个实例。");
            }
            return StartWeb();
        }

        private OperationResult WaitForWebStop()
        {
            DateTime deadline = DateTime.UtcNow.AddSeconds(15);
            while (DateTime.UtcNow < deadline)
            {
                Thread.Sleep(250);
                if (Snapshot().Ownership == WebOwnership.Stopped)
                    return OperationResult.Ok("Web 已停止。");
            }
            return OperationResult.Fail("等待 DSH 停止超时；Launcher 保持运行。");
        }

        internal OperationResult OpenWeb()
        {
            WebStatusSnapshot status = Snapshot();
            if (status.Ownership == WebOwnership.Stopped || status.Ownership == WebOwnership.Starting)
                return OperationResult.Fail("Web 尚未就绪。");
            string url = "http://127.0.0.1:" + settings.Port.ToString();
            try
            {
                Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
                return OperationResult.Ok("已打开 " + url);
            }
            catch (Exception error)
            {
                return OperationResult.Fail("无法打开浏览器：" + error.Message);
            }
        }

        internal OperationResult RunHeadless(string task, out string output)
        {
            output = String.Empty;
            if (PluginManagementBusy()) return PluginManagementConflict();
            if (String.IsNullOrWhiteSpace(task)) return OperationResult.Fail("请输入任务描述。");
            string dsh = ResolveDsh();
            if (dsh == null) return OperationResult.Fail("未找到 dsh。");
            LauncherRequest request = BaseRequest("headless", dsh);
            request.task = task.Trim();
            return RunCapturedRequest(request, out output);
        }

        internal OperationResult RunDoctor(out string output)
        {
            StringBuilder report = new StringBuilder();
            report.AppendLine("DeepSeek Harness Launcher 诊断");
            report.AppendLine("时间: " + DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss"));
            report.AppendLine("数据目录: " + LauncherPaths.DataRoot);
            report.AppendLine("工作目录: " + settings.WorkingDirectory);
            report.AppendLine("端口: " + settings.Port.ToString());
            string dsh = ResolveDsh();
            report.AppendLine("dsh: " + (dsh ?? "未找到"));
            string source = ResolveDshSource();
            report.AppendLine("DSH 源码: " + (source ?? (String.IsNullOrWhiteSpace(settings.DshSourceDirectory)
                ? "未配置（当前安装可能使用全局 dsh）"
                : "配置的目录无效")));
            WebStatusSnapshot status = Snapshot();
            report.AppendLine("Web: " + status.Ownership.ToString() + " — " + status.Detail);
            if (dsh == null)
            {
                output = report.ToString();
                return OperationResult.Fail("诊断完成，但未找到 dsh。");
            }
            LauncherRequest request = BaseRequest("doctor", dsh);
            string version;
            OperationResult result = RunCapturedRequest(request, out version);
            report.AppendLine("版本: " + version.Trim());
            output = report.ToString();
            return result.Success ? OperationResult.Ok("诊断完成。") : result;
        }

        internal bool IsGitAvailable()
        {
            string path = Environment.GetEnvironmentVariable("PATH");
            if (String.IsNullOrWhiteSpace(path)) return false;
            string[] extensions = { ".exe", ".cmd", ".bat", ".com" };
            foreach (string rawDirectory in path.Split(Path.PathSeparator))
            {
                string directory = rawDirectory.Trim().Trim('"');
                if (String.IsNullOrWhiteSpace(directory)) continue;
                foreach (string extension in extensions)
                {
                    try
                    {
                        if (File.Exists(Path.Combine(directory, "git" + extension))) return true;
                    }
                    catch
                    {
                        // Ignore malformed or inaccessible PATH entries and keep searching.
                    }
                }
            }
            return false;
        }

        internal string DshSourceBuildLog()
        {
            return ReadTail(LauncherPaths.BuildLog, 320);
        }

        internal OperationResult BuildDshSource(out string output)
        {
            return BuildDshSource(IsGitAvailable(), out output);
        }

        internal OperationResult BuildDshSource(bool updateSource, out string output)
        {
            output = String.Empty;
            if (PluginManagementBusy()) return PluginManagementConflict();
            string source = ResolveDshSource();
            if (source == null)
            {
                if (String.IsNullOrWhiteSpace(settings.DshSourceDirectory))
                    return OperationResult.Fail("当前安装未记录 DSH 源码路径；请通过本地 DSH checkout 重新运行安装脚本。");
                return OperationResult.Fail("记录的 DSH 源码目录无效，或不是受支持的 DSH checkout。");
            }

            LauncherRequest request = BaseRequest("build", String.Empty);
            request.sourceDirectory = source;
            request.workingDirectory = source;
            request.logPath = LauncherPaths.BuildLog;
            request.updateSource = updateSource;
            string commandOutput;
            LauncherLog.Write((updateSource ? "update and build" : "build") + " DSH source=" + source);
            OperationResult result = RunCapturedRequest(request, out commandOutput);
            string logTail = ReadTail(LauncherPaths.BuildLog, 240);
            output = String.IsNullOrWhiteSpace(commandOutput)
                ? logTail
                : logTail + Environment.NewLine + Environment.NewLine + "命令引擎输出" + Environment.NewLine
                    + "────────────────────────────────────────" + Environment.NewLine + commandOutput.Trim();
            if (!result.Success)
            {
                LauncherLog.Write("update/build DSH failed: " + result.Message);
                return result;
            }
            LauncherLog.Write("update/build DSH completed source=" + source);
            return OperationResult.Ok(updateSource ? "DSH 源码已更新并构建完成。" : "DSH 源码构建完成（未执行 Git 更新）。");
        }

        internal OperationResult RunProfile(string profile)
        {
            if (PluginManagementBusy()) return PluginManagementConflict();
            if (String.IsNullOrWhiteSpace(profile) || !System.Text.RegularExpressions.Regex.IsMatch(profile, "^[A-Za-z0-9][A-Za-z0-9._-]*$"))
                return OperationResult.Fail("Profile 名称无效。");
            string dsh = ResolveDsh();
            if (dsh == null) return OperationResult.Fail("未找到 dsh。");
            LauncherRequest request = BaseRequest("profile", dsh);
            request.profile = profile.Trim();
            request.logPath = LauncherPaths.ProfileLog(request.profile);
            string requestPath = WriteRequest(request);
            string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "DSH-Launcher.Command.ps1");
            ProcessStartInfo startInfo = PowerShellStartInfo(script, requestPath, true, false);
            Process process = Process.Start(startInfo);
            if (process == null) return OperationResult.Fail("无法启动 Profile。");
            process.Dispose();
            LauncherLog.Write("run profile=" + profile.Trim());
            return OperationResult.Ok("已在后台启动 Profile '" + profile.Trim() + "'；输出已写入日志。");
        }

        internal string[] Profiles()
        {
            string home = Environment.GetEnvironmentVariable("DSH_HOME");
            if (String.IsNullOrWhiteSpace(home))
                home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".dsh");
            string profiles = Path.Combine(home, "profiles");
            if (!Directory.Exists(profiles)) return new[] { "web", "headless" };
            List<string> names = new List<string>();
            foreach (string directory in Directory.GetDirectories(profiles))
            {
                string name = Path.GetFileName(directory);
                if (!String.Equals(name, "node_modules", StringComparison.OrdinalIgnoreCase)) names.Add(name);
            }
            if (!names.Contains("web")) names.Add("web");
            names.Sort(StringComparer.OrdinalIgnoreCase);
            return names.ToArray();
        }

        internal LoginStartupMode GetAutostartMode()
        {
            using (RegistryKey key = Registry.CurrentUser.OpenSubKey(RunKey))
            {
                return StartupRegistration.ParseMode(key == null ? null : key.GetValue(RunName) as string);
            }
        }

        internal OperationResult SetAutostartMode(LoginStartupMode mode)
        {
            try
            {
                using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RunKey))
                {
                    if (mode == LoginStartupMode.Disabled)
                    {
                        key.DeleteValue(RunName, false);
                    }
                    else
                    {
                        if (mode != LoginStartupMode.LauncherOnly && mode != LoginStartupMode.LauncherAndDsh)
                            return OperationResult.Fail("未知的登录启动模式。");
                        string executable = Process.GetCurrentProcess().MainModule.FileName;
                        key.SetValue(RunName, StartupRegistration.BuildCommand(executable, mode), RegistryValueKind.String);
                    }
                }
                LauncherLog.Write("autostartMode=" + mode.ToString());
                if (mode == LoginStartupMode.LauncherOnly)
                    return OperationResult.Ok("登录后将仅启动 Launcher。");
                if (mode == LoginStartupMode.LauncherAndDsh)
                    return OperationResult.Ok("登录后 Launcher 将在 30 秒后自动启动 DSH Web。");
                return OperationResult.Ok("已关闭登录启动。");
            }
            catch (Exception error)
            {
                return OperationResult.Fail("无法更新开机启动：" + error.Message);
            }
        }

        internal string RecentLogs()
        {
            StringBuilder output = new StringBuilder();
            output.AppendLine("Launcher 日志");
            output.AppendLine("────────────────────────────────────────");
            output.AppendLine(ReadTail(LauncherPaths.LauncherLog, 80));
            output.AppendLine();
            output.AppendLine("DSH Web 日志");
            output.AppendLine("────────────────────────────────────────");
            output.AppendLine(ReadTail(LauncherPaths.ServerLog, 160));
            return output.ToString();
        }

        internal void OpenLogFolder()
        {
            LauncherPaths.Ensure();
            Process.Start(new ProcessStartInfo("explorer.exe", NativeArguments.Quote(LauncherPaths.Logs)) { UseShellExecute = true });
        }

        private LauncherRequest BaseRequest(string mode, string dsh)
        {
            return new LauncherRequest
            {
                requestId = Guid.NewGuid().ToString("D"),
                mode = mode,
                dshCommand = dsh,
                workingDirectory = settings.WorkingDirectory,
                port = settings.Port,
                noOpen = settings.NoOpen,
                logPath = LauncherPaths.ServerLog,
                statePath = LauncherPaths.State,
                stopPath = LauncherPaths.Stop,
                task = String.Empty,
                profile = String.Empty,
                sourceDirectory = String.Empty,
                updateSource = false,
            };
        }

        private OperationResult RunCapturedRequest(LauncherRequest request, out string output)
        {
            output = String.Empty;
            string requestPath = WriteRequest(request);
            string script = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "DSH-Launcher.Command.ps1");
            if (!File.Exists(script)) return OperationResult.Fail("Launcher command engine 组件缺失。");
            try
            {
                ProcessStartInfo startInfo = PowerShellStartInfo(script, requestPath, true, false);
                startInfo.RedirectStandardOutput = true;
                startInfo.RedirectStandardError = true;
                startInfo.StandardOutputEncoding = new UTF8Encoding(false);
                startInfo.StandardErrorEncoding = new UTF8Encoding(false);
                using (Process process = Process.Start(startInfo))
                {
                    if (process == null) return OperationResult.Fail("无法启动命令引擎。");
                    Task<string> stdoutRead = process.StandardOutput.ReadToEndAsync();
                    Task<string> stderrRead = process.StandardError.ReadToEndAsync();
                    process.WaitForExit();
                    Task.WaitAll(stdoutRead, stderrRead);
                    string stdout = stdoutRead.Result;
                    string stderr = stderrRead.Result;
                    output = stdout + (String.IsNullOrWhiteSpace(stderr) ? String.Empty : Environment.NewLine + stderr);
                    if (process.ExitCode != 0)
                        return OperationResult.Fail("命令执行失败，退出码 " + process.ExitCode.ToString() + "。");
                }
                return OperationResult.Ok("命令执行完成。");
            }
            catch (Exception error)
            {
                return OperationResult.Fail("命令执行失败：" + error.Message);
            }
            finally
            {
                TryDelete(requestPath);
            }
        }

        private static string WriteRequest(LauncherRequest request)
        {
            string path = Path.Combine(LauncherPaths.Requests, request.mode + "-" + request.requestId + ".json");
            JsonFile.Write(path, request);
            return path;
        }

        private static ProcessStartInfo PowerShellStartInfo(string script, string requestPath, bool hidden, bool interactive)
        {
            string arguments = "-NoLogo -NoProfile ";
            if (!interactive) arguments += "-NonInteractive ";
            arguments += "-ExecutionPolicy Bypass -File " + NativeArguments.Quote(script)
                + " -RequestPath " + NativeArguments.Quote(requestPath);
            return new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = arguments,
                UseShellExecute = false,
                CreateNoWindow = hidden,
                WindowStyle = hidden ? ProcessWindowStyle.Hidden : ProcessWindowStyle.Normal,
            };
        }

        private static bool ProcessMatches(LauncherState state)
        {
            int pid = state.supervisorPid;
            if (pid <= 0) return false;
            try
            {
                using (Process process = Process.GetProcessById(pid))
                {
                    if (process.HasExited || !String.Equals(process.ProcessName, "powershell", StringComparison.OrdinalIgnoreCase))
                        return false;
                    DateTime recorded;
                    if (!DateTime.TryParse(state.startedAtUtc, null,
                        System.Globalization.DateTimeStyles.RoundtripKind, out recorded)) return false;
                    return Math.Abs((process.StartTime.ToUniversalTime() - recorded.ToUniversalTime()).TotalSeconds) <= 15;
                }
            }
            catch
            {
                return false;
            }
        }

        private static bool IsPortOpen(int port, int timeoutMilliseconds)
        {
            if (port < 1 || port > 65535) return false;
            using (TcpClient client = new TcpClient())
            {
                try
                {
                    IAsyncResult result = client.BeginConnect("127.0.0.1", port, null, null);
                    if (!result.AsyncWaitHandle.WaitOne(timeoutMilliseconds)) return false;
                    client.EndConnect(result);
                    return true;
                }
                catch
                {
                    return false;
                }
            }
        }

        private static string ReadTail(string path, int lines)
        {
            if (!File.Exists(path)) return "（暂无日志）";
            try
            {
                string[] all = File.ReadAllLines(path, Encoding.UTF8);
                int start = Math.Max(0, all.Length - lines);
                return String.Join(Environment.NewLine, all, start, all.Length - start);
            }
            catch (Exception error)
            {
                return "（无法读取日志：" + error.Message + "）";
            }
        }

        private static void TryDelete(string path)
        {
            try { if (File.Exists(path)) File.Delete(path); }
            catch { }
        }
    }
}
