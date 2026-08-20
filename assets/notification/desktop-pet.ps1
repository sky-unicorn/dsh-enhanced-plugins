param(
  [Parameter(Mandatory = $true)]
  [string]$IconPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class DeepSeekPetPlacement {
  public string Display { get; set; }
  public double XRatio { get; set; }
  public double YRatio { get; set; }
}

public static class DeepSeekPetNativeCursor {
  [StructLayout(LayoutKind.Sequential)]
  private struct NativeRect {
    public int Left;
    public int Top;
    public int Right;
    public int Bottom;
  }

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Auto)]
  private struct MonitorInfo {
    public int Size;
    public NativeRect Monitor;
    public NativeRect Work;
    public uint Flags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)]
    public string Device;
  }

  private delegate bool MonitorCallback(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data);

  [DllImport("user32.dll")]
  public static extern IntPtr LoadCursor(IntPtr instance, int cursorName);

  [DllImport("user32.dll")]
  public static extern IntPtr SetCursor(IntPtr cursor);

  [DllImport("user32.dll")]
  private static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);

  [DllImport("user32.dll", CharSet = CharSet.Auto)]
  private static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);

  [DllImport("user32.dll")]
  private static extern bool GetWindowRect(IntPtr window, out NativeRect rect);

  [DllImport("user32.dll")]
  private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr clip, MonitorCallback callback, IntPtr data);

  [DllImport("user32.dll")]
  private static extern bool SetWindowPos(
    IntPtr window,
    IntPtr insertAfter,
    int x,
    int y,
    int width,
    int height,
    uint flags
  );

  private static MonitorInfo ReadMonitor(IntPtr monitor) {
    var info = new MonitorInfo();
    info.Size = Marshal.SizeOf(typeof(MonitorInfo));
    if (!GetMonitorInfo(monitor, ref info)) throw new InvalidOperationException("Unable to read monitor geometry.");
    return info;
  }

  private static List<MonitorInfo> ReadMonitors() {
    var monitors = new List<MonitorInfo>();
    var workAreas = new HashSet<string>(StringComparer.Ordinal);
    MonitorCallback callback = delegate(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data) {
      var info = ReadMonitor(monitor);
      var key = String.Format(
        "{0},{1},{2},{3}",
        info.Work.Left,
        info.Work.Top,
        info.Work.Right,
        info.Work.Bottom
      );
      if (workAreas.Add(key)) monitors.Add(info);
      return true;
    };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
    return monitors;
  }

  private static long IntersectionArea(NativeRect first, NativeRect second) {
    var width = Math.Max(0, Math.Min(first.Right, second.Right) - Math.Max(first.Left, second.Left));
    var height = Math.Max(0, Math.Min(first.Bottom, second.Bottom) - Math.Max(first.Top, second.Top));
    return (long)width * height;
  }

  private static long CenterDistanceSquared(NativeRect first, NativeRect second) {
    var firstX = (long)first.Left + first.Right;
    var firstY = (long)first.Top + first.Bottom;
    var secondX = (long)second.Left + second.Right;
    var secondY = (long)second.Top + second.Bottom;
    var dx = firstX - secondX;
    var dy = firstY - secondY;
    return dx * dx + dy * dy;
  }

  private static bool ClampIntoWorkArea(ref NativeRect bounds, NativeRect work) {
    var width = Math.Max(1, bounds.Right - bounds.Left);
    var height = Math.Max(1, bounds.Bottom - bounds.Top);
    var maxLeft = Math.Max(work.Left, work.Right - width);
    var maxTop = Math.Max(work.Top, work.Bottom - height);
    var left = Math.Max(work.Left, Math.Min(maxLeft, bounds.Left));
    var top = Math.Max(work.Top, Math.Min(maxTop, bounds.Top));
    if (left == bounds.Left && top == bounds.Top) return false;
    bounds.Left = left;
    bounds.Top = top;
    bounds.Right = left + width;
    bounds.Bottom = top + height;
    return true;
  }

  private static IntPtr FindMonitor(string device) {
    var found = IntPtr.Zero;
    MonitorCallback callback = delegate(IntPtr monitor, IntPtr hdc, IntPtr rect, IntPtr data) {
      var info = ReadMonitor(monitor);
      if (String.Equals(info.Device, device, StringComparison.OrdinalIgnoreCase)) {
        found = monitor;
        return false;
      }
      return true;
    };
    EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, callback, IntPtr.Zero);
    return found;
  }

  private static double ClampRatio(double value) {
    if (Double.IsNaN(value) || Double.IsInfinity(value)) return 0;
    return Math.Max(0, Math.Min(1, value));
  }

  public static bool IsDisplayAvailable(string device) {
    return !String.IsNullOrEmpty(device) && FindMonitor(device) != IntPtr.Zero;
  }

  public static bool ConstrainMovingRect(IntPtr rectangle) {
    if (rectangle == IntPtr.Zero) return false;
    var bounds = (NativeRect)Marshal.PtrToStructure(rectangle, typeof(NativeRect));
    var width = Math.Max(0, bounds.Right - bounds.Left);
    var height = Math.Max(0, bounds.Bottom - bounds.Top);
    if (width == 0 || height == 0) return false;
    var monitors = ReadMonitors();
    if (monitors.Count == 0) return false;

    var windowArea = (long)width * height;
    long coveredArea = 0;
    foreach (var monitor in monitors) coveredArea += IntersectionArea(bounds, monitor.Work);
    // Adjacent displays jointly cover a cross-display drag, so the internal
    // boundary stays open. Only uncovered physical desktop edges are clamped.
    if (coveredArea >= windowArea) return false;

    var target = monitors[0];
    long bestIntersection = -1;
    long bestDistance = Int64.MaxValue;
    foreach (var monitor in monitors) {
      var intersection = IntersectionArea(bounds, monitor.Work);
      var distance = CenterDistanceSquared(bounds, monitor.Work);
      if (intersection > bestIntersection || (intersection == bestIntersection && distance < bestDistance)) {
        target = monitor;
        bestIntersection = intersection;
        bestDistance = distance;
      }
    }
    if (!ClampIntoWorkArea(ref bounds, target.Work)) return false;
    Marshal.StructureToPtr(bounds, rectangle, false);
    return true;
  }

  public static DeepSeekPetPlacement CapturePlacement(IntPtr window) {
    NativeRect bounds;
    if (!GetWindowRect(window, out bounds)) return null;
    var monitor = MonitorFromWindow(window, 2);
    if (monitor == IntPtr.Zero) return null;
    var info = ReadMonitor(monitor);
    if (ClampIntoWorkArea(ref bounds, info.Work)) {
      SetWindowPos(window, IntPtr.Zero, bounds.Left, bounds.Top, 0, 0, 0x0015);
    }
    var availableX = Math.Max(0, (info.Work.Right - info.Work.Left) - (bounds.Right - bounds.Left));
    var availableY = Math.Max(0, (info.Work.Bottom - info.Work.Top) - (bounds.Bottom - bounds.Top));
    return new DeepSeekPetPlacement {
      Display = info.Device,
      XRatio = availableX == 0 ? 0 : ClampRatio((double)(bounds.Left - info.Work.Left) / availableX),
      YRatio = availableY == 0 ? 0 : ClampRatio((double)(bounds.Top - info.Work.Top) / availableY),
    };
  }

  public static bool RestorePlacement(IntPtr window, string device, double xRatio, double yRatio) {
    var monitor = FindMonitor(device);
    if (monitor == IntPtr.Zero) return false;
    NativeRect bounds;
    if (!GetWindowRect(window, out bounds)) return false;
    var info = ReadMonitor(monitor);
    var width = Math.Max(1, bounds.Right - bounds.Left);
    var height = Math.Max(1, bounds.Bottom - bounds.Top);
    var availableX = Math.Max(0, (info.Work.Right - info.Work.Left) - width);
    var availableY = Math.Max(0, (info.Work.Bottom - info.Work.Top) - height);
    var x = info.Work.Left + (int)Math.Round(ClampRatio(xRatio) * availableX);
    var y = info.Work.Top + (int)Math.Round(ClampRatio(yRatio) * availableY);
    return SetWindowPos(window, IntPtr.Zero, x, y, 0, 0, 0x0015);
  }
}

