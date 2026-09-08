using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading;

namespace DshEnhanced.WindowsLauncher
{
    internal sealed partial class LauncherRuntime
    {
        internal bool DesktopRunning()
        {
            LauncherState state = JsonFile.Read<LauncherState>(LauncherPaths.DesktopState);
            return state != null && state.status != "stopped" && ProcessMatches(state);
        }

        internal LauncherState DesktopLastState()
        {
            return JsonFile.Read<LauncherState>(LauncherPaths.DesktopState);
        }

        internal bool DesktopBuildRunning()
        {
            LauncherState state = DesktopLastState();
            return state != null && state.desktopBuild && state.status != "stopped" && ProcessMatches(state);
        }

        internal OperationResult StartDesktop() { return StartDesktop(false); }
        internal OperationResult BuildAndStartDesktop() { return StartDesktop(true); }

        // Source launch uses DSH's own scripts; the supervisor owns only this invocation's process tree.
        private OperationResult StartDesktop(bool build)
        {
            using (Mutex gate = new Mutex(false, @"Local\DSH.Enhanced.WindowsLauncher.DesktopStart"))
            {
                bool acquired = false;
                try
                {
                    try { acquired = gate.WaitOne(0); } catch (AbandonedMutexException) { acquired = true; }
                    if (!acquired) return OperationResult.Fail(DesktopText.StartPending);
                    if (PluginManagementBusy()) return PluginManagementConflict();
                    if (DesktopRunning()) return OperationResult.Ok(DesktopText.Running);
                    string source = ResolveDshSource();
                    if (!DesktopLaunch.SupportsSource(source)) return OperationResult.Fail(DesktopText.SelectFirst);
                    if (!build && !DesktopLaunch.HasBuild(source)) return OperationResult.Fail(DesktopText.NeedsBuild);
                    if (build && Snapshot().Ownership != WebOwnership.Stopped)
                        return OperationResult.Fail(DesktopText.StopBeforeBuild);
                    string supervisor = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "DSH-Launcher.Supervisor.ps1");
                    if (!File.Exists(supervisor)) return OperationResult.Fail("Launcher supervisor 组件缺失。");
                    LauncherRequest request = BaseRequest("desktop", String.Empty);
                    request.sourceDirectory = request.workingDirectory = source;
                    request.desktopBuild = build;
                    request.port = 0;
                    request.logPath = LauncherPaths.DesktopLog;
                    request.statePath = LauncherPaths.DesktopState;
                    request.stopPath = LauncherPaths.DesktopStop;
                    request.accessPath = String.Empty;
                    request.runtimeNode = ToolchainInspector.BootstrapNode();
                    if (request.runtimeNode == null) return OperationResult.Fail(RuntimeText.NoBootstrap);
                    request.runtimePath = Path.Combine(LauncherPaths.Run, "desktop-toolchain.json");
                    request.sandboxHome = Path.Combine(LauncherPaths.DataRoot, "sandbox");
                    string requestPath = WriteRequest(request);
                    TryDelete(LauncherPaths.DesktopStop);
                    LauncherState pending = new LauncherState {
                        requestId = request.requestId, status = "starting", startedAtUtc = DateTime.UtcNow.ToString("o"),
                        port = 0, logPath = LauncherPaths.DesktopLog, desktopBuild = build,
                    };
                    JsonFile.Write(LauncherPaths.DesktopState, pending);
                    ProcessStartInfo info = PowerShellStartInfo(supervisor, requestPath, true, false);
                    info.UseShellExecute = true;
                    info.CreateNoWindow = false;
                    using (Process process = Process.Start(info))
                    {
                        if (process == null) return OperationResult.Fail(DesktopText.Failed);
                        LauncherState observed = DesktopLastState();
                        if (observed == null || observed.requestId != request.requestId || observed.supervisorPid <= 0)
                        {
                            pending.supervisorPid = process.Id;
                            JsonFile.Write(LauncherPaths.DesktopState, pending);
                        }
                    }
                    return OperationResult.Ok(build ? DesktopText.BuildSubmitted : DesktopText.Launched);
                }
                catch (Exception error) { return OperationResult.Fail(DesktopText.Failed + " " + error.Message); }
                finally { if (acquired) gate.ReleaseMutex(); }
            }
        }

        internal OperationResult StopDesktop()
        {
            LauncherState state = DesktopLastState();
            if (state == null || !DesktopRunning()) return OperationResult.Ok(DesktopText.Stopped);
            File.WriteAllText(LauncherPaths.DesktopStop, state.requestId, new UTF8Encoding(false));
            return OperationResult.Ok(DesktopText.Stopping);
        }

        internal OperationResult StopAllAndWait()
        {
            OperationResult desktop = StopDesktop();
            if (!desktop.Success) return desktop;
            DateTime deadline = DateTime.UtcNow.AddSeconds(20);
            while (DesktopRunning() && DateTime.UtcNow < deadline) Thread.Sleep(200);
            if (DesktopRunning()) return OperationResult.Fail(DesktopText.StopTimeout);
            return StopWebAndWait();
        }
    }
}
