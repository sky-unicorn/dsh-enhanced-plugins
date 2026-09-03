using System;
using System.Diagnostics;
using System.IO;
using DshEnhanced.WindowsLauncher;

internal static class LauncherUpdateWorkspaceTest
{
    private static void Check(bool condition, string message)
    {
        if (!condition) throw new Exception(message);
    }

    private static void Wait(PendingPluginOperation operation)
    {
        try
        {
            using (Process process = Process.GetProcessById(operation.CoordinatorPid))
            {
                if (!process.WaitForExit(30000))
                {
                    process.Kill();
                    process.WaitForExit();
                    throw new Exception("Coordinator did not finish.");
                }
            }
        }
        catch (ArgumentException) { }
    }

    private static int Main(string[] args)
    {
        try
        {
            LauncherPaths.Ensure();
            string staleLegacy = Path.Combine(LauncherPaths.Updates, Guid.NewGuid().ToString("D"));
            Directory.CreateDirectory(staleLegacy);
            File.WriteAllText(Path.Combine(staleLegacy, "source.zip"), "previous build");
            PluginManagerRuntime runtime = new PluginManagerRuntime();
            PluginManagementPlan plan = new PluginManagementPlan { sourceRevision = "stale-test-revision" };
            PendingPluginOperation first;
            Check(runtime.StartApply(args[0], "web", new string[0], false, plan, out first).Success, "First start failed.");
            Wait(first);
            PluginApplyResult result;
            Check(runtime.TryReadResult(first, out result) && !result.success, "Expected a real coordinator validation failure.");
            Check(result.message.Contains("源码在计划生成后发生变化"), "Failure did not reach Apply validation: " + result.message);
            string current = Path.Combine(LauncherPaths.Updates, "current");
            Check(first.RequestDirectory == current, "Update did not use the fixed directory.");
            Check(result.logPath == Path.Combine(current, "logs", "update.log") && File.Exists(result.logPath), "Incorrect failure log path.");
            Directory.CreateDirectory(Path.Combine(current, "downloaded", "nested"));
            File.WriteAllText(Path.Combine(current, "downloaded", "nested", "stale.txt"), "stale");
            File.WriteAllText(Path.Combine(current, "source.zip"), "stale");
            File.WriteAllText(Path.Combine(current, "logs", "old.log"), "stale");

            PendingPluginOperation second;
            Check(runtime.StartApply(args[0], "web", new string[0], false, plan, out second).Success, "Second start failed.");
            try
            {
                Check(second.RequestDirectory == first.RequestDirectory && second.RequestId != first.RequestId, "Workspace was not reused with a new request ID.");
                Check(!Directory.Exists(Path.Combine(current, "downloaded")) && !File.Exists(Path.Combine(current, "source.zip"))
                    && !File.Exists(Path.Combine(current, "logs", "old.log")), "Old artifacts survived reuse.");
                Check(!runtime.TryReadResult(first, out result), "An old request consumed or overwrote the new result.");
            }
            finally { Wait(second); }
            Check(new PluginManagerRuntime().TryReadResult(second, out result) && result.requestId == second.RequestId, "Restarted runtime lost the result.");
            Check(runtime.LatestCompletedResult().requestId == second.RequestId, "Latest result was not discovered.");
            Check(Directory.Exists(staleLegacy), "A failed update deleted legacy files before committing.");
            Check(Directory.GetDirectories(LauncherPaths.Updates).Length == 2, "Updates accumulated per-request directories.");

            using (Process self = Process.GetCurrentProcess())
            {
                PendingPluginOperationRecord live = new PendingPluginOperationRecord
                {
                    requestId = second.RequestId, coordinatorPid = self.Id,
                    startedAtUtc = self.StartTime.ToUniversalTime().ToString("o"),
                };
                JsonFile.Write(Path.Combine(current, "pending.json"), live);
                string saved = File.ReadAllText(second.ResultPath);
                PendingPluginOperation blocked;
                Check(!runtime.StartApply(args[0], "web", new string[0], false, plan, out blocked).Success,
                    "A still-running coordinator with a result was overwritten.");
                Check(File.ReadAllText(second.ResultPath) == saved, "Blocked start changed existing files.");
                File.Delete(second.ResultPath);
                PendingPluginOperation resumed = new PluginManagerRuntime().LatestPendingOperation();
                Check(resumed != null && resumed.RequestId == second.RequestId && !resumed.IsInterrupted, "Restarted runtime lost the active operation.");
                File.Delete(Path.Combine(current, "pending.json"));

                string legacyId = Guid.NewGuid().ToString("D");
                string legacy = Path.Combine(LauncherPaths.Updates, legacyId);
                live.requestId = legacyId;
                JsonFile.Write(Path.Combine(legacy, "pending.json"), live);
                JsonFile.Write(Path.Combine(legacy, "request.json"), new PluginApplyRequest { requestId = legacyId });
                Check(!runtime.StartApply(args[0], "web", new string[0], false, plan, out blocked).Success, "A legacy coordinator did not block reuse.");
                resumed = runtime.LatestPendingOperation();
                Check(resumed != null && resumed.RequestId == legacyId, "Legacy operation was not discovered.");
                JsonFile.Write(resumed.ResultPath, new PluginApplyResult { success = false, stage = "apply" });
                Check(runtime.TryReadResult(resumed, out result), "Legacy failure without requestId was rejected.");
            }
            Console.WriteLine("UPDATE_WORKSPACE_OK");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error);
            return 1;
        }
    }
}