public sealed class DeepSeekPetInputReader {
  private readonly ConcurrentQueue<string> lines = new ConcurrentQueue<string>();
  private volatile bool reachedEnd;

  public DeepSeekPetInputReader(TextReader reader) {
    var thread = new Thread(() => {
      try {
        string line;
        while ((line = reader.ReadLine()) != null) lines.Enqueue(line);
      } finally {
        reachedEnd = true;
      }
    });
    thread.IsBackground = true;
    thread.Name = "DeepSeek desktop pet input";
    thread.Start();
  }

  public bool TryDequeue(out string line) {
    return lines.TryDequeue(out line);
  }

  public bool IsComplete {
    get { return reachedEnd && lines.IsEmpty; }
  }
}
'@

[xml]$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        ResizeMode="NoResize" ShowInTaskbar="False" Topmost="True"
        ShowActivated="False" WindowStartupLocation="Manual"
        Cursor="Arrow" ForceCursor="True"
        Width="112" Height="112" Visibility="Hidden">
  <Grid x:Name="Motion" Background="Transparent" Cursor="Arrow" ForceCursor="True">
    <Viewbox Stretch="Uniform" IsHitTestVisible="True">
      <Grid Width="112" Height="112">
    <Ellipse x:Name="HatchGlow" Margin="5" Fill="#4D6BFE" Opacity="0"
             IsHitTestVisible="False" />
    <Ellipse x:Name="GroundShadow" Width="55" Height="11" Margin="0,0,0,5"
             HorizontalAlignment="Center" VerticalAlignment="Bottom"
             Fill="#172554" Opacity="0.2" RenderTransformOrigin="0.5,0.5"
             IsHitTestVisible="False">
      <Ellipse.RenderTransform><ScaleTransform x:Name="GroundShadowScale" /></Ellipse.RenderTransform>
    </Ellipse>

    <Ellipse x:Name="Ring" Margin="3" StrokeThickness="3" StrokeDashArray="2 3"
             Stroke="#4D6BFE" Opacity="0" RenderTransformOrigin="0.5,0.5"
             IsHitTestVisible="False">
      <Ellipse.RenderTransform>
        <RotateTransform x:Name="RingRotation" />
      </Ellipse.RenderTransform>
    </Ellipse>

    <Canvas x:Name="Bubbles" IsHitTestVisible="False" Opacity="0">
      <Ellipse x:Name="BubbleOne" Canvas.Left="78" Canvas.Top="38" Width="9" Height="9"
               Fill="#9CB7FF" Opacity="0.75">
        <Ellipse.RenderTransform><TranslateTransform x:Name="BubbleOneMotion" /></Ellipse.RenderTransform>
      </Ellipse>
      <Ellipse x:Name="BubbleTwo" Canvas.Left="88" Canvas.Top="54" Width="6" Height="6"
               Fill="#C4D4FF" Opacity="0.55">
        <Ellipse.RenderTransform><TranslateTransform x:Name="BubbleTwoMotion" /></Ellipse.RenderTransform>
      </Ellipse>
    </Canvas>

    <Canvas x:Name="Sparks" IsHitTestVisible="False" Opacity="0">
      <Ellipse Canvas.Left="19" Canvas.Top="44" Width="7" Height="7" Fill="#34D399">
        <Ellipse.RenderTransform><TranslateTransform x:Name="SparkOneMotion" /></Ellipse.RenderTransform>
      </Ellipse>
      <Ellipse Canvas.Left="31" Canvas.Top="17" Width="5" Height="5" Fill="#FBBF24">
        <Ellipse.RenderTransform><TranslateTransform x:Name="SparkTwoMotion" /></Ellipse.RenderTransform>
      </Ellipse>
      <Ellipse Canvas.Left="78" Canvas.Top="20" Width="6" Height="6" Fill="#60A5FA">
        <Ellipse.RenderTransform><TranslateTransform x:Name="SparkThreeMotion" /></Ellipse.RenderTransform>
      </Ellipse>
      <Ellipse Canvas.Left="88" Canvas.Top="54" Width="5" Height="5" Fill="#F472B6">
        <Ellipse.RenderTransform><TranslateTransform x:Name="SparkFourMotion" /></Ellipse.RenderTransform>
      </Ellipse>
    </Canvas>

    <Grid x:Name="PetVisual" Margin="10" RenderTransformOrigin="0.5,0.5"
          Cursor="Arrow" ForceCursor="True">
      <Grid.RenderTransform>
        <TransformGroup>
          <ScaleTransform x:Name="PetScale" ScaleX="1" ScaleY="1" />
          <ScaleTransform x:Name="PetTrickScale" ScaleX="1" ScaleY="1" />
          <ScaleTransform x:Name="PetHoverScale" ScaleX="1" ScaleY="1" />
          <ScaleTransform x:Name="PetEntranceScale" ScaleX="1" ScaleY="1" />
          <RotateTransform x:Name="PetRotation" />
          <RotateTransform x:Name="PetTrickRotation" />
          <TranslateTransform x:Name="PetMotion" />
          <TranslateTransform x:Name="PetTrickMotion" />
          <TranslateTransform x:Name="PetEntranceMotion" />
        </TransformGroup>
      </Grid.RenderTransform>
      <Border x:Name="PetBubble" CornerRadius="999" Background="#6477C9">
        <Border.Effect>
          <DropShadowEffect x:Name="Shadow" BlurRadius="18" ShadowDepth="4" Opacity="0.35" Color="#4D6BFE" />
        </Border.Effect>
        <Viewbox Margin="20" IsHitTestVisible="False">
          <Path x:Name="Fish" Fill="White" Stretch="Uniform" />
        </Viewbox>
      </Border>
    </Grid>

    <Grid x:Name="HatchShell" Width="82" Height="82" HorizontalAlignment="Center"
          VerticalAlignment="Center" Visibility="Collapsed" IsHitTestVisible="False">
      <Path x:Name="HatchTop"
            Data="M 6,42 A 35,35 0 0 1 76,42 L 67,49 58,41 49,50 40,41 30,50 20,41 6,49 Z"
            Fill="#E8EDFF" Stroke="#4D6BFE" StrokeThickness="2"
            RenderTransformOrigin="0.5,0.5">
        <Path.RenderTransform><TranslateTransform x:Name="HatchTopMotion" /></Path.RenderTransform>
      </Path>
      <Path x:Name="HatchBottom"
            Data="M 6,49 L 20,41 30,50 40,41 49,50 58,41 67,49 76,42 A 35,35 0 0 1 6,49 Z"
            Fill="#D6DFFF" Stroke="#4D6BFE" StrokeThickness="2"
            RenderTransformOrigin="0.5,0.5">
        <Path.RenderTransform><TranslateTransform x:Name="HatchBottomMotion" /></Path.RenderTransform>
      </Path>
    </Grid>

    <Border x:Name="Badge" Width="29" Height="29" CornerRadius="999"
            HorizontalAlignment="Right" VerticalAlignment="Top"
            Background="#F59E0B" BorderBrush="White" BorderThickness="3"
            RenderTransformOrigin="0.5,0.5" Visibility="Collapsed"
            IsHitTestVisible="False">
      <Border.RenderTransform><ScaleTransform x:Name="BadgeScale" /></Border.RenderTransform>
      <TextBlock x:Name="BadgeText" Text="!" Foreground="White" FontSize="16"
                 FontWeight="Bold" HorizontalAlignment="Center" VerticalAlignment="Center" />
    </Border>
      </Grid>
    </Viewbox>
  </Grid>
