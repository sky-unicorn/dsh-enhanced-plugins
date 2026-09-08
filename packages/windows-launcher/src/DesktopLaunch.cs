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
        internal const string WebHint = "浏览器访问本机 Web 服务，使用当前 Web 插件配置。";
        internal const string DesktopHint = "使用官方源码启动命令；独立开发数据，不自动继承 Web 已装插件。";
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
        private RoundedPanel launchModeCard;
        private ModernButton browserModeButton;
        private ModernButton desktopModeButton;
        private ModernButton desktopSourceButton;
        private ModernButton desktopBuildButton;
        private Label launchModeHint;
        private Label desktopPathLabel;

        private void BuildLaunchModeCard()
        {
            launchModeCard = new RoundedPanel();
            overviewPage.Content.Controls.Add(launchModeCard);
            AddCardTitle(launchModeCard, DesktopText.Title, "选择默认启动体验；登录自动启动也使用此选择");
            browserModeButton = NewButton(DesktopText.Browser, ModernButtonKind.Secondary, 118);
            desktopModeButton = NewButton(DesktopText.Desktop, ModernButtonKind.Secondary, 118);
            desktopSourceButton = NewButton(DesktopText.Source, ModernButtonKind.Quiet, 118);
            desktopBuildButton = NewButton(DesktopText.Build, ModernButtonKind.Secondary, 136);
            desktopBuildButton.Click += delegate { RunOperation(runtime.BuildAndStartDesktop); };
            launchModeHint = NewLabel(DesktopText.WebHint, 9f, FontStyle.Regular, UiTheme.Muted);
            desktopPathLabel = NewLabel("", 8.5f, FontStyle.Regular, UiTheme.Muted);
            launchModeCard.Controls.Add(browserModeButton);
            launchModeCard.Controls.Add(desktopModeButton);
            launchModeCard.Controls.Add(desktopSourceButton);
            launchModeCard.Controls.Add(launchModeHint);
            launchModeCard.Controls.Add(desktopPathLabel);
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

        private int LayoutLaunchModeCard(int left, int width)
        {
            bool desktop = runtime.Settings.LaunchMode == "desktop";
            int height = Dip(desktop ? 228 : 184);
            SetBoundsIfChanged(launchModeCard, left, 0, width, height);
            LayoutCardHeader(launchModeCard);
            SetBoundsIfChanged(browserModeButton, Dip(28), Dip(76), Dip(118), Dip(40));
            SetBoundsIfChanged(desktopModeButton, Dip(158), Dip(76), Dip(118), Dip(40));
            SetRuntimeLabel(launchModeHint, Dip(28), Dip(124), Math.Max(Dip(100), width - Dip(56)), Dip(42));
            SetRuntimeLabel(desktopPathLabel, Dip(28), Dip(178), Math.Max(Dip(80), width - Dip(192)), Dip(28));
            SetBoundsIfChanged(desktopSourceButton, Math.Max(Dip(28), width - Dip(146)), Dip(174), Dip(118), Dip(36));
            desktopSourceButton.Visible = desktop;
            desktopPathLabel.Visible = desktop;
            return height + Dip(16);
        }

        private void ApplyLaunchModeStatus()
        {
            bool desktop = runtime.Settings.LaunchMode == "desktop";
            browserModeButton.Text = (desktop ? "" : "✓ ") + DesktopText.Browser;
            desktopModeButton.Text = (desktop ? "✓ " : "") + DesktopText.Desktop;
            browserModeButton.Kind = desktop ? ModernButtonKind.Secondary : ModernButtonKind.Primary;
            desktopModeButton.Kind = desktop ? ModernButtonKind.Primary : ModernButtonKind.Secondary;
            launchModeHint.Text = desktop ? DesktopText.DesktopHint : DesktopText.WebHint;
            string source = runtime.ResolveDshSource();
            desktopPathLabel.Text = source ?? DesktopText.SelectFirst;
            startButton.Text = desktop ? "启动桌面端" : "启动 Web";
            openButton.Text = desktop ? DesktopText.Logs : "打开页面";
            restartButton.Visible = !desktop;
            desktopBuildButton.Visible = desktop;
            noOpenToggle.Enabled = !desktop;
            portLabel.Visible = portInput.Visible = browserLabel.Visible = noOpenToggle.Visible = !desktop;
            shieldLabel.Text = "只管理由 Launcher 启动的进程";
            pathCard.Visible = true;
            if (!desktop) return;
            bool configured = DesktopLaunch.SupportsSource(source);
            bool built = configured && DesktopLaunch.HasBuild(source);
            bool running = runtime.DesktopRunning();
            LauncherState last = runtime.DesktopLastState();
            bool failed = !running && last != null && (last.status != "stopped" || last.exitCode != 0) && !last.stoppedByLauncher;
            SetLabelText(statusTitle, running ? DesktopText.Running : failed ? DesktopText.Failed
                : !configured ? "绑定 DSH 源码" : !built ? "桌面端需要构建" : "源码桌面可启动");
            SetLabelText(statusDetail, running ? "命令正在执行；窗口就绪情况请查看桌面窗口"
                : failed ? "启动命令未成功结束，请打开桌面日志查看原因"
                : !configured ? DesktopText.SelectFirst : !built ? DesktopText.NeedsBuild : "pnpm run start:desktop · 复用已有构建");
            SetLabelText(statusPort, "独立开发 profile · 首次或更新源码后使用“构建并启动”");
            statusDot.IndicatorColor = failed ? UiTheme.Danger : running || built ? UiTheme.Primary : UiTheme.Warning;
            startButton.Enabled = built && !running;
            desktopBuildButton.Enabled = configured && !running;
            openButton.Enabled = true;
            stopButton.Enabled = running;
            portInput.Enabled = false;
        }
    }
}
