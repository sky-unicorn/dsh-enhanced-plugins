param(
  [Parameter(Mandatory = $true)]
  [string]$IconPath
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore, PresentationFramework, WindowsBase
Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public static class DeepSeekPetNativeCursor {
  [DllImport("user32.dll")]
  public static extern IntPtr LoadCursor(IntPtr instance, int cursorName);

  [DllImport("user32.dll")]
  public static extern IntPtr SetCursor(IntPtr cursor);
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

    <Grid x:Name="PetVisual" Margin="10" RenderTransformOrigin="0.5,0.5"
          Cursor="Arrow" ForceCursor="True">
      <Grid.RenderTransform>
        <TransformGroup>
          <ScaleTransform x:Name="PetScale" ScaleX="1" ScaleY="1" />
          <RotateTransform x:Name="PetRotation" />
          <TranslateTransform x:Name="PetMotion" />
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
</Window>
'@

$reader = [System.Xml.XmlNodeReader]::new($xaml)
$window = [System.Windows.Markup.XamlReader]::Load($reader)
$application = [System.Windows.Application]::new()
$application.ShutdownMode = [System.Windows.ShutdownMode]::OnExplicitShutdown
$motion = $window.FindName('Motion')
$ring = $window.FindName('Ring')
$ringRotation = $window.FindName('RingRotation')
$bubbles = $window.FindName('Bubbles')
$bubbleOneMotion = $window.FindName('BubbleOneMotion')
$bubbleTwoMotion = $window.FindName('BubbleTwoMotion')
$petVisual = $window.FindName('PetVisual')
$petMotion = $window.FindName('PetMotion')
$petRotation = $window.FindName('PetRotation')
$petScale = $window.FindName('PetScale')
$petBubble = $window.FindName('PetBubble')
$shadow = $window.FindName('Shadow')
$fish = $window.FindName('Fish')
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
  petSize = 112
  petPosition = 'bottom-right'
}
$script:state = 'idle'
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

function Clear-Animations {
  $petMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::XProperty, $null)
  $petMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $petRotation.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
  $petScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $null)
  $petScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $null)
  $ringRotation.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, $null)
  $ring.BeginAnimation([System.Windows.UIElement]::OpacityProperty, $null)
  $badgeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleXProperty, $null)
  $badgeScale.BeginAnimation([System.Windows.Media.ScaleTransform]::ScaleYProperty, $null)
  $bubbleOneMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $bubbleTwoMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, $null)
  $petMotion.X = 0
  $petMotion.Y = 0
  $petRotation.Angle = 0
  $petScale.ScaleX = 1
  $petScale.ScaleY = 1
  $ringRotation.Angle = 0
  $badgeScale.ScaleX = 1
  $badgeScale.ScaleY = 1
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

function Set-Placement {
  $size = [Math]::Max(64, [Math]::Min(200, [double]$script:settings.petSize))
  $window.Width = $size
  $window.Height = $size
  $area = [System.Windows.SystemParameters]::WorkArea
  $margin = 20
  switch ([string]$script:settings.petPosition) {
    'top-left' { $window.Left = $area.Left + $margin; $window.Top = $area.Top + $margin }
    'top-right' { $window.Left = $area.Right - $size - $margin; $window.Top = $area.Top + $margin }
    'bottom-left' { $window.Left = $area.Left + $margin; $window.Top = $area.Bottom - $size - $margin }
    default { $window.Left = $area.Right - $size - $margin; $window.Top = $area.Bottom - $size - $margin }
  }
}

function Set-StateVisual {
  Clear-Animations
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
      $petMotion.BeginAnimation([System.Windows.Media.TranslateTransform]::YProperty, (New-Animation -3 3 1.55))
      $petRotation.BeginAnimation([System.Windows.Media.RotateTransform]::AngleProperty, (New-Animation -3 3 2.1))
      Animate-Scale 0.98 1.03 1.25
    }
  }
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
      $script:settings = $message.config
      Set-Placement
      $window.Visibility = if ([bool]$script:settings.petEnabled) { 'Visible' } else { 'Hidden' }
    }
    'state' {
      $script:state = [string]$message.state
      Set-StateVisual
    }
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
})
$window.Add_MouseMove({
  if ($_.LeftButton -eq [System.Windows.Input.MouseButtonState]::Pressed) {
    [DeepSeekPetNativeCursor]::SetCursor($script:sizeAllCursorHandle) | Out-Null
  } else {
    [DeepSeekPetNativeCursor]::SetCursor($script:arrowCursorHandle) | Out-Null
  }
})
$window.Add_MouseLeftButtonDown({
  [System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::SizeAll
  [DeepSeekPetNativeCursor]::SetCursor($script:sizeAllCursorHandle) | Out-Null
  $window.Cursor = [System.Windows.Input.Cursors]::SizeAll
  if ($_.ButtonState -eq [System.Windows.Input.MouseButtonState]::Pressed) {
    try { $window.DragMove() } finally {
      [System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::Arrow
      [DeepSeekPetNativeCursor]::SetCursor($script:arrowCursorHandle) | Out-Null
      $window.Cursor = [System.Windows.Input.Cursors]::Arrow
    }
  }
})
$window.Add_MouseLeftButtonUp({
  [System.Windows.Input.Mouse]::OverrideCursor = [System.Windows.Input.Cursors]::Arrow
  [DeepSeekPetNativeCursor]::SetCursor($script:arrowCursorHandle) | Out-Null
  $window.Cursor = [System.Windows.Input.Cursors]::Arrow
})

# A background .NET thread owns the blocking stdin read. Windows PowerShell 5
# may block before ReadLineAsync returns, so starting it on the Dispatcher would
# make the window look hung and turn the mouse cursor into a busy spinner.
# This timer only drains already-queued messages; WPF animations run natively.
$inputTimer = [System.Windows.Threading.DispatcherTimer]::new()
$inputTimer.Interval = [TimeSpan]::FromMilliseconds(80)
$inputTimer.Add_Tick({
  if ($script:soundPlaying -and [DateTime]::UtcNow -ge $script:soundDeadline) {
    Finish-CustomSound
  }
  [string]$line = $null
  while ($inputReader.TryDequeue([ref]$line)) {
    if ($line.Trim().Length -gt 0) {
      try { Apply-Message ($line | ConvertFrom-Json) } catch { }
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
  [System.Windows.Input.Mouse]::OverrideCursor = $null
  $application.Shutdown()
})

Set-Placement
Set-StateVisual
$inputTimer.Start()
$null = $application.Run()