</Window>
'@

$reader = [System.Xml.XmlNodeReader]::new($xaml)
$window = [System.Windows.Markup.XamlReader]::Load($reader)
$application = [System.Windows.Application]::new()
$application.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown
$script:windowHandle = [System.Windows.Interop.WindowInteropHelper]::new($window).EnsureHandle()
$motion = $window.FindName('Motion')
$hatchGlow = $window.FindName('HatchGlow')
$groundShadow = $window.FindName('GroundShadow')
$groundShadowScale = $window.FindName('GroundShadowScale')
$ring = $window.FindName('Ring')
$ringRotation = $window.FindName('RingRotation')
$bubbles = $window.FindName('Bubbles')
$bubbleOneMotion = $window.FindName('BubbleOneMotion')
$bubbleTwoMotion = $window.FindName('BubbleTwoMotion')
$sparks = $window.FindName('Sparks')
$sparkOneMotion = $window.FindName('SparkOneMotion')
$sparkTwoMotion = $window.FindName('SparkTwoMotion')
$sparkThreeMotion = $window.FindName('SparkThreeMotion')
$sparkFourMotion = $window.FindName('SparkFourMotion')
$petVisual = $window.FindName('PetVisual')
$petMotion = $window.FindName('PetMotion')
$petRotation = $window.FindName('PetRotation')
$petScale = $window.FindName('PetScale')
$petTrickMotion = $window.FindName('PetTrickMotion')
$petTrickRotation = $window.FindName('PetTrickRotation')
$petTrickScale = $window.FindName('PetTrickScale')
$petHoverScale = $window.FindName('PetHoverScale')
$petEntranceMotion = $window.FindName('PetEntranceMotion')
$petEntranceScale = $window.FindName('PetEntranceScale')
$petBubble = $window.FindName('PetBubble')
$shadow = $window.FindName('Shadow')
$fish = $window.FindName('Fish')
$hatchShell = $window.FindName('HatchShell')
$hatchTop = $window.FindName('HatchTop')
$hatchBottom = $window.FindName('HatchBottom')
$hatchTopMotion = $window.FindName('HatchTopMotion')
$hatchBottomMotion = $window.FindName('HatchBottomMotion')
$badge = $window.FindName('Badge')
$badgeScale = $window.FindName('BadgeScale')
$badgeText = $window.FindName('BadgeText')

