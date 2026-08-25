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
                WebStatusSnapshot status;
                if (action == "start") result = runtime.StartWeb();
                else if (action == "stop") result = runtime.StopWeb();
                else if (action == "restart") result = runtime.RestartWeb();
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
                });
                return result.Success ? 0 : 1;
            }

            if (args.Length >= 2 && String.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                string baseDirectory = AppDomain.CurrentDomain.BaseDirectory;
                bool complete = File.Exists(Path.Combine(baseDirectory, "DSH-Launcher.Command.ps1"))
                    && File.Exists(Path.Combine(baseDirectory, "DSH-Launcher.Supervisor.ps1"));
                File.WriteAllText(args[1], complete ? "SELF_TEST_OK" : "SELF_TEST_INCOMPLETE", new UTF8Encoding(false));
                return complete ? 0 : 1;
            }

            if (args.Length >= 2 && String.Equals(args[0], "--screenshot", StringComparison.OrdinalIgnoreCase))
            {
                using (Icon icon = LauncherIcon.Create())
                using (MainForm form = new MainForm(new LauncherRuntime(), icon, delegate { }))
                {
                    form.CaptureTo(args[1], args.Length >= 3 ? args[2] : "overview",
                        args.Length >= 4 ? args[3] : "normal");
                }
                return 0;
            }

            if (args.Length >= 1 && String.Equals(args[0], "--ui-preview", StringComparison.OrdinalIgnoreCase))
            {
                using (Icon icon = LauncherIcon.Create())
                using (MainForm form = new MainForm(new LauncherRuntime(), icon, Application.Exit))
                    Application.Run(form);
                return 0;
            }

            bool created;
            using (Mutex mutex = new Mutex(true, MutexName, out created))
            {
                if (!created)
                {
                    SignalEvent(ShowEventName);
                    return 0;
                }
                bool startHidden = args.Length >= 1 && String.Equals(args[0], "--tray", StringComparison.OrdinalIgnoreCase);
                Application.Run(new LauncherApplicationContext(startHidden));
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
        private readonly System.Windows.Forms.Timer signalTimer;
        private bool exiting;

        internal LauncherApplicationContext(bool startHidden)
        {
            runtime = new LauncherRuntime();
            icon = LauncherIcon.Create();
            form = new MainForm(runtime, icon, ExitLauncher);
            form.FormClosing += OnFormClosing;

            tray = new NotifyIcon();
            tray.Icon = icon;
            tray.Text = "DeepSeek Harness Launcher";
            tray.Visible = true;
            tray.ContextMenuStrip = BuildTrayMenu();
            tray.DoubleClick += delegate { ShowWindow(); };

            showSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShowEventName);
            shutdownSignal = new EventWaitHandle(false, EventResetMode.AutoReset, Program.ShutdownEventName);
            signalTimer = new System.Windows.Forms.Timer();
            signalTimer.Interval = 250;
            signalTimer.Tick += delegate
            {
                if (showSignal.WaitOne(0)) ShowWindow();
                if (shutdownSignal.WaitOne(0)) ExitLauncher();
            };
            signalTimer.Start();

            if (!startHidden) ShowWindow();
            else tray.ShowBalloonTip(1800, "DeepSeek Harness", "Launcher 已在托盘就绪。", ToolTipIcon.Info);
        }

        private ContextMenuStrip BuildTrayMenu()
        {
            ContextMenuStrip menu = new ContextMenuStrip();
            menu.Font = UiTheme.Font(9.5f, FontStyle.Regular);
            menu.Items.Add("打开控制中心", null, delegate { ShowWindow(); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("启动 Web", null, delegate { RunTrayOperation(runtime.StartWeb); });
            menu.Items.Add("打开 Web 页面", null, delegate { RunTrayOperation(runtime.OpenWeb); });
            menu.Items.Add("重启 Web", null, delegate { RunTrayOperation(runtime.RestartWeb); });
            menu.Items.Add("停止 Web", null, delegate { RunTrayOperation(runtime.StopWeb); });
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("打开日志目录", null, delegate { runtime.OpenLogFolder(); });
            ToolStripMenuItem autostart = new ToolStripMenuItem("登录时启动 Launcher");
            autostart.Click += delegate { RunTrayOperation(delegate { return runtime.SetAutostart(!runtime.IsAutostartEnabled()); }); };
            menu.Items.Add(autostart);
            menu.Opening += delegate
            {
                autostart.Checked = runtime.IsAutostartEnabled();
                WebStatusSnapshot status = runtime.Snapshot();
                menu.Items[2].Enabled = status.Ownership == WebOwnership.Stopped;
                menu.Items[3].Enabled = status.Ownership == WebOwnership.Owned || status.Ownership == WebOwnership.External;
                menu.Items[4].Enabled = status.Ownership != WebOwnership.External;
                menu.Items[5].Enabled = status.CanStop;
            };
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("退出 Launcher", null, delegate { ExitLauncher(); });
            return menu;
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
            tray.Visible = false;
            tray.Dispose();
            showSignal.Dispose();
            shutdownSignal.Dispose();
            form.Close();
            icon.Dispose();
            ExitThread();
        }
    }

    internal sealed class MainForm : Form
    {
        private readonly LauncherRuntime runtime;
        private readonly Action exitLauncher;
        private readonly Panel pageHost;
        private readonly Panel header;
        private readonly Panel overviewPage;
        private readonly Panel tasksPage;
        private readonly Panel diagnosticsPage;
        private NavButton overviewNav;
        private NavButton tasksNav;
        private NavButton diagnosticsNav;
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
        private readonly ToggleSwitch autostartToggle;
        private readonly RichTextBox taskInput;
        private readonly RichTextBox taskOutput;
        private readonly ModernButton taskRunButton;
        private readonly ComboBox profileInput;
        private Label taskInputLabel;
        private Label taskOutputLabel;
        private RoundedPanel taskInputShell;
        private RoundedPanel taskOutputShell;
        private readonly RichTextBox diagnosticsOutput;
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
        private Label autoLabel;
        private RoundedPanel taskCard;
        private RoundedPanel profileCard;
        private ModernButton runProfileButton;
        private RoundedPanel diagnosticsCard;
        private FlowLayoutPanel diagnosticsActions;
        private Panel activePage;
        private bool loadingSettings;
        private bool layoutPending;
        private bool dshResolved;
        private string resolvedDsh;
        private int refreshInFlight;
        private int refreshAgain;

        internal MainForm(LauncherRuntime runtime, Icon icon, Action exitLauncher)
        {
            this.runtime = runtime;
            this.exitLauncher = exitLauncher;
            SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                | ControlStyles.ResizeRedraw, true);
            UpdateStyles();
            Text = "DeepSeek Harness Launcher";
            Icon = (Icon)icon.Clone();
            BackColor = UiTheme.Background;
            Font = UiTheme.Font(9.5f, FontStyle.Regular);
            AutoScaleMode = AutoScaleMode.Dpi;
            StartPosition = FormStartPosition.CenterScreen;
            Size = new Size(1120, 740);
            MinimumSize = new Size(960, 660);

            Panel sidebar = BuildSidebar();
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
            pageHost.Controls.Add(overviewPage);
            pageHost.Controls.Add(tasksPage);
            pageHost.Controls.Add(diagnosticsPage);

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
            autostartToggle = new ToggleSwitch();
            BuildOverviewPage();

            taskInput = new RichTextBox();
            taskOutput = new RichTextBox();
            taskRunButton = NewButton("运行 Headless", ModernButtonKind.Primary, 144);
            profileInput = new ComboBox();
            BuildTasksPage();

            diagnosticsOutput = new RichTextBox();
            BuildDiagnosticsPage();

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
            autostartToggle.CheckedChanged += delegate
            {
                if (loadingSettings) return;
                OperationResult result = runtime.SetAutostart(autostartToggle.Checked);
                ShowToast(result);
            };

            loadingSettings = true;
            portInput.Value = runtime.Settings.Port;
            noOpenToggle.Checked = runtime.Settings.NoOpen;
            autostartToggle.Checked = runtime.IsAutostartEnabled();
            loadingSettings = false;

            refreshTimer = new System.Windows.Forms.Timer();
            refreshTimer.Interval = 2000;
            refreshTimer.Tick += delegate { RefreshNow(); };
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

        private Panel BuildSidebar()
        {
            Panel sidebar = new Panel();
            sidebar.Dock = DockStyle.Left;
            sidebar.Width = 224;
            sidebar.BackColor = UiTheme.Sidebar;

            BrandMark mark = new BrandMark();
            mark.Location = new Point(24, 26);
            sidebar.Controls.Add(mark);
            Label name = new Label();
            name.AutoSize = true;
            name.Text = "DeepSeek Harness";
            name.Font = UiTheme.Font(10.2f, FontStyle.Bold);
            name.ForeColor = Color.White;
            name.Location = new Point(82, 30);
            sidebar.Controls.Add(name);
            Label edition = new Label();
            edition.AutoSize = true;
            edition.Text = "WINDOWS LAUNCHER";
            edition.Font = UiTheme.Font(7.2f, FontStyle.Bold);
            edition.ForeColor = Color.FromArgb(126, 148, 185);
            edition.Location = new Point(82, 55);
            sidebar.Controls.Add(edition);

            overviewNav = NewNav("概览", 122, NavGlyph.Overview);
            tasksNav = NewNav("任务与 Profile", 172, NavGlyph.Tasks);
            diagnosticsNav = NewNav("日志与诊断", 222, NavGlyph.Diagnostics);
            sidebar.Controls.Add(overviewNav);
            sidebar.Controls.Add(tasksNav);
            sidebar.Controls.Add(diagnosticsNav);
            overviewNav.Click += delegate { ShowPage(overviewPage, overviewNav, "概览"); };
            tasksNav.Click += delegate { ShowPage(tasksPage, tasksNav, "任务与 Profile"); };
            diagnosticsNav.Click += delegate { ShowPage(diagnosticsPage, diagnosticsNav, "日志与诊断"); };

            Label version = new Label();
            version.Text = "LOCAL COMPANION  ·  v0.1.0";
            version.ForeColor = Color.FromArgb(115, 134, 165);
            version.Font = UiTheme.Font(7.4f, FontStyle.Regular);
            version.AutoSize = true;
            sidebar.Controls.Add(version);
            ModernButton exit = NewButton("退出 Launcher", ModernButtonKind.Quiet, 176);
            exit.Click += delegate { exitLauncher(); };
            sidebar.Controls.Add(exit);
            EventHandler layoutFooter = delegate
            {
                exit.Location = new Point(24, Math.Max(320, sidebar.ClientSize.Height - 128));
                version.Location = new Point(24, Math.Max(378, sidebar.ClientSize.Height - 65));
            };
            sidebar.SizeChanged += layoutFooter;
            layoutFooter(sidebar, EventArgs.Empty);
            return sidebar;
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
            settingsCard.Size = new Size(780, 158);
            overviewPage.Controls.Add(settingsCard);
            AddCardTitle(settingsCard, "启动选项", "调用官方 dsh web，不修改 profile 配置");

            portLabel = NewLabel("服务端口", 9f, FontStyle.Regular, UiTheme.Muted);
            settingsCard.Controls.Add(portLabel);
            portInput.Size = new Size(118, 40);
            portInput.Minimum = 1;
            portInput.Maximum = 65535;
            portInput.Font = UiTheme.Font(10f, FontStyle.Regular);
            settingsCard.Controls.Add(portInput);

            browserLabel = NewLabel("启动后不自动打开浏览器", 9f, FontStyle.Regular, UiTheme.Muted);
            settingsCard.Controls.Add(browserLabel);
            settingsCard.Controls.Add(noOpenToggle);

            autoLabel = NewLabel("登录时启动托盘", 9f, FontStyle.Regular, UiTheme.Muted);
            settingsCard.Controls.Add(autoLabel);
            settingsCard.Controls.Add(autostartToggle);

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
            profileInput.DropDownStyle = ComboBoxStyle.DropDown;
            profileInput.Font = UiTheme.Font(10f, FontStyle.Regular);
            profileInput.Items.AddRange(runtime.Profiles());
            if (profileInput.Items.Count > 0) profileInput.SelectedIndex = 0;
            profileCard.Controls.Add(profileInput);
            runProfileButton = NewButton("启动 Profile", ModernButtonKind.Secondary, 132);
            runProfileButton.Click += delegate { ShowToast(runtime.RunProfile(profileInput.Text)); };
            profileCard.Controls.Add(runProfileButton);
        }

        private void BuildDiagnosticsPage()
        {
            diagnosticsCard = new RoundedPanel();
            diagnosticsPage.Controls.Add(diagnosticsCard);
            AddCardTitle(diagnosticsCard, "日志与环境诊断", "诊断不会启动、停止或接管现有 DSH 服务");
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

        private void LayoutResponsivePages()
        {
            if (overviewPage == null || overviewActions == null) return;
            LayoutHeader();
            // Control.Visible is false while an ancestor form is hidden, even when this is the
            // selected page. Track the selection explicitly so the first layout can run before Show().
            if (activePage == overviewPage) LayoutOverview();
            else if (activePage == tasksPage) LayoutTasks();
            else if (activePage == diagnosticsPage) LayoutDiagnostics();
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

        private void LayoutOverview()
        {
            int left;
            int width;
            GetContentBounds(overviewPage, out left, out width);
            if (width < 1) return;

            SetBoundsIfChanged(hero, left, 0, width, 154);
            privacyLabel.Location = new Point(Math.Max(31, width - privacyLabel.PreferredSize.Width - 31), 28);
            shieldLabel.Location = new Point(Math.Max(31, width - shieldLabel.PreferredSize.Width - 31), 109);

            SetBoundsIfChanged(overviewActions, left, 170, width, 48);
            int cardsTop = 230;
            bool sideBySide = width >= 1020;
            int bottom;
            if (sideBySide)
            {
                int settingsWidth = Math.Max(680, (int)Math.Round(width * 0.64));
                SetBoundsIfChanged(settingsCard, left, cardsTop, settingsWidth, 168);
                SetBoundsIfChanged(pathCard, left + settingsWidth + 18, cardsTop, width - settingsWidth - 18, 168);
                bottom = cardsTop + 168;
            }
            else
            {
                SetBoundsIfChanged(settingsCard, left, cardsTop, width, 168);
                SetBoundsIfChanged(pathCard, left, cardsTop + 186, width, 112);
                bottom = cardsTop + 298;
            }

            int available = Math.Max(360, settingsCard.Width - 56);
            int column = available / 3;
            LayoutSetting(portLabel, portInput, 28, column);
            LayoutSetting(browserLabel, noOpenToggle, 28 + column, column);
            LayoutSetting(autoLabel, autostartToggle, 28 + (column * 2), column);

            SetBoundsIfChanged(dshPath, 28, 86, Math.Max(80, pathCard.Width - 56), 24);
            overviewPage.AutoScrollMinSize = new Size(0, bottom + 16);
        }

        private static void LayoutSetting(Label label, Control control, int left, int columnWidth)
        {
            label.Location = new Point(left, 78);
            control.Location = new Point(left, 107);
            if (control is PortField) control.Width = Math.Min(118, Math.Max(92, columnWidth - 18));
        }

        private void LayoutTasks()
        {
            int left;
            int width;
            GetContentBounds(tasksPage, out left, out width);
            if (width < 1) return;

            bool sideBySide = width >= 1000;
            int bottom;
            if (sideBySide)
            {
                int taskWidth = (int)Math.Round((width - 18) * 0.66);
                int cardHeight = Math.Min(450, Math.Max(390, tasksPage.ClientSize.Height - 80));
                SetBoundsIfChanged(taskCard, left, 0, taskWidth, cardHeight);
                SetBoundsIfChanged(profileCard, left + taskWidth + 18, 0, width - taskWidth - 18, 212);
                bottom = cardHeight;
            }
            else
            {
                SetBoundsIfChanged(taskCard, left, 0, width, 344);
                SetBoundsIfChanged(profileCard, left, 362, width, 154);
                bottom = 516;
            }

            int editorWidth = Math.Max(170, (taskCard.Width - 84) / 2);
            int outputLeft = 56 + editorWidth;
            int editorHeight = Math.Max(112, taskCard.Height - 178);
            taskInputLabel.Location = new Point(28, 78);
            SetBoundsIfChanged(taskInputShell, 28, 106, editorWidth, editorHeight);
            taskOutputLabel.Location = new Point(outputLeft, 78);
            SetBoundsIfChanged(taskOutputShell, outputLeft, 106, editorWidth, editorHeight);
            taskRunButton.Location = new Point(28, taskCard.Height - 58);

            if (sideBySide)
            {
                SetBoundsIfChanged(profileInput, 28, 82, Math.Max(120, profileCard.Width - 56), 30);
                runProfileButton.Location = new Point(28, 134);
            }
            else
            {
                int inputWidth = Math.Min(320, Math.Max(180, profileCard.Width - 220));
                SetBoundsIfChanged(profileInput, 28, 82, inputWidth, 30);
                runProfileButton.Location = new Point(44 + inputWidth, 77);
            }
            tasksPage.AutoScrollMinSize = new Size(0, bottom);
        }

        private void LayoutDiagnostics()
        {
            int left;
            int width;
            GetContentBounds(diagnosticsPage, out left, out width);
            if (width < 1) return;
            int height = Math.Max(360, diagnosticsPage.ClientSize.Height - 2);
            SetBoundsIfChanged(diagnosticsCard, left, 0, width, height);
            SetBoundsIfChanged(diagnosticsActions, 28, 72, Math.Max(180, width - 56), 46);
            SetBoundsIfChanged(diagnosticsOutput, 28, 132, Math.Max(180, width - 56), Math.Max(160, height - 160));
        }

        private static void GetContentBounds(Control page, out int left, out int width)
        {
            width = Math.Min(1180, Math.Max(1, page.ClientSize.Width));
            left = Math.Max(0, (page.ClientSize.Width - width) / 2);
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
                bool autostart = false;
                string dsh = resolvedDsh;
                Exception failure = null;
                try
                {
                    status = runtime.Snapshot();
                    autostart = runtime.IsAutostartEnabled();
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
                            ApplyStatus(status, autostart, dsh);
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

        private void ApplyStatus(WebStatusSnapshot status, bool autostart, string dsh)
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
            loadingSettings = true;
            autostartToggle.Checked = autostart;
            loadingSettings = false;
        }

        private static void SetLabelText(Label label, string value)
        {
            if (!String.Equals(label.Text, value, StringComparison.Ordinal)) label.Text = value;
        }

        internal void CaptureTo(string path, string page, string layout)
        {
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-20000, -20000);
            bool stressResize = String.Equals(layout, "stress", StringComparison.OrdinalIgnoreCase);
            bool firstShow = String.Equals(layout, "first", StringComparison.OrdinalIgnoreCase);
            if (String.Equals(layout, "wide", StringComparison.OrdinalIgnoreCase)) Size = new Size(1600, 900);
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
            else
            {
                if (!firstShow) ShowPage(overviewPage, overviewNav, "概览");
                overviewNav.Focus();
            }
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
            overviewNav.Selected = nav == overviewNav;
            tasksNav.Selected = nav == tasksNav;
            diagnosticsNav.Selected = nav == diagnosticsNav;
            page.BringToFront();
            pageTitle.Text = title;
            if (page == overviewPage) pageSubtitle.Text = "本机 DSH 服务与任务控制中心";
            else if (page == tasksPage) pageSubtitle.Text = "安全运行单次任务或启动独立 Profile";
            else pageSubtitle.Text = "查看运行记录并检查本机环境";
            if (page == diagnosticsPage) diagnosticsOutput.Text = runtime.RecentLogs();
            LayoutResponsivePages();
        }

        private static void AddCardTitle(Control parent, string title, string subtitle)
        {
            Label heading = NewLabel(title, 11f, FontStyle.Bold, UiTheme.Text);
            heading.Location = new Point(28, 20);
            parent.Controls.Add(heading);
            Label detail = NewLabel(subtitle, 8.8f, FontStyle.Regular, UiTheme.Muted);
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
            button.Margin = new Padding(0, 0, 12, 0);
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
