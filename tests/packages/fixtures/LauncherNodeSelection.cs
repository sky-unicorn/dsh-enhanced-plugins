using System;
using System.Drawing;
using System.IO;
using System.Reflection;
using System.Windows.Forms;
using DshEnhanced.WindowsLauncher;

internal static class LauncherNodeSelectionTest
{
    private static readonly BindingFlags PrivateInstance = BindingFlags.NonPublic | BindingFlags.Instance;

    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static T Field<T>(object instance, string name)
    {
        return (T)instance.GetType().GetField(name, PrivateInstance).GetValue(instance);
    }

    private static void Choose(ModernComboBox input, int index)
    {
        // Exercise the same commit event used by mouse and keyboard selection.
        typeof(ModernComboBox).GetMethod("CommitChoice", PrivateInstance).Invoke(input, new object[] { index });
    }

    private static void CaptureRuntime(MainForm form, string path)
    {
        ModernScrollPage page = Field<ModernScrollPage>(form, "overviewPage");
        page.AutoScrollPosition = new Point(0, Field<RoundedPanel>(form, "pathCard").Top);
        form.Refresh();
        Application.DoEvents();
        using (Bitmap bitmap = new Bitmap(form.Width, form.Height))
        {
            form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
            bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
    }

    [STAThread]
    private static int Main(string[] args)
    {
        try
        {
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            LauncherRuntime runtime = new LauncherRuntime();
            Check(runtime.Settings.NodeVersion == String.Empty, "Existing settings must default to automatic selection.");
            using (Icon icon = LauncherIcon.Create())
            using (MainForm form = new MainForm(runtime, icon))
            {
                form.CaptureTo(Path.Combine(args[1], "initial.png"), "overview", "runtime");
                ModernComboBox input = Field<ModernComboBox>(form, "nodeVersionInput");
                Check(input.SelectionOnly && input.Enabled && input.ItemCount == 2, "Installed versions were not available in the selector.");
                Check(input.Text == RuntimeText.Automatic, "Automatic selection was not shown.");
                ModernButton browser = Field<ModernButton>(form, "browserModeButton");
                ModernButton desktop = Field<ModernButton>(form, "desktopModeButton");
                Check((browser.AccessibilityObject.State & AccessibleStates.Checked) != 0, "Selected browser mode was not accessible.");
                typeof(ModernButton).GetMethod("OnKeyDown", PrivateInstance).Invoke(browser, new object[] { new KeyEventArgs(Keys.Right) });
                Check(new LauncherRuntime().Settings.LaunchMode == "desktop", "Keyboard mode selection was not saved.");
                Check((desktop.AccessibilityObject.State & AccessibleStates.Checked) != 0, "Selected desktop mode was not accessible.");
                typeof(ModernButton).GetMethod("OnKeyDown", PrivateInstance).Invoke(desktop, new object[] { new KeyEventArgs(Keys.Left) });
                Check(new LauncherRuntime().Settings.LaunchMode == "web", "Keyboard mode selection did not return to browser.");
                Choose(input, 1);
                Check(new LauncherRuntime().Settings.NodeVersion == args[0], "Manual selection did not survive reload.");
                Check(runtime.InspectToolchain().requestedNodeVersion == args[0], "Overview did not inspect the saved version.");
                foreach (string mode in new[] { "web", "desktop", "build" })
                {
                    LauncherRequest request = (LauncherRequest)typeof(LauncherRuntime).GetMethod("BaseRequest", PrivateInstance)
                        .Invoke(runtime, new object[] { mode, String.Empty });
                    Check(request.nodeVersion == args[0], mode + " did not inherit manual selection.");
                }
                form.CaptureTo(Path.Combine(args[1], "manual-full.png"), "overview", "runtime");
                CaptureRuntime(form, Path.Combine(args[1], "manual.png"));

                runtime.Settings.NodeVersion = "99.0.0";
                runtime.SaveSettings();
                ToolchainSnapshot missing = runtime.InspectToolchain();
                typeof(MainForm).GetMethod("ApplyNodeSelection", PrivateInstance).Invoke(form, new object[] { missing });
                Check(input.Enabled && input.Text.Contains(RuntimeText.MissingVersion), "Missing saved versions must remain visible and recoverable.");
                Choose(input, 0);
                Check(new LauncherRuntime().Settings.NodeVersion == String.Empty, "Switching back to automatic was not persisted.");
                Check(runtime.InspectToolchain().phase == "ready", "Automatic selection did not recover after a missing manual version.");
            }
            foreach (string layout in new[] { "compact", "scale150" })
            {
                using (Icon icon = LauncherIcon.Create())
                using (MainForm form = new MainForm(new LauncherRuntime(), icon))
                {
                    form.CaptureTo(Path.Combine(args[1], layout + "-full.png"), "overview", layout);
                    CaptureRuntime(form, Path.Combine(args[1], layout + ".png"));
                }
            }
            Console.WriteLine("NODE_SELECTION_UI_OK");
            return 0;
        }
        catch (Exception error) { Console.Error.WriteLine(error); return 1; }
    }
}