# PowerShell can leave an application-starting cursor associated with its WPF
# dispatcher even after the window is responsive. Override it for this process
# so merely hovering the pet never shows a busy cursor.
[System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::Arrow
$script:arrowCursorHandle = [DeepSeekPetNativeCursor]::LoadCursor([IntPtr]::Zero, 32512)
$script:sizeAllCursorHandle = [DeepSeekPetNativeCursor]::LoadCursor([IntPtr]::Zero, 32646)

[xml]$icon = Get-Content -Raw -LiteralPath $IconPath
$fish.Data = [System.Windows.Media.Geometry]::Parse([string]$icon.svg.path.d)

$script:settings = [pscustomobject]@{
  completionSound = 'subtle'
  confirmationSound = 'prominent'
  completionCustomSoundPath = ''
  confirmationCustomSoundPath = ''
  petEnabled = $false
  petIdleTopmost = $true
  petSize = 112
  petPosition = 'bottom-right'
}
$script:state = 'idle'
$script:visualMode = 'state'
$script:visualUntil = [DateTime]::MinValue
$script:nextIdleTrick = [DateTime]::UtcNow.AddSeconds(6)
$script:motionEnabled = [System.Windows.SystemParameters]::ClientAreaAnimation
$script:isDragging = $false
$script:placementPending = $false
$script:stopping = $false
$script:pendingStop = $false
$script:soundPlaying = $false
$script:soundDeadline = [DateTime]::MinValue
$inputReader = [DeepSeekPetInputReader]::new([Console]::In)
$script:mediaPlayer = [System.Windows.Media.MediaPlayer]::new()

function Brush([string]$color) {
  return [System.Windows.Media.BrushConverter]::new().ConvertFromString($color)
}

function New-Animation(
  [double]$from,
  [double]$to,
  [double]$seconds,
  [bool]$autoReverse = $true,
  [double]$delaySeconds = 0
) {
  $animation = [System.Windows.Media.Animation.DoubleAnimation]::new()
  $animation.From = $from
  $animation.To = $to
  $animation.Duration = [System.Windows.Duration]::new([TimeSpan]::FromSeconds($seconds))
  $animation.AutoReverse = $autoReverse
  $animation.RepeatBehavior = [System.Windows.Media.Animation.RepeatBehavior]::Forever
  if ($delaySeconds -gt 0) { $animation.BeginTime = [TimeSpan]::FromSeconds($delaySeconds) }
  return $animation
}

function New-OneShotAnimation(
  [double]$from,
  [double]$to,
  [double]$seconds,
  [bool]$autoReverse = $false,
  [double]$delaySeconds = 0
) {
  $animation = [System.Windows.Media.Animation.DoubleAnimation]::new()
  $animation.From = $from
  $animation.To = $to
  $animation.Duration = [System.Windows.Duration]::new([TimeSpan]::FromSeconds($seconds))
  $animation.AutoReverse = $autoReverse
  $animation.FillBehavior = [System.Windows.Media.Animation.FillBehavior]::HoldEnd
  if ($delaySeconds -gt 0) { $animation.BeginTime = [TimeSpan]::FromSeconds($delaySeconds) }
  return $animation
}

function Clear-Animations {
  $petMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $null)
  $petMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $petRotation.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
  $petScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $null)
  $petScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $null)
  $petTrickMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $petTrickRotation.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
  $petTrickScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $null)
  $petTrickScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $null)
  $petHoverScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $null)
  $petHoverScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $null)
  $petEntranceMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $petEntranceScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $null)
  $petEntranceScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $null)
  $petVisual.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $ringRotation.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
  $ring.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $hatchGlow.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $sparks.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $badgeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $null)
  $badgeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $null)
  $bubbleOneMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $bubbleTwoMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $sparkOneMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $sparkTwoMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $sparkThreeMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $sparkFourMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $hatchTopMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $hatchBottomMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $hatchTop.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $hatchBottom.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $groundShadowScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $null)
  $groundShadowScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $null)
  $petMotion.X = 0
  $petMotion.Y = 0
  $petRotation.Angle = 0
  $petScale.ScaleX = 1
  $petScale.ScaleY = 1
  $petTrickMotion.Y = 0
  $petTrickRotation.Angle = 0
  $petTrickScale.ScaleX = 1
  $petTrickScale.ScaleY = 1
  $petHoverScale.ScaleX = 1
  $petHoverScale.ScaleY = 1
  $petEntranceMotion.Y = 0
  $petEntranceScale.ScaleX = 1
  $petEntranceScale.ScaleY = 1
  $petVisual.Opacity = 1
  $ringRotation.Angle = 0
  $badgeScale.ScaleX = 1
  $badgeScale.ScaleY = 1
  $hatchGlow.Opacity = 0
  $sparks.Opacity = 0
  $hatchTopMotion.Y = 0
  $hatchBottomMotion.Y = 0
  $hatchTop.Opacity = 1
  $hatchBottom.Opacity = 1
  $groundShadowScale.ScaleX = 1
  $groundShadowScale.ScaleY = 1
  $hatchShell.Visibility = 'Collapsed'
}

