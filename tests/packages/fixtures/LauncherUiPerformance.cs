using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Windows.Forms;
using DshEnhanced.WindowsLauncher;

internal static class LauncherUiPerformanceTest
{
    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            Console.OutputEncoding = System.Text.Encoding.UTF8;
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            LauncherPaths.Ensure();
            if (args.Length == 0)
            {
                VerifyButtonTextRepaint();
                VerifyLogTail();
                VerifyLauncherLogSession();
            }
            using (Icon icon = LauncherIcon.Create())
            using (MainForm form = new MainForm(new LauncherRuntime(), icon))
                form.MeasureUi(args.Length > 0 && args[0] == "--measure");
            if (args.Length == 0)
                foreach (string page in new[] { "overview", "tasks", "diagnostics", "source", "plugins" })
                    foreach (string layout in page == "plugins"
                        ? new[] { "normal", "compact", "wide", "scale150", "pluginstress" }
                        : new[] { "normal", "compact", "wide", "scale150" })
                        using (Icon icon = LauncherIcon.Create())
                        using (MainForm form = new MainForm(new LauncherRuntime(), icon))
                            form.CaptureUiFixture(page, layout);
            Console.WriteLine("UI_PERFORMANCE_OK");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }

    private static void VerifyButtonTextRepaint()
    {
        using (ModernButton button = new ModernButton { Text = "启动 Web", Size = new Size(116, 42) })
        {
            button.CreateControl();
            if (!button.IsHandleCreated) throw new Exception("Button must have a native handle.");
            int invalidations = 0;
            button.Invalidated += delegate { invalidations++; };
            foreach (bool enabled in new[] { true, false })
            {
                button.Enabled = enabled;
                foreach (string label in new[] { "启动桌面端", "启动 Web" })
                {
                    // Observe the control's repaint request before any Update,
                    // DrawToBitmap, resize, hover, or scroll can hide the bug.
                    // An offscreen HWND can have an empty OS update region.
                    invalidations = 0;
                    button.Text = label;
                    if (invalidations == 0)
                        throw new Exception("Changing a button label must request repaint without scrolling: " + label);
                    invalidations = 0;
                    button.Text = label;
                    if (invalidations != 0)
                        throw new Exception("An unchanged button label must not request another repaint.");
                }
            }
        }
        Console.WriteLine("BUTTON_TEXT_REPAINT_OK");
    }

    private sealed class CountingStream : MemoryStream
    {
        internal int BytesRead;
        internal CountingStream(string text) : base(System.Text.Encoding.UTF8.GetBytes(text)) { }
        public override int Read(byte[] buffer, int offset, int count)
        {
            int read = base.Read(buffer, offset, count);
            BytesRead += read;
            return read;
        }
    }

    private static void VerifyLauncherLogSession()
    {
        File.WriteAllText(LauncherPaths.LauncherLog, "PREVIOUS_LAUNCHER_RUN");
        LauncherLog.BeginSession();
        LauncherLog.Write("CURRENT_FIRST");
        LauncherLog.Write("CURRENT_SECOND");
        string current = File.ReadAllText(LauncherPaths.LauncherLog);
        if (current.Contains("PREVIOUS_LAUNCHER_RUN") || !current.Contains("CURRENT_FIRST") || !current.Contains("CURRENT_SECOND"))
            throw new Exception("A Launcher session must replace older sessions and retain all current entries.");
        LauncherLog.BeginSession();
        LauncherLog.Write("NEXT_LAUNCHER_RUN");
        string next = File.ReadAllText(LauncherPaths.LauncherLog);
        if (next.Contains("CURRENT_") || !next.Contains("NEXT_LAUNCHER_RUN"))
            throw new Exception("Restarting Launcher must replace the preceding session log.");
    }

    private static void VerifyLogTail()
    {
        using (CountingStream stream = new CountingStream("\ufeffold\r\n\r\n中文\r\u001b[31merror\u001b[0m"))
        {
            string tail = LauncherRuntime.ReadLogTail(stream, 2);
            if (tail != "中文" + Environment.NewLine + "error" || !stream.CanRead)
                throw new Exception("Log tail must preserve UTF-8/newlines, strip ANSI, and leave the stream open.");
        }
        using (CountingStream stream = new CountingStream(new string('x', 4 * 1024 * 1024) + "\n中文\r\nlatest\r\n"))
        {
            string tail = LauncherRuntime.ReadLogTail(stream, 2);
            if (tail != "中文" + Environment.NewLine + "latest" || stream.BytesRead > 256 * 1024)
                throw new Exception("Large logs must read only the bounded suffix and include the latest line.");
        }
        foreach (string ending in new[] { "", "\n", "\r\n" })
            using (CountingStream stream = new CountingStream(new string('中', 200000) + "结尾" + ending))
            {
                string tail = LauncherRuntime.ReadLogTail(stream, 1);
                if (!tail.EndsWith("结尾") || tail.Contains("\ufffd") || stream.BytesRead > 256 * 1024)
                    throw new Exception("A long line must retain its UTF-8 suffix without reading the whole log.");
            }
        using (CountingStream stream = new CountingStream(""))
            if (LauncherRuntime.ReadLogTail(stream, 3) != "") throw new Exception("Empty log must remain empty.");
    }
}

