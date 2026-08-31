using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace DshEnhanced.WindowsLauncher
{
    internal sealed class PluginSourceSnapshot
    {
        public string path { get; set; }
        public string revision { get; set; }
        public string repository { get; set; }
        public string @ref { get; set; }
    }

    internal sealed class PluginFeatureSnapshot
    {
        public string id { get; set; }
        public string packageName { get; set; }
        public string kind { get; set; }
        public string scope { get; set; }
        public bool required { get; set; }
        public bool defaultSelected { get; set; }
        public int order { get; set; }
        public string category { get; set; }
        public string name { get; set; }
        public string description { get; set; }
        public bool installed { get; set; }
        public bool selected { get; set; }
        public bool isNew { get; set; }
    }

    internal sealed class PluginManagerSnapshot
    {
        public int protocolVersion { get; set; }
        public bool success { get; set; }
        public string message { get; set; }
        public string profile { get; set; }
        public string[] profiles { get; set; }
        public bool managed { get; set; }
        public string lastAppliedRevision { get; set; }
        public bool aggregateInstalled { get; set; }
        public bool externalChange { get; set; }
        public PluginSourceSnapshot source { get; set; }
        public PluginFeatureSnapshot[] features { get; set; }
    }

    internal sealed class PluginUpdateSourceInfo
    {
        public string mode { get; set; }
        public bool clean { get; set; }
        public string changes { get; set; }
        public string branch { get; set; }
        public string remote { get; set; }
        public string currentRevision { get; set; }
        public string latestRevision { get; set; }
        public string relation { get; set; }
        public bool updateAvailable { get; set; }
    }

    internal sealed class PluginUpdateCheck
    {
        public int protocolVersion { get; set; }
        public bool success { get; set; }
        public string message { get; set; }
        public PluginUpdateSourceInfo source { get; set; }
    }

    internal sealed class PluginApplyResult
    {
        public int protocolVersion { get; set; }
        public string requestId { get; set; }
        public bool success { get; set; }
        public string stage { get; set; }
        public string message { get; set; }
        public string detail { get; set; }
        public string sourceRevision { get; set; }
        public string sourceMode { get; set; }
        public bool dshRestored { get; set; }
        public string logPath { get; set; }
        public PluginManagerSnapshot snapshot { get; set; }
    }

    internal sealed class PluginApplyRequest
    {
        public string requestId { get; set; }
        public string profile { get; set; }
        public string[] desiredFeatures { get; set; }
        public bool updateSource { get; set; }
        public string expectedSourceRevision { get; set; }
        public string[] expectedActualFeatures { get; set; }
        public bool expectedAggregateInstalled { get; set; }
    }

    internal sealed class PluginLauncherPlan
    {
        public bool required { get; set; }
        public string action { get; set; }
        public string currentHash { get; set; }
        public string candidateHash { get; set; }
    }

    internal sealed class PluginProfilePlan
    {
        public string name { get; set; }
        public string[] actualFeatures { get; set; }
        public string[] desiredFeatures { get; set; }
        public string[] install { get; set; }
        public string[] update { get; set; }
        public string[] remove { get; set; }
        public bool migrateAggregate { get; set; }
    }

    internal sealed class PluginManagementPlan
    {
        public int protocolVersion { get; set; }
        public bool success { get; set; }
        public string message { get; set; }
        public string sourceRevision { get; set; }
        public bool updateSource { get; set; }
        public string[] additionalManagedProfiles { get; set; }
        public PluginLauncherPlan launcher { get; set; }
        public PluginProfilePlan profile { get; set; }
    }

    internal sealed class PendingPluginOperation
    {
        internal string RequestId { get; set; }
        internal string ResultPath { get; set; }
        internal string RequestDirectory { get; set; }
        internal DateTime StartedAtUtc { get; set; }
        internal int CoordinatorPid { get; set; }
        internal bool IsInterrupted { get; set; }
    }

    internal sealed class PendingPluginOperationRecord
    {
        public string requestId { get; set; }
        public int coordinatorPid { get; set; }
        public string startedAtUtc { get; set; }
    }

    internal sealed class PluginManagerRuntime
    {
        private string ScriptPath
        {
            get { return Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "DSH-Launcher.PluginManager.ps1"); }
        }

        internal OperationResult Snapshot(string repositoryRoot, string profile, out PluginManagerSnapshot snapshot)
        {
            return RunMachine("Snapshot", repositoryRoot, profile, null, out snapshot);
        }

        internal OperationResult Bind(string repositoryRoot, string profile, out PluginManagerSnapshot snapshot)
        {
            return RunMachine("Bind", repositoryRoot, profile, null, out snapshot);
        }

        internal OperationResult ImportZip(string zipPath, string profile, out PluginManagerSnapshot snapshot)
        {
            return RunMachine("ImportZip", zipPath, profile, null, out snapshot);
        }

        internal OperationResult CheckUpdate(string repositoryRoot, string profile, out PluginUpdateCheck result)
        {
            return RunMachine("CheckUpdate", repositoryRoot, profile, null, out result);
        }

        internal OperationResult Plan(string repositoryRoot, string profile, IEnumerable<string> desired,
            bool updateSource, out PluginManagementPlan plan)
        {
            return RunMachine("Plan", repositoryRoot, profile, new PluginApplyRequest
            {
                requestId = Guid.NewGuid().ToString("D"),
                profile = profile,
                desiredFeatures = desired.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray(),
                updateSource = updateSource,
            }, out plan);
        }

        internal OperationResult StartApply(string repositoryRoot, string profile, IEnumerable<string> desired,
            bool updateSource, PluginManagementPlan plan, out PendingPluginOperation pending)
        {
            pending = null;
            if (!File.Exists(ScriptPath)) return OperationResult.Fail("插件管理组件缺失，请从项目源码重新安装 Launcher。");
            string requestId = Guid.NewGuid().ToString("D");
            string requestDirectory = Path.Combine(LauncherPaths.Updates, requestId);
            Directory.CreateDirectory(requestDirectory);
            string requestPath = Path.Combine(requestDirectory, "request.json");
            string resultPath = Path.Combine(requestDirectory, "result.json");
            string coordinatorPath = Path.Combine(requestDirectory, "coordinator.ps1");
            File.Copy(ScriptPath, coordinatorPath, true);
            JsonFile.Write(requestPath, new PluginApplyRequest
            {
                requestId = requestId,
                profile = profile,
                desiredFeatures = desired.Distinct(StringComparer.Ordinal).OrderBy(value => value, StringComparer.Ordinal).ToArray(),
                updateSource = updateSource,
                expectedSourceRevision = plan == null ? String.Empty : plan.sourceRevision,
                expectedActualFeatures = plan == null || plan.profile == null ? new string[0] : plan.profile.actualFeatures,
                expectedAggregateInstalled = plan != null && plan.profile != null && plan.profile.migrateAggregate,
            });
            JsonFile.Write(Path.Combine(requestDirectory, "plan.json"), plan);
            ProcessStartInfo startInfo = PowerShellStartInfo(coordinatorPath, "Apply", repositoryRoot, profile, requestPath, resultPath);
            // The coordinator must outlive this Launcher when its executable is updated.
            startInfo.UseShellExecute = true;
            startInfo.CreateNoWindow = false;
            startInfo.WindowStyle = ProcessWindowStyle.Hidden;
            Process process = Process.Start(startInfo);
            if (process == null) return OperationResult.Fail("无法启动外部插件更新协调器。");
            int coordinatorPid = process.Id;
            DateTime startedAtUtc = DateTime.UtcNow;
            JsonFile.Write(Path.Combine(requestDirectory, "pending.json"), new PendingPluginOperationRecord
            {
                requestId = requestId,
                coordinatorPid = coordinatorPid,
                startedAtUtc = startedAtUtc.ToString("o"),
            });
            process.Dispose();
            pending = new PendingPluginOperation
            {
                RequestId = requestId,
                ResultPath = resultPath,
                RequestDirectory = requestDirectory,
                StartedAtUtc = startedAtUtc,
                CoordinatorPid = coordinatorPid,
                IsInterrupted = false,
            };
            LauncherLog.Write("plugin apply started request=" + requestId + " profile=" + profile
                + " updateSource=" + updateSource.ToString());
            return OperationResult.Ok(updateSource
                ? "源码更新、构建与插件调和已交给外部协调器。"
                : "插件构建与目标状态调和已交给外部协调器。");
        }

        internal bool TryReadResult(PendingPluginOperation pending, out PluginApplyResult result)
        {
            result = null;
            if (pending == null) return false;
            if (!File.Exists(pending.ResultPath))
            {
                if (!pending.IsInterrupted) return false;
                result = new PluginApplyResult
                {
                    protocolVersion = 1,
                    requestId = pending.RequestId,
                    success = false,
                    stage = "interrupted",
                    message = "外部更新协调器已异常结束。Launcher 已重新读取实际状态；请查看日志并重新生成计划。",
                    logPath = Path.Combine(pending.RequestDirectory, "logs", "update.log"),
                };
                try { JsonFile.Write(pending.ResultPath, result); } catch { }
                return true;
            }
            result = JsonFile.Read<PluginApplyResult>(pending.ResultPath);
            return result != null;
        }

        internal PendingPluginOperation LatestPendingOperation()
        {
            if (!Directory.Exists(LauncherPaths.Updates)) return null;
            foreach (DirectoryInfo directory in new DirectoryInfo(LauncherPaths.Updates).GetDirectories()
                .OrderByDescending(value => value.LastWriteTimeUtc))
            {
                string resultPath = Path.Combine(directory.FullName, "result.json");
                string requestPath = Path.Combine(directory.FullName, "request.json");
                string pendingPath = Path.Combine(directory.FullName, "pending.json");
                if (File.Exists(resultPath) || !File.Exists(requestPath) || !File.Exists(pendingPath)) continue;
                PendingPluginOperationRecord record = JsonFile.Read<PendingPluginOperationRecord>(pendingPath);
                if (record == null || record.coordinatorPid <= 0) continue;
                DateTime startedAtUtc;
                if (!DateTime.TryParse(record.startedAtUtc, null,
                    System.Globalization.DateTimeStyles.RoundtripKind, out startedAtUtc))
                    startedAtUtc = directory.CreationTimeUtc;
                bool active = false;
                try
                {
                    using (Process process = Process.GetProcessById(record.coordinatorPid))
                    {
                        active = !process.HasExited
                            && Math.Abs((process.StartTime.ToUniversalTime() - startedAtUtc.ToUniversalTime()).TotalMinutes) < 2;
                    }
                }
                catch { active = false; }
                return new PendingPluginOperation
                {
                    RequestId = record.requestId,
                    ResultPath = resultPath,
                    RequestDirectory = directory.FullName,
                    StartedAtUtc = startedAtUtc,
                    CoordinatorPid = record.coordinatorPid,
                    IsInterrupted = !active,
                };
            }
            return null;
        }

        internal PluginApplyResult LatestCompletedResult()
        {
            if (!Directory.Exists(LauncherPaths.Updates)) return null;
            FileInfo latest = new DirectoryInfo(LauncherPaths.Updates).GetDirectories()
                .Select(directory => new FileInfo(Path.Combine(directory.FullName, "result.json")))
                .Where(file => file.Exists)
                .OrderByDescending(file => file.LastWriteTimeUtc)
                .FirstOrDefault();
            return latest == null ? null : JsonFile.Read<PluginApplyResult>(latest.FullName);
        }

        internal string ReadOperationLog(PendingPluginOperation pending, string completedLogPath)
        {
            string path = completedLogPath;
            if (String.IsNullOrWhiteSpace(path) && pending != null)
                path = Path.Combine(pending.RequestDirectory, "logs", "update.log");
            if (String.IsNullOrWhiteSpace(path) || !File.Exists(path)) return String.Empty;
            try
            {
                const int maximumBytes = 256 * 1024;
                string text;
                bool truncated;
                using (FileStream stream = new FileStream(path, FileMode.Open, FileAccess.Read,
                    FileShare.ReadWrite | FileShare.Delete))
                {
                    long start = Math.Max(0, stream.Length - maximumBytes);
                    truncated = start > 0;
                    stream.Position = start;
                    byte[] buffer = new byte[(int)(stream.Length - start)];
                    int offset = 0;
                    while (offset < buffer.Length)
                    {
                        int read = stream.Read(buffer, offset, buffer.Length - offset);
                        if (read <= 0) break;
                        offset += read;
                    }
                    text = Encoding.UTF8.GetString(buffer, 0, offset);
                }
                if (truncated)
                {
                    int firstLine = text.IndexOf('\n');
                    if (firstLine >= 0) text = text.Substring(firstLine + 1);
                }
                string[] lines = text.Replace("\r\n", "\n").Replace('\r', '\n').Split('\n');
                int tailStart = Math.Max(0, lines.Length - 280);
                string tail = TerminalText.ForDisplay(
                    String.Join(Environment.NewLine, lines, tailStart, lines.Length - tailStart));
                return truncated ? "…较早日志已省略，完整日志请打开请求目录查看…" + Environment.NewLine + tail : tail;
            }
            catch (Exception error)
            {
                return "无法读取插件管理日志：" + error.Message;
            }
        }

        internal void OpenOperationDirectory(PendingPluginOperation pending, string completedLogPath)
        {
            string directory = pending == null ? null : pending.RequestDirectory;
            if (String.IsNullOrWhiteSpace(directory) && !String.IsNullOrWhiteSpace(completedLogPath))
                directory = Path.GetDirectoryName(Path.GetDirectoryName(completedLogPath));
            if (String.IsNullOrWhiteSpace(directory) || !Directory.Exists(directory)) directory = LauncherPaths.Updates;
            Directory.CreateDirectory(directory);
            Process.Start(new ProcessStartInfo("explorer.exe", NativeArguments.Quote(directory)) { UseShellExecute = true });
        }

        private OperationResult RunMachine<T>(string operation, string repositoryRoot, string profile,
            object request, out T value) where T : class
        {
            value = null;
            if (!File.Exists(ScriptPath)) return OperationResult.Fail("插件管理组件缺失，请从项目源码重新安装 Launcher。");
            string requestId = Guid.NewGuid().ToString("N");
            string resultPath = Path.Combine(LauncherPaths.Requests, "plugin-" + operation.ToLowerInvariant()
                + "-" + requestId + ".json");
            string requestPath = null;
            if (request != null)
            {
                requestPath = Path.Combine(LauncherPaths.Requests, "plugin-request-" + requestId + ".json");
                JsonFile.Write(requestPath, request);
            }
            try
            {
                ProcessStartInfo startInfo = PowerShellStartInfo(ScriptPath, operation, repositoryRoot, profile, requestPath, resultPath);
                startInfo.UseShellExecute = false;
                startInfo.CreateNoWindow = true;
                startInfo.WindowStyle = ProcessWindowStyle.Hidden;
                using (Process process = Process.Start(startInfo))
                {
                    if (process == null) return OperationResult.Fail("无法启动插件管理协议进程。");
                    if (!process.WaitForExit(60000))
                    {
                        try { process.Kill(); } catch { }
                        return OperationResult.Fail("插件管理协议读取超时。");
                    }
                }
                value = JsonFile.Read<T>(resultPath);
                if (value == null) return OperationResult.Fail("插件管理协议没有返回有效 JSON。");
                PluginManagerSnapshot snapshot = value as PluginManagerSnapshot;
                PluginUpdateCheck check = value as PluginUpdateCheck;
                PluginManagementPlan plan = value as PluginManagementPlan;
                bool success = snapshot != null ? snapshot.success
                    : check != null ? check.success
                    : plan == null || plan.success;
                string message = snapshot != null ? snapshot.message
                    : check != null ? check.message
                    : plan == null ? null : plan.message;
                if (!success) return OperationResult.Fail(String.IsNullOrWhiteSpace(message) ? "插件管理操作失败。" : message);
                return OperationResult.Ok("插件管理状态已刷新。");
            }
            catch (Exception error)
            {
                return OperationResult.Fail("插件管理操作失败：" + error.Message);
            }
            finally
            {
                TryDelete(requestPath);
                TryDelete(resultPath);
            }
        }

        private ProcessStartInfo PowerShellStartInfo(string scriptPath, string operation, string repositoryRoot, string profile,
            string requestPath, string outputPath)
        {
            StringBuilder arguments = new StringBuilder();
            arguments.Append("-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File ");
            arguments.Append(NativeArguments.Quote(scriptPath));
            arguments.Append(" -Operation ").Append(NativeArguments.Quote(operation));
            if (!String.IsNullOrWhiteSpace(repositoryRoot))
                arguments.Append(" -RepositoryRoot ").Append(NativeArguments.Quote(repositoryRoot));
            arguments.Append(" -Profile ").Append(NativeArguments.Quote(profile));
            if (!String.IsNullOrWhiteSpace(requestPath))
                arguments.Append(" -RequestPath ").Append(NativeArguments.Quote(requestPath));
            arguments.Append(" -OutputPath ").Append(NativeArguments.Quote(outputPath));
            return new ProcessStartInfo
            {
                FileName = "powershell.exe",
                Arguments = arguments.ToString(),
            };
        }

        private static void TryDelete(string path)
        {
            if (String.IsNullOrWhiteSpace(path)) return;
            try { if (File.Exists(path)) File.Delete(path); } catch { }
        }
    }

    internal sealed class PluginFeatureRow : RoundedPanel
    {
        private readonly ToggleSwitch toggle;
        private readonly Label nameLabel;
        private readonly Label descriptionLabel;
        private readonly Label identityLabel;
        private readonly Label statusLabel;
        private PluginFeatureSnapshot feature;
        private bool layingOut;
        private Color rowBackColor = UiTheme.Surface;
        private Color rowBorderColor = UiTheme.Border;

        internal event EventHandler SelectionChanged;

        internal PluginFeatureRow()
        {
            Height = 82;
            Radius = 13;
            BorderColor = UiTheme.Border;
            BackColor = UiTheme.Surface;
            toggle = new ToggleSwitch();
            toggle.CheckedChanged += delegate
            {
                if (SelectionChanged != null) SelectionChanged(this, EventArgs.Empty);
            };
            Controls.Add(toggle);
            nameLabel = NewRowLabel(10.2f, FontStyle.Bold, UiTheme.Text);
            descriptionLabel = NewRowLabel(8.4f, FontStyle.Regular, UiTheme.Muted);
            identityLabel = NewRowLabel(7.7f, FontStyle.Regular, UiTheme.Muted);
            statusLabel = NewRowLabel(8.2f, FontStyle.Bold, UiTheme.Primary);
            statusLabel.TextAlign = ContentAlignment.MiddleRight;
            Controls.Add(nameLabel);
            Controls.Add(descriptionLabel);
            Controls.Add(identityLabel);
            Controls.Add(statusLabel);
        }

        internal PluginFeatureSnapshot Feature
        {
            get { return feature; }
        }

        internal bool Selected
        {
            get { return toggle.Checked; }
            set { toggle.Checked = feature != null && feature.required || value; }
        }

        internal void Bind(PluginFeatureSnapshot value)
        {
            feature = value;
            nameLabel.Text = value.name;
            descriptionLabel.Text = value.description;
            identityLabel.Text = value.id + "  ·  " + value.packageName;
            toggle.Enabled = !value.required;
            toggle.Checked = value.required || value.selected;
            string state = value.required ? "必选"
                : value.isNew ? "新增"
                : value.installed ? "已安装"
                : "未安装";
            statusLabel.Text = state;
            statusLabel.ForeColor = value.isNew ? UiTheme.Success
                : value.installed || value.required ? UiTheme.Primary : UiTheme.Muted;
            rowBackColor = value.required ? UiTheme.PrimarySoft : UiTheme.Surface;
            rowBorderColor = value.required ? UiTheme.BorderStrong : UiTheme.Border;
            BackColor = rowBackColor;
            nameLabel.BackColor = rowBackColor;
            descriptionLabel.BackColor = rowBackColor;
            identityLabel.BackColor = rowBackColor;
            statusLabel.BackColor = rowBackColor;
            Invalidate();
            PerformLayout();
        }

        protected override void OnLayout(LayoutEventArgs levent)
        {
            base.OnLayout(levent);
            if (toggle == null || nameLabel == null || descriptionLabel == null
                || identityLabel == null || statusLabel == null) return;
            if (layingOut) return;
            layingOut = true;
            try
            {
            int scale = Math.Max(1, DeviceDpi);
            Func<int, int> dip = value => Math.Max(1, (int)Math.Round(value * scale / 96f));
            int inset = dip(18);
            int toggleWidth = dip(48);
            toggle.SetBounds(inset, dip(24), toggleWidth, dip(28));
            int textLeft = inset + toggleWidth + dip(14);
            int statusWidth = Math.Min(dip(82), Math.Max(dip(58), Width / 6));
            int textWidth = Math.Max(dip(100), Width - textLeft - statusWidth - inset - dip(10));
            nameLabel.SetBounds(textLeft, dip(12), textWidth, dip(23));
            descriptionLabel.SetBounds(textLeft, dip(36), textWidth, dip(20));
            identityLabel.SetBounds(textLeft, dip(58), textWidth, dip(17));
            statusLabel.SetBounds(Width - statusWidth - inset, dip(25), statusWidth, dip(28));
            }
            finally { layingOut = false; }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            Control backgroundOwner = Parent;
            while (backgroundOwner != null && backgroundOwner.BackColor == Color.Transparent)
                backgroundOwner = backgroundOwner.Parent;
            e.Graphics.Clear(backgroundOwner == null ? UiTheme.Surface : backgroundOwner.BackColor);
            int edge = UiTheme.Dip(this, 1);
            using (System.Drawing.Drawing2D.GraphicsPath path = UiTheme.RoundedRectangle(
                new Rectangle(0, 0, Math.Max(1, Width - edge), Math.Max(1, Height - edge)), UiTheme.Dip(this, 13)))
            using (SolidBrush brush = new SolidBrush(rowBackColor)) e.Graphics.FillPath(brush, path);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
            int inset = UiTheme.Dip(this, 1);
            int reduction = UiTheme.Dip(this, 3);
            using (System.Drawing.Drawing2D.GraphicsPath path = UiTheme.RoundedRectangle(
                new Rectangle(inset, inset, Math.Max(1, Width - reduction), Math.Max(1, Height - reduction)),
                UiTheme.Dip(this, 12)))
            using (Pen pen = new Pen(rowBorderColor, UiTheme.Dip(this, 1f))) e.Graphics.DrawPath(pen, path);
        }

        private static Label NewRowLabel(float size, FontStyle style, Color color)
        {
            return new Label
            {
                AutoSize = false,
                AutoEllipsis = true,
                BackColor = UiTheme.Surface,
                Font = UiTheme.Font(size, style),
                ForeColor = color,
            };
        }
    }

    internal sealed partial class MainForm
    {
        private readonly PluginManagerRuntime pluginRuntime;
        private readonly ModernScrollPage pluginPage;
        private NavButton pluginNav;
        private RoundedPanel pluginSourceCard;
        private RoundedPanel pluginFeaturesCard;
        private RoundedPanel pluginLogCard;
        private Label pluginSourcePath;
        private Label pluginSourceRevision;
        private Label pluginSourceStatus;
        private StatusIndicator pluginSourceStatusDot;
        private ModernButton pluginChooseSourceButton;
        private ModernButton pluginCheckButton;
        private ModernButton pluginUpdateButton;
        private Label pluginProfileCaption;
        private ModernComboBox pluginProfileInput;
        private Label pluginSearchCaption;
        private RoundedPanel pluginSearchShell;
        private TextBox pluginSearchInput;
        private ModernButton pluginSelectAllButton;
        private ModernButton pluginClearButton;
        private FlowLayoutPanel pluginFeatureRows;
        private RoundedPanel pluginPlanShell;
        private Label pluginPlanHeading;
        private Label pluginPlanText;
        private ModernButton pluginApplyButton;
        private ModernRichTextBox pluginLogOutput;
        private ModernButton pluginOpenRequestButton;
        private ContextMenuStrip pluginSourceMenu;
        private PluginManagerSnapshot pluginSnapshot;
        private readonly Dictionary<string, bool> pluginSelections = new Dictionary<string, bool>(StringComparer.Ordinal);
        private readonly Dictionary<string, PluginFeatureRow> pluginRows = new Dictionary<string, PluginFeatureRow>(StringComparer.Ordinal);
        private PendingPluginOperation pendingPluginOperation;
        private string completedPluginLogPath;
        private int pluginRefreshInProgress;
        private bool pluginControlsLoading;
        private bool pluginOperationHistoryLoaded;
        private DateTime pluginSnapshotLoadedAtUtc = DateTime.MinValue;

        private void BuildPluginManagerPage()
        {
            pluginSourceCard = new RoundedPanel();
            pluginFeaturesCard = new RoundedPanel();
            pluginLogCard = new RoundedPanel();
            pluginPage.Content.Controls.Add(pluginSourceCard);
            pluginPage.Content.Controls.Add(pluginFeaturesCard);
            pluginPage.Content.Controls.Add(pluginLogCard);

            AddCardTitle(pluginSourceCard, "项目源码", "绑定、检查并安全更新 dsh-enhanced-plugins 源码");
            pluginSourcePath = NewLabel("尚未读取源码绑定", 8.6f, FontStyle.Regular, UiTheme.Muted);
            pluginSourcePath.AutoSize = false;
            pluginSourcePath.AutoEllipsis = true;
            pluginSourceRevision = NewLabel(String.Empty, 8.2f, FontStyle.Regular, UiTheme.Muted);
            pluginSourceRevision.AutoSize = false;
            pluginSourceRevision.AutoEllipsis = true;
            pluginSourceStatus = NewLabel("等待读取", 8.2f, FontStyle.Bold, UiTheme.Primary);
            pluginSourceStatus.AutoSize = false;
            pluginSourceStatus.TextAlign = ContentAlignment.MiddleLeft;
            pluginSourceStatusDot = new StatusIndicator();
            pluginChooseSourceButton = NewButton("选择源码", ModernButtonKind.Secondary, 108);
            pluginCheckButton = NewButton("检查更新", ModernButtonKind.Secondary, 108);
            pluginUpdateButton = NewButton("更新源码并应用", ModernButtonKind.Primary, 156);
            pluginSourceCard.Controls.Add(pluginSourcePath);
            pluginSourceCard.Controls.Add(pluginSourceRevision);
            pluginSourceCard.Controls.Add(pluginSourceStatusDot);
            pluginSourceCard.Controls.Add(pluginSourceStatus);
            pluginSourceCard.Controls.Add(pluginChooseSourceButton);
            pluginSourceCard.Controls.Add(pluginCheckButton);
            pluginSourceCard.Controls.Add(pluginUpdateButton);

            AddCardTitle(pluginFeaturesCard, "Profile 功能", "选择此 Profile 的目标功能；Windows Launcher 会作为必选项一并维护");
            pluginProfileCaption = NewLabel("目标 Profile", 8.1f, FontStyle.Bold, UiTheme.Muted);
            pluginProfileInput = new ModernComboBox();
            pluginSearchCaption = NewLabel("筛选功能", 8.1f, FontStyle.Bold, UiTheme.Muted);
            pluginSearchShell = NewEditorShell();
            pluginSearchInput = new TextBox();
            pluginSearchInput.BorderStyle = BorderStyle.None;
            pluginSearchInput.BackColor = UiTheme.SurfaceSoft;
            pluginSearchInput.ForeColor = UiTheme.Text;
            pluginSearchInput.Font = UiTheme.Font(9.2f, FontStyle.Regular);
            pluginSearchShell.Controls.Add(pluginSearchInput);
            pluginSelectAllButton = NewButton("全选", ModernButtonKind.Secondary, 82);
            pluginClearButton = NewButton("清空", ModernButtonKind.Secondary, 82);
            pluginFeatureRows = NewPluginRowsPanel();
            pluginFeaturesCard.Controls.Add(pluginProfileCaption);
            pluginFeaturesCard.Controls.Add(pluginProfileInput);
            pluginFeaturesCard.Controls.Add(pluginSearchCaption);
            pluginFeaturesCard.Controls.Add(pluginSearchShell);
            pluginFeaturesCard.Controls.Add(pluginSelectAllButton);
            pluginFeaturesCard.Controls.Add(pluginClearButton);
            pluginFeaturesCard.Controls.Add(pluginFeatureRows);

            pluginPlanShell = new RoundedPanel
            {
                Radius = 14,
                BackColor = UiTheme.SurfaceSoft,
                BorderColor = UiTheme.Border,
            };
            pluginPlanHeading = NewLabel("待确认更改", 9.2f, FontStyle.Bold, UiTheme.Text);
            pluginPlanText = NewLabel("正在读取安装状态…", 8.7f, FontStyle.Regular, UiTheme.Text);
            pluginPlanText.AutoSize = false;
            pluginApplyButton = NewButton("确认并应用", ModernButtonKind.Primary, 148);
            pluginPlanShell.Controls.Add(pluginPlanHeading);
            pluginPlanShell.Controls.Add(pluginPlanText);
            pluginPlanShell.Controls.Add(pluginApplyButton);
            pluginFeaturesCard.Controls.Add(pluginPlanShell);

            AddCardTitle(pluginLogCard, "运行日志", "完整 UTF-8 日志保存在独立请求目录");
            RoundedPanel logShell = NewEditorShell();
            logShell.Tag = "plugin-log-shell";
            pluginLogOutput = new ModernRichTextBox();
            pluginLogOutput.ReadOnly = true;
            pluginLogOutput.BorderStyle = BorderStyle.None;
            pluginLogOutput.BackColor = UiTheme.SurfaceSoft;
            pluginLogOutput.ForeColor = UiTheme.Text;
            pluginLogOutput.Font = new Font("Consolas", 8.3f, FontStyle.Regular);
            pluginLogOutput.Dock = DockStyle.Fill;
            pluginLogOutput.Text = "插件管理操作将在这里显示。";
            logShell.Controls.Add(pluginLogOutput);
            ModernTextAreaScroll.Attach(logShell, pluginLogOutput);
            pluginOpenRequestButton = NewButton("打开请求目录", ModernButtonKind.Secondary, 132);
            pluginLogCard.Controls.Add(logShell);
            pluginLogCard.Controls.Add(pluginOpenRequestButton);

            pluginSourceMenu = new ContextMenuStrip();
            pluginSourceMenu.Items.Add("选择已解压的源码目录…", null, delegate { ChoosePluginSourceDirectory(); });
            pluginSourceMenu.Items.Add("导入源码 ZIP…", null, delegate { ImportPluginSourceZip(); });
            pluginChooseSourceButton.Click += delegate
            {
                pluginSourceMenu.Show(pluginChooseSourceButton, new Point(0, pluginChooseSourceButton.Height));
            };
            pluginCheckButton.Click += delegate { CheckPluginUpdate(); };
            pluginUpdateButton.Click += delegate { RunPluginApply(true); };
            pluginApplyButton.Click += delegate { RunPluginApply(false); };
            pluginSelectAllButton.Click += delegate { SetAllPluginRows(true); };
            pluginClearButton.Click += delegate { SetAllPluginRows(false); };
            pluginSearchInput.TextChanged += delegate { RenderPluginRows(); };
            pluginProfileInput.TextChanged += delegate
            {
                if (!pluginControlsLoading) RefreshPluginManager(true);
            };
            pluginOpenRequestButton.Click += delegate
            {
                pluginRuntime.OpenOperationDirectory(pendingPluginOperation, completedPluginLogPath);
            };
        }

        private static FlowLayoutPanel NewPluginRowsPanel()
        {
            return new FlowLayoutPanel
            {
                BackColor = Color.Transparent,
                FlowDirection = FlowDirection.TopDown,
                WrapContents = false,
                AutoScroll = false,
                Padding = Padding.Empty,
                Margin = Padding.Empty,
            };
        }

        private void RefreshPluginManager(bool force)
        {
            if (!force && activePage != pluginPage) return;
            if (!force && pluginSnapshot != null
                && DateTime.UtcNow - pluginSnapshotLoadedAtUtc < TimeSpan.FromSeconds(30))
            {
                LayoutPluginManager();
                return;
            }
            if (captureMode)
            {
                string captureProfile = String.IsNullOrWhiteSpace(pluginProfileInput.Text) ? "web" : pluginProfileInput.Text.Trim();
                string captureRepository = pluginSnapshot == null || pluginSnapshot.source == null
                    ? String.Empty : pluginSnapshot.source.path;
                PluginManagerSnapshot captureSnapshot;
                OperationResult captureResult = pluginRuntime.Snapshot(captureRepository, captureProfile, out captureSnapshot);
                if (captureResult.Success && captureSnapshot != null) ApplyPluginSnapshot(captureSnapshot);
                else pluginLogOutput.Text = captureResult.Message;
                return;
            }
            if (Interlocked.CompareExchange(ref pluginRefreshInProgress, 1, 0) != 0) return;
            string profile = String.IsNullOrWhiteSpace(pluginProfileInput.Text) ? "web" : pluginProfileInput.Text.Trim();
            string repository = pluginSnapshot == null || pluginSnapshot.source == null ? String.Empty : pluginSnapshot.source.path;
            SetPluginBusy(true, "正在读取动态目录与 Profile 实际状态…");
            ThreadPool.QueueUserWorkItem(delegate
            {
                PluginManagerSnapshot snapshot;
                OperationResult result = pluginRuntime.Snapshot(repository, profile, out snapshot);
                if (IsDisposed || !IsHandleCreated) return;
                try
                {
                    BeginInvoke(new Action(delegate
                    {
                        Interlocked.Exchange(ref pluginRefreshInProgress, 0);
                        if (result.Success && snapshot != null)
                        {
                            ApplyPluginSnapshot(snapshot);
                            SetPluginBusy(false, snapshot.externalChange
                                ? "检测到 Profile 外部变更"
                                : "源码目录与安装状态已刷新");
                        }
                        else
                        {
                            SetPluginBusy(false, "需要绑定项目源码");
                            pluginLogOutput.Text = result.Message;
                            if (activePage == pluginPage) ShowToast(result);
                        }
                    }));
                }
                catch (InvalidOperationException) { Interlocked.Exchange(ref pluginRefreshInProgress, 0); }
            });
        }

        private void ApplyPluginSnapshot(PluginManagerSnapshot snapshot)
        {
            pluginSnapshot = snapshot;
            pluginSnapshotLoadedAtUtc = DateTime.UtcNow;
            pluginControlsLoading = true;
            try
            {
                string selected = String.IsNullOrWhiteSpace(pluginProfileInput.Text) ? snapshot.profile : pluginProfileInput.Text.Trim();
                string[] profiles = snapshot.profiles ?? new[] { "web" };
                pluginProfileInput.SetItems(profiles);
                int selectedIndex = Array.FindIndex(profiles, value => String.Equals(value, selected, StringComparison.OrdinalIgnoreCase));
                if (selectedIndex < 0)
                    selectedIndex = Array.FindIndex(profiles, value => String.Equals(value, snapshot.profile ?? "web", StringComparison.OrdinalIgnoreCase));
                pluginProfileInput.SelectedIndex = selectedIndex < 0 && profiles.Length > 0 ? 0 : selectedIndex;
            }
            finally { pluginControlsLoading = false; }
            pluginSourcePath.Text = "路径：" + (snapshot.source == null ? "未绑定" : snapshot.source.path);
            string revision = snapshot.source == null ? String.Empty : snapshot.source.revision ?? String.Empty;
            pluginSourceRevision.Text = "当前：" + ShortRevision(revision)
                + (snapshot.source == null || String.IsNullOrWhiteSpace(snapshot.source.@ref) ? String.Empty : "  ·  " + snapshot.source.@ref);
            pluginSourceStatus.Text = snapshot.aggregateInstalled ? "待迁移聚合包"
                : snapshot.externalChange ? "外部变更" : "已绑定";
            pluginSourceStatus.ForeColor = snapshot.externalChange || snapshot.aggregateInstalled ? UiTheme.Warning : UiTheme.Success;
            pluginSourceStatusDot.IndicatorColor = pluginSourceStatus.ForeColor;
            pluginSelections.Clear();
            if (snapshot.features != null)
                foreach (PluginFeatureSnapshot feature in snapshot.features.Where(value => value.scope == "profile"))
                    pluginSelections[feature.id] = feature.selected;
            RenderPluginRows();
            UpdatePluginPlan();
            if (!pluginOperationHistoryLoaded)
            {
                pluginOperationHistoryLoaded = true;
                PluginApplyResult latest = pluginRuntime.LatestCompletedResult();
                if (latest != null && pendingPluginOperation == null)
                {
                    completedPluginLogPath = latest.logPath;
                    string log = pluginRuntime.ReadOperationLog(null, latest.logPath);
                    if (!String.IsNullOrWhiteSpace(log)) pluginLogOutput.Text = log;
                }
                if (pendingPluginOperation == null)
                {
                    pendingPluginOperation = pluginRuntime.LatestPendingOperation();
                    if (pendingPluginOperation != null)
                    {
                        pluginLogOutput.Text = pluginRuntime.ReadOperationLog(pendingPluginOperation, null);
                        SetPluginBusy(true, pendingPluginOperation.IsInterrupted
                            ? "检测到异常中断的更新请求" : "外部更新协调器仍在运行…");
                    }
                }
            }
            LayoutPluginManager();
        }

        private void RenderPluginRows()
        {
            if (pluginFeatureRows == null) return;
            CapturePluginSelections();
            string filter = pluginSearchInput == null ? String.Empty : pluginSearchInput.Text.Trim();
            pluginFeatureRows.SuspendLayout();
            bool previousLoading = pluginControlsLoading;
            pluginControlsLoading = true;
            try
            {
                if (pluginSnapshot == null || pluginSnapshot.features == null) return;
                PluginFeatureSnapshot[] ordered = pluginSnapshot.features
                    .OrderBy(item => item.scope == "global" ? 0 : 1)
                    .ThenBy(item => item.order)
                    .ThenBy(item => item.id)
                    .ToArray();
                HashSet<string> currentIds = new HashSet<string>(ordered.Select(feature => feature.id), StringComparer.Ordinal);
                foreach (string staleId in pluginRows.Keys.Where(id => !currentIds.Contains(id)).ToArray())
                {
                    PluginFeatureRow stale = pluginRows[staleId];
                    pluginFeatureRows.Controls.Remove(stale);
                    stale.Dispose();
                    pluginRows.Remove(staleId);
                }
                int displayIndex = 0;
                foreach (PluginFeatureSnapshot feature in ordered)
                {
                    PluginFeatureRow row;
                    if (!pluginRows.TryGetValue(feature.id, out row))
                    {
                        row = new PluginFeatureRow();
                        pluginRows.Add(feature.id, row);
                        pluginFeatureRows.Controls.Add(row);
                        PluginFeatureRow capturedRow = row;
                        row.SelectionChanged += delegate
                        {
                            if (pluginControlsLoading) return;
                            if (capturedRow.Feature != null)
                                pluginSelections[capturedRow.Feature.id] = capturedRow.Selected;
                            UpdatePluginPlan();
                        };
                    }
                    row.Bind(feature);
                    bool selected;
                    if (pluginSelections.TryGetValue(feature.id, out selected)) row.Selected = selected;
                    bool matches = feature.scope == "global" || String.IsNullOrWhiteSpace(filter);
                    if (!matches)
                    {
                        string haystack = (feature.name + "\n" + feature.description + "\n"
                            + feature.id + "\n" + feature.packageName).ToLowerInvariant();
                        matches = haystack.Contains(filter.ToLowerInvariant());
                    }
                    row.Visible = matches;
                    pluginFeatureRows.Controls.SetChildIndex(row, displayIndex++);
                }
            }
            finally
            {
                pluginControlsLoading = previousLoading;
                pluginFeatureRows.ResumeLayout(false);
            }
            SizePluginRows();
            LayoutPluginManager();
        }

        private Dictionary<string, bool> CurrentPluginSelections()
        {
            CapturePluginSelections();
            return new Dictionary<string, bool>(pluginSelections, StringComparer.Ordinal);
        }

        private void CapturePluginSelections()
        {
            if (pluginFeatureRows != null)
                foreach (PluginFeatureRow row in pluginFeatureRows.Controls.OfType<PluginFeatureRow>())
                    if (row.Feature != null) pluginSelections[row.Feature.id] = row.Selected;
        }

        private void SetAllPluginRows(bool selected)
        {
            if (pluginSnapshot != null && pluginSnapshot.features != null)
                foreach (PluginFeatureSnapshot feature in pluginSnapshot.features.Where(value => value.scope == "profile"))
                    pluginSelections[feature.id] = selected;
            foreach (PluginFeatureRow row in pluginFeatureRows.Controls.OfType<PluginFeatureRow>()) row.Selected = selected;
            UpdatePluginPlan();
        }

        private string[] DesiredPluginFeatures()
        {
            Dictionary<string, bool> visibleSelections = CurrentPluginSelections();
            if (pluginSnapshot == null || pluginSnapshot.features == null) return new string[0];
            return pluginSnapshot.features.Where(feature => feature.scope == "profile")
                .Where(feature =>
                {
                    bool selected;
                    return visibleSelections.TryGetValue(feature.id, out selected) ? selected : feature.selected;
                })
                .Select(feature => feature.id)
                .Distinct(StringComparer.Ordinal)
                .OrderBy(value => value, StringComparer.Ordinal)
                .ToArray();
        }

        private void UpdatePluginPlan()
        {
            if (pluginPlanText == null) return;
            if (pluginSnapshot == null || pluginSnapshot.features == null)
            {
                pluginPlanText.Text = "尚未读取功能目录。";
                pluginApplyButton.Enabled = false;
                return;
            }
            HashSet<string> desired = new HashSet<string>(DesiredPluginFeatures(), StringComparer.Ordinal);
            PluginFeatureSnapshot[] profileFeatures = pluginSnapshot.features.Where(feature => feature.scope == "profile").ToArray();
            string[] install = profileFeatures.Where(feature => desired.Contains(feature.id) && !feature.installed).Select(feature => feature.name).ToArray();
            string[] remove = profileFeatures.Where(feature => !desired.Contains(feature.id) && feature.installed).Select(feature => feature.name).ToArray();
            bool revisionChanged = pluginSnapshot.source != null
                && (String.IsNullOrWhiteSpace(pluginSnapshot.lastAppliedRevision)
                    || !String.Equals(pluginSnapshot.source.revision, pluginSnapshot.lastAppliedRevision, StringComparison.Ordinal));
            string[] refresh = revisionChanged
                ? profileFeatures.Where(feature => desired.Contains(feature.id) && feature.installed).Select(feature => feature.name).ToArray()
                : new string[0];
            bool launcherMissing = pluginSnapshot.features.Any(feature => feature.scope == "global"
                && feature.required && !feature.installed);
            StringBuilder summary = new StringBuilder();
            if (launcherMissing) summary.AppendLine("修复：Windows Launcher");
            if (pluginSnapshot.aggregateInstalled) summary.AppendLine("迁移：根聚合包 → 独立功能包");
            if (install.Length > 0) summary.AppendLine("安装：" + String.Join("、", install));
            if (refresh.Length > 0) summary.AppendLine("刷新：" + String.Join("、", refresh));
            if (remove.Length > 0) summary.AppendLine("卸载：" + String.Join("、", remove));
            bool hasChanges = launcherMissing || pluginSnapshot.aggregateInstalled
                || install.Length > 0 || refresh.Length > 0 || remove.Length > 0;
            if (!hasChanges) summary.Append("当前已是目标状态，无需再次构建或应用。");
            if (pluginSnapshot.externalChange) summary.AppendLine().Append("注意：实际 Profile 与上次成功目标集合不同，本次将以当前选择重新调和。");
            pluginPlanText.Text = summary.ToString().Trim();
            pluginApplyButton.Enabled = pendingPluginOperation == null && hasChanges;
        }

        private void ChoosePluginSourceDirectory()
        {
            using (FolderBrowserDialog dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择 dsh-enhanced-plugins 项目源码根目录";
                dialog.ShowNewFolderButton = false;
                if (pluginSnapshot != null && pluginSnapshot.source != null && Directory.Exists(pluginSnapshot.source.path))
                    dialog.SelectedPath = pluginSnapshot.source.path;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                string root = dialog.SelectedPath;
                string profile = SelectedPluginProfile();
                SetPluginBusy(true, "正在验证并绑定项目源码…");
                ThreadPool.QueueUserWorkItem(delegate
                {
                    PluginManagerSnapshot snapshot;
                    OperationResult result = pluginRuntime.Bind(root, profile, out snapshot);
                    BeginInvoke(new Action(delegate
                    {
                        if (result.Success && snapshot != null) ApplyPluginSnapshot(snapshot);
                        SetPluginBusy(false, result.Success ? "项目源码已绑定" : "源码绑定失败");
                        ShowToast(result);
                        if (!result.Success) pluginLogOutput.Text = result.Message;
                    }));
                });
            }
        }

        private void ImportPluginSourceZip()
        {
            using (OpenFileDialog dialog = new OpenFileDialog())
            {
                dialog.Title = "导入 dsh-enhanced-plugins 源码 ZIP";
                dialog.Filter = "源码 ZIP (*.zip)|*.zip";
                dialog.CheckFileExists = true;
                dialog.Multiselect = false;
                if (dialog.ShowDialog(this) != DialogResult.OK) return;
                string zipPath = dialog.FileName;
                string profile = SelectedPluginProfile();
                SetPluginBusy(true, "正在安全解压并验证源码 ZIP…");
                ThreadPool.QueueUserWorkItem(delegate
                {
                    PluginManagerSnapshot snapshot;
                    OperationResult result = pluginRuntime.ImportZip(zipPath, profile, out snapshot);
                    BeginInvoke(new Action(delegate
                    {
                        if (result.Success && snapshot != null) ApplyPluginSnapshot(snapshot);
                        SetPluginBusy(false, result.Success ? "本地源码 ZIP 已导入并绑定" : "源码 ZIP 导入失败");
                        ShowToast(result);
                        if (!result.Success) pluginLogOutput.Text = result.Message;
                    }));
                });
            }
        }

        private void CheckPluginUpdate()
        {
            if (pluginSnapshot == null || pluginSnapshot.source == null)
            {
                ShowToast(OperationResult.Fail("请先绑定项目源码。"));
                return;
            }
            SetPluginBusy(true, "正在安全检查远端 revision…");
            ThreadPool.QueueUserWorkItem(delegate
            {
                PluginUpdateCheck check;
                OperationResult result = pluginRuntime.CheckUpdate(pluginSnapshot.source.path, SelectedPluginProfile(), out check);
                BeginInvoke(new Action(delegate
                {
                    SetPluginBusy(false, result.Success && check != null && check.source != null && check.source.updateAvailable
                        ? "发现源码更新" : result.Success ? "当前已是最新" : "检查更新失败");
                    if (result.Success && check != null && check.source != null)
                    {
                        pluginSourceStatus.Text = check.source.updateAvailable ? "有更新" : "已是最新";
                        pluginSourceStatus.ForeColor = check.source.updateAvailable ? UiTheme.Warning : UiTheme.Success;
                        pluginSourceStatusDot.IndicatorColor = pluginSourceStatus.ForeColor;
                        pluginLogOutput.Text = "更新模式：" + check.source.mode + Environment.NewLine
                            + "当前 revision：" + check.source.currentRevision + Environment.NewLine
                            + "远端 revision：" + check.source.latestRevision + Environment.NewLine
                            + "关系：" + check.source.relation
                            + (check.source.clean ? String.Empty : Environment.NewLine + "本地修改：" + check.source.changes);
                    }
                    ShowToast(result);
                }));
            });
        }

        private void RunPluginApply(bool updateSource)
        {
            if (pluginSnapshot == null || pluginSnapshot.source == null)
            {
                ShowToast(OperationResult.Fail("请先绑定并读取项目源码。"));
                return;
            }
            string[] desired = DesiredPluginFeatures();
            string profile = SelectedPluginProfile();
            string repository = pluginSnapshot.source.path;
            SetPluginBusy(true, "正在生成并校验只读执行计划…");
            ThreadPool.QueueUserWorkItem(delegate
            {
                PluginManagementPlan plan;
                OperationResult planResult = pluginRuntime.Plan(repository, profile, desired, updateSource, out plan);
                BeginInvoke(new Action(delegate
                {
                    if (!planResult.Success || plan == null || plan.profile == null)
                    {
                        SetPluginBusy(false, "执行计划生成失败");
                        ShowToast(planResult);
                        pluginLogOutput.Text = planResult.Message;
                        return;
                    }
                    if (!PluginPlanHasWork(plan))
                    {
                        SetPluginBusy(false, "当前已是目标状态");
                        pluginPlanText.Text = "当前已是目标状态，无需再次构建或应用。";
                        pluginApplyButton.Enabled = false;
                        ShowToast(OperationResult.Ok("未检测到源码或功能选择变化，无需执行。"));
                        return;
                    }
                    string message = BuildPluginConfirmation(plan);
                    if (MessageBox.Show(this, message, updateSource ? "更新源码并应用" : "应用插件更改",
                        MessageBoxButtons.YesNo, MessageBoxIcon.Question,
                        MessageBoxDefaultButton.Button2) != DialogResult.Yes)
                    {
                        SetPluginBusy(false, "已取消插件管理操作");
                        ShowToast(OperationResult.Ok("已取消，未修改源码、Profile 或 Launcher。"));
                        return;
                    }
                    PendingPluginOperation pending;
                    OperationResult result = pluginRuntime.StartApply(repository, profile, desired, updateSource, plan, out pending);
                    if (result.Success)
                    {
                        pendingPluginOperation = pending;
                        completedPluginLogPath = null;
                        pluginLogOutput.Text = result.Message + Environment.NewLine + "请求 ID：" + pending.RequestId;
                        SetPluginBusy(true, updateSource ? "正在更新源码、构建并应用…" : "正在构建并应用…");
                    }
                    else SetPluginBusy(false, "无法启动外部协调器");
                    ShowToast(result);
                }));
            });
        }

        private static bool PluginPlanHasWork(PluginManagementPlan plan)
        {
            if (plan == null || plan.profile == null) return false;
            return plan.updateSource
                || plan.profile.migrateAggregate
                || plan.profile.install != null && plan.profile.install.Length > 0
                || plan.profile.update != null && plan.profile.update.Length > 0
                || plan.profile.remove != null && plan.profile.remove.Length > 0
                || plan.launcher != null && !String.Equals(plan.launcher.action, "none", StringComparison.Ordinal);
        }

        private string BuildPluginConfirmation(PluginManagementPlan plan)
        {
            StringBuilder message = new StringBuilder();
            message.AppendLine(plan.updateSource
                ? "将安全获取候选源码，在隔离快照中完成构建和检查后再进入提交阶段。"
                : "将使用当前绑定源码完成构建和检查后再进入提交阶段。");
            message.AppendLine();
            message.AppendLine("源码 revision：" + ShortRevision(plan.sourceRevision));
            message.AppendLine("目标 Profile：" + plan.profile.name);
            if (plan.additionalManagedProfiles != null && plan.additionalManagedProfiles.Length > 0)
                message.AppendLine("同步其它已管理 Profile：" + String.Join("、", plan.additionalManagedProfiles));
            if (plan.profile.migrateAggregate) message.AppendLine("迁移：根聚合包 → 独立功能包");
            message.AppendLine("安装：" + FeatureNames(plan.profile.install));
            message.AppendLine("刷新：" + FeatureNames(plan.profile.update));
            message.AppendLine("卸载：" + FeatureNames(plan.profile.remove));
            message.AppendLine("Launcher：" + LauncherActionName(plan.launcher == null ? null : plan.launcher.action));
            message.AppendLine();
            message.Append("进入 Profile 提交阶段后不会强制取消；Launcher 发生变化时控制中心会关闭，新版将在托盘继续运行，可双击托盘图标或通过右键菜单再次打开。确定执行这份计划吗？");
            return message.ToString();
        }

        private string FeatureNames(string[] featureIds)
        {
            if (featureIds == null || featureIds.Length == 0) return "无";
            Dictionary<string, string> names = (pluginSnapshot == null || pluginSnapshot.features == null
                ? new PluginFeatureSnapshot[0] : pluginSnapshot.features)
                .ToDictionary(feature => feature.id, feature => feature.name, StringComparer.Ordinal);
            return String.Join("、", featureIds.Select(id => names.ContainsKey(id) ? names[id] : id));
        }

        private static string LauncherActionName(string action)
        {
            if (String.Equals(action, "none", StringComparison.Ordinal)) return "哈希相同，无需重启";
            if (String.Equals(action, "repair", StringComparison.Ordinal)) return "修复必选组件";
            if (String.Equals(action, "update", StringComparison.Ordinal)) return "更新并重启";
            return "构建后按候选哈希决定是否更新";
        }

        private void RefreshPluginOperation()
        {
            if (pendingPluginOperation == null) return;
            PluginApplyResult result;
            if (!pluginRuntime.TryReadResult(pendingPluginOperation, out result))
            {
                string liveLog = pluginRuntime.ReadOperationLog(pendingPluginOperation, null);
                if (!String.IsNullOrWhiteSpace(liveLog) && !String.Equals(pluginLogOutput.Text, liveLog, StringComparison.Ordinal))
                {
                    pluginLogOutput.Text = liveLog;
                    pluginLogOutput.SelectionStart = pluginLogOutput.TextLength;
                    pluginLogOutput.ScrollToCaret();
                }
                return;
            }
            PendingPluginOperation completed = pendingPluginOperation;
            pendingPluginOperation = null;
            completedPluginLogPath = result.logPath;
            string log = pluginRuntime.ReadOperationLog(completed, result.logPath);
            pluginLogOutput.Text = String.IsNullOrWhiteSpace(log) ? result.message : log;
            SetPluginBusy(false, result.success ? "插件管理操作完成" : "插件管理操作失败");
            ShowToast(result.success ? OperationResult.Ok(result.message) : OperationResult.Fail(result.message));
            if (result.success && result.snapshot != null) ApplyPluginSnapshot(result.snapshot);
            else RefreshPluginManager(true);
        }

        private void SetPluginBusy(bool busy, string status)
        {
            pluginSourceStatus.Text = status;
            Color statusColor = busy ? UiTheme.Primary
                : status.IndexOf("失败", StringComparison.Ordinal) >= 0
                    || status.IndexOf("异常", StringComparison.Ordinal) >= 0
                    || status.IndexOf("无法", StringComparison.Ordinal) >= 0 ? UiTheme.Danger
                : status.IndexOf("需要", StringComparison.Ordinal) >= 0
                    || status.IndexOf("外部变更", StringComparison.Ordinal) >= 0
                    || status.IndexOf("发现源码更新", StringComparison.Ordinal) >= 0 ? UiTheme.Warning
                : status.IndexOf("取消", StringComparison.Ordinal) >= 0 ? UiTheme.Muted
                : UiTheme.Success;
            pluginSourceStatus.ForeColor = statusColor;
            pluginSourceStatusDot.IndicatorColor = statusColor;
            pluginChooseSourceButton.Enabled = !busy;
            pluginCheckButton.Enabled = !busy && pluginSnapshot != null;
            pluginUpdateButton.Enabled = !busy && pluginSnapshot != null;
            pluginApplyButton.Enabled = !busy && pluginSnapshot != null;
            pluginProfileInput.Enabled = !busy;
            pluginSelectAllButton.Enabled = !busy;
            pluginClearButton.Enabled = !busy;
        }

        private string SelectedPluginProfile()
        {
            return String.IsNullOrWhiteSpace(pluginProfileInput.Text) ? "web" : pluginProfileInput.Text.Trim();
        }

        private static string ShortRevision(string revision)
        {
            if (String.IsNullOrWhiteSpace(revision)) return "未知 revision";
            return revision.Length <= 12 ? revision : revision.Substring(0, 12);
        }

        private void LayoutPluginManager()
        {
            if (pluginPage == null || pluginSourceCard == null) return;
            int left;
            int width;
            GetContentBounds(pluginPage, out left, out width);
            if (width < 1) return;
            int pageTop = 0;
            int gap = Dip(18);
            bool compactSource = width < Dip(640);
            bool stackSourceActions = width < Dip(500);
            int sourceHeight = Dip(stackSourceActions ? 288 : compactSource ? 230 : 196);
            SetBoundsIfChanged(pluginSourceCard, left, pageTop, width, sourceHeight);
            LayoutCardHeader(pluginSourceCard);
            if (compactSource)
            {
                int available = Math.Max(Dip(120), pluginSourceCard.Width - Dip(56));
                SetBoundsIfChanged(pluginSourcePath, Dip(28), Dip(76), available, Dip(22));
                SetBoundsIfChanged(pluginSourceRevision, Dip(28), Dip(103), available, Dip(22));
                SetBoundsIfChanged(pluginSourceStatusDot, Dip(28), Dip(134), Dip(14), Dip(14));
                SetBoundsIfChanged(pluginSourceStatus, Dip(48), Dip(128),
                    Math.Max(Dip(100), available - Dip(20)), Dip(28));
                if (stackSourceActions)
                {
                    int smallGap = Dip(12);
                    int half = Math.Max(Dip(90), (available - smallGap) / 2);
                    SetBoundsIfChanged(pluginChooseSourceButton, Dip(28), Dip(166), half, Dip(42));
                    SetBoundsIfChanged(pluginCheckButton, Dip(28) + half + smallGap, Dip(166),
                        Math.Max(Dip(90), available - half - smallGap), Dip(42));
                    SetBoundsIfChanged(pluginUpdateButton, Dip(28), Dip(220), available, Dip(42));
                }
                else
                {
                    pluginChooseSourceButton.Location = new Point(Dip(28), Dip(166));
                    pluginCheckButton.Location = new Point(Dip(148), Dip(166));
                    pluginUpdateButton.Location = new Point(Dip(268), Dip(166));
                }
            }
            else
            {
                int sourceStatusWidth = Math.Min(Dip(310), Math.Max(Dip(190), pluginSourceCard.Width / 3));
                int sourceStatusLeft = pluginSourceCard.Width - Dip(28) - sourceStatusWidth;
                SetBoundsIfChanged(pluginSourcePath, Dip(28), Dip(76),
                    Math.Max(Dip(120), sourceStatusLeft - Dip(46)), Dip(22));
                SetBoundsIfChanged(pluginSourceRevision, Dip(28), Dip(103),
                    Math.Max(Dip(120), pluginSourceCard.Width - Dip(56)), Dip(22));
                SetBoundsIfChanged(pluginSourceStatusDot, sourceStatusLeft, Dip(80), Dip(14), Dip(14));
                SetBoundsIfChanged(pluginSourceStatus, sourceStatusLeft + Dip(20), Dip(74),
                    Math.Max(Dip(120), sourceStatusWidth - Dip(20)), Dip(28));
                pluginChooseSourceButton.Location = new Point(Dip(28), Dip(142));
                pluginCheckButton.Location = new Point(Dip(148), Dip(142));
                pluginUpdateButton.Location = new Point(Dip(268), Dip(142));
            }

            int mainTop = sourceHeight + gap;
            int toolbarWidth = Math.Max(Dip(140), width - Dip(56));
            bool compactToolbar = toolbarWidth < Dip(720);
            bool stackCompactToolbar = toolbarWidth < Dip(400);
            int rowsTop = stackCompactToolbar ? Dip(290) : compactToolbar ? Dip(224) : Dip(158);
            int visibleRows = pluginFeatureRows.Controls.OfType<PluginFeatureRow>().Count(row => row.Visible);
            int rowsHeight = visibleRows == 0 ? Dip(58)
                : (visibleRows * Dip(82)) + (Math.Max(0, visibleRows - 1) * Dip(9));
            int planTop = rowsTop + rowsHeight + Dip(20);
            bool wideFooter = width >= Dip(720);
            int planHeight = wideFooter ? Dip(118) : Dip(164);
            int featureHeight = planTop + planHeight + Dip(28);
            SetBoundsIfChanged(pluginFeaturesCard, left, pageTop + mainTop, width, featureHeight);
            LayoutCardHeader(pluginFeaturesCard);
            int profileWidth;
            int searchWidth;
            if (stackCompactToolbar)
            {
                profileWidth = toolbarWidth;
                searchWidth = toolbarWidth;
                SetBoundsIfChanged(pluginProfileCaption, Dip(28), Dip(76), profileWidth, Dip(20));
                SetBoundsIfChanged(pluginProfileInput, Dip(28), Dip(100), profileWidth, Dip(40));
                int selectorGap = Dip(12);
                int selectorWidth = Math.Max(Dip(72), (toolbarWidth - selectorGap) / 2);
                SetBoundsIfChanged(pluginSelectAllButton, Dip(28), Dip(152), selectorWidth, Dip(42));
                SetBoundsIfChanged(pluginClearButton, Dip(28) + selectorWidth + selectorGap, Dip(152),
                    Math.Max(Dip(72), toolbarWidth - selectorWidth - selectorGap), Dip(42));
                SetBoundsIfChanged(pluginSearchCaption, Dip(28), Dip(204), searchWidth, Dip(20));
                SetBoundsIfChanged(pluginSearchShell, Dip(28), Dip(228), searchWidth, Dip(40));
            }
            else if (compactToolbar)
            {
                profileWidth = Math.Max(Dip(120), Math.Min(Dip(190), toolbarWidth - Dip(196)));
                searchWidth = toolbarWidth;
                SetBoundsIfChanged(pluginProfileCaption, Dip(28), Dip(76), profileWidth, Dip(20));
                SetBoundsIfChanged(pluginProfileInput, Dip(28), Dip(100), profileWidth, Dip(40));
                pluginSelectAllButton.Location = new Point(pluginFeaturesCard.Width - Dip(202), Dip(100));
                pluginClearButton.Location = new Point(pluginFeaturesCard.Width - Dip(112), Dip(100));
                SetBoundsIfChanged(pluginSearchCaption, Dip(28), Dip(150), searchWidth, Dip(20));
                SetBoundsIfChanged(pluginSearchShell, Dip(28), Dip(174), searchWidth, Dip(40));
            }
            else
            {
                int toolbarTop = Dip(102);
                int buttonsWidth = Dip(184);
                profileWidth = Math.Min(Dip(190), Math.Max(Dip(120), toolbarWidth / 4));
                searchWidth = Math.Max(Dip(130), toolbarWidth - profileWidth - buttonsWidth - Dip(20));
                SetBoundsIfChanged(pluginProfileCaption, Dip(28), Dip(76), profileWidth, Dip(20));
                SetBoundsIfChanged(pluginProfileInput, Dip(28), toolbarTop, profileWidth, Dip(40));
                SetBoundsIfChanged(pluginSearchCaption, Dip(40) + profileWidth, Dip(76), searchWidth, Dip(20));
                SetBoundsIfChanged(pluginSearchShell, Dip(40) + profileWidth, toolbarTop, searchWidth, Dip(40));
                pluginSelectAllButton.Location = new Point(Dip(52) + profileWidth + searchWidth, toolbarTop);
                pluginClearButton.Location = new Point(Dip(142) + profileWidth + searchWidth, toolbarTop);
            }
            pluginSearchInput.SetBounds(Dip(8), Dip(9), Math.Max(Dip(80), searchWidth - Dip(16)), Dip(22));
            SetBoundsIfChanged(pluginFeatureRows, Dip(28), rowsTop, toolbarWidth, rowsHeight);
            SetBoundsIfChanged(pluginPlanShell, Dip(28), planTop, toolbarWidth, planHeight);
            SetBoundsIfChanged(pluginPlanHeading, Dip(18), Dip(13), Math.Max(Dip(120), pluginPlanShell.Width - Dip(36)), Dip(24));
            if (wideFooter)
            {
                int applyWidth = Dip(156);
                SetBoundsIfChanged(pluginPlanText, Dip(18), Dip(42),
                    Math.Max(Dip(160), pluginPlanShell.Width - applyWidth - Dip(58)), Dip(58));
                SetBoundsIfChanged(pluginApplyButton, pluginPlanShell.Width - applyWidth - Dip(18), Dip(43), applyWidth, Dip(44));
            }
            else
            {
                SetBoundsIfChanged(pluginPlanText, Dip(18), Dip(40),
                    Math.Max(Dip(120), pluginPlanShell.Width - Dip(36)), Dip(66));
                SetBoundsIfChanged(pluginApplyButton, Dip(18), planHeight - Dip(56),
                    Math.Max(Dip(120), pluginPlanShell.Width - Dip(36)), Dip(42));
            }

            int logTop = mainTop + featureHeight + gap;
            bool stackLog = width < Dip(520);
            int logHeight = Dip(stackLog ? 300 : 230);
            SetBoundsIfChanged(pluginLogCard, left, pageTop + logTop, width, logHeight);
            LayoutCardHeader(pluginLogCard);
            RoundedPanel logShell = pluginLogCard.Controls.OfType<RoundedPanel>().First(control => Equals(control.Tag, "plugin-log-shell"));
            if (stackLog)
            {
                pluginOpenRequestButton.Location = new Point(Dip(28), Dip(76));
                SetBoundsIfChanged(logShell, Dip(28), Dip(130), Math.Max(Dip(120), width - Dip(56)),
                    logHeight - Dip(158));
            }
            else
            {
                SetBoundsIfChanged(logShell, Dip(28), Dip(76), Math.Max(Dip(120), width - Dip(220)),
                    logHeight - Dip(104));
                pluginOpenRequestButton.Location = new Point(pluginLogCard.Width - Dip(164), Dip(76));
            }
            pluginPage.AutoScrollMinSize = new Size(0, logTop + logHeight + Dip(8));
            SizePluginRows();
        }

        private void SizePluginRows()
        {
            if (pluginFeatureRows == null) return;
            int featureWidth = Math.Max(Dip(100), pluginFeatureRows.ClientSize.Width
                - pluginFeatureRows.Padding.Horizontal);
            foreach (PluginFeatureRow row in pluginFeatureRows.Controls.OfType<PluginFeatureRow>())
            {
                row.Width = featureWidth;
                row.Height = Dip(82);
                row.Margin = new Padding(0, 0, 0, Dip(9));
            }
        }
    }
}