function Animate-Scale([double]$from, [double]$to, [double]$seconds) {
  $petScale.BeginAnimation(
    [System.Windows.Media.ScaleTransform]::ScaleXProperty,
    (New-Animation $from $to $seconds)
  )
  $petScale.BeginAnimation(
    [System.Windows.Media.ScaleTransform]::ScaleYProperty,
    (New-Animation $from $to $seconds)
  )
}

function Animate-OneShotScale(
  $transform,
  [double]$from,
  [double]$to,
  [double]$seconds,
  [bool]$autoReverse = $false,
  [double]$delaySeconds = 0
) {
  $transform.BeginAnimation(
    [System.Windows.Media.ScaleTransform]::ScaleXProperty,
    (New-OneShotAnimation $from $to $seconds $autoReverse $delaySeconds)
  )
  $transform.BeginAnimation(
    [System.Windows.Media.ScaleTransform]::ScaleYProperty,
    (New-OneShotAnimation $from $to $seconds $autoReverse $delaySeconds)
  )
}

function Set-TopmostForState {
  $keepIdleTopmost = $true
  if ($null -ne $script:settings.PSObject.Properties['petIdleTopmost']) {
    $keepIdleTopmost = [bool]$script:settings.petIdleTopmost
  }
  $window.Topmost = $script:state -ne 'idle' -or $keepIdleTopmost
}

function Try-RestoreSavedPlacement {
  $state = $script:settings.placementState
  if ($null -eq $state -or $null -eq $state.displays) { return $false }
  $properties = @($state.displays.PSObject.Properties)
  $active = [string]$state.activeDisplay

  foreach ($property in $properties) {
    if ($property.Name -ne $active) { continue }
    $placement = $property.Value
    if (
      [DeepSeekPetNativeCursor]::IsDisplayAvailable($property.Name) -and
      [DeepSeekPetNativeCursor]::RestorePlacement(
        $script:windowHandle,
        $property.Name,
        [double]$placement.xRatio,
        [double]$placement.yRatio
      )
    ) { return $true }
  }

  # If the last-used monitor is offline, prefer another monitor whose own
  # dragged position was previously recorded. Do not overwrite activeDisplay;
  # reconnecting the original monitor can therefore restore it later.
  foreach ($property in $properties) {
    if ($property.Name -eq $active) { continue }
    $placement = $property.Value
    if (
      [DeepSeekPetNativeCursor]::IsDisplayAvailable($property.Name) -and
      [DeepSeekPetNativeCursor]::RestorePlacement(
        $script:windowHandle,
        $property.Name,
        [double]$placement.xRatio,
        [double]$placement.yRatio
      )
    ) { return $true }
  }
  return $false
}

function Set-Placement {
  $size = [Math]::Max(64, [Math]::Min(200, [double]$script:settings.petSize))
  $window.Width = $size
  $window.Height = $size
  $window.UpdateLayout()
  if (Try-RestoreSavedPlacement) { return }
  $area = [System.Windows.SystemParameters]::WorkArea
  $margin = 20
  switch ([string]$script:settings.petPosition) {
    'top-left' { $window.Left = $area.Left + $margin; $window.Top = $area.Top + $margin }
    'top-right' { $window.Left = $area.Right - $size - $margin; $window.Top = $area.Top + $margin }
    'bottom-left' { $window.Left = $area.Left + $margin; $window.Top = $area.Bottom - $size - $margin }
    default { $window.Left = $area.Right - $size - $margin; $window.Top = $area.Bottom - $size - $margin }
  }
}

