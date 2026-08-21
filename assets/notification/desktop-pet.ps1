param(
  [Parameter(Mandatory = $true)]
  [string]$SpritePath,
  [Parameter(Mandatory = $true)]
  [string]$IdleSpritePath
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

  private static long EdgeDistanceSquared(NativeRect first, NativeRect second) {
    long dx = 0;
    long dy = 0;
    if (first.Right < second.Left) dx = (long)second.Left - first.Right;
    else if (second.Right < first.Left) dx = (long)first.Left - second.Right;
    if (first.Bottom < second.Top) dy = (long)second.Top - first.Bottom;
    else if (second.Bottom < first.Top) dy = (long)first.Top - second.Bottom;
    return dx * dx + dy * dy;
  }

  private static bool TrySelectNearestMonitor(NativeRect bounds, out MonitorInfo target) {
    var monitors = ReadMonitors();
    target = new MonitorInfo();
    if (monitors.Count == 0) return false;

    target = monitors[0];
    long bestIntersection = -1;
    long bestEdgeDistance = Int64.MaxValue;
    long bestCenterDistance = Int64.MaxValue;
    foreach (var monitor in monitors) {
      var intersection = IntersectionArea(bounds, monitor.Work);
      var edgeDistance = EdgeDistanceSquared(bounds, monitor.Work);
      var centerDistance = CenterDistanceSquared(bounds, monitor.Work);
      if (
        intersection > bestIntersection
        || (intersection == bestIntersection && edgeDistance < bestEdgeDistance)
        || (
          intersection == bestIntersection
          && edgeDistance == bestEdgeDistance
          && centerDistance < bestCenterDistance
        )
      ) {
        target = monitor;
        bestIntersection = intersection;
        bestEdgeDistance = edgeDistance;
        bestCenterDistance = centerDistance;
      }
    }
    return true;
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

  public static DeepSeekPetPlacement CapturePlacement(IntPtr window) {
    NativeRect bounds;
    if (!GetWindowRect(window, out bounds)) return null;
    MonitorInfo info;
    if (!TrySelectNearestMonitor(bounds, out info)) return null;
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

public static class DeepSeekNotificationGain {
  private const ushort PcmFormat = 1;
  private const ushort FloatFormat = 3;
  private const ushort ExtensibleFormat = 0xfffe;

  private static bool Matches(byte[] bytes, int offset, string value) {
    if (offset < 0 || offset + value.Length > bytes.Length) return false;
    for (var index = 0; index < value.Length; index++) {
      if (bytes[offset + index] != (byte)value[index]) return false;
    }
    return true;
  }

  private static ushort ReadUInt16(byte[] bytes, int offset) {
    return (ushort)(bytes[offset] | (bytes[offset + 1] << 8));
  }

  private static uint ReadUInt32(byte[] bytes, int offset) {
    return (uint)(bytes[offset]
      | (bytes[offset + 1] << 8)
      | (bytes[offset + 2] << 16)
      | (bytes[offset + 3] << 24));
  }

  private static bool IsWaveSubFormat(byte[] bytes, int offset, ushort format) {
    var tail = new byte[] { 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71 };
    if (offset < 0 || offset + 16 > bytes.Length) return false;
    if (ReadUInt32(bytes, offset) != format) return false;
    for (var index = 0; index < tail.Length; index++) {
      if (bytes[offset + 4 + index] != tail[index]) return false;
    }
    return true;
  }

  private static double Limit(double sample, double multiplier) {
    if (Double.IsNaN(sample) || Double.IsInfinity(sample)) return 0;
    var amplified = sample * multiplier;
    var magnitude = Math.Abs(amplified);
    if (magnitude <= 0.9) return amplified;
    var limited = 0.9 + (0.1 * Math.Tanh((magnitude - 0.9) / 0.1));
    return Math.Max(-1, Math.Min(1, Math.Sign(amplified) * limited));
  }

  private static void WriteInt16(byte[] bytes, int offset, double sample) {
    var scaled = (int)Math.Round(sample * 32768.0, MidpointRounding.AwayFromZero);
    scaled = Math.Max(Int16.MinValue, Math.Min(Int16.MaxValue, scaled));
    bytes[offset] = (byte)(scaled & 0xff);
    bytes[offset + 1] = (byte)((scaled >> 8) & 0xff);
  }

  private static void WriteInt24(byte[] bytes, int offset, double sample) {
    var scaled = (int)Math.Round(sample * 8388608.0, MidpointRounding.AwayFromZero);
    scaled = Math.Max(-8388608, Math.Min(8388607, scaled));
    bytes[offset] = (byte)(scaled & 0xff);
    bytes[offset + 1] = (byte)((scaled >> 8) & 0xff);
    bytes[offset + 2] = (byte)((scaled >> 16) & 0xff);
  }

  private static void WriteInt32(byte[] bytes, int offset, double sample) {
    var scaled = (long)Math.Round(sample * 2147483648.0, MidpointRounding.AwayFromZero);
    scaled = Math.Max(Int32.MinValue, Math.Min(Int32.MaxValue, scaled));
    var value = (int)scaled;
    bytes[offset] = (byte)(value & 0xff);
    bytes[offset + 1] = (byte)((value >> 8) & 0xff);
    bytes[offset + 2] = (byte)((value >> 16) & 0xff);
    bytes[offset + 3] = (byte)((value >> 24) & 0xff);
  }

  private static bool AmplifyPcm(
    byte[] bytes,
    int dataOffset,
    int dataSize,
    ushort channels,
    ushort blockAlign,
    ushort bitsPerSample,
    double multiplier
  ) {
    var bytesPerSample = bitsPerSample / 8;
    if (channels == 0 || (bitsPerSample != 8 && bitsPerSample != 16
      && bitsPerSample != 24 && bitsPerSample != 32)
      || blockAlign < channels * bytesPerSample) return false;
    for (var frame = 0; frame + blockAlign <= dataSize; frame += blockAlign) {
      for (var channel = 0; channel < channels; channel++) {
        var offset = dataOffset + frame + (channel * bytesPerSample);
        if (bitsPerSample == 8) {
          var sample = (bytes[offset] - 128) / 128.0;
          var scaled = (int)Math.Round((Limit(sample, multiplier) * 128.0) + 128.0,
            MidpointRounding.AwayFromZero);
          bytes[offset] = (byte)Math.Max(0, Math.Min(255, scaled));
        } else if (bitsPerSample == 16) {
          var raw = (short)ReadUInt16(bytes, offset);
          WriteInt16(bytes, offset, Limit(raw / 32768.0, multiplier));
        } else if (bitsPerSample == 24) {
          var raw = bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16);
          if ((raw & 0x800000) != 0) raw |= unchecked((int)0xff000000);
          WriteInt24(bytes, offset, Limit(raw / 8388608.0, multiplier));
        } else {
          var raw = BitConverter.ToInt32(bytes, offset);
          WriteInt32(bytes, offset, Limit(raw / 2147483648.0, multiplier));
        }
      }
    }
    return true;
  }

  private static bool AmplifyFloat(
    byte[] bytes,
    int dataOffset,
    int dataSize,
    ushort channels,
    ushort blockAlign,
    ushort bitsPerSample,
    double multiplier
  ) {
    var bytesPerSample = bitsPerSample / 8;
    if (channels == 0 || (bitsPerSample != 32 && bitsPerSample != 64)
      || blockAlign < channels * bytesPerSample) return false;
    for (var frame = 0; frame + blockAlign <= dataSize; frame += blockAlign) {
      for (var channel = 0; channel < channels; channel++) {
        var offset = dataOffset + frame + (channel * bytesPerSample);
        var sample = bitsPerSample == 32
          ? (double)BitConverter.ToSingle(bytes, offset)
          : BitConverter.ToDouble(bytes, offset);
        var encoded = bitsPerSample == 32
          ? BitConverter.GetBytes((float)Limit(sample, multiplier))
          : BitConverter.GetBytes(Limit(sample, multiplier));
        Buffer.BlockCopy(encoded, 0, bytes, offset, bytesPerSample);
      }
    }
    return true;
  }

  public static string CreateAmplifiedCopy(string sourcePath, int gainPercent) {
    if (String.IsNullOrEmpty(sourcePath) || gainPercent <= 0) return sourcePath;
    gainPercent = Math.Max(0, Math.Min(100, gainPercent));
    var bytes = File.ReadAllBytes(sourcePath);
    if (bytes.Length < 12 || !Matches(bytes, 0, "RIFF") || !Matches(bytes, 8, "WAVE")) {
      return sourcePath;
    }

    var formatOffset = -1;
    var formatSize = 0;
    var dataOffset = -1;
    var dataSize = 0;
    var chunkOffset = 12;
    while (chunkOffset + 8 <= bytes.Length) {
      var rawSize = ReadUInt32(bytes, chunkOffset + 4);
      if (rawSize > Int32.MaxValue) return sourcePath;
      var chunkSize = (int)rawSize;
      var contentOffset = chunkOffset + 8;
      var contentEnd = (long)contentOffset + chunkSize;
      if (contentEnd > bytes.Length) return sourcePath;
      if (formatOffset < 0 && Matches(bytes, chunkOffset, "fmt ")) {
        formatOffset = contentOffset;
        formatSize = chunkSize;
      } else if (dataOffset < 0 && Matches(bytes, chunkOffset, "data")) {
        dataOffset = contentOffset;
        dataSize = chunkSize;
      }
      var paddedSize = (long)chunkSize + (chunkSize & 1);
      var nextOffset = (long)contentOffset + paddedSize;
      if (nextOffset > Int32.MaxValue || nextOffset <= chunkOffset) return sourcePath;
      chunkOffset = (int)nextOffset;
    }
    if (formatOffset < 0 || formatSize < 16 || dataOffset < 0 || dataSize == 0) return sourcePath;

    var format = ReadUInt16(bytes, formatOffset);
    var channels = ReadUInt16(bytes, formatOffset + 2);
    var blockAlign = ReadUInt16(bytes, formatOffset + 12);
    var bitsPerSample = ReadUInt16(bytes, formatOffset + 14);
    if (format == ExtensibleFormat) {
      if (formatSize < 40 || ReadUInt16(bytes, formatOffset + 16) < 22) return sourcePath;
      if (IsWaveSubFormat(bytes, formatOffset + 24, PcmFormat)) format = PcmFormat;
      else if (IsWaveSubFormat(bytes, formatOffset + 24, FloatFormat)) format = FloatFormat;
      else return sourcePath;
    }

    var multiplier = 1.0 + (gainPercent / 100.0);
    var changed = format == PcmFormat
      ? AmplifyPcm(bytes, dataOffset, dataSize, channels, blockAlign, bitsPerSample, multiplier)
      : format == FloatFormat
        && AmplifyFloat(bytes, dataOffset, dataSize, channels, blockAlign, bitsPerSample, multiplier);
    if (!changed) return sourcePath;

    var outputPath = Path.Combine(
      Path.GetTempPath(),
      "dsh-notification-" + Guid.NewGuid().ToString("N") + ".wav"
    );
    File.WriteAllBytes(outputPath, bytes);
    return outputPath;
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
    <Ellipse x:Name="GroundShadow" Width="55" Height="11" Margin="0,0,0,5"
             HorizontalAlignment="Center" VerticalAlignment="Bottom"
             Fill="#172554" Opacity="0.2" IsHitTestVisible="False" />

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

    <Grid x:Name="PetVisual" Margin="4" RenderTransformOrigin="0.5,0.5"
          Cursor="Arrow" ForceCursor="True">
      <Grid.RenderTransform>
        <TransformGroup>
          <ScaleTransform x:Name="PetScale" ScaleX="1" ScaleY="1" />
          <ScaleTransform x:Name="PetTrickScale" ScaleX="1" ScaleY="1" />
          <ScaleTransform x:Name="PetHoverScale" ScaleX="1" ScaleY="1" />
          <RotateTransform x:Name="PetRotation" />
          <RotateTransform x:Name="PetTrickRotation" />
          <TranslateTransform x:Name="PetMotion" />
          <TranslateTransform x:Name="PetTrickMotion" />
        </TransformGroup>
      </Grid.RenderTransform>
      <Border x:Name="PetBubble" CornerRadius="999" Background="Transparent">
        <Border.Effect>
          <DropShadowEffect x:Name="Shadow" BlurRadius="18" ShadowDepth="4" Opacity="0.35" Color="#4D6BFE" />
        </Border.Effect>
        <Image x:Name="SpriteFrame" Stretch="Uniform" IsHitTestVisible="False"
               RenderOptions.BitmapScalingMode="HighQuality" SnapsToDevicePixels="True" />
      </Border>
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
$groundShadow = $window.FindName('GroundShadow')
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
$petBubble = $window.FindName('PetBubble')
$shadow = $window.FindName('Shadow')
$spriteFrame = $window.FindName('SpriteFrame')
$badge = $window.FindName('Badge')
$badgeScale = $window.FindName('BadgeScale')
$badgeText = $window.FindName('BadgeText')

# PowerShell can leave an application-starting cursor associated with its WPF
# dispatcher even after the window is responsive. Override it for this process
# so merely hovering the pet never shows a busy cursor.
[System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::Arrow
$script:arrowCursorHandle = [DeepSeekPetNativeCursor]::LoadCursor([IntPtr]::Zero, 32512)
$script:sizeAllCursorHandle = [DeepSeekPetNativeCursor]::LoadCursor([IntPtr]::Zero, 32646)

function Read-SpriteBitmap([string]$path, [string]$description) {
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Desktop pet $description sprite sheet does not exist: $path"
  }
  $stream = [System.IO.File]::OpenRead($path)
  try {
    $bitmap = [System.Windows.Media.Imaging.BitmapImage]::new()
    $bitmap.BeginInit()
    $bitmap.CacheOption = [System.Windows.Media.Imaging.BitmapCacheOption]::OnLoad
    $bitmap.StreamSource = $stream
    $bitmap.EndInit()
    $bitmap.Freeze()
    return $bitmap
  } finally {
    $stream.Dispose()
  }
}

$spriteBitmap = Read-SpriteBitmap $SpritePath 'state'
$idleSpriteBitmap = Read-SpriteBitmap $IdleSpritePath 'idle interaction'
$script:spriteFrameCount = 5
$script:spriteRows = [ordered]@{
  idle = 0
  working = 1
  confirmation = 2
  ready = 3
  blocked = 4
}
if ($spriteBitmap.PixelWidth -ne 1536 -or $spriteBitmap.PixelHeight -ne 1024) {
  throw 'Desktop pet state sprite sheet must be the bundled 1536 by 1024 frame grid.'
}
if ($idleSpriteBitmap.PixelWidth -ne 1536 -or $idleSpriteBitmap.PixelHeight -ne 1024) {
  throw 'Desktop pet idle interaction sprite sheet must be the bundled 1536 by 1024 frame grid.'
}
# The generated sheet uses transparent gutters around each animation cell.
# These audited edges keep fins and state accents out of adjacent crops.
$script:spriteColumnEdges = @(0, 311, 609, 921, 1222, 1536)
$script:spriteRowEdges = @(0, 204, 396, 605, 786, 1024)
$script:spriteFrames = @{}
foreach ($spriteEntry in $script:spriteRows.GetEnumerator()) {
  $frames = @()
  for ($frameIndex = 0; $frameIndex -lt $script:spriteFrameCount; $frameIndex++) {
    $left = $script:spriteColumnEdges[$frameIndex]
    $right = $script:spriteColumnEdges[$frameIndex + 1]
    $top = $script:spriteRowEdges[$spriteEntry.Value]
    $bottom = $script:spriteRowEdges[$spriteEntry.Value + 1]
    $crop = [System.Windows.Int32Rect]::new($left, $top, $right - $left, $bottom - $top)
    $frame = [System.Windows.Media.Imaging.CroppedBitmap]::new($spriteBitmap, $crop)
    $frame.Freeze()
    $frames += $frame
  }
  $script:spriteFrames[$spriteEntry.Key] = $frames
}
$idleSpriteRows = [ordered]@{
  'idle-sleep' = 0
  'idle-eager' = 1
}
$idleSpriteColumnEdges = @(0, 307, 614, 921, 1228, 1536)
$idleSpriteRowEdges = @(0, 512, 1024)
foreach ($idleSpriteEntry in $idleSpriteRows.GetEnumerator()) {
  $frames = @()
  for ($frameIndex = 0; $frameIndex -lt $script:spriteFrameCount; $frameIndex++) {
    $left = $idleSpriteColumnEdges[$frameIndex]
    $right = $idleSpriteColumnEdges[$frameIndex + 1]
    $top = $idleSpriteRowEdges[$idleSpriteEntry.Value]
    $bottom = $idleSpriteRowEdges[$idleSpriteEntry.Value + 1]
    $crop = [System.Windows.Int32Rect]::new($left, $top, $right - $left, $bottom - $top)
    $frame = [System.Windows.Media.Imaging.CroppedBitmap]::new($idleSpriteBitmap, $crop)
    $frame.Freeze()
    $frames += $frame
  }
  $script:spriteFrames[$idleSpriteEntry.Key] = $frames
}

$script:settings = [pscustomobject]@{
  completionSound = 'subtle'
  confirmationSound = 'prominent'
  blockedSound = 'prominent'
  soundGain = 0
  completionCustomSoundPath = ''
  confirmationCustomSoundPath = ''
  blockedCustomSoundPath = ''
  petEnabled = $false
  petIdleTopmost = $true
  petSize = 112
  petPosition = 'bottom-right'
}
$script:state = 'idle'
$script:visualMode = 'state'
$script:visualUntil = [DateTime]::MinValue
$script:motionEnabled = [System.Windows.SystemParameters]::ClientAreaAnimation
$script:spriteState = 'idle-sleep'
$script:spriteFrameIndex = 0
$script:nextSpriteFrame = [DateTime]::MinValue
$script:spriteFrameDurations = @{
  'idle-sleep' = 650
  'idle-eager' = 110
  working = 100
  confirmation = 100
  ready = 120
  blocked = 130
}
$script:staticSpriteFrames = @{
  'idle-sleep' = 2
  'idle-eager' = 2
  working = 2
  confirmation = 2
  ready = 2
  blocked = 3
}
$script:isDragging = $false
$script:isPointerOver = $false
$script:placementPending = $false
$script:stopping = $false
$script:pendingStop = $false
$script:soundPlaying = $false
$script:soundDeadline = [DateTime]::MinValue
$script:amplifiedSoundPath = ''
$inputReader = [DeepSeekPetInputReader]::new([Console]::In)
$script:mediaPlayer = [System.Windows.Media.MediaPlayer]::new()

function Brush([string]$color) {
  return [System.Windows.Media.BrushConverter]::new().ConvertFromString($color)
}

function Show-SpriteFrame([int]$index) {
  $frames = $script:spriteFrames[$script:spriteState]
  if ($null -eq $frames -or $frames.Count -ne $script:spriteFrameCount) {
    throw "Desktop pet sprite state is unavailable: $($script:spriteState)"
  }
  $bounded = [Math]::Max(0, [Math]::Min($script:spriteFrameCount - 1, $index))
  $script:spriteFrameIndex = $bounded
  $spriteFrame.Source = $frames[$bounded]
}

function Set-SpriteState([string]$stateName) {
  if (-not $script:spriteFrames.ContainsKey($stateName)) { $stateName = 'idle-sleep' }
  if ($script:spriteState -eq $stateName -and $null -ne $spriteFrame.Source) { return }
  $script:spriteState = $stateName
  $script:nextSpriteFrame = [DateTime]::MinValue

  if (-not $script:motionEnabled) {
    Show-SpriteFrame ([int]$script:staticSpriteFrames[$stateName])
    return
  }

  Show-SpriteFrame 0
  $script:nextSpriteFrame = [DateTime]::UtcNow.AddMilliseconds(
    [double]$script:spriteFrameDurations[$stateName]
  )
}

function Advance-SpriteAnimation([DateTime]$now) {
  if (-not $script:motionEnabled -or $window.Visibility -ne [System.Windows.Visibility]::Visible) { return }
  if ($now -lt $script:nextSpriteFrame) { return }

  $nextFrame = $script:spriteFrameIndex + 1
  if ($nextFrame -ge $script:spriteFrameCount) { $nextFrame = 0 }
  Show-SpriteFrame $nextFrame
  $script:nextSpriteFrame = $now.AddMilliseconds(
    [double]$script:spriteFrameDurations[$script:spriteState]
  )
}

function Get-StateSpriteState {
  if ($script:state -ne 'idle') { return $script:state }
  if ($script:isDragging -or $script:isPointerOver) { return 'idle-eager' }
  return 'idle-sleep'
}

function Update-IdleInteractionVisual {
  if ($script:state -ne 'idle' -or $script:visualMode -ne 'state') { return }
  Set-SpriteState (Get-StateSpriteState)
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
  $petVisual.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $ringRotation.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
  $ring.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $sparks.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $badgeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $null)
  $badgeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $null)
  $bubbleOneMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $bubbleTwoMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $sparkOneMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $sparkTwoMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $sparkThreeMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $sparkFourMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
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
  $petVisual.Opacity = 1
  $ringRotation.Angle = 0
  $badgeScale.ScaleX = 1
  $badgeScale.ScaleY = 1
  $sparks.Opacity = 0
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
  Set-SpriteState (Get-StateSpriteState)
  $petBubble.Background = [System.Windows.Media.Brushes]::Transparent
  $groundShadow.Opacity = 0.2
  $bubbles.Opacity = 0
  $sparks.Opacity = 0
  $badge.Visibility = 'Collapsed'
  switch ($script:state) {
    'working' {
      $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#4D6BFE')
      $ring.Stroke = Brush '#4D6BFE'
      $ring.Opacity = 0.72
      if (-not $script:motionEnabled) { return }
      $ringRotation.BeginAnimation(
        [System.Windows.Media.RotateTransform]::AngleProperty,
        (New-Animation 0 360 1.2 $false)
      )
    }
    'confirmation' {
      $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#F59E0B')
      $ring.Stroke = Brush '#F59E0B'
      $ring.Opacity = 1
      if (-not $script:motionEnabled) { return }
      $ring.BeginAnimation([System.Windows.UIElement]::OpacityProperty, (New-Animation 0.45 1 0.32))
      $ringRotation.BeginAnimation(
        [System.Windows.Media.RotateTransform]::AngleProperty,
        (New-Animation 0 360 0.65 $false)
      )
    }
    default {
      $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#4D6BFE')
      $ring.Opacity = 0
    }
  }
}

function Show-Outcome([string]$outcome) {
  # A pending decision is always the highest-priority global status.
  if ($script:state -eq 'confirmation') { return }
  $script:visualMode = $outcome
  $script:visualUntil = [DateTime]::UtcNow.AddSeconds(1.8)
  $window.Topmost = $true
  Clear-Animations
  Set-SpriteState $outcome
  $petBubble.Background = [System.Windows.Media.Brushes]::Transparent
  $bubbles.Opacity = 0
  $ring.Opacity = 0
  $badge.Visibility = 'Collapsed'
  $groundShadow.Opacity = 0.2

  if ($outcome -eq 'ready') {
    $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#10B981')
  } else {
    $shadow.Color = [System.Windows.Media.ColorConverter]::ConvertFromString('#EF4444')
  }
}

function Remove-AmplifiedSound {
  if ($script:amplifiedSoundPath.Length -eq 0) { return }
  $path = $script:amplifiedSoundPath
  $script:amplifiedSoundPath = ''
  try {
    if (Test-Path -LiteralPath $path -PathType Leaf) {
      Remove-Item -LiteralPath $path -Force
    }
  } catch {
    # Media Foundation can briefly retain the file after Close; the OS will
    # eventually clean the profile-independent temporary directory.
  }
}

function Finish-Sound {
  $script:soundPlaying = $false
  $script:mediaPlayer.Stop()
  $script:mediaPlayer.Close()
  Remove-AmplifiedSound
  if ($script:pendingStop) {
    $window.Close()
    $application.Shutdown()
  }
}

$script:mediaPlayer.Add_MediaEnded({ Finish-Sound })
$script:mediaPlayer.Add_MediaFailed({ Finish-Sound })

function Resolve-SystemSoundPath([string]$alias, [string]$fallbackName) {
  $registryPath = "Registry::HKEY_CURRENT_USER\AppEvents\Schemes\Apps\.Default\$alias\.Current"
  try {
    if (Test-Path -LiteralPath $registryPath) {
      $configured = (Get-Item -LiteralPath $registryPath).GetValue('')
      if ($null -ne $configured -and ([string]$configured).Length -gt 0) {
        $expanded = [Environment]::ExpandEnvironmentVariables([string]$configured)
        if (Test-Path -LiteralPath $expanded -PathType Leaf) { return $expanded }
      }
    }
  } catch {
    # Fall back to the standard Windows media file below.
  }
  if ($null -ne $env:WINDIR -and ([string]$env:WINDIR).Length -gt 0) {
    $fallback = Join-Path ([string]$env:WINDIR) "Media\$fallbackName"
    if (Test-Path -LiteralPath $fallback -PathType Leaf) { return $fallback }
  }
  return ''
}

function Get-SoundGain {
  $percent = 0
  if ($null -ne $script:settings.soundGain) {
    $percent = [int]$script:settings.soundGain
  }
  return [Math]::Min(100, [Math]::Max(0, $percent))
}

function Play-MediaSound([string]$path) {
  if ($path.Length -eq 0 -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { return $false }
  $script:mediaPlayer.Stop()
  $script:mediaPlayer.Close()
  Remove-AmplifiedSound
  $playbackPath = $path
  try {
    $playbackPath = [DeepSeekNotificationGain]::CreateAmplifiedCopy($path, (Get-SoundGain))
  } catch {
    [Console]::Error.WriteLine("notification sound gain failed: $($_.Exception.Message)")
    $playbackPath = $path
  }
  if (-not [StringComparer]::OrdinalIgnoreCase.Equals($playbackPath, $path)) {
    $script:amplifiedSoundPath = $playbackPath
  }
  $script:mediaPlayer.Volume = 1.0
  $script:mediaPlayer.Open([Uri]::new($playbackPath))
  $script:mediaPlayer.Play()
  $script:soundPlaying = $true
  $script:soundDeadline = [DateTime]::UtcNow.AddSeconds(30)
  return $true
}

function Play-ConfiguredSound([string]$kind) {
  $choice = switch ($kind) {
    'completion' { [string]$script:settings.completionSound; break }
    'confirmation' { [string]$script:settings.confirmationSound; break }
    'blocked' { [string]$script:settings.blockedSound; break }
    default { return }
  }
  if ($choice -eq 'off') { return }
  if ($choice -eq 'custom') {
    $path = switch ($kind) {
      'completion' { [string]$script:settings.completionCustomSoundPath; break }
      'confirmation' { [string]$script:settings.confirmationCustomSoundPath; break }
      'blocked' { [string]$script:settings.blockedCustomSoundPath; break }
    }
    if (Play-MediaSound $path) { return }
    $choice = 'subtle'
  }
  $alias = ''
  $fallbackName = ''
  if ($kind -eq 'completion') {
    if ($choice -eq 'prominent') {
      $alias = 'SystemExclamation'
      $fallbackName = 'Windows Exclamation.wav'
    } else {
      $alias = 'SystemAsterisk'
      $fallbackName = 'Windows Ding.wav'
    }
  } elseif ($kind -eq 'confirmation') {
    if ($choice -eq 'prominent') {
      $alias = 'SystemExclamation'
      $fallbackName = 'Windows Exclamation.wav'
    } else {
      $alias = 'SystemQuestion'
      $fallbackName = 'Windows Default.wav'
    }
  } else {
    if ($choice -eq 'prominent') {
      $alias = 'SystemHand'
      $fallbackName = 'Windows Critical Stop.wav'
    } else {
      $alias = 'SystemQuestion'
      $fallbackName = 'Windows Default.wav'
    }
  }
  [void](Play-MediaSound (Resolve-SystemSoundPath $alias $fallbackName))
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
        if (-not $wasVisible) { Set-StateVisual }
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
  $script:isPointerOver = $true
  [System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::Arrow
  [DeepSeekPetNativeCursor]::SetCursor($script:arrowCursorHandle) | Out-Null
  $window.Cursor = [System.Windows.Input.Cursors]::Arrow
  $motion.Cursor = [System.Windows.Input.Cursors]::Arrow
  $petVisual.Cursor = [System.Windows.Input.Cursors]::Arrow
  if ($script:motionEnabled) {
    Animate-OneShotScale $petHoverScale 1 1.09 0.16 $true
  }
  Update-IdleInteractionVisual
})
$window.Add_MouseLeave({
  $script:isPointerOver = $false
  Update-IdleInteractionVisual
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
  Update-IdleInteractionVisual
  [System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::SizeAll
  [DeepSeekPetNativeCursor]::SetCursor($script:sizeAllCursorHandle) | Out-Null
  $window.Cursor = [System.Windows.Input.Cursors]::SizeAll
  if ($_.ButtonState -eq [System.Windows.Input.MouseButtonState]::Pressed) {
    try { $window.DragMove() } finally {
      $script:isDragging = $false
      $script:isPointerOver = [bool]$window.IsMouseOver
      $script:placementPending = $false
      Write-PositionEvent
      [System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::Arrow
      [DeepSeekPetNativeCursor]::SetCursor($script:arrowCursorHandle) | Out-Null
      $window.Cursor = [System.Windows.Input.Cursors]::Arrow
      Update-IdleInteractionVisual
    }
  }
})
$window.Add_MouseLeftButtonUp({
  $script:isDragging = $false
  $script:isPointerOver = [bool]$window.IsMouseOver
  [System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::Arrow
  [DeepSeekPetNativeCursor]::SetCursor($script:arrowCursorHandle) | Out-Null
  $window.Cursor = [System.Windows.Input.Cursors]::Arrow
  Update-IdleInteractionVisual
})

# DragMove remains unconstrained so the pet can follow the pointer beyond every
# desktop edge. Its finally block snaps and records the window after release.
# Display changes are deferred to the normal Dispatcher tick so they cannot
# re-enter a drag.
$script:windowSource = [System.Windows.Interop.HwndSource]::FromHwnd($script:windowHandle)
$script:windowHook = [System.Windows.Interop.HwndSourceHook]{
  param($hwnd, $message, $wParam, $lParam, [ref]$handled)
  if ($message -eq 0x007E) { $script:placementPending = $true }
  return [IntPtr]::Zero
}
$script:windowSource.AddHook($script:windowHook)

# A background .NET thread owns the blocking stdin read. Windows PowerShell 5
# may block before ReadLineAsync returns, so starting it on the Dispatcher would
# make the window look hung and turn the mouse cursor into a busy spinner.
# This timer drains queued messages and advances cached sprite frames; WPF
# still owns the ring and hover animations natively.
$inputTimer = [System.Windows.Threading.DispatcherTimer]::new()
$inputTimer.Interval = [TimeSpan]::FromMilliseconds(50)
$inputTimer.Add_Tick({
  $now = [DateTime]::UtcNow
  if ($script:placementPending -and -not $script:isDragging) {
    $script:placementPending = $false
    Set-Placement
  }
  if ($script:soundPlaying -and [DateTime]::UtcNow -ge $script:soundDeadline) {
    Finish-Sound
  }
  if ($script:visualMode -ne 'state' -and $now -ge $script:visualUntil) {
    Set-StateVisual
  }
  Advance-SpriteAnimation $now
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
  Remove-AmplifiedSound
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
