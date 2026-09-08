using System;
using System.Drawing;
using System.IO;
using System.Windows.Forms;

namespace DshEnhanced.WindowsLauncher
{
    internal static class DesktopText
    {
        internal const string Title = "启动方式";
        internal const string Browser = "浏览器";
        internal const string Desktop = "桌面端";
        internal const string Browse = "选择应用…";
        internal const string WebHint = "浏览器访问本机 Web 服务，使用当前 Web 插件配置。";
        internal const string DesktopHint = "打开官方桌面应用；插件由桌面端独立管理，关闭应用即可结束。";
        internal const string SelectFirst = "请先选择已安装的官方 DeepSeek Harness 桌面应用（.exe）。";
        internal const string Failed = "无法启动桌面应用。";
        internal const string Launched = "已发送桌面启动请求；应用就绪状态请在桌面窗口中确认。";
    }

    internal static class DesktopLaunch
    {
        internal static bool IsExecutable(string path)
        {
            try
            {
                return !String.IsNullOrWhiteSpace(path) && Path.IsPathRooted(path)
                    && String.Equals(Path.GetExtension(path), ".exe", StringComparison.OrdinalIgnoreCase)
                    && File.Exists(path);
            }
            catch (ArgumentException) { return false; }
        }
    }

    internal sealed partial class MainForm
    {
        private RoundedPanel launchModeCard;
        private ModernButton browserModeButton;
        private ModernButton desktopModeButton;
        private ModernButton desktopBrowseButton;
        private Label launchModeHint;
        private Label desktopPathLabel;

        private void BuildLaunchModeCard()
        {
            launchModeCard = new RoundedPanel();
            overviewPage.Content.Controls.Add(launchModeCard);
            AddCardTitle(launchModeCard, DesktopText.Title, "选择默认启动体验；登录自动启动也使用此选择");
            browserModeButton = NewButton(DesktopText.Browser, ModernButtonKind.Secondary, 118);
            desktopModeButton = NewButton(DesktopText.Desktop, ModernButtonKind.Secondary, 118);
            desktopBrowseButton = NewButton(DesktopText.Browse, ModernButtonKind.Quiet, 118);
            launchModeHint = NewLabel(DesktopText.WebHint, 9f, FontStyle.Regular, UiTheme.Muted);
            desktopPathLabel = NewLabel("", 8.5f, FontStyle.Regular, UiTheme.Muted);
            launchModeCard.Controls.Add(browserModeButton);
            launchModeCard.Controls.Add(desktopModeButton);
            launchModeCard.Controls.Add(desktopBrowseButton);
            launchModeCard.Controls.Add(launchModeHint);
            launchModeCard.Controls.Add(desktopPathLabel);
            browserModeButton.Click += delegate { SelectLaunchMode("web"); };
            desktopModeButton.Click += delegate { SelectLaunchMode("desktop"); };
            desktopBrowseButton.Click += delegate {
                using (OpenFileDialog dialog = new OpenFileDialog())
                {
                    dialog.Title = DesktopText.SelectFirst;
                    dialog.Filter = "Windows 应用 (*.exe)|*.exe";
                    dialog.CheckFileExists = true;
                    if (dialog.ShowDialog(this) != DialogResult.OK) return;
                    if (!DesktopLaunch.IsExecutable(dialog.FileName)) return;
                    runtime.Settings.DesktopExecutable = dialog.FileName;
                    runtime.SaveSettings();
                    RefreshNow();
                }
            };
        }

        private void SelectLaunchMode(string mode)
        {
            runtime.Settings.LaunchMode = mode;
            runtime.SaveSettings();
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
            SetBoundsIfChanged(desktopBrowseButton, Math.Max(Dip(28), width - Dip(146)), Dip(174), Dip(118), Dip(36));
            desktopBrowseButton.Visible = desktop;
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
            desktopPathLabel.Text = String.IsNullOrWhiteSpace(runtime.Settings.DesktopExecutable)
                ? "尚未选择桌面应用" : runtime.Settings.DesktopExecutable;
            startButton.Text = desktop ? "启动桌面端" : "启动 Web";
            openButton.Visible = restartButton.Visible = stopButton.Visible = !desktop;
            noOpenToggle.Enabled = !desktop;
            portLabel.Visible = portInput.Visible = browserLabel.Visible = noOpenToggle.Visible = !desktop;
            shieldLabel.Text = desktop ? "应用生命周期由桌面端管理" : "只管理由 Launcher 启动的进程";
            pathCard.Visible = !desktop;
            if (!desktop) return;
            bool ready = DesktopLaunch.IsExecutable(runtime.Settings.DesktopExecutable);
            SetLabelText(statusTitle, ready ? "桌面应用已配置" : "配置桌面应用");
            SetLabelText(statusDetail, ready ? "使用官方独立窗口打开 DSH" : DesktopText.SelectFirst);
            SetLabelText(statusPort, "无需 Web 端口 · Desktop 独立管理插件");
            statusDot.IndicatorColor = ready ? UiTheme.Primary : UiTheme.Warning;
            startButton.Enabled = ready;
            portInput.Enabled = false;
        }
    }
}