function Write-PositionEvent {
  $placement = [DeepSeekPetNativeCursor]::CapturePlacement($script:windowHandle)
  if ($null -eq $placement -or [string]::IsNullOrWhiteSpace($placement.Display)) { return }
  $message = [pscustomobject]@{
    event = 'position'
    display = [string]$placement.Display
    xRatio = [double]$placement.XRatio
    yRatio = [double]$placement.YRatio
  }
  [Console]::Out.WriteLine(($message | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

function Set-StateVisual {
  $script:visualMode = 'state'
  $script:visualUntil = [DateTime]::MinValue
  Set-TopmostForState
  Clear-Animations
  $groundShadow.Opacity = 0.2
  switch ($script:state) {
    'working' {
      $petBubble.Background = Brush '#4D6BFE'
      $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#4D6BFE')
      $ring.Stroke = Brush '#4D6BFE'
      $ring.Opacity = 0.85
      $bubbles.Opacity = 1
      $badge.Visibility = 'Visible'
      $badge.Background = Brush '#4D6BFE'
      $badgeText.Text = '...'
      $badgeText.FontSize = 9
      if (-not $script:motionEnabled) { return }
      $petMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, (New-Animation -4 4 0.45))
      $petMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (New-Animation -2 2 0.34))
      $petRotation.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, (New-Animation -7 7 0.45))
      Animate-Scale 0.98 1.06 0.34
      $ringRotation.BeginAnimation(
        [System.Windows.Media.RotateTransform]::AngleProperty,
        (New-Animation 0 360 1.2 $false)
      )
      $bubbleOneMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (New-Animation 10 -25 1.0 $false))
      $bubbleTwoMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (New-Animation 12 -20 0.8 $false 0.25))
    }
    'confirmation' {
      $petBubble.Background = Brush '#F59E0B'
      $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#F59E0B')
      $ring.Stroke = Brush '#F59E0B'
      $ring.Opacity = 1
      $bubbles.Opacity = 0
      $badge.Visibility = 'Visible'
      $badge.Background = Brush '#EF4444'
      $badgeText.Text = '!'
      $badgeText.FontSize = 16
      if (-not $script:motionEnabled) { return }
      $petMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, (New-Animation -5 5 0.10))
      $petMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (New-Animation 1 -7 0.28))
      $petRotation.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, (New-Animation -6 6 0.10))
      Animate-Scale 1 1.08 0.28
      $ring.BeginAnimation([System.Windows.UIElement]::OpacityProperty, (New-Animation 0.45 1 0.32))
      $ringRotation.BeginAnimation(
        [System.Windows.Media.RotateTransform]::AngleProperty,
        (New-Animation 0 360 0.65 $false)
      )
      $badgeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, (New-Animation 0.9 1.16 0.28))
      $badgeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, (New-Animation 0.9 1.16 0.28))
    }
    default {
      $petBubble.Background = Brush '#6477C9'
      $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#4D6BFE')
      $ring.Opacity = 0
      $bubbles.Opacity = 0
      $badge.Visibility = 'Collapsed'
      $script:nextIdleTrick = [DateTime]::UtcNow.AddSeconds((Get-Random -Minimum 5 -Maximum 10))
      if (-not $script:motionEnabled) { return }
      $petMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (New-Animation -3 3 1.55))
      $petRotation.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, (New-Animation -3 3 2.1))
      Animate-Scale 0.98 1.03 1.25
    }
  }
}

function Show-Hatch {
  if (-not $script:motionEnabled) {
    Set-StateVisual
    return
  }
  $script:visualMode = 'hatch'
  $script:visualUntil = [DateTime]::UtcNow.AddSeconds(1.55)
  $window.Topmost = $true
  Clear-Animations
  $petBubble.Background = Brush '#4D6BFE'
  $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#4D6BFE')
  $ring.Opacity = 0
  $bubbles.Opacity = 0
  $sparks.Opacity = 0
  $badge.Visibility = 'Collapsed'
  $hatchShell.Visibility = 'Visible'
  $hatchGlow.Opacity = 0.08
  $groundShadow.Opacity = 0.16

  $hatchGlow.BeginAnimation(
    [System.Windows.UIElement]::OpacityProperty,
    (New-OneShotAnimation 0.08 0.48 0.42 $true 0.28)
  )
  $hatchTopMotion.BeginAnimation(
    [System.Windows.Media.TranslateTransform]::YProperty,
    (New-OneShotAnimation 0 -27 0.48 $false 0.32)
  )
  $hatchBottomMotion.BeginAnimation(
    [System.Windows.Media.TranslateTransform]::YProperty,
    (New-OneShotAnimation 0 28 0.48 $false 0.32)
  )
  $hatchTop.BeginAnimation(
    [System.Windows.UIElement]::OpacityProperty,
    (New-OneShotAnimation 1 0 0.4 $false 0.52)
  )
  $hatchBottom.BeginAnimation(
    [System.Windows.UIElement]::OpacityProperty,
    (New-OneShotAnimation 1 0 0.4 $false 0.52)
  )
  Animate-OneShotScale $petEntranceScale 0.08 1 0.55 $false 0.38
  $petEntranceMotion.BeginAnimation(
    [System.Windows.Media.TranslateTransform]::YProperty,
    (New-OneShotAnimation 18 0 0.55 $false 0.38)
  )
  Animate-OneShotScale $groundShadowScale 0.35 1 0.55 $false 0.38
}