namespace DshEnhanced.WindowsLauncher
{
    internal sealed partial class MainForm
    {
        private sealed class UiWorkCounter
        {
            internal int Layouts;
            internal int Resizes;
            internal int Paints;
            internal int Invalidations;

            internal UiWorkCounter(Control root)
            {
                foreach (Control control in ControlTree(root))
                {
                    control.Layout += delegate { Layouts++; };
                    control.SizeChanged += delegate { Resizes++; };
                    control.Paint += delegate { Paints++; };
                    control.Invalidated += delegate { Invalidations++; };
                }
            }

            internal void Reset() { Layouts = Resizes = Paints = Invalidations = 0; }
        }

        private static IEnumerable<Control> ControlTree(Control root)
        {
            yield return root;
            foreach (Control child in root.Controls)
                foreach (Control control in ControlTree(child)) yield return control;
        }

        private static void RequireUi(bool condition, string message)
        {
            if (!condition) throw new InvalidOperationException(message);
        }

        private static void MeasureWork(string name, UiWorkCounter counter, int count, Action<int> action)
        {
            counter.Reset();
            List<double> samples = new List<double>();
            for (int index = 0; index < count; index++)
            {
                Stopwatch watch = Stopwatch.StartNew();
                action(index);
                Application.DoEvents();
                samples.Add(watch.Elapsed.TotalMilliseconds);
            }
            samples.Sort();
            Console.WriteLine("{0}: median={1:F2}ms p95={2:F2}ms layouts={3} resizes={4} paints={5} invalidations={6}",
                name, samples[count / 2], samples[Math.Min(count - 1, (int)(count * .95))],
                counter.Layouts, counter.Resizes, counter.Paints, counter.Invalidations);
        }

        internal void MeasureUi(bool measureOnly)
        {
            captureMode = true;
            inspectRequested = 0;
            dshResolved = true;
            resolvedDsh = "fixture";
            pluginOperationHistoryLoaded = true;
            StartPosition = FormStartPosition.Manual;
            Location = new Point(-20000, -20000);
            ShowInTaskbar = false;
            Size = new Size(1120, 740);
            Show();
            refreshTimer.Stop();
            DateTime deadline = DateTime.UtcNow.AddSeconds(5);
            do
            {
                Application.DoEvents();
                System.Threading.Thread.Sleep(10);
            } while ((refreshInFlight != 0 || refreshAgain != 0) && DateTime.UtcNow < deadline);
            RequireUi(refreshInFlight == 0 && refreshAgain == 0, "Initial status refresh did not settle.");
            ApplyPluginSnapshot(UiFixtureSnapshot());
            ShowPage(pluginPage, pluginNav, "插件管理");
            Application.DoEvents();
            UiWorkCounter counter = new UiWorkCounter(this);

            MeasureWork("idle-layout", counter, 20, delegate { LayoutResponsivePages(); });
            if (!measureOnly) RequireUi(counter.Resizes == 0, "Unchanged layout must not resize controls.");
            MeasureWork("plugin-scroll", counter, 40, index => pluginPage.ScrollBy(index < 20 ? 24 : -24));
            if (!measureOnly) RequireUi(counter.Layouts == 0, "Scrolling must not run layout.");
            using (Bitmap bitmap = new Bitmap(pluginPage.Width, pluginPage.Height))
                MeasureWork("plugin-scroll-draw", counter, 20, index => {
                    pluginPage.ScrollBy(index < 10 ? 24 : -24);
                    pluginPage.DrawToBitmap(bitmap, pluginPage.ClientRectangle);
                });
            MeasureWork("navigation", counter, 20, index => {
                if (index % 2 == 0) ShowPage(overviewPage, overviewNav, "概览");
                else ShowPage(pluginPage, pluginNav, "插件管理");
            });
            MeasureWork("filter", counter, 20, index => pluginSearchInput.Text = index % 2 == 0 ? "feature-1" : "");
            MeasureWork("toggle-all", counter, 20, index => SetAllPluginRows(index % 2 == 0));
            RequireUi(pluginRows["feature-0"].Selected, "Required launcher selection must be retained.");
            RequireUi(DesiredPluginFeatures().Length == 0, "Clear must deselect all optional features.");

            // A real large UTF-8 log reproduces the synchronous full-file read on navigation.
            using (StreamWriter writer = new StreamWriter(LauncherPaths.BuildLog, false, System.Text.Encoding.UTF8))
                for (int index = 0; index < 350000; index++) writer.WriteLine("构建输出 {0}: {1}", index, new string('x', 160));
            MeasureWork("source-navigation-64MB", counter, 6, index => {
                if (index % 2 == 0) ShowPage(sourcePage, sourceNav, "DSH 源码");
                else ShowPage(overviewPage, overviewNav, "概览");
            });
            RequireUi(sourceOutput.Text.Contains("349999"), "The newest log entry must remain visible.");
            ShowPage(pluginPage, pluginNav, "插件管理");
            LayoutResponsivePages();
            ValidateResponsiveLayout();
            if (!measureOnly) VerifyResponsiveWork(counter);
            Hide();
        }

