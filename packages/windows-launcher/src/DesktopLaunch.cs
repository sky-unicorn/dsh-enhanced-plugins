using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace DshEnhanced.WindowsLauncher
{
    internal static class DesktopText
    {
        internal const string Title = "启动方式";
        internal const string Browser = "浏览器";
        internal const string Desktop = "源码桌面";
        internal const string Source = "查看源码";
        internal const string Build = "构建并启动";
        internal const string Logs = "桌面日志";
        internal const string WebHint = "浏览器访问 · 使用 Web 插件配置";
        internal const string DesktopHint = "源码桌面 · 独立开发数据";
        internal const string ModeHint = "默认启动方式；登录自动启动也使用此选择";
        internal const string LocalService = "本机服务";
        internal const string DesktopReady = "已有构建，可以直接启动";
        internal const string DesktopData = "独立开发数据 · 首次使用请先构建";
        internal const string SelectFirst = "请先绑定包含桌面启动脚本的 DSH 源码目录。";
        internal const string NeedsBuild = "桌面构建产物不完整，请点击“构建并启动”。";
        internal const string Failed = "桌面启动失败。";
        internal const string Launched = "已提交 pnpm run start:desktop；启动过程见桌面日志。";
        internal const string BuildSubmitted = "已提交 pnpm run dev:desktop；构建和启动过程见桌面日志。";
        internal const string StartPending = "已有桌面启动请求正在提交。";
        internal const string Running = "桌面启动命令运行中";
        internal const string Stopped = "桌面启动命令已结束";
        internal const string Stopping = "正在停止由 Launcher 启动的桌面命令及子进程。";
        internal const string StopTimeout = "桌面进程尚未停止，请查看桌面日志。";
        internal const string StopBeforeBuild = "构建会更新共享源码产物，请先停止正在运行的 Web/桌面进程。";
    }

    internal static class DesktopLaunch
    {
        internal static bool SupportsSource(string source)
        {
            if (String.IsNullOrWhiteSpace(source)) return false;
            try
            {
                var manifest = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                    File.ReadAllText(Path.Combine(source, "package.json"), Encoding.UTF8));
                object value;
                if (!manifest.TryGetValue("scripts", out value)) return false;
                var scripts = value as Dictionary<string, object>;
                return scripts != null && scripts.ContainsKey("start:desktop") && scripts.ContainsKey("dev:desktop");
            }
            catch (IOException) { return false; }
            catch (UnauthorizedAccessException) { return false; }
            catch (ArgumentException) { return false; }
            catch (InvalidOperationException) { return false; }
        }

        internal static bool HasBuild(string source)
        {
            if (String.IsNullOrWhiteSpace(source)) return false;
            foreach (string entry in new[] { "apps/desktop/lib/main.js", "apps/desktop-host/lib/index.js", "apps/web/dist/index.html" })
                if (!File.Exists(Path.Combine(source, entry))) return false;
            return true;
        }
    }

    internal sealed partial class MainForm
    {
        private RoundedPanel launchModeSelector;
        private ModernButton browserModeButton;
        private ModernButton desktopModeButton;
        private ModernButton desktopSourceButton;
        private ModernButton desktopBuildButton;

        private void BuildLaunchModeSelector()
        {
            launchModeSelector = new RoundedPanel { Radius = 12, BackColor = UiTheme.SurfaceSoft,
                AccessibleRole = AccessibleRole.Grouping, AccessibleName = DesktopText.Title };
            header.Controls.Add(launchModeSelector);
            browserModeButton = NewButton(DesktopText.Browser, ModernButtonKind.SegmentSelected, 0);
            desktopModeButton = NewButton(DesktopText.Desktop, ModernButtonKind.Segment, 0);
            desktopSourceButton = NewButton(DesktopText.Source, ModernButtonKind.Secondary, 96);
            desktopBuildButton = NewButton(DesktopText.Build, ModernButtonKind.Secondary, 136);
            desktopBuildButton.Click += delegate { RunOperation(runtime.BuildAndStartDesktop); };
            launchModeSelector.Controls.Add(browserModeButton);
            launchModeSelector.Controls.Add(desktopModeButton);
            foreach (ModernButton button in new[] { browserModeButton, desktopModeButton })
            {
                button.AccessibleRole = AccessibleRole.RadioButton;
                button.AccessibleName = button.Text;
                runtimeTips.SetToolTip(button, DesktopText.ModeHint);
                button.KeyDown += delegate(object sender, KeyEventArgs e)
                {
                    if (e.KeyCode != Keys.Left && e.KeyCode != Keys.Right) return;
                    bool desktop = e.KeyCode == Keys.Right;
                    SelectLaunchMode(desktop ? "desktop" : "web");
                    (desktop ? desktopModeButton : browserModeButton).Focus();
                    e.Handled = e.SuppressKeyPress = true;
                };
            }
            browserModeButton.Click += delegate { SelectLaunchMode("web"); };
            desktopModeButton.Click += delegate { SelectLaunchMode("desktop"); };
            desktopSourceButton.Click += delegate { ShowPage(sourcePage, sourceNav, "DSH 源码"); };
        }

        private void SelectLaunchMode(string mode)
        {
            runtime.Settings.LaunchMode = mode;
            runtime.SaveSettings();
            System.Threading.Interlocked.Exchange(ref inspectRequested, 1);
            ApplyLaunchModeStatus();
            QueueResponsiveLayout();
            RefreshNow();
        }

        private void LayoutLaunchModeSelector(int left, int top, int width)
        {
            SetBoundsIfChanged(launchModeSelector, left, top, width, Dip(44));
            int segmentWidth = (width - Dip(8)) / 2;
            SetBoundsIfChanged(browserModeButton, Dip(4), Dip(4), segmentWidth, Dip(36));
            SetBoundsIfChanged(desktopModeButton, Dip(4) + segmentWidth, Dip(4), segmentWidth, Dip(36));
        }

        private void ApplyLaunchModeStatus()
        {
            bool desktop = runtime.Settings.LaunchMode == "desktop";
            browserModeButton.Kind = desktop ? ModernButtonKind.Segment : ModernButtonKind.SegmentSelected;
            desktopModeButton.Kind = desktop ? ModernButtonKind.SegmentSelected : ModernButtonKind.Segment;
            browserModeButton.TabStop = !desktop;
            desktopModeButton.TabStop = desktop;
            if (activePage == overviewPage) pageSubtitle.Text = desktop ? DesktopText.DesktopHint : DesktopText.WebHint;
            string source = runtime.ResolveDshSource();
            desktopSourceButton.Visible = desktop;
            runtimeTips.SetToolTip(desktopSourceButton, source ?? DesktopText.SelectFirst);
            startButton.Text = desktop ? "启动桌面端" : "启动 Web";
            openButton.Text = desktop ? DesktopText.Logs : "打开页面";
            restartButton.Visible = !desktop;
            desktopBuildButton.Visible = desktop;
            noOpenToggle.Enabled = !desktop;
            portLabel.Visible = portInput.Visible = browserLabel.Visible = noOpenToggle.Visible = !desktop;
            pathCard.Visible = true;
            if (!desktop) return;
            bool configured = DesktopLaunch.SupportsSource(source);
            bool built = configured && DesktopLaunch.HasBuild(source);
            bool running = runtime.DesktopRunning();
            desktopBuildButton.Kind = !built && !running ? ModernButtonKind.Primary : ModernButtonKind.Secondary;
            LauncherState last = runtime.DesktopLastState();
            bool failed = !running && last != null && (last.status != "stopped" || last.exitCode != 0) && !last.stoppedByLauncher;
            SetLabelText(statusTitle, running ? DesktopText.Running : failed ? DesktopText.Failed
                : !configured ? "绑定 DSH 源码" : !built ? "桌面端需要构建" : "源码桌面可启动");
            SetLabelText(statusDetail, running ? "命令正在执行；窗口就绪情况请查看桌面窗口"
                : failed ? "启动命令未成功结束，请打开桌面日志查看原因"
                : !configured ? DesktopText.SelectFirst : !built ? DesktopText.NeedsBuild : DesktopText.DesktopReady);
            SetLabelText(statusPort, DesktopText.DesktopData);
            statusDot.IndicatorColor = failed ? UiTheme.Danger : running || built ? UiTheme.Primary : UiTheme.Warning;
            startButton.Enabled = built && !running;
            desktopBuildButton.Enabled = configured && !running;
            openButton.Enabled = true;
            stopButton.Enabled = running;
            portInput.Enabled = false;
        }
    }
}