function Show-Outcome([string]$outcome) {
  # A pending decision is always the highest-priority global status.
  if ($script:state -eq 'confirmation') { return }
  $script:visualMode = $outcome
  $script:visualUntil = [DateTime]::UtcNow.AddSeconds(1.8)
  $window.Topmost = $true
  Clear-Animations
  $bubbles.Opacity = 0
  $ring.Opacity = 0.9
  $badge.Visibility = 'Visible'
  $groundShadow.Opacity = 0.2

  if ($outcome -eq 'ready') {
    $petBubble.Background = Brush '#10B981'
    $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#10B981')
    $ring.Stroke = Brush '#34D399'
    $badge.Background = Brush '#10B981'
    $badgeText.Text = [char]0x2713
    $badgeText.FontSize = 16
    $sparks.Opacity = 1
    if (-not $script:motionEnabled) { return }
    $petMotion.BeginAnimation(
      [System.Windows.Media.TranslateTransform]::YProperty,
      (New-OneShotAnimation 0 -12 0.28 $true)
    )
    $petRotation.BeginAnimation(
      [System.Windows.Media.RotateTransform]::AngleProperty,
      (New-OneShotAnimation -7 7 0.2 $true 0.08)
    )
    Animate-OneShotScale $petEntranceScale 0.84 1.12 0.3 $true
    $ringRotation.BeginAnimation(
      [System.Windows.Media.RotateTransform]::AngleProperty,
      (New-OneShotAnimation 0 360 0.75)
    )
    $sparkOneMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (New-OneShotAnimation 8 -20 0.62 $true))
    $sparkTwoMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (New-OneShotAnimation 8 -17 0.55 $true 0.08))
    $sparkThreeMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (New-OneShotAnimation 8 -22 0.68 $true 0.04))
    $sparkFourMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (New-OneShotAnimation 8 -18 0.58 $true 0.12))
  } else {
    $petBubble.Background = Brush '#EF4444'
    $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#EF4444')
    $ring.Stroke = Brush '#F87171'
    $badge.Background = Brush '#DC2626'
    $badgeText.Text = [char]0x00D7
    $badgeText.FontSize = 17
    $sparks.Opacity = 0
    if (-not $script:motionEnabled) { return }
    $petMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, (New-Animation -6 6 0.09))
    $petRotation.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, (New-Animation -5 5 0.09))
    $ring.BeginAnimation([System.Windows.UIElement]::OpacityProperty, (New-Animation 0.35 1 0.25))
    $badgeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, (New-Animation 0.9 1.15 0.24))
    $badgeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, (New-Animation 0.9 1.15 0.24))
  }
}

function Play-IdleTrick {
  if (-not $script:motionEnabled -or $script:state -ne 'idle' -or $script:visualMode -ne 'state') { return }
  switch (Get-Random -Minimum 0 -Maximum 3) {
    0 {
      $petTrickMotion.BeginAnimation(
        [System.Windows.Media.TranslateTransform]::YProperty,
        (New-OneShotAnimation 0 -10 0.28 $true)
      )
    }
    1 {
      $petTrickRotation.BeginAnimation(
        [System.Windows.Media.RotateTransform]::AngleProperty,
        (New-OneShotAnimation 0 14 0.24 $true)
      )
    }
    default {
      $petTrickScale.BeginAnimation(
        [System.Windows.Media.ScaleTransform]::ScaleXProperty,
        (New-OneShotAnimation 1 1.12 0.24 $true)
      )
      $petTrickScale.BeginAnimation(
        [System.Windows.Media.ScaleTransform]::ScaleYProperty,
        (New-OneShotAnimation 1 0.88 0.24 $true)
      )
    }
  }
  $script:nextIdleTrick = [DateTime]::UtcNow.AddSeconds((Get-Random -Minimum 5 -Maximum 10))
}

function Finish-CustomSound {
  $script:soundPlaying = $false
  $script:mediaPlayer.Stop()
  $script:mediaPlayer.Close()
  if ($script:pendingStop) {
    $window.Close()
    $application.Shutdown()
  }
}

$script:mediaPlayer.Add_MediaEnded({ Finish-CustomSound })
$script:mediaPlayer.Add_MediaFailed({ Finish-CustomSound })

function Play-ConfiguredSound([string]$kind) {
  $choice = if ($kind -eq 'completion') {
    [string]$script:settings.completionSound
  } else {
    [string]$script:settings.confirmationSound
  }
  if ($choice -eq 'off') { return }
  if ($choice -eq 'custom') {
    $path = if ($kind -eq 'completion') {
      [string]$script:settings.completionCustomSoundPath
    } else {
      [string]$script:settings.confirmationCustomSoundPath
    }
    if ($path.Length -gt 0 -and (Test-Path -LiteralPath $path -PathType Leaf)) {
      $script:mediaPlayer.Stop()
      $script:mediaPlayer.Close()
      $script:mediaPlayer.Open([Uri]::new($path))
      $script:mediaPlayer.Play()
      $script:soundPlaying = $true
      $script:soundDeadline = [DateTime]::UtcNow.AddSeconds(30)
      return
    }
    $choice = 'subtle'
  }
  if ($kind -eq 'completion') {
    if ($choice -eq 'prominent') { [System.Media.SystemSounds]::Exclamation.Play() }
    else { [System.Media.SystemSounds]::Asterisk.Play() }
  } else {
    if ($choice -eq 'prominent') { [System.Media.SystemSounds]::Hand.Play() }
    else { [System.Media.SystemSounds]::Question.Play() }
  }
}

function Request-Stop {
  $script:stopping = $true
  if ($script:soundPlaying) {
    $script:pendingStop = $true
    $window.Visibility = 'Hidden'
  } else {
    $window.Close()
    $application.Shutdown()
  }
}

