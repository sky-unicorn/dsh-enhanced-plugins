using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace DshEnhanced.WindowsLauncher
{
    internal static class Program
    {
        internal const string ShowEventName = "Local\\DSH.Enhanced.WindowsLauncher.Show";
        internal const string ShutdownEventName = "Local\\DSH.Enhanced.WindowsLauncher.Shutdown";
        internal const string StartDshEventName = "Local\\DSH.Enhanced.WindowsLauncher.StartDsh";
        internal const string MutexName = "Local\\DSH.Enhanced.WindowsLauncher.Single";

        [DllImport("user32.dll")]
        private static extern bool SetProcessDPIAware();

        [DllImport("user32.dll", EntryPoint = "SetProcessDpiAwarenessContext")]
        private static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);

        [DllImport("shcore.dll")]
        private static extern int SetProcessDpiAwareness(int awareness);

        [STAThread]
        private static int Main(string[] args)
        {
            EnableModernDpiAwareness();
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            LauncherPaths.Ensure();

            if (args.Length >= 1 && String.Equals(args[0], "--shutdown", StringComparison.OrdinalIgnoreCase))
            {
                SignalEvent(ShutdownEventName);
                return 0;
            }

            if (args.Length >= 2 && String.Equals(args[0], "--doctor", StringComparison.OrdinalIgnoreCase))
            {
                LauncherRuntime runtime = new LauncherRuntime();
                string report;
                OperationResult result = runtime.RunDoctor(out report);
                File.WriteAllText(args[1], report, new UTF8Encoding(false));
                return result.Success ? 0 : 1;
            }

            if (args.Length >= 3 && String.Equals(args[0], "--automation", StringComparison.OrdinalIgnoreCase))
            {
                LauncherRuntime runtime = new LauncherRuntime();
                string action = args[1].ToLowerInvariant();
                OperationResult result;
                string operationOutput = String.Empty;
                WebStatusSnapshot status;
                if (action == "start") result = runtime.StartWeb();
                else if (action == "stop") result = runtime.StopWeb();
                else if (action == "stop-and-wait") result = runtime.StopWebAndWait();
                else if (action == "restart") result = runtime.RestartWeb();
                else if (action == "build") result = runtime.BuildDshSource(out operationOutput);
                else if (action == "status") result = OperationResult.Ok("状态读取完成。");
                else result = OperationResult.Fail("未知自动化操作：" + action);
                status = runtime.Snapshot();
                JsonFile.Write(args[2], new Dictionary<string, object>
                {
                    { "success", result.Success },
                    { "message", result.Message },
                    { "ownership", status.Ownership.ToString() },
                    { "port", status.Port },
                    { "canStop", status.CanStop },
                    { "output", operationOutput },
                });
                return result.Success ? 0 : 1;
            }

            if (args.Length >= 2 && String.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
                bool complete = File.Exists(Path.Combine(baseDirectory, "DSH-Launcher.Command.ps1"))
                    && File.Exists(Path.Combine(baseDirectory, "DSH-Launcher.Supervisor.ps1"))
                    && File.Exists(Path.Combine(baseDirectory, "DSH-Launcher.exe.config"))
                    && StartupRegistration.SelfTest();
                File.WriteAllText(args[1], complete ? "SELF_TEST_OK" : "SELF_TEST_INCOMPLETE", new UTF8Encoding(false));
                return complete ? 0 : 1;
            }

            if (args.Length >= 2 && String.Equals(args[0], "--screenshot", StringComparison.OrdinalIgnoreCase))
            {
                try
                {
                    using (Icon icon = LauncherIcon.Create())
                    using (MainForm form = new MainForm(new LauncherRuntime(), icon))
                    {
                        form.CaptureTo(args[1], args.Length >= 3 ? args[2] : "overview",
                            args.Length >= 4 ? args[3] : "normal");
                    }
                    return 0;
                }
                catch (Exception error)
                {
                    File.WriteAllText(args[1] + ".error.txt", error.ToString(), new UTF8Encoding(false));
                    return 1;
                }
            }

            if (args.Length >= 1 && String.Equals(args[0], "--ui-preview", StringComparison.OrdinalIgnoreCase))
            {
                using (Icon icon = LauncherIcon.Create())
                using (MainForm form = new MainForm(new LauncherRuntime(), icon))
                    Application.Run(form);
                return 0;
            }

            bool startHidden = StartupRegistration.HasArgument(args, "--tray");
            bool startDshAfterLogin = StartupRegistration.HasArgument(args, StartupRegistration.StartDshArgument);
            bool created;
            using (Mutex mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    SignalEvent(startDshAfterLogin ? StartDshEventName : ShowEventName);
                    return 0;
                }
                Application.Run(new LauncherApplicationContext(startHidden, startDshAfterLogin));
            }
            return 0;
        }

        private static void EnableModernDpiAwareness()
        {
            // Win10 1703+ / Win11: crisp per-monitor scaling with correct control metrics.
            try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
            // Older Win10 builds: per-monitor awareness without the v2 context.
            try
            {
                int result = SetProcessDpiAwareness(2);
                if (result == 0 || result == unchecked((int)0x80070005)) return;
            }
            catch { }
            try { SetProcessDPIAware(); } catch { }
        }

        private static void SignalEvent(string name)
        {
            try
            {
                using (EventWaitHandle signal = EventWaitHandle.OpenExisting(name)) signal.Set();
            }
            catch (WaitHandleCannotBeOpenedException) { }
        }
    }

    internal sealed class LauncherApplicationContext : ApplicationContext
    {
        private readonly LauncherRuntime runtime;
        private readonly MainForm form;
        private readonly NotifyIcon tray;
        private readonly Icon icon;
        private readonly EventWaitHandle showSignal;
        private readonly EventWaitHandle shutdownSignal;
        private readonly EventWaitHandle startDshSignal;
        private readonly System.Windows.Forms.Timer signalTimer;
        private readonly System.Windows.Forms.Timer delayedDshTimer;
        private bool exiting;
        private int stopAndExitInProgress;

        internal LauncherApplicationContext(bool startHidden, bool startDshAfterLogin)
        {
            runtime = new LauncherRuntime();
            icon = LauncherIcon.Create();
            form = new MainForm(runtime, icon);
            form.FormClosing += OnFormClosing;
            // A login-started instance may stay hidden for its entire lifetime. Force a
            // native handle now so background Web completion can safely use BeginInvoke.
            if (form.Handle == IntPtr.Zero) throw new InvalidOperationException("无法创建 Launcher 后台窗口句柄。");

            tray = new NotifyIcon();
            tray.Icon = icon;
            tray.Text = "DeepSeek Harness Launcher";
            tray.Visible = true;
            tray.ContextMenuStrip = BuildTrayMenu();
            tray.DoubleClick += delegate { ShowWindow(); };

            showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowEventName);
            shutdownSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShutdownEventName);
            startDshSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.StartDshEventName);
            delayedDshTimer = new System.Windows.Forms.Timer();
            delayedDshTimer.Interval = 30000;
            delayedDshTimer.Tick += delegate
            {
                delayedDshTimer.Stop();
                LauncherLog.Write("login DSH delay elapsed; submitting Web start");
                RunTrayOperation(runtime.StartWeb);
            };
            signalTimer = new System.Windows.Forms.Timer();
            signalTimer.Interval = 250;
            signalTimer.Tick += delegate
            {
                if (showSignal.WaitOne(0)) ShowWindow();
                if (shutdownSignal.WaitOne(0)) ExitLauncher();
                if (startDshSignal.WaitOne(0)) ScheduleDelayedDsh();
            };
            signalTimer.Start();

            if (!startHidden) ShowWindow();
            else if (startDshAfterLogin)
                tray.ShowBalloonTip(2200, "DeepSeek Harness", "Launcher 已就绪，将在 30 秒后启动 DSH Web。", ToolTipIcon.Info);
            else tray.ShowBalloonTip(1800, "DeepSeek Harness", "Launcher 已在托盘就绪。", ToolTipIcon.Info);
            if (startDshAfterLogin) ScheduleDelayedDsh();
        }

        private ContextMenuStrip BuildTrayMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Font = UiTheme.Font(9.5f, FontStyle.Regular);
            menu.Items.Add("打开控制中心", null, delegate { ShowWindow(); });
            menu.Items.Add(new ToolStripSeparator());
            ToolStripItem startWeb = menu.Items.Add("启动 Web", null, delegate { RunTrayOperation(runtime.StartWeb); });
            ToolStripItem openWeb = menu.Items.Add("打开 Web 页面", null, delegate { RunTrayOperation(runtime.OpenWeb); });
            ToolStripItem restartWeb = menu.Items.Add("重启 Web", null, delegate { RunTrayOperation(runtime.RestartWeb); });
            ToolStripItem stopWeb = menu.Items.Add("停止 Web", null, delegate { RunTrayOperation(runtime.StopWeb); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开日志目录", null, delegate { runtime.OpenLogFolder(); });
            ToolStripMenuItem launcherAutostart = new ToolStripMenuItem("登录后仅启动 Launcher");
            launcherAutostart.Click += delegate { SetStartupModeFromTray(LoginStartupMode.LauncherOnly); };
            menu.Items.Add(launcherAutostart);
            ToolStripMenuItem dshAutostart = new ToolStripMenuItem("登录后自动启动 DSH（延迟 30 秒）");
            dshAutostart.Click += delegate { SetStartupModeFromTray(LoginStartupMode.LauncherAndDsh); };
            menu.Items.Add(dshAutostart);
            menu.Items.Add(new ToolStripSeparator());
            ToolStripItem launcherOnlyExit = menu.Items.Add("仅退出 Launcher", null, delegate { ExitLauncher(); });
            ToolStripItem exitLauncher = menu.Items.Add("退出 Launcher", null, delegate { StopDshAndExit(); });
            menu.Opening += delegate
            {
                LoginStartupMode mode = runtime.GetAutostartMode();
                launcherAutostart.Checked = mode == LoginStartupMode.LauncherOnly;
                dshAutostart.Checked = mode == LoginStartupMode.LauncherAndDsh;
                WebStatusSnapshot status = runtime.Snapshot();
                bool stoppingAndExiting = Volatile.Read(ref stopAndExitInProgress) != 0;
                startWeb.Enabled = !stoppingAndExiting && status.Ownership == WebOwnership.Stopped;
                openWeb.Enabled = !stoppingAndExiting
                    && (status.Ownership == WebOwnership.Owned || status.Ownership == WebOwnership.External);
                restartWeb.Enabled = !stoppingAndExiting && status.Ownership != WebOwnership.External;
                stopWeb.Enabled = !stoppingAndExiting && status.CanStop;
                exitLauncher.Enabled = !stoppingAndExiting;
                launcherOnlyExit.Enabled = !stoppingAndExiting;
            };
            return menu;
        }

        private void SetStartupModeFromTray(LoginStartupMode selected)
        {
            RunTrayOperation(delegate
            {
                LoginStartupMode current = runtime.GetAutostartMode();
                return runtime.SetAutostartMode(current == selected ? LoginStartupMode.Disabled : selected);
            });
        }

        private void ScheduleDelayedDsh()
        {
            delayedDshTimer.Stop();
            delayedDshTimer.Start();
            LauncherLog.Write("login DSH start scheduled delay=30s");
        }

        private void RunTrayOperation(Func<OperationResult> operation)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                OperationResult result;
                try { result = operation(); }
                catch (Exception error) { result = OperationResult.Fail(error.Message); }
                form.BeginInvoke(new Action(delegate
                {
                    tray.ShowBalloonTip(2200, result.Success ? "DeepSeek Harness" : "操作未完成", result.Message,
                        result.Success ? ToolTipIcon.Info : ToolTipIcon.Warning);
                    form.RefreshNow();
                }));
            });
        }

        private void ShowWindow()
        {
            bool opening = !form.Visible;
            if (opening) form.Show();
            if (form.WindowState == FormWindowState.Minimized) form.WindowState = FormWindowState.Normal;
            form.ShowInTaskbar = true;
            form.Activate();
            form.BringToFront();
            if (!opening) form.RefreshNow();
        }

        private void OnFormClosing(object sender, FormClosingEventArgs args)
        {
            if (exiting) return;
            args.Cancel = true;
            form.Hide();
            form.ShowInTaskbar = false;
            tray.ShowBalloonTip(1500, "Launcher 仍在运行", "可从系统托盘再次打开控制中心。", ToolTipIcon.Info);
        }

        private void ExitLauncher()
        {
            if (exiting) return;
            exiting = true;
            signalTimer.Stop();
            delayedDshTimer.Stop();
            tray.Visible = false;
            tray.Dispose();
            showSignal.Dispose();
            shutdownSignal.Dispose();
            startDshSignal.Dispose();
            delayedDshTimer.Dispose();
            form.Close();
            icon.Dispose();
            ExitThread();
        }

        private void StopDshAndExit()
        {
            if (exiting || Interlocked.CompareExchange(ref stopAndExitInProgress, 1, 0) != 0) return;
            delayedDshTimer.Stop();
            form.SetStopAndExitState(true, OperationResult.Ok("正在停止 DSH，完成后将退出 Launcher…"));
            ThreadPool.QueueUserWorkItem(delegate
            {
                OperationResult result;
                try { result = runtime.StopWebAndWait(); }
                catch (Exception error) { result = OperationResult.Fail("停止 DSH 失败：" + error.Message); }
                if (exiting || form.IsDisposed || !form.IsHandleCreated) return;
                try
                {
                    form.BeginInvoke(new Action(delegate
                    {
                        if (result.Success)
                        {
                            ExitLauncher();
                            return;
                        }
                        Interlocked.Exchange(ref stopAndExitInProgress, 0);
                        form.SetStopAndExitState(false, result);
                        tray.ShowBalloonTip(2400, "未能退出 Launcher", result.Message, ToolTipIcon.Warning);
                    }));
                }
                catch (InvalidOperationException) { }
            });
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly LauncherRuntime runtime;
        private Panel sidebar;
        private BrandMark brandMark;
        private Label brandName;
        private Label brandEdition;
        private Label sidebarVersion;
        private readonly Panel pageHost;
        private readonly Panel header;
        private readonly Panel overviewPage;
        private readonly Panel tasksPage;
        private readonly Panel diagnosticsPage;
        private readonly Panel sourcePage;
        private NavButton overviewNav;
        private NavButton tasksNav;
        private NavButton diagnosticsNav;
        private NavButton sourceNav;
        private readonly Label pageTitle;
        private readonly Label pageSubtitle;
        private readonly Label statusTitle;
        private readonly Label statusDetail;
        private readonly Label statusPort;
        private readonly StatusIndicator statusDot;
        private readonly Label dshPath;
        private readonly ModernButton startButton;
        private readonly ModernButton openButton;
        private readonly ModernButton restartButton;
        private readonly ModernButton stopButton;
        private readonly PortField portInput;
        private readonly ToggleSwitch noOpenToggle;
        private readonly ToggleSwitch launcherAutostartToggle;
        private readonly ToggleSwitch dshAutostartToggle;
        private readonly RichTextBox taskInput;
        private readonly RichTextBox taskOutput;
        private readonly ModernButton taskRunButton;
        private readonly ModernComboBox profileInput;
        private Label taskInputLabel;
        private Label taskOutputLabel;
        private RoundedPanel taskInputShell;
        private RoundedPanel taskOutputShell;
        private readonly RichTextBox diagnosticsOutput;
        private readonly RichTextBox sourceOutput;
        private readonly ModernButton buildDshButton;
        private readonly Label toast;
        private readonly System.Windows.Forms.Timer refreshTimer;
        private HeroPanel hero;
        private FlowLayoutPanel overviewActions;
        private RoundedPanel settingsCard;
        private RoundedPanel pathCard;
        private Label privacyLabel;
        private Label shieldLabel;
        private Label portLabel;
        private Label browserLabel;
        private Label launcherAutoLabel;
        private Label dshAutoLabel;
        private RoundedPanel taskCard;
        private RoundedPanel profileCard;
        private ModernButton runProfileButton;
        private RoundedPanel diagnosticsCard;
        private FlowLayoutPanel diagnosticsActions;
        private RoundedPanel sourceCard;
        private RoundedPanel sourceLogShell;
        private Label sourcePathLabel;
        private Panel activePage;
        private bool loadingSettings;
        private bool layoutPending;
        private bool dshResolved;
        private string resolvedDsh;
        private int refreshInFlight;
        private int refreshAgain;
        private int buildInProgress;
        private bool captureMode;
        private float layoutScaleOverride;

        internal MainForm(LauncherRuntime runtime, Icon icon)
        {
            this.runtime = runtime;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.ResizeRedraw, true);
            UpdateStyles();
            Text = "DeepSeek Harness Launcher";
            Icon = (Icon)icon.Clone();
            BackColor = UiTheme.Background;
            Font = UiTheme.Font(9.5f, FontStyle.Regular);
            AutoScaleDimensions = new SizeF(96f, 96f);
            AutoScaleMode = AutoScaleMode.Dpi;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1120, 740);
            MinimumSize = Size.Empty;

            sidebar = BuildSidebar();
            Controls.Add(sidebar);

            Panel workspace = new Panel();
            workspace.Dock = DockStyle.Fill;
            workspace.BackColor = UiTheme.Background;
            Controls.Add(workspace);
            workspace.BringToFront();

            header = new Panel();
            header.Dock = DockStyle.Top;
            header.Height = 92;
            header.BackColor = UiTheme.Background;
            pageTitle = new Label();
            pageTitle.AutoSize = true;
            pageTitle.Text = "概览";
            pageTitle.Font = UiTheme.Font(21f, FontStyle.Bold);
            pageTitle.ForeColor = UiTheme.Text;
            pageTitle.Location = new Point(34, 19);
            header.Controls.Add(pageTitle);
            pageSubtitle = new Label();
            pageSubtitle.AutoSize = true;
            pageSubtitle.Text = "本机 DSH 服务与任务控制中心";
            pageSubtitle.Font = UiTheme.Font(9.2f, FontStyle.Regular);
            pageSubtitle.ForeColor = UiTheme.Muted;
            pageSubtitle.Location = new Point(36, 57);
            header.Controls.Add(pageSubtitle);
            workspace.Controls.Add(header);

            toast = new Label();
            toast.Dock = DockStyle.Bottom;
            toast.Height = 42;
            toast.TextAlign = ContentAlignment.MiddleLeft;
            toast.Padding = new Padding(36, 0, 0, 0);
            toast.ForeColor = UiTheme.Muted;
            toast.BackColor = UiTheme.Background;
            toast.Text = "就绪";
            workspace.Controls.Add(toast);

            pageHost = new Panel();
            pageHost.Dock = DockStyle.Fill;
            pageHost.Padding = new Padding(34, 8, 34, 12);
            pageHost.BackColor = UiTheme.Background;
            workspace.Controls.Add(pageHost);
            pageHost.BringToFront();

            overviewPage = new Panel();
            overviewPage.Dock = DockStyle.Fill;
            overviewPage.BackColor = UiTheme.Background;
            overviewPage.AutoScroll = true;
            tasksPage = new Panel();
            tasksPage.Dock = DockStyle.Fill;
            tasksPage.BackColor = UiTheme.Background;
            tasksPage.AutoScroll = true;
            diagnosticsPage = new Panel();
            diagnosticsPage.Dock = DockStyle.Fill;
            diagnosticsPage.BackColor = UiTheme.Background;
            diagnosticsPage.AutoScroll = true;
            sourcePage = new Panel();
            sourcePage.Dock = DockStyle.Fill;
            sourcePage.BackColor = UiTheme.Background;
            sourcePage.AutoScroll = true;
            pageHost.Controls.Add(overviewPage);
            pageHost.Controls.Add(tasksPage);
            pageHost.Controls.Add(diagnosticsPage);
            pageHost.Controls.Add(sourcePage);

            statusTitle = new Label();
            statusDetail = new Label();
            statusPort = new Label();
            statusDot = new StatusIndicator();
            dshPath = new Label();
            startButton = NewButton("启动 Web", ModernButtonKind.Primary, 116);
            openButton = NewButton("打开页面", ModernButtonKind.Secondary, 112);
            restartButton = NewButton("重新启动", ModernButtonKind.Secondary, 112);
            stopButton = NewButton("停止", ModernButtonKind.Danger, 92);
            portInput = new PortField();
            noOpenToggle = new ToggleSwitch();
            launcherAutostartToggle = new ToggleSwitch();
            dshAutostartToggle = new ToggleSwitch();
            BuildOverviewPage();

            taskInput = new RichTextBox();
            taskOutput = new RichTextBox();
            taskRunButton = NewButton("运行 Headless", ModernButtonKind.Primary, 144);
            profileInput = new ModernComboBox();
            BuildTasksPage();

            diagnosticsOutput = new RichTextBox();
            BuildDiagnosticsPage();
            sourceOutput = new RichTextBox();
            buildDshButton = NewButton("拉取最新源码并构建", ModernButtonKind.Primary, 184);
            BuildSourcePage();

            startButton.Click += delegate { RunOperation(runtime.StartWeb); };
            openButton.Click += delegate { RunOperation(runtime.OpenWeb); };
            restartButton.Click += delegate { RunOperation(runtime.RestartWeb); };
            stopButton.Click += delegate { RunOperation(runtime.StopWeb); };
            taskRunButton.Click += delegate { RunHeadless(); };
            portInput.ValueChanged += delegate
            {
                if (loadingSettings) return;
                runtime.Settings.Port = Decimal.ToInt32(portInput.Value);
                runtime.SaveSettings();
                RefreshNow();
            };
            noOpenToggle.CheckedChanged += delegate
            {
                if (loadingSettings) return;
                runtime.Settings.NoOpen = noOpenToggle.Checked;
                runtime.SaveSettings();
            };
            launcherAutostartToggle.CheckedChanged += delegate
            {
                if (loadingSettings) return;
                ChangeAutostartMode(LoginStartupMode.LauncherOnly, launcherAutostartToggle.Checked);
            };
            dshAutostartToggle.CheckedChanged += delegate
            {
                if (loadingSettings) return;
                ChangeAutostartMode(LoginStartupMode.LauncherAndDsh, dshAutostartToggle.Checked);
            };

            loadingSettings = true;
            portInput.Value = runtime.Settings.Port;
            noOpenToggle.Checked = runtime.Settings.NoOpen;
            ApplyStartupModeToControls(runtime.GetAutostartMode());
            loadingSettings = false;

            refreshTimer = new System.Windows.Forms.Timer();
            refreshTimer.Interval = 2000;
            refreshTimer.Tick += delegate
            {
                RefreshNow();
                if (activePage == sourcePage || Interlocked.CompareExchange(ref buildInProgress, 0, 0) != 0)
                    RefreshSourceLog(true);
            };
            VisibleChanged += delegate
            {
                if (Visible)
                {
                    refreshTimer.Start();
                    RefreshNow();
                }
                else refreshTimer.Stop();
            };
            ShowPage(overviewPage, overviewNav, "概览");
            pageHost.Resize += delegate { QueueResponsiveLayout(); };
            Shown += delegate
            {
                ApplyDisplayConstraints();
                // The first visible layout runs after WinForms has applied DPI scaling and docking.
                // Keep it synchronous so the initial paint never exposes overlapping default bounds.
                PerformLayout();
                pageHost.PerformLayout();
                LayoutResponsivePages();
                QueueResponsiveLayout();
            };
            PerformLayout();
            LayoutResponsivePages();
        }

        protected override void OnLoad(EventArgs e)
        {
            base.OnLoad(e);
            ApplyDisplayConstraints();
            PerformLayout();
            LayoutResponsivePages();
        }

        protected override void WndProc(ref Message message)
        {
            const int WmDpiChanged = 0x02E0;
            base.WndProc(ref message);
            if (message.Msg != WmDpiChanged || captureMode || IsDisposed || !IsHandleCreated) return;
            try
            {
                BeginInvoke(new Action(delegate
                {
                    if (IsDisposed) return;
                    ApplyDisplayConstraints();
                    PerformLayout();
                    pageHost.PerformLayout();
                    LayoutResponsivePages();
                }));
            }
            catch (InvalidOperationException) { }
        }

        private int Dip(int value)
        {
            float scale = layoutScaleOverride > 0f ? layoutScaleOverride : Math.Max(1f, DeviceDpi / 96f);
            return Math.Max(value == 0 ? 0 : 1, (int)Math.Round(value * scale));
        }

        private void ApplyDisplayConstraints()
        {
            if (captureMode || WindowState != FormWindowState.Normal) return;
            Rectangle workingArea = Screen.FromControl(this).WorkingArea;
            int margin = Dip(8);
            int maximumWidth = Math.Max(1, workingArea.Width - (margin * 2));
            int maximumHeight = Math.Max(1, workingArea.Height - (margin * 2));
            int responsiveMinimumWidth = Math.Min(maximumWidth,
                Math.Min(Dip(820), Math.Max(640, (maximumWidth * 3) / 4)));
            int responsiveMinimumHeight = Math.Min(maximumHeight,
                Math.Min(Dip(560), Math.Max(480, (maximumHeight * 3) / 4)));

            MinimumSize = Size.Empty;
            Size = new Size(Math.Min(Width, maximumWidth), Math.Min(Height, maximumHeight));
            MinimumSize = new Size(responsiveMinimumWidth, responsiveMinimumHeight);

            int left = Math.Max(workingArea.Left + margin,
                Math.Min(Left, workingArea.Right - margin - Width));
            int top = Math.Max(workingArea.Top + margin,
                Math.Min(Top, workingArea.Bottom - margin - Height));
            Location = new Point(left, top);
            MaximizedBounds = workingArea;
        }

        private Panel BuildSidebar()
        {
            Panel sidebar = new Panel();
            sidebar.Dock = DockStyle.Left;
            sidebar.Width = 224;
            sidebar.BackColor = UiTheme.Sidebar;

            brandMark = new BrandMark();
            brandMark.Location = new Point(24, 26);
            sidebar.Controls.Add(brandMark);
            brandName = new Label();
            brandName.AutoSize = true;
            brandName.Text = "DeepSeek Harness";
            brandName.Font = UiTheme.Font(10.2f, FontStyle.Bold);
            brandName.ForeColor = Color.White;
            brandName.Location = new Point(82, 30);
            sidebar.Controls.Add(brandName);
            brandEdition = new Label();
            brandEdition.AutoSize = true;
            brandEdition.Text = "WINDOWS LAUNCHER";
            brandEdition.Font = UiTheme.Font(7.2f, FontStyle.Bold);
            brandEdition.ForeColor = Color.FromArgb(126, 148, 185);
            brandEdition.Location = new Point(82, 55);
            sidebar.Controls.Add(brandEdition);

            overviewNav = NewNav("概览", 122, NavGlyph.Overview);
            tasksNav = NewNav("任务与 Profile", 172, NavGlyph.Tasks);
            diagnosticsNav = NewNav("日志与诊断", 222, NavGlyph.Diagnostics);
            sourceNav = NewNav("DSH 源码", 272, NavGlyph.Source);
            sidebar.Controls.Add(overviewNav);
            sidebar.Controls.Add(tasksNav);
            sidebar.Controls.Add(diagnosticsNav);
            sidebar.Controls.Add(sourceNav);
            overviewNav.Click += delegate { ShowPage(overviewPage, overviewNav, "概览"); };
            tasksNav.Click += delegate { ShowPage(tasksPage, tasksNav, "任务与 Profile"); };
            diagnosticsNav.Click += delegate { ShowPage(diagnosticsPage, diagnosticsNav, "日志与诊断"); };
            sourceNav.Click += delegate { ShowPage(sourcePage, sourceNav, "DSH 源码"); };

            sidebarVersion = new Label();
            sidebarVersion.Text = "LOCAL COMPANION  ·  v0.1.0";
            sidebarVersion.ForeColor = Color.FromArgb(115, 134, 165);
            sidebarVersion.Font = UiTheme.Font(7.4f, FontStyle.Regular);
            sidebarVersion.AutoSize = true;
            sidebar.Controls.Add(sidebarVersion);
            EventHandler layoutFooter = delegate
            {
                LayoutSidebarFooter(sidebar, false);
            };
            sidebar.SizeChanged += layoutFooter;
            layoutFooter(sidebar, EventArgs.Empty);
            return sidebar;
        }

        private void LayoutSidebarFooter(Panel owner, bool compact)
        {
            int inset = compact ? Dip(12) : Dip(24);
            sidebarVersion.Visible = !compact && owner.ClientSize.Height >= Dip(350);
            sidebarVersion.Location = new Point(inset,
                Math.Max(Dip(300), owner.ClientSize.Height - Dip(65)));
        }

        private void BuildOverviewPage()
        {
            hero = new HeroPanel();
            hero.Size = new Size(780, 154);
            overviewPage.Controls.Add(hero);

            statusDot.Location = new Point(30, 33);
            hero.Controls.Add(statusDot);
            statusTitle.AutoSize = true;
            statusTitle.Font = UiTheme.Font(16.5f, FontStyle.Bold);
            statusTitle.ForeColor = Color.White;
            statusTitle.BackColor = Color.Transparent;
            statusTitle.Location = new Point(54, 23);
            statusTitle.Text = "正在检查 Web 状态";
            hero.Controls.Add(statusTitle);
            statusDetail.AutoSize = true;
            statusDetail.Font = UiTheme.Font(9.5f, FontStyle.Regular);
            statusDetail.ForeColor = Color.FromArgb(184, 199, 222);
            statusDetail.BackColor = Color.Transparent;
            statusDetail.Location = new Point(31, 64);
            hero.Controls.Add(statusDetail);
            statusPort.AutoSize = true;
            statusPort.Font = UiTheme.Font(10f, FontStyle.Bold);
            statusPort.ForeColor = Color.FromArgb(146, 172, 255);
            statusPort.BackColor = Color.Transparent;
            statusPort.Location = new Point(31, 103);
            hero.Controls.Add(statusPort);
            privacyLabel = NewLabel("LOCAL ONLY", 8f, FontStyle.Bold, Color.FromArgb(140, 165, 216));
            hero.Controls.Add(privacyLabel);
            shieldLabel = NewLabel("只管理由 Launcher 启动的进程", 8.5f, FontStyle.Regular, Color.FromArgb(177, 193, 218));
            hero.Controls.Add(shieldLabel);

            overviewActions = new FlowLayoutPanel();
            overviewActions.Size = new Size(780, 48);
            overviewActions.BackColor = UiTheme.Background;
            overviewActions.WrapContents = false;
            overviewActions.Controls.Add(startButton);
            overviewActions.Controls.Add(openButton);
            overviewActions.Controls.Add(restartButton);
            overviewActions.Controls.Add(stopButton);
            overviewPage.Controls.Add(overviewActions);

            settingsCard = new RoundedPanel();
            settingsCard.Size = new Size(780, 168);
            overviewPage.Controls.Add(settingsCard);
            AddCardTitle(settingsCard, "启动选项", "两种登录启动模式互斥；自动 DSH 会在 Launcher 就绪 30 秒后启动 Web");

            portLabel = NewLabel("服务端口", 9f, FontStyle.Regular, UiTheme.Muted);
            settingsCard.Controls.Add(portLabel);
            portInput.Size = new Size(118, 40);
            portInput.Minimum = 1;
            portInput.Maximum = 65535;
            portInput.Font = UiTheme.Font(10f, FontStyle.Regular);
            settingsCard.Controls.Add(portInput);

            browserLabel = NewLabel("启动后不打开浏览器", 9f, FontStyle.Regular, UiTheme.Muted);
            settingsCard.Controls.Add(browserLabel);
            settingsCard.Controls.Add(noOpenToggle);

            launcherAutoLabel = NewLabel("登录仅启动 Launcher", 9f, FontStyle.Regular, UiTheme.Muted);
            settingsCard.Controls.Add(launcherAutoLabel);
            settingsCard.Controls.Add(launcherAutostartToggle);

            dshAutoLabel = NewLabel("登录自动启动 DSH", 9f, FontStyle.Regular, UiTheme.Muted);
            settingsCard.Controls.Add(dshAutoLabel);
            settingsCard.Controls.Add(dshAutostartToggle);

            pathCard = new RoundedPanel();
            pathCard.Size = new Size(780, 112);
            overviewPage.Controls.Add(pathCard);
            AddCardTitle(pathCard, "运行环境", "Launcher 会优先使用 dsh.ps1，避免批处理参数重新解释");
            dshPath.AutoEllipsis = true;
            dshPath.Font = UiTheme.Font(8.5f, FontStyle.Regular);
            dshPath.ForeColor = UiTheme.Muted;
            pathCard.Controls.Add(dshPath);
        }

        private void BuildTasksPage()
        {
            taskCard = new RoundedPanel();
            taskCard.Size = new Size(780, 320);
            tasksPage.Controls.Add(taskCard);
            AddCardTitle(taskCard, "Headless 单次任务", "任务内容通过请求文件传递，不拼接到 shell 命令");
            taskInputLabel = NewLabel("任务内容", 8.8f, FontStyle.Regular, UiTheme.Muted);
            taskCard.Controls.Add(taskInputLabel);
            taskInputShell = NewEditorShell();
            taskCard.Controls.Add(taskInputShell);
            taskInput.BorderStyle = BorderStyle.None;
            taskInput.Font = UiTheme.Font(10f, FontStyle.Regular);
            taskInput.BackColor = Color.FromArgb(242, 245, 251);
            taskInput.ForeColor = UiTheme.Text;
            taskInput.Dock = DockStyle.Fill;
            taskInputShell.Controls.Add(taskInput);
            taskCard.Controls.Add(taskRunButton);
            taskOutputLabel = NewLabel("运行输出", 8.8f, FontStyle.Regular, UiTheme.Muted);
            taskCard.Controls.Add(taskOutputLabel);
            taskOutputShell = NewEditorShell();
            taskCard.Controls.Add(taskOutputShell);
            taskOutput.ReadOnly = true;
            taskOutput.BorderStyle = BorderStyle.None;
            taskOutput.BackColor = Color.FromArgb(242, 245, 251);
            taskOutput.ForeColor = UiTheme.Text;
            taskOutput.Font = new Font("Consolas", 8.5f, FontStyle.Regular);
            taskOutput.Dock = DockStyle.Fill;
            taskOutputShell.Controls.Add(taskOutput);

            profileCard = new RoundedPanel();
            profileCard.Size = new Size(780, 154);
            tasksPage.Controls.Add(profileCard);
            AddCardTitle(profileCard, "启动其他 Profile", "后台无窗口运行，输出以 UTF-8 保存在日志目录");
            profileInput.SetItems(runtime.Profiles());
            if (profileInput.ItemCount > 0) profileInput.SelectedIndex = 0;
            profileCard.Controls.Add(profileInput);
            runProfileButton = NewButton("启动 Profile", ModernButtonKind.Secondary, 132);
            runProfileButton.Click += delegate { ShowToast(runtime.RunProfile(profileInput.Text)); };
            profileCard.Controls.Add(runProfileButton);
        }

        private void BuildDiagnosticsPage()
        {
            diagnosticsCard = new RoundedPanel();
            diagnosticsPage.Controls.Add(diagnosticsCard);
            AddCardTitle(diagnosticsCard, "日志与环境诊断", "查看 Launcher 与 Web 运行记录，检查本机 DSH 环境");
            diagnosticsActions = new FlowLayoutPanel();
            diagnosticsActions.BackColor = UiTheme.Surface;
            diagnosticsActions.WrapContents = false;
            ModernButton refreshLogs = NewButton("刷新日志", ModernButtonKind.Secondary, 110);
            ModernButton doctor = NewButton("运行诊断", ModernButtonKind.Primary, 110);
            ModernButton folder = NewButton("打开日志目录", ModernButtonKind.Quiet, 126);
            refreshLogs.Click += delegate { diagnosticsOutput.Text = runtime.RecentLogs(); };
            doctor.Click += delegate { RunDoctor(); };
            folder.Click += delegate { runtime.OpenLogFolder(); };
            diagnosticsActions.Controls.Add(refreshLogs);
            diagnosticsActions.Controls.Add(doctor);
            diagnosticsActions.Controls.Add(folder);
            diagnosticsCard.Controls.Add(diagnosticsActions);
            diagnosticsOutput.ReadOnly = true;
            diagnosticsOutput.BorderStyle = BorderStyle.None;
            diagnosticsOutput.BackColor = UiTheme.SurfaceSoft;
            diagnosticsOutput.ForeColor = UiTheme.Text;
            diagnosticsOutput.Font = new Font("Consolas", 8.5f, FontStyle.Regular);
            diagnosticsOutput.Text = runtime.RecentLogs();
            diagnosticsCard.Controls.Add(diagnosticsOutput);
        }

        private void BuildSourcePage()
        {
            sourceCard = new RoundedPanel();
            sourcePage.Controls.Add(sourceCard);
            AddCardTitle(sourceCard, "更新并构建 DSH", "先以安全快进方式拉取最新源码，再执行 pnpm run build");

            sourcePathLabel = NewLabel(String.Empty, 8.5f, FontStyle.Regular, UiTheme.Muted);
            sourcePathLabel.AutoSize = false;
            sourcePathLabel.AutoEllipsis = true;
            sourceCard.Controls.Add(sourcePathLabel);

            buildDshButton.Click += delegate { RunDshBuild(); };
            buildDshButton.Enabled = runtime.ResolveDshSource() != null;
            sourceCard.Controls.Add(buildDshButton);

            sourceLogShell = NewEditorShell();
            sourceCard.Controls.Add(sourceLogShell);
            sourceOutput.ReadOnly = true;
            sourceOutput.BorderStyle = BorderStyle.None;
            sourceOutput.BackColor = UiTheme.SurfaceSoft;
            sourceOutput.ForeColor = UiTheme.Text;
            sourceOutput.Font = new Font("Consolas", 8.5f, FontStyle.Regular);
            sourceOutput.Dock = DockStyle.Fill;
            sourceOutput.Text = runtime.DshSourceBuildLog();
            sourceLogShell.Controls.Add(sourceOutput);
            UpdateSourcePath();
        }

        private void LayoutResponsivePages()
        {
            if (overviewPage == null || overviewActions == null) return;
            LayoutSidebar();
            LayoutHeader();
            // Control.Visible is false while an ancestor form is hidden, even when this is the
            // selected page. Track the selection explicitly so the first layout can run before Show().
            if (activePage == overviewPage) LayoutOverview();
            else if (activePage == tasksPage) LayoutTasks();
            else if (activePage == diagnosticsPage) LayoutDiagnostics();
            else if (activePage == sourcePage) LayoutSource();
        }

        private void QueueResponsiveLayout()
        {
            if (layoutPending || IsDisposed || !IsHandleCreated) return;
            layoutPending = true;
            try
            {
                BeginInvoke(new Action(delegate
                {
                    layoutPending = false;
                    if (!IsDisposed) LayoutResponsivePages();
                }));
            }
            catch (InvalidOperationException) { layoutPending = false; }
        }

        private void LayoutHeader()
        {
            int contentLeft;
            int contentWidth;
            GetContentBounds(overviewPage, out contentLeft, out contentWidth);
            int left = pageHost.Padding.Left + contentLeft;
            pageTitle.Left = left;
            pageSubtitle.Left = left + 2;
        }

        private void LayoutSidebar()
        {
            if (sidebar == null) return;
            bool compact = ClientSize.Width < Dip(760);
            int sidebarWidth = Dip(compact ? 176 : 224);
            if (sidebar.Width != sidebarWidth) sidebar.Width = sidebarWidth;

            brandName.Visible = !compact;
            brandEdition.Visible = !compact;
            brandMark.Location = compact
                ? new Point(Math.Max(0, (sidebarWidth - brandMark.Width) / 2), Dip(26))
                : new Point(Dip(24), Dip(26));

            NavButton[] navigation = { overviewNav, tasksNav, diagnosticsNav, sourceNav };
            foreach (NavButton button in navigation) button.Width = sidebarWidth;
            LayoutSidebarFooter(sidebar, compact);
        }

        private void LayoutOverview()
        {
            int left;
            int width;
            GetContentBounds(overviewPage, out left, out width);
            if (width < 1) return;

            int heroHeight = Dip(154);
            SetBoundsIfChanged(hero, left, 0, width, heroHeight);
            bool compactHero = width < Dip(560);
            privacyLabel.Visible = !compactHero;
            shieldLabel.Visible = !compactHero;
            statusDot.Location = new Point(Dip(30), Dip(33));
            SetBoundsIfChanged(statusTitle, Dip(54), Dip(22),
                Math.Max(Dip(140), width - Dip(compactHero ? 86 : 250)), Dip(34));
            SetBoundsIfChanged(statusDetail, Dip(31), Dip(62), Math.Max(Dip(120), width - Dip(62)), Dip(25));
            SetBoundsIfChanged(statusPort, Dip(31), Dip(101), Math.Max(Dip(120), width - Dip(62)), Dip(25));
            if (!compactHero)
            {
                privacyLabel.Location = new Point(Math.Max(Dip(31), width - privacyLabel.PreferredSize.Width - Dip(31)), Dip(28));
                shieldLabel.Location = new Point(Math.Max(Dip(31), width - shieldLabel.PreferredSize.Width - Dip(31)), Dip(109));
            }

            overviewActions.WrapContents = true;
            int actionsTop = heroHeight + Dip(16);
            int actionsHeight = FlowLayoutHeight(overviewActions, width, Dip(48));
            SetBoundsIfChanged(overviewActions, left, actionsTop, width, actionsHeight);
            int cardsTop = actionsTop + actionsHeight + Dip(12);

            int availableForSettings = Math.Max(Dip(120), width - Dip(56));
            int settingsColumns = Math.Max(1, Math.Min(4, availableForSettings / Dip(165)));
            int settingsRows = (4 + settingsColumns - 1) / settingsColumns;
            int settingsHeight = Dip(92) + (settingsRows * Dip(70)) + Dip(10);
            bool sideBySide = width >= Dip(1020);
            int bottom;
            if (sideBySide)
            {
                int gap = Dip(18);
                int settingsWidth = Math.Max(Dip(680), (int)Math.Round(width * 0.64));
                availableForSettings = Math.Max(Dip(120), settingsWidth - Dip(56));
                settingsColumns = Math.Max(1, Math.Min(4, availableForSettings / Dip(165)));
                settingsRows = (4 + settingsColumns - 1) / settingsColumns;
                settingsHeight = Dip(92) + (settingsRows * Dip(70)) + Dip(10);
                SetBoundsIfChanged(settingsCard, left, cardsTop, settingsWidth, settingsHeight);
                SetBoundsIfChanged(pathCard, left + settingsWidth + gap, cardsTop,
                    width - settingsWidth - gap, settingsHeight);
                bottom = cardsTop + settingsHeight;
            }
            else
            {
                int pathHeight = Dip(112);
                int gap = Dip(18);
                SetBoundsIfChanged(settingsCard, left, cardsTop, width, settingsHeight);
                SetBoundsIfChanged(pathCard, left, cardsTop + settingsHeight + gap, width, pathHeight);
                bottom = cardsTop + settingsHeight + gap + pathHeight;
            }

            LayoutCardHeader(settingsCard);
            LayoutCardHeader(pathCard);
            int available = Math.Max(Dip(120), settingsCard.Width - Dip(56));
            int column = available / settingsColumns;
            Label[] labels = { portLabel, browserLabel, launcherAutoLabel, dshAutoLabel };
            Control[] controls = { portInput, noOpenToggle, launcherAutostartToggle, dshAutostartToggle };
            for (int index = 0; index < labels.Length; index++)
            {
                int row = index / settingsColumns;
                int columnIndex = index % settingsColumns;
                LayoutSetting(labels[index], controls[index], Dip(28) + (column * columnIndex),
                    column, Dip(78) + (row * Dip(70)));
            }

            SetBoundsIfChanged(dshPath, Dip(28), Dip(82), Math.Max(Dip(80), pathCard.Width - Dip(56)), Dip(24));
            overviewPage.AutoScrollMinSize = new Size(0, bottom + Dip(8));
        }

        private void LayoutSetting(Label label, Control control, int left, int columnWidth, int top)
        {
            label.AutoSize = false;
            label.AutoEllipsis = true;
            SetBoundsIfChanged(label, left, top, Math.Max(Dip(72), columnWidth - Dip(12)), Dip(21));
            control.Location = new Point(left, top + Dip(27));
            if (control is PortField) control.Width = Math.Min(Dip(118), Math.Max(Dip(92), columnWidth - Dip(18)));
        }

        private void LayoutTasks()
        {
            int left;
            int width;
            GetContentBounds(tasksPage, out left, out width);
            if (width < 1) return;

            bool sideBySide = width >= Dip(1080);
            int gap = Dip(18);
            int bottom;
            if (sideBySide)
            {
                int taskWidth = (int)Math.Round((width - gap) * 0.66);
                int cardHeight = Math.Min(Dip(450), Math.Max(Dip(390), tasksPage.ClientSize.Height - Dip(80)));
                SetBoundsIfChanged(taskCard, left, 0, taskWidth, cardHeight);
                SetBoundsIfChanged(profileCard, left + taskWidth + gap, 0, width - taskWidth - gap, Dip(212));
                bottom = cardHeight;
            }
            else
            {
                bool stackEditors = width < Dip(680);
                int taskHeight = Dip(stackEditors ? 600 : 344);
                int profileHeight = width < Dip(480) ? Dip(204) : Dip(154);
                SetBoundsIfChanged(taskCard, left, 0, width, taskHeight);
                SetBoundsIfChanged(profileCard, left, taskHeight + gap, width, profileHeight);
                bottom = taskHeight + gap + profileHeight;
            }

            LayoutCardHeader(taskCard);
            LayoutCardHeader(profileCard);
            bool editorsStacked = taskCard.Width < Dip(680);
            if (editorsStacked)
            {
                int editorWidth = Math.Max(Dip(140), taskCard.Width - Dip(56));
                int editorHeight = Dip(150);
                taskInputLabel.Location = new Point(Dip(28), Dip(78));
                SetBoundsIfChanged(taskInputShell, Dip(28), Dip(106), editorWidth, editorHeight);
                taskRunButton.Location = new Point(Dip(28), Dip(274));
                taskOutputLabel.Location = new Point(Dip(28), Dip(334));
                SetBoundsIfChanged(taskOutputShell, Dip(28), Dip(362), editorWidth,
                    Math.Max(Dip(150), taskCard.Height - Dip(390)));
            }
            else
            {
                int editorWidth = Math.Max(Dip(170), (taskCard.Width - Dip(84)) / 2);
                int outputLeft = Dip(56) + editorWidth;
                int editorHeight = Math.Max(Dip(112), taskCard.Height - Dip(178));
                taskInputLabel.Location = new Point(Dip(28), Dip(78));
                SetBoundsIfChanged(taskInputShell, Dip(28), Dip(106), editorWidth, editorHeight);
                taskOutputLabel.Location = new Point(outputLeft, Dip(78));
                SetBoundsIfChanged(taskOutputShell, outputLeft, Dip(106), editorWidth, editorHeight);
                taskRunButton.Location = new Point(Dip(28), taskCard.Height - Dip(58));
            }

            if (sideBySide)
            {
                SetBoundsIfChanged(profileInput, Dip(28), Dip(78), Math.Max(Dip(120), profileCard.Width - Dip(56)), Dip(42));
                runProfileButton.Location = new Point(Dip(28), Dip(140));
            }
            else
            {
                bool stackProfile = profileCard.Width < Dip(480);
                int inputWidth = stackProfile
                    ? Math.Max(Dip(120), profileCard.Width - Dip(56))
                    : Math.Min(Dip(320), Math.Max(Dip(180), profileCard.Width - Dip(220)));
                SetBoundsIfChanged(profileInput, Dip(28), Dip(77), inputWidth, Dip(42));
                runProfileButton.Location = stackProfile
                    ? new Point(Dip(28), Dip(142))
                    : new Point(Dip(44) + inputWidth, Dip(77));
            }
            tasksPage.AutoScrollMinSize = new Size(0, bottom);
        }

        private void LayoutDiagnostics()
        {
            int left;
            int width;
            GetContentBounds(diagnosticsPage, out left, out width);
            if (width < 1) return;
            diagnosticsActions.WrapContents = true;
            int actionsHeight = FlowLayoutHeight(diagnosticsActions, width - Dip(56), Dip(46));
            int outputTop = Dip(72) + actionsHeight + Dip(14);
            int height = Math.Max(outputTop + Dip(188), diagnosticsPage.ClientSize.Height - Dip(2));
            SetBoundsIfChanged(diagnosticsCard, left, 0, width, height);
            LayoutCardHeader(diagnosticsCard);
            SetBoundsIfChanged(diagnosticsActions, Dip(28), Dip(72), Math.Max(Dip(120), width - Dip(56)), actionsHeight);
            SetBoundsIfChanged(diagnosticsOutput, Dip(28), outputTop, Math.Max(Dip(120), width - Dip(56)),
                Math.Max(Dip(160), height - outputTop - Dip(28)));
            diagnosticsPage.AutoScrollMinSize = new Size(0, height);
        }

        private void LayoutSource()
        {
            int left;
            int width;
            GetContentBounds(sourcePage, out left, out width);
            if (width < 1) return;

            int logTop = Dip(174);
            int height = Math.Max(logTop + Dip(214), sourcePage.ClientSize.Height - Dip(2));
            SetBoundsIfChanged(sourceCard, left, 0, width, height);
            LayoutCardHeader(sourceCard);
            SetBoundsIfChanged(sourcePathLabel, Dip(28), Dip(76), Math.Max(Dip(120), width - Dip(56)), Dip(24));
            buildDshButton.Location = new Point(Dip(28), Dip(112));
            SetBoundsIfChanged(sourceLogShell, Dip(28), logTop, Math.Max(Dip(120), width - Dip(56)),
                Math.Max(Dip(180), height - logTop - Dip(28)));
            sourcePage.AutoScrollMinSize = new Size(0, height);
        }

        private void GetContentBounds(Control page, out int left, out int width)
        {
            width = Math.Min(Dip(1180), Math.Max(1, page.ClientSize.Width));
            left = Math.Max(0, (page.ClientSize.Width - width) / 2);
        }

        private int FlowLayoutHeight(FlowLayoutPanel panel, int availableWidth, int minimumHeight)
        {
            int rowWidth = 0;
            int rowHeight = 0;
            int totalHeight = 0;
            foreach (Control control in panel.Controls)
            {
                if (!control.Visible) continue;
                int itemWidth = control.Width + control.Margin.Horizontal;
                int itemHeight = control.Height + control.Margin.Vertical;
                if (rowWidth > 0 && rowWidth + itemWidth > availableWidth)
                {
                    totalHeight += rowHeight;
                    rowWidth = 0;
                    rowHeight = 0;
                }
                rowWidth += itemWidth;
                rowHeight = Math.Max(rowHeight, itemHeight);
            }
            totalHeight += rowHeight;
            return Math.Max(minimumHeight, totalHeight);
        }

        private void LayoutCardHeader(Control card)
        {
            foreach (Control control in card.Controls)
            {
                Label label = control as Label;
                if (label == null || !(label.Tag is string)) continue;
                string role = (string)label.Tag;
                label.AutoSize = false;
                label.AutoEllipsis = true;
                if (role == "card-title")
                    SetBoundsIfChanged(label, Dip(28), Dip(18), Math.Max(Dip(80), card.Width - Dip(56)), Dip(26));
                else if (role == "card-subtitle")
                    SetBoundsIfChanged(label, Dip(28), Dip(45), Math.Max(Dip(80), card.Width - Dip(56)), Dip(24));
            }
        }

        private static void SetBoundsIfChanged(Control control, int left, int top, int width, int height)
        {
            if (control.Left == left && control.Top == top && control.Width == width && control.Height == height) return;
            control.SetBounds(left, top, width, height);
        }

        internal void RefreshNow()
        {
            if (IsDisposed || !IsHandleCreated) return;
            if (Interlocked.CompareExchange(ref refreshInFlight, 1, 0) != 0)
            {
                Interlocked.Exchange(ref refreshAgain, 1);
                return;
            }

            ThreadPool.QueueUserWorkItem(delegate
            {
                WebStatusSnapshot status = null;
                LoginStartupMode autostartMode = LoginStartupMode.Disabled;
                string dsh = resolvedDsh;
                Exception failure = null;
                try
                {
                    status = runtime.Snapshot();
                    autostartMode = runtime.GetAutostartMode();
                    if (!dshResolved) dsh = runtime.ResolveDsh();
                }
                catch (Exception error) { failure = error; }

                if (IsDisposed || !IsHandleCreated)
                {
                    Interlocked.Exchange(ref refreshInFlight, 0);
                    return;
                }
                try
                {
                    BeginInvoke(new Action(delegate
                    {
                        Interlocked.Exchange(ref refreshInFlight, 0);
                        if (failure == null)
                        {
                            resolvedDsh = dsh;
                            dshResolved = true;
                            ApplyStatus(status, autostartMode, dsh);
                        }
                        else
                        {
                            statusDot.IndicatorColor = UiTheme.Danger;
                            SetLabelText(statusTitle, "状态读取失败");
                            SetLabelText(statusDetail, failure.Message);
                        }
                        if (Interlocked.Exchange(ref refreshAgain, 0) != 0) RefreshNow();
                    }));
                }
                catch (InvalidOperationException) { Interlocked.Exchange(ref refreshInFlight, 0); }
            });
        }

        private void ApplyStatus(WebStatusSnapshot status, LoginStartupMode autostartMode, string dsh)
        {
            if (status.Ownership == WebOwnership.Owned)
            {
                SetLabelText(statusTitle, "Web 已就绪");
                statusDot.IndicatorColor = UiTheme.Success;
            }
            else if (status.Ownership == WebOwnership.Starting)
            {
                SetLabelText(statusTitle, "Web 正在启动");
                statusDot.IndicatorColor = UiTheme.Warning;
            }
            else if (status.Ownership == WebOwnership.External)
            {
                SetLabelText(statusTitle, "检测到外部 Web 服务");
                statusDot.IndicatorColor = UiTheme.Warning;
            }
            else
            {
                SetLabelText(statusTitle, "Web 未运行");
                statusDot.IndicatorColor = Color.FromArgb(120, 137, 160);
            }
            SetLabelText(statusDetail, status.Detail);
            SetLabelText(statusPort, "http://127.0.0.1:" + status.Port.ToString());
            startButton.Enabled = status.Ownership == WebOwnership.Stopped;
            openButton.Enabled = status.Ownership == WebOwnership.Owned || status.Ownership == WebOwnership.External;
            restartButton.Enabled = status.Ownership != WebOwnership.External;
            stopButton.Enabled = status.CanStop;
            portInput.Enabled = status.Ownership == WebOwnership.Stopped;
            SetLabelText(dshPath, dsh ?? "未找到 dsh；请先安装 DeepSeek Harness");
            UpdateSourcePath();
            loadingSettings = true;
            ApplyStartupModeToControls(autostartMode);
            loadingSettings = false;
        }

        private void ChangeAutostartMode(LoginStartupMode selected, bool enabled)
        {
            LoginStartupMode current = runtime.GetAutostartMode();
            LoginStartupMode desired = enabled ? selected
                : current == selected ? LoginStartupMode.Disabled : current;
            OperationResult result = runtime.SetAutostartMode(desired);
            loadingSettings = true;
            ApplyStartupModeToControls(runtime.GetAutostartMode());
            loadingSettings = false;
            ShowToast(result);
        }

        private void ApplyStartupModeToControls(LoginStartupMode mode)
        {
            launcherAutostartToggle.Checked = mode == LoginStartupMode.LauncherOnly;
            dshAutostartToggle.Checked = mode == LoginStartupMode.LauncherAndDsh;
        }

        private static void SetLabelText(Label label, string value)
        {
            if (!String.Equals(label.Text, value, StringComparison.Ordinal)) label.Text = value;
        }

        internal void CaptureTo(string path, string page, string layout)
        {
            captureMode = true;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-20000, -20000);
            bool stressResize = String.Equals(layout, "stress", StringComparison.OrdinalIgnoreCase);
            bool firstShow = String.Equals(layout, "first", StringComparison.OrdinalIgnoreCase);
            bool simulated150 = String.Equals(layout, "scale150", StringComparison.OrdinalIgnoreCase);
            bool simulated200 = String.Equals(layout, "scale200", StringComparison.OrdinalIgnoreCase);
            if (simulated150 || simulated200)
            {
                layoutScaleOverride = simulated200 ? 2f : 1.5f;
                AutoScaleMode = AutoScaleMode.None;
                Scale(new SizeF(layoutScaleOverride, layoutScaleOverride));
                Size = new Size(1366, 720);
            }
            else if (String.Equals(layout, "compact", StringComparison.OrdinalIgnoreCase)) Size = new Size(820, 600);
            else if (String.Equals(layout, "wide", StringComparison.OrdinalIgnoreCase)) Size = new Size(1600, 900);
            Show();
            Application.DoEvents();
            if (firstShow)
            {
                if (overviewActions.Top <= hero.Bottom || settingsCard.Top <= overviewActions.Bottom
                    || pathCard.Top <= settingsCard.Top)
                    throw new InvalidOperationException("The overview page did not complete its first-show layout.");
            }
            if (stressResize)
            {
                Size[] sizes = {
                    new Size(960, 660), new Size(1360, 820), new Size(1040, 700),
                    new Size(1600, 900), new Size(1120, 740),
                };
                for (int index = 0; index < 20; index++)
                {
                    Size = sizes[index % sizes.Length];
                    Application.DoEvents();
                }
                Size = new Size(1120, 740);
                Application.DoEvents();
            }
            if (!firstShow) LayoutResponsivePages();
            if (!firstShow && String.Equals(page, "tasks", StringComparison.OrdinalIgnoreCase))
            {
                ShowPage(tasksPage, tasksNav, "任务与 Profile");
                tasksNav.Focus();
            }
            else if (!firstShow && String.Equals(page, "diagnostics", StringComparison.OrdinalIgnoreCase))
            {
                ShowPage(diagnosticsPage, diagnosticsNav, "日志与诊断");
                diagnosticsNav.Focus();
            }
            else if (!firstShow && String.Equals(page, "source", StringComparison.OrdinalIgnoreCase))
            {
                ShowPage(sourcePage, sourceNav, "DSH 源码");
                sourceNav.Focus();
            }
            else
            {
                if (!firstShow) ShowPage(overviewPage, overviewNav, "概览");
                overviewNav.Focus();
            }
            PerformLayout();
            pageHost.PerformLayout();
            LayoutResponsivePages();
            activePage.PerformLayout();
            ValidateResponsiveLayout();
            Refresh();
            Application.DoEvents();
            Thread.Sleep(160);
            Refresh();
            Application.DoEvents();
            using (Bitmap bitmap = new Bitmap(Width, Height))
            {
                DrawToBitmap(bitmap, new Rectangle(0, 0, Width, Height));
                bitmap.Save(path, ImageFormat.Png);
            }
            refreshTimer.Stop();
            Hide();
        }

        private void ValidateResponsiveLayout()
        {
            if (activePage == overviewPage)
            {
                EnsureContained(overviewActions, startButton, "overview start action");
                EnsureContained(overviewActions, openButton, "overview open action");
                EnsureContained(overviewActions, restartButton, "overview restart action");
                EnsureContained(overviewActions, stopButton, "overview stop action");
                EnsureContained(settingsCard, portInput, "port setting");
                EnsureContained(settingsCard, noOpenToggle, "browser setting");
                EnsureContained(settingsCard, launcherAutostartToggle, "Launcher startup setting");
                EnsureContained(settingsCard, dshAutostartToggle, "DSH startup setting");
                EnsureContained(pathCard, dshPath, "DSH path");
            }
            else if (activePage == tasksPage)
            {
                EnsureContained(taskCard, taskInputShell, "task input");
                EnsureContained(taskCard, taskOutputShell, "task output");
                EnsureContained(taskCard, taskRunButton, "task action");
                EnsureContained(profileCard, profileInput, "profile input");
                EnsureContained(profileCard, runProfileButton, "profile action");
            }
            else if (activePage == diagnosticsPage)
            {
                foreach (Control action in diagnosticsActions.Controls)
                    EnsureContained(diagnosticsActions, action, "diagnostics action");
                EnsureContained(diagnosticsCard, diagnosticsOutput, "diagnostics output");
            }
            else if (activePage == sourcePage)
            {
                EnsureContained(sourceCard, sourcePathLabel, "DSH source path");
                EnsureContained(sourceCard, buildDshButton, "DSH source action");
                EnsureContained(sourceCard, sourceLogShell, "DSH source log");
            }
        }

        private static void EnsureContained(Control parent, Control child, string description)
        {
            if (!child.Visible) return;
            if (child.Left < 0 || child.Top < 0 || child.Right > parent.ClientSize.Width + 1
                || child.Bottom > parent.ClientSize.Height + 1)
                throw new InvalidOperationException("Responsive layout overflow: " + description + ".");
        }

        private void RunOperation(Func<OperationResult> operation)
        {
            SetActionsEnabled(false);
            ThreadPool.QueueUserWorkItem(delegate
            {
                OperationResult result;
                try { result = operation(); }
                catch (Exception error) { result = OperationResult.Fail(error.Message); }
                BeginInvoke(new Action(delegate
                {
                    ShowToast(result);
                    SetActionsEnabled(true);
                }));
            });
        }

        private void RunHeadless()
        {
            string task = taskInput.Text;
            taskRunButton.Enabled = false;
            taskOutput.Text = "任务运行中…";
            ThreadPool.QueueUserWorkItem(delegate
            {
                string output;
                OperationResult result = runtime.RunHeadless(task, out output);
                BeginInvoke(new Action(delegate
                {
                    taskRunButton.Enabled = true;
                    taskOutput.Text = String.IsNullOrWhiteSpace(output) ? result.Message : output.Trim();
                    ShowToast(result);
                }));
            });
        }

        private void RunDoctor()
        {
            diagnosticsOutput.Text = "正在检查 DSH 环境…";
            ThreadPool.QueueUserWorkItem(delegate
            {
                string output;
                OperationResult result = runtime.RunDoctor(out output);
                BeginInvoke(new Action(delegate
                {
                    diagnosticsOutput.Text = output;
                    ShowToast(result);
                }));
            });
        }

        private void RunDshBuild()
        {
            string source = runtime.ResolveDshSource();
            if (source == null)
            {
                ShowToast(OperationResult.Fail("未配置有效的 DSH 源码目录；请通过本地 checkout 重新运行安装脚本。"));
                return;
            }
            bool updateSource = runtime.IsGitAvailable();
            string confirmation = updateSource
                ? "即将依次执行：" + Environment.NewLine + Environment.NewLine
                    + "1. git pull --ff-only" + Environment.NewLine
                    + "2. pnpm run build" + Environment.NewLine + Environment.NewLine
                    + "源码目录：" + source + Environment.NewLine + Environment.NewLine
                    + "如果存在无法快进的提交或冲突，流程会停止，不会继续构建。确定运行吗？"
                : "未检测到 Git，无法拉取最新源码。" + Environment.NewLine + Environment.NewLine
                    + "本次将跳过源码更新，仅执行 pnpm run build。" + Environment.NewLine + Environment.NewLine
                    + "源码目录：" + source + Environment.NewLine + Environment.NewLine
                    + "确定继续吗？";
            DialogResult confirmed = MessageBox.Show(this, confirmation, "更新并构建 DSH",
                MessageBoxButtons.YesNo, updateSource ? MessageBoxIcon.Question : MessageBoxIcon.Warning,
                MessageBoxDefaultButton.Button2);
            if (confirmed != DialogResult.Yes)
            {
                ShowToast(OperationResult.Ok("已取消 DSH 源码操作。"));
                return;
            }
            if (Interlocked.CompareExchange(ref buildInProgress, 1, 0) != 0) return;
            buildDshButton.Enabled = false;
            sourceOutput.Text = (updateSource ? "正在拉取最新 DSH 源码并构建…" : "未检测到 Git，正在仅构建 DSH 源码…")
                + Environment.NewLine + "源码目录: " + source + Environment.NewLine
                + "日志将自动刷新，无需离开当前页面。";
            sourceOutput.SelectionStart = sourceOutput.TextLength;
            sourceOutput.ScrollToCaret();
            ShowToast(OperationResult.Ok(updateSource ? "DSH 源码更新与构建已开始。" : "DSH 源码构建已开始（已跳过 Git 更新）。"));
            ThreadPool.QueueUserWorkItem(delegate
            {
                string output;
                OperationResult result;
                try { result = runtime.BuildDshSource(updateSource, out output); }
                catch (Exception error)
                {
                    output = error.ToString();
                    result = OperationResult.Fail("DSH 源码更新或构建失败：" + error.Message);
                }
                Interlocked.Exchange(ref buildInProgress, 0);
                if (IsDisposed || !IsHandleCreated) return;
                try
                {
                    BeginInvoke(new Action(delegate
                    {
                        sourceOutput.Text = String.IsNullOrWhiteSpace(output) ? result.Message : output.Trim();
                        sourceOutput.SelectionStart = sourceOutput.TextLength;
                        sourceOutput.ScrollToCaret();
                        buildDshButton.Enabled = runtime.ResolveDshSource() != null;
                        ShowToast(result);
                    }));
                }
                catch (InvalidOperationException) { }
            });
        }

        private void UpdateSourcePath()
        {
            string source = runtime.ResolveDshSource();
            sourcePathLabel.Text = "源码目录：" + (source ?? "未配置有效的本地 DSH checkout");
            buildDshButton.Enabled = Interlocked.CompareExchange(ref buildInProgress, 0, 0) == 0 && source != null;
        }

        private void RefreshSourceLog(bool followTail)
        {
            string log = runtime.DshSourceBuildLog();
            if (String.Equals(sourceOutput.Text, log, StringComparison.Ordinal)) return;
            sourceOutput.Text = log;
            if (followTail)
            {
                sourceOutput.SelectionStart = sourceOutput.TextLength;
                sourceOutput.ScrollToCaret();
            }
        }

        private void SetActionsEnabled(bool enabled)
        {
            if (!enabled)
            {
                startButton.Enabled = false;
                openButton.Enabled = false;
                restartButton.Enabled = false;
                stopButton.Enabled = false;
            }
            else RefreshNow();
        }

        internal void SetStopAndExitState(bool inProgress, OperationResult result)
        {
            SetActionsEnabled(!inProgress);
            ShowToast(result);
        }

        private void ShowToast(OperationResult result)
        {
            toast.Text = (result.Success ? "●  " : "▲  ") + result.Message;
            toast.ForeColor = result.Success ? UiTheme.Success : UiTheme.Danger;
        }

        private void ShowPage(Panel page, NavButton nav, string title)
        {
            activePage = page;
            overviewPage.Visible = page == overviewPage;
            tasksPage.Visible = page == tasksPage;
            diagnosticsPage.Visible = page == diagnosticsPage;
            sourcePage.Visible = page == sourcePage;
            overviewNav.Selected = nav == overviewNav;
            tasksNav.Selected = nav == tasksNav;
            diagnosticsNav.Selected = nav == diagnosticsNav;
            sourceNav.Selected = nav == sourceNav;
            page.BringToFront();
            pageTitle.Text = title;
            if (page == overviewPage) pageSubtitle.Text = "本机 DSH 服务与任务控制中心";
            else if (page == tasksPage) pageSubtitle.Text = "安全运行单次任务或启动独立 Profile";
            else if (page == diagnosticsPage) pageSubtitle.Text = "查看运行记录并检查本机环境";
            else pageSubtitle.Text = "拉取最新代码并构建安装时确认的本地 checkout";
            if (page == diagnosticsPage) diagnosticsOutput.Text = runtime.RecentLogs();
            if (page == sourcePage)
            {
                UpdateSourcePath();
                RefreshSourceLog(true);
            }
            LayoutResponsivePages();
        }

        private static void AddCardTitle(Control parent, string title, string subtitle)
        {
            Label heading = NewLabel(title, 11f, FontStyle.Bold, UiTheme.Text);
            heading.Tag = "card-title";
            heading.Location = new Point(28, 20);
            parent.Controls.Add(heading);
            Label detail = NewLabel(subtitle, 8.8f, FontStyle.Regular, UiTheme.Muted);
            detail.Tag = "card-subtitle";
            detail.Location = new Point(28, 47);
            parent.Controls.Add(detail);
        }

        private static Label NewLabel(string text, float size, FontStyle style, Color color)
        {
            Label label = new Label();
            label.AutoSize = true;
            label.Text = text;
            label.Font = UiTheme.Font(size, style);
            label.ForeColor = color;
            label.BackColor = Color.Transparent;
            return label;
        }

        private static RoundedPanel NewEditorShell()
        {
            RoundedPanel shell = new RoundedPanel();
            shell.Radius = 12;
            shell.BackColor = Color.FromArgb(242, 245, 251);
            shell.BorderColor = UiTheme.BorderStrong;
            shell.Padding = new Padding(12);
            return shell;
        }

        private static ModernButton NewButton(string text, ModernButtonKind kind, int width)
        {
            ModernButton button = new ModernButton();
            button.Text = text;
            button.Kind = kind;
            button.Width = width;
            button.Margin = new Padding(0, 0, 12, 8);
            return button;
        }

        private static NavButton NewNav(string text, int top, NavGlyph glyph)
        {
            NavButton button = new NavButton();
            button.Text = text;
            button.Location = new Point(0, top);
            button.Width = 224;
            button.Glyph = glyph;
            return button;
        }

    }

    internal static class LauncherIcon
    {
        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        private static extern bool DestroyIcon(IntPtr handle);

        internal static Icon Create()
        {
            try
            {
                Icon associated = Icon.ExtractAssociatedIcon(Application.ExecutablePath);
                if (associated != null)
                {
                    Icon clone = (Icon)associated.Clone();
                    associated.Dispose();
                    return clone;
                }
            }
            catch { }

            using (Bitmap bitmap = new Bitmap(64, 64))
            using (Graphics graphics = Graphics.FromImage(bitmap))
            {
                WhaleGlyph.DrawBadge(graphics, new RectangleF(2f, 2f, 60f, 60f));
                IntPtr handle = bitmap.GetHicon();
                try { return (Icon)Icon.FromHandle(handle).Clone(); }
                finally { DestroyIcon(handle); }
            }
        }
    }
}