        private void VerifyResponsiveWork(UiWorkCounter counter)
        {
            foreach (Size size in new[] { new Size(820, 600), new Size(1600, 900), new Size(1120, 740) })
            {
                Size = size;
                Application.DoEvents();
                foreach (ModernScrollPage page in new[] { overviewPage, tasksPage, diagnosticsPage, sourcePage, pluginPage })
                {
                    NavButton nav = page == overviewPage ? overviewNav : page == tasksPage ? tasksNav
                        : page == diagnosticsPage ? diagnosticsNav : page == sourcePage ? sourceNav : pluginNav;
                    ShowPage(page, nav, "Layout test");
                    LayoutResponsivePages();
                    Application.DoEvents();
                    counter.Reset();
                    LayoutResponsivePages();
                    RequireUi(counter.Resizes == 0, "Repeated layout changed control sizes at " + size + ": " + nav.Text);
                    ValidateResponsiveLayout();
                }
            }

            pluginRows["feature-1"].Selected = true;
            PluginFeatureRow retained = pluginRows["feature-1"];
            pluginSearchInput.Text = "no-match";
            RequireUi(DesiredPluginFeatures().Contains("feature-1"), "Filtering must retain hidden selections.");
            pluginSearchInput.Text = "";
            RequireUi(Object.ReferenceEquals(retained, pluginRows["feature-1"]), "Filtering must reuse existing controls.");
            PluginManagerSnapshot next = UiFixtureSnapshot();
            next.features[1].selected = false;
            ApplyPluginSnapshot(next);
            RequireUi(!retained.Selected, "A refreshed snapshot must replace the previous selection.");
            next = UiFixtureSnapshot();
            next.features = next.features.Where(feature => feature.id != "feature-1").ToArray();
            ApplyPluginSnapshot(next);
            RequireUi(retained.IsDisposed, "Retired feature controls must be disposed.");
            var hooked = (HashSet<Control>)typeof(ModernScrollPage).GetField("hookedControls",
                System.Reflection.BindingFlags.Instance | System.Reflection.BindingFlags.NonPublic).GetValue(pluginPage);
            RequireUi(hooked.All(control => !control.IsDisposed), "The scroll page must not retain retired controls.");

            ShowPage(overviewPage, overviewNav, "概览");
            foreach (string mode in new[] { "desktop", "web" })
            {
                runtime.Settings.LaunchMode = mode;
                ApplyLaunchModeStatus();
                LayoutResponsivePages();
                counter.Reset();
                LayoutResponsivePages();
                RequireUi(counter.Resizes == 0, "Mode-specific button sizes must remain stable.");
                ValidateResponsiveLayout();
            }
        }

        internal void CaptureUiFixture(string page, string layout)
        {
            captureMode = true;
            pluginOperationHistoryLoaded = true;
            ApplyPluginSnapshot(UiFixtureSnapshot());
            CaptureTo(Path.Combine(LauncherPaths.DataRoot, page + "-" + layout + ".png"), page, layout);
        }

        private static PluginManagerSnapshot UiFixtureSnapshot()
        {
            PluginFeatureSnapshot[] features = Enumerable.Range(0, 8).Select(index => new PluginFeatureSnapshot {
                id = "feature-" + index, packageName = "fixture-feature-" + index,
                name = "测试功能 " + index, description = "测试切换与滚动时的真实控件布局",
                scope = index == 0 ? "global" : "profile", required = index == 0,
                installed = true, selected = true, order = index,
            }).ToArray();
            return new PluginManagerSnapshot {
                profile = "web", profiles = new[] { "web" }, features = features,
                source = new PluginSourceSnapshot { path = "fixture", revision = "test" },
                lastAppliedRevision = "test",
            };
        }
    }
}