function Apply-Message($message) {
  switch ([string]$message.command) {
    'config' {
      $wasVisible = $window.Visibility -eq [System.Windows.Visibility]::Visible
      $script:settings = $message.config
      Set-Placement
      if ([bool]$script:settings.petEnabled) {
        $window.Visibility = 'Visible'
        if (-not $wasVisible) { Show-Hatch }
        elseif ($script:visualMode -eq 'state') { Set-TopmostForState }
      } else {
        $window.Visibility = 'Hidden'
        Set-StateVisual
      }
    }
    'state' {
      $script:state = [string]$message.state
      if ($script:state -eq 'confirmation' -or $script:visualMode -eq 'state') {
        Set-StateVisual
      }
    }
    'effect' { Show-Outcome ([string]$message.outcome) }
    'sound' { Play-ConfiguredSound ([string]$message.kind) }
    'stop' { Request-Stop }
  }
}

$window.Add_MouseEnter({
  [System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::Arrow
  [DeepSeekPetNativeCursor]::SetCursor($script:arrowCursorHandle) | Out-Null
  $window.Cursor = [System.Windows.Input.Cursors]::Arrow
  $motion.Cursor = [System.Windows.Input.Cursors]::Arrow
  $petVisual.Cursor = [System.Windows.Input.Cursors]::Arrow
  if ($script:motionEnabled) {
    Animate-OneShotScale $petHoverScale 1 1.09 0.16 $true
  }
})
$window.Add_MouseMove({
  if ($_.LeftButton -eq [System.Windows.Input.MouseButtonState]::Pressed) {
    [DeepSeekPetNativeCursor]::SetCursor($script:sizeAllCursorHandle) | Out-Null
  } else {
    [DeepSeekPetNativeCursor]::SetCursor($script:arrowCursorHandle) | Out-Null
  }
})
$window.Add_MouseLeftButtonDown({
  $script:isDragging = $true
  [System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::SizeAll
  [DeepSeekPetNativeCursor]::SetCursor($script:sizeAllCursorHandle) | Out-Null
  $window.Cursor = [System.Windows.Input.Cursors]::SizeAll
  if ($_.ButtonState -eq [System.Windows.Input.MouseButtonState]::Pressed) {
    try { $window.DragMove() } finally {
      $script:isDragging = $false
      $script:placementPending = $false
      Write-PositionEvent
      [System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::Arrow
      [DeepSeekPetNativeCursor]::SetCursor($script:arrowCursorHandle) | Out-Null
      $window.Cursor = [System.Windows.Input.Cursors]::Arrow
    }
  }
})
$window.Add_MouseLeftButtonUp({
  $script:isDragging = $false
  [System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::Arrow
  [DeepSeekPetNativeCursor]::SetCursor($script:arrowCursorHandle) | Out-Null
  $window.Cursor = [System.Windows.Input.Cursors]::Arrow
})

# WM_MOVING constrains only uncovered outer desktop edges; adjacent monitor
# work areas remain open so the pet can cross between displays. Display changes
# are deferred to the normal Dispatcher tick so they cannot re-enter a drag.
$script:windowSource = [System.Windows.Interop.HwndSource]::FromHwnd($script:windowHandle)
$script:windowHook = [System.Windows.Interop.HwndSourceHook]{
  param($hwnd, $message, $wParam, $lParam, [ref]$handled)
  if ($message -eq 0x0216 -and $script:isDragging) {
    [DeepSeekPetNativeCursor]::ConstrainMovingRect($lParam) | Out-Null
  }
  if ($message -eq 0x007E) { $script:placementPending = $true }
  return [IntPtr]::Zero
}
$script:windowSource.AddHook($script:windowHook)

# A background .NET thread owns the blocking stdin read. Windows PowerShell 5
# may block before ReadLineAsync returns, so starting it on the Dispatcher would
# make the window look hung and turn the mouse cursor into a busy spinner.
# This timer only drains already-queued messages; WPF animations run natively.
$inputTimer = [System.Windows.Threading.DispatcherTimer]::new()
$inputTimer.Interval = [TimeSpan]::FromMilliseconds(80)
$inputTimer.Add_Tick({
  $now = [DateTime]::UtcNow
  if ($script:placementPending -and -not $script:isDragging) {
    $script:placementPending = $false
    Set-Placement
  }
  if ($script:soundPlaying -and [DateTime]::UtcNow -ge $script:soundDeadline) {
    Finish-CustomSound
  }
  if ($script:visualMode -ne 'state' -and $now -ge $script:visualUntil) {
    Set-StateVisual
  }
  $shouldPlayIdleTrick = $window.Visibility -eq [System.Windows.Visibility]::Visible -and $script:state -eq 'idle' -and $script:visualMode -eq 'state' -and $now -ge $script:nextIdleTrick
  if ($shouldPlayIdleTrick) {
    Play-IdleTrick
  }
  [string]$line = $null
  while ($inputReader.TryDequeue([ref]$line)) {
    if ($line.Trim().Length -gt 0) {
      try {
        Apply-Message ($line | ConvertFrom-Json)
      } catch {
        [Console]::Error.WriteLine("desktop pet message failed: $($_.Exception.Message)")
      }
    }
    $line = $null
  }
  if ($inputReader.IsComplete -and -not $script:stopping) {
    Request-Stop
  }
})

$window.Add_Closed({
  $script:stopping = $true
  $inputTimer.Stop()
  $script:mediaPlayer.Stop()
  $script:mediaPlayer.Close()
  if ($null -ne $script:windowSource -and $null -ne $script:windowHook) {
    $script:windowSource.RemoveHook($script:windowHook)
  }
  [System.Windows.Input.Mouse]::OverrideCursor = $null
  $application.Shutdown()
})

Set-Placement
Set-StateVisual
$inputTimer.Start()
$null = $application.Run()
