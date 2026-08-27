using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace DshEnhanced.WindowsLauncher
{
    internal static class UiTheme
    {
        internal static readonly Color Background = Color.FromArgb(246, 248, 252);
        internal static readonly Color Surface = Color.White;
        internal static readonly Color SurfaceSoft = Color.FromArgb(247, 249, 253);
        internal static readonly Color Border = Color.FromArgb(224, 229, 239);
        internal static readonly Color BorderStrong = Color.FromArgb(207, 216, 231);
        internal static readonly Color Sidebar = Color.FromArgb(10, 18, 34);
        internal static readonly Color SidebarHover = Color.FromArgb(21, 34, 57);
        internal static readonly Color SidebarSelected = Color.FromArgb(32, 48, 78);
        internal static readonly Color Primary = Color.FromArgb(77, 107, 254);
        internal static readonly Color PrimaryHover = Color.FromArgb(63, 83, 238);
        internal static readonly Color PrimarySoft = Color.FromArgb(237, 240, 255);
        internal static readonly Color Text = Color.FromArgb(21, 30, 49);
        internal static readonly Color Muted = Color.FromArgb(103, 116, 140);
        internal static readonly Color Subtle = Color.FromArgb(142, 154, 176);
        internal static readonly Color Success = Color.FromArgb(20, 166, 119);
        internal static readonly Color Warning = Color.FromArgb(235, 148, 25);
        internal static readonly Color Danger = Color.FromArgb(218, 64, 76);

        internal static Font Font(float size, FontStyle style)
        {
            return new Font("Microsoft YaHei UI", size, style, GraphicsUnit.Point);
        }

        internal static int Dip(Control control, int value)
        {
            float scale = control == null ? 1f : Math.Max(1f, control.DeviceDpi / 96f);
            return Math.Max(value == 0 ? 0 : 1, (int)Math.Round(value * scale));
        }

        internal static float Dip(Control control, float value)
        {
            float scale = control == null ? 1f : Math.Max(1f, control.DeviceDpi / 96f);
            return value * scale;
        }

        internal static GraphicsPath RoundedRectangle(Rectangle bounds, int radius)
        {
            return RoundedRectangle(new RectangleF(bounds.X, bounds.Y, bounds.Width, bounds.Height), radius);
        }

        internal static GraphicsPath RoundedRectangle(RectangleF bounds, float radius)
        {
            float diameter = Math.Max(2f, radius * 2f);
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180f, 90f);
            path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270f, 90f);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0f, 90f);
            path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90f, 90f);
            path.CloseFigure();
            return path;
        }
    }

    internal class RoundedPanel : Panel
    {
        private int radius = 18;
        private Color borderColor = UiTheme.Border;

        internal int Radius { get { return radius; } set { radius = value; Invalidate(); } }
        internal Color BorderColor { get { return borderColor; } set { borderColor = value; Invalidate(); } }
        internal int LogicalPadding { get; set; }

        internal RoundedPanel()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw, true);
            BackColor = UiTheme.Surface;
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Parent == null ? UiTheme.Background : Parent.BackColor);
            int edge = UiTheme.Dip(this, 1);
            int scaledRadius = UiTheme.Dip(this, radius);
            using (GraphicsPath path = UiTheme.RoundedRectangle(new Rectangle(0, 0,
                Math.Max(1, Width - edge), Math.Max(1, Height - edge)), scaledRadius))
            using (SolidBrush brush = new SolidBrush(BackColor)) e.Graphics.FillPath(brush, path);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            int inset = UiTheme.Dip(this, 1);
            int reduction = UiTheme.Dip(this, 3);
            int scaledRadius = UiTheme.Dip(this, Math.Max(3, radius - 1));
            using (GraphicsPath path = UiTheme.RoundedRectangle(new Rectangle(inset, inset,
                Math.Max(1, Width - reduction), Math.Max(1, Height - reduction)), scaledRadius))
            using (Pen pen = new Pen(borderColor, UiTheme.Dip(this, 1f))) e.Graphics.DrawPath(pen, path);
        }
    }

    internal sealed class ModernScrollBar : Control
    {
        private int maximum;
        private int value;
        private int viewportSize = 1;
        private int smallChange;
        private int largeChange;
        private bool hovering;
        private bool dragging;
        private int dragOriginY;
        private int dragOriginValue;

        internal event EventHandler ValueChanged;

        internal int Maximum
        {
            get { return maximum; }
            set
            {
                int next = Math.Max(0, value);
                if (maximum == next) return;
                maximum = next;
                SetValue(this.value);
                Invalidate();
            }
        }

        internal int Value
        {
            get { return value; }
            set { SetValue(value); }
        }

        internal int ViewportSize
        {
            get { return viewportSize; }
            set { viewportSize = Math.Max(1, value); Invalidate(); }
        }

        internal int SmallChange
        {
            get { return smallChange; }
            set { smallChange = Math.Max(0, value); }
        }

        internal int LargeChange
        {
            get { return largeChange; }
            set { largeChange = Math.Max(0, value); }
        }

        internal ModernScrollBar()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                | ControlStyles.Selectable | ControlStyles.SupportsTransparentBackColor, true);
            BackColor = Color.Transparent;
            Cursor = Cursors.Hand;
            TabStop = true;
            AccessibleRole = AccessibleRole.ScrollBar;
            AccessibleName = "页面滚动条";
        }

        internal void ScrollBy(int amount)
        {
            SetValue(value + amount);
        }

        internal void ScrollPage(int direction)
        {
            int amount = largeChange > 0 ? largeChange
                : Math.Max(UiTheme.Dip(this, 80), viewportSize - UiTheme.Dip(this, 48));
            ScrollBy(direction * amount);
        }

        private void SetValue(int next)
        {
            next = Math.Max(0, Math.Min(maximum, next));
            if (value == next) return;
            value = next;
            Invalidate();
            EventHandler handler = ValueChanged;
            if (handler != null) handler(this, EventArgs.Empty);
        }

        private Rectangle ThumbBounds()
        {
            int inset = UiTheme.Dip(this, 1);
            int trackHeight = Math.Max(1, Height - (inset * 2));
            int contentSize = Math.Max(1, maximum + viewportSize);
            int thumbHeight = Math.Max(UiTheme.Dip(this, 34),
                (int)Math.Round(trackHeight * (viewportSize / (double)contentSize)));
            thumbHeight = Math.Min(trackHeight, thumbHeight);
            int travel = Math.Max(0, trackHeight - thumbHeight);
            int top = inset + (maximum == 0 ? 0
                : (int)Math.Round(travel * (value / (double)maximum)));
            return new Rectangle(inset, top, Math.Max(1, Width - (inset * 2)), thumbHeight);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            if (maximum <= 0) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            int trackWidth = Math.Max(UiTheme.Dip(this, 3), Width / 3);
            Rectangle track = new Rectangle((Width - trackWidth) / 2, UiTheme.Dip(this, 1),
                trackWidth, Math.Max(1, Height - UiTheme.Dip(this, 2)));
            Rectangle thumb = ThumbBounds();
            Color thumbColor = dragging ? UiTheme.PrimaryHover
                : hovering || Focused ? UiTheme.Primary : Color.FromArgb(161, 174, 198);
            using (GraphicsPath trackPath = UiTheme.RoundedRectangle(track, trackWidth / 2f))
            using (SolidBrush trackBrush = new SolidBrush(Color.FromArgb(232, 236, 244)))
            using (GraphicsPath thumbPath = UiTheme.RoundedRectangle(thumb, Math.Max(1f, thumb.Width / 2f)))
            using (SolidBrush thumbBrush = new SolidBrush(thumbColor))
            {
                e.Graphics.FillPath(trackBrush, trackPath);
                e.Graphics.FillPath(thumbBrush, thumbPath);
            }
        }

        protected override void OnMouseEnter(EventArgs e)
        {
            hovering = true;
            Invalidate();
            base.OnMouseEnter(e);
        }

        protected override void OnMouseLeave(EventArgs e)
        {
            hovering = false;
            if (!dragging) Invalidate();
            base.OnMouseLeave(e);
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            Focus();
            Rectangle thumb = ThumbBounds();
            if (e.Button == MouseButtons.Left && thumb.Contains(e.Location))
            {
                dragging = true;
                dragOriginY = e.Y;
                dragOriginValue = value;
                Capture = true;
                Invalidate();
            }
            else if (e.Button == MouseButtons.Left)
            {
                ScrollPage(e.Y < thumb.Top ? -1 : 1);
            }
            base.OnMouseDown(e);
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            if (dragging)
            {
                Rectangle thumb = ThumbBounds();
                int travel = Math.Max(1, Height - UiTheme.Dip(this, 2) - thumb.Height);
                SetValue(dragOriginValue + (int)Math.Round((e.Y - dragOriginY) * (maximum / (double)travel)));
            }
            base.OnMouseMove(e);
        }

        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (dragging)
            {
                dragging = false;
                Capture = false;
                Invalidate();
            }
            base.OnMouseUp(e);
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            int step = smallChange > 0 ? smallChange : UiTheme.Dip(this, 48);
            if (e.KeyCode == Keys.Up) ScrollBy(-step);
            else if (e.KeyCode == Keys.Down) ScrollBy(step);
            else if (e.KeyCode == Keys.PageUp) ScrollPage(-1);
            else if (e.KeyCode == Keys.PageDown) ScrollPage(1);
            else if (e.KeyCode == Keys.Home) Value = 0;
            else if (e.KeyCode == Keys.End) Value = maximum;
            else { base.OnKeyDown(e); return; }
            e.Handled = true;
            e.SuppressKeyPress = true;
        }

        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
    }

    internal sealed class ModernScrollPage : UserControl, IMessageFilter
    {
        private const int WmMouseWheel = 0x020A;
        private readonly Panel content;
        private readonly ModernScrollBar scrollBar;
        private readonly HashSet<Control> hookedControls = new HashSet<Control>();
        private Size minimumContentSize;
        private bool updatingMetrics;
        private bool messageFilterInstalled;

        internal Panel Content { get { return content; } }
        internal int ViewportWidth { get { return content.ClientSize.Width; } }
        internal int ScrollValue { get { return scrollBar.Value; } }
        internal bool ScrollBarVisible { get { return scrollBar.Visible; } }

        internal new Size AutoScrollMinSize
        {
            get { return minimumContentSize; }
            set
            {
                Size next = new Size(Math.Max(0, value.Width), Math.Max(0, value.Height));
                if (minimumContentSize == next) return;
                minimumContentSize = next;
                UpdateScrollMetrics();
            }
        }

        internal new Point AutoScrollPosition
        {
            get { return new Point(0, -scrollBar.Value); }
            set { scrollBar.Value = Math.Abs(value.Y); }
        }

        internal ModernScrollPage()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                | ControlStyles.Selectable, true);
            AutoScroll = false;
            TabStop = true;

            content = new Panel();
            content.BackColor = UiTheme.Background;
            content.TabStop = false;
            Controls.Add(content);

            scrollBar = new ModernScrollBar();
            scrollBar.Visible = false;
            scrollBar.ValueChanged += delegate { ApplyScrollPosition(); };
            Controls.Add(scrollBar);
            scrollBar.BringToFront();

            HookControlTree(content);
        }

        internal void ScrollBy(int amount)
        {
            scrollBar.ScrollBy(amount);
        }

        internal void ScrollToTop()
        {
            scrollBar.Value = 0;
        }

        internal static bool SelfTest()
        {
            using (ModernScrollPage page = new ModernScrollPage())
            {
                page.Size = new Size(320, 200);
                page.CreateControl();
                page.PerformLayout();
                page.AutoScrollMinSize = new Size(0, 700);
                page.ScrollBy(120);
                bool scrolled = page.ScrollBarVisible && page.ScrollValue == 120
                    && page.Content.Top == -120 && page.ViewportWidth < page.ClientSize.Width;
                page.AutoScrollPosition = new Point(0, 5000);
                bool clamped = page.ScrollValue == 500 && page.Content.Top == -500;
                page.AutoScrollMinSize = new Size(0, 100);
                bool reset = !page.ScrollBarVisible && page.ScrollValue == 0 && page.Content.Top == 0;
                return scrolled && clamped && reset;
            }
        }

        private void HookControlTree(Control control)
        {
            if (!hookedControls.Add(control)) return;
            control.Enter += OnContentControlEnter;
            control.ControlAdded += delegate(object sender, ControlEventArgs args) { HookControlTree(args.Control); };
            foreach (Control child in control.Controls) HookControlTree(child);
        }

        public bool PreFilterMessage(ref Message message)
        {
            if (message.Msg != WmMouseWheel || !Visible || !scrollBar.Visible || IsDisposed) return false;
            Point screenPoint = Control.MousePosition;
            if (!RectangleToScreen(ClientRectangle).Contains(screenPoint)) return false;
            Control hovered = DeepestControlAtPoint(this, screenPoint);
            if (hovered is TextBoxBase || hovered is ListBox || hovered is ComboBox) return false;
            int delta = (short)(((long)message.WParam >> 16) & 0xffff);
            if (delta == 0) return false;
            int lines = SystemInformation.MouseWheelScrollLines;
            int distance = lines < 0 ? Math.Max(1, ClientSize.Height - UiTheme.Dip(this, 48))
                : UiTheme.Dip(this, Math.Max(1, lines) * 42);
            scrollBar.ScrollBy(-(int)Math.Round(delta * (distance / 120d)));
            return true;
        }

        private static Control DeepestControlAtPoint(Control root, Point screenPoint)
        {
            Control current = root;
            while (current != null && current.HasChildren)
            {
                Point clientPoint = current.PointToClient(screenPoint);
                Control child = current.GetChildAtPoint(clientPoint,
                    GetChildAtPointSkip.Invisible | GetChildAtPointSkip.Disabled);
                if (child == null) break;
                current = child;
            }
            return current;
        }

        private void OnContentControlEnter(object sender, EventArgs e)
        {
            Control control = sender as Control;
            if (control == null || control == content || !content.Contains(control)) return;
            Rectangle visibleBounds = content.RectangleToClient(control.RectangleToScreen(control.ClientRectangle));
            int margin = UiTheme.Dip(this, 16);
            int viewportTop = scrollBar.Value;
            int viewportBottom = viewportTop + ClientSize.Height;
            if (visibleBounds.Top - margin < viewportTop)
                scrollBar.Value = Math.Max(0, visibleBounds.Top - margin);
            else if (visibleBounds.Bottom + margin > viewportBottom)
                scrollBar.Value = visibleBounds.Bottom + margin - ClientSize.Height;
        }

        private void UpdateScrollMetrics()
        {
            if (updatingMetrics || IsDisposed || content == null || scrollBar == null) return;
            updatingMetrics = true;
            try
            {
                int gutter = UiTheme.Dip(this, 16);
                int viewportWidth = Math.Max(1, ClientSize.Width - gutter);
                int viewportHeight = Math.Max(1, ClientSize.Height);
                int contentHeight = Math.Max(viewportHeight, minimumContentSize.Height);
                scrollBar.ViewportSize = viewportHeight;
                scrollBar.Maximum = Math.Max(0, contentHeight - viewportHeight);
                scrollBar.Visible = scrollBar.Maximum > 0;
                int barWidth = UiTheme.Dip(this, 9);
                int barInset = UiTheme.Dip(this, 4);
                scrollBar.SetBounds(Math.Max(0, ClientSize.Width - barWidth), barInset,
                    barWidth, Math.Max(1, ClientSize.Height - (barInset * 2)));
                content.SetBounds(0, -scrollBar.Value, viewportWidth, contentHeight);
                scrollBar.BringToFront();
            }
            finally { updatingMetrics = false; }
        }

        private void ApplyScrollPosition()
        {
            if (content.Top != -scrollBar.Value) content.Top = -scrollBar.Value;
        }

        protected override void OnLayout(LayoutEventArgs e)
        {
            base.OnLayout(e);
            UpdateScrollMetrics();
        }

        protected override void OnBackColorChanged(EventArgs e)
        {
            base.OnBackColorChanged(e);
            if (content != null) content.BackColor = BackColor;
        }

        protected override void OnHandleCreated(EventArgs e)
        {
            base.OnHandleCreated(e);
            if (!messageFilterInstalled)
            {
                Application.AddMessageFilter(this);
                messageFilterInstalled = true;
            }
        }

        protected override void OnHandleDestroyed(EventArgs e)
        {
            if (messageFilterInstalled)
            {
                Application.RemoveMessageFilter(this);
                messageFilterInstalled = false;
            }
            base.OnHandleDestroyed(e);
        }

        protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
        {
            Keys key = keyData & Keys.KeyCode;
            if ((keyData & Keys.Modifiers) == Keys.None && scrollBar.Visible)
            {
                if (key == Keys.PageUp) { scrollBar.ScrollPage(-1); return true; }
                if (key == Keys.PageDown) { scrollBar.ScrollPage(1); return true; }
                if (key == Keys.Home) { scrollBar.Value = 0; return true; }
                if (key == Keys.End) { scrollBar.Value = scrollBar.Maximum; return true; }
            }
            return base.ProcessCmdKey(ref msg, keyData);
        }
    }

    internal sealed class ModernRichTextBox : RichTextBox
    {
        internal event MouseEventHandler ThemedMouseWheel;

        protected override void OnMouseWheel(MouseEventArgs e)
        {
            MouseEventHandler handler = ThemedMouseWheel;
            if (handler != null)
            {
                handler(this, e);
                return;
            }
            base.OnMouseWheel(e);
        }
    }

    internal static class ModernTextAreaScroll
    {
        internal static void Attach(RoundedPanel shell, ModernRichTextBox editor)
        {
            if (shell == null) throw new ArgumentNullException("shell");
            if (editor == null) throw new ArgumentNullException("editor");
            new Binding(shell, editor);
        }

        internal static bool SelfTest()
        {
            using (RoundedPanel shell = new RoundedPanel())
            using (ModernRichTextBox editor = new ModernRichTextBox())
            {
                shell.Size = new Size(320, 160);
                shell.Padding = new Padding(12);
                shell.Controls.Add(editor);
                string content = "line 01";
                for (int index = 2; index <= 80; index++)
                    content += Environment.NewLine + "line " + index.ToString("D2", CultureInfo.InvariantCulture);
                editor.Text = content;
                Attach(shell, editor);
                shell.CreateControl();
                editor.CreateControl();
                shell.PerformLayout();
                ModernScrollBar themedBar = null;
                foreach (Control child in shell.Controls)
                {
                    themedBar = child as ModernScrollBar;
                    if (themedBar != null) break;
                }
                if (themedBar == null) return false;
                themedBar.Value = Math.Min(4, themedBar.Maximum);
                return themedBar.Visible
                    && themedBar.Maximum > 0
                    && themedBar.Value > 0
                    && editor.ScrollBars == RichTextBoxScrollBars.None
                    && editor.Dock == DockStyle.None
                    && editor.Right <= themedBar.Left;
            }
        }

        private sealed class Binding
        {
            private const int EmGetFirstVisibleLine = 0x00CE;
            private const int EmGetLineCount = 0x00BA;
            private const int EmLineScroll = 0x00B6;

            [DllImport("user32.dll", CharSet = CharSet.Auto)]
            private static extern IntPtr SendMessage(IntPtr handle, int message, IntPtr wParam, IntPtr lParam);

            private readonly RoundedPanel shell;
            private readonly ModernRichTextBox editor;
            private readonly ModernScrollBar scrollBar;
            private bool synchronizing;
            private int wheelRemainder;

            internal Binding(RoundedPanel shell, ModernRichTextBox editor)
            {
                this.shell = shell;
                this.editor = editor;
                scrollBar = new ModernScrollBar();
                scrollBar.Visible = false;
                scrollBar.AccessibleName = "内容滚动条";
                scrollBar.SmallChange = 1;
                shell.Controls.Add(scrollBar);
                scrollBar.BringToFront();

                editor.Dock = DockStyle.None;
                editor.ScrollBars = RichTextBoxScrollBars.None;
                editor.ThemedMouseWheel += OnEditorMouseWheel;
                editor.TextChanged += delegate { SyncFromEditor(); };
                editor.SelectionChanged += delegate { SyncFromEditor(); };
                editor.VScroll += delegate { SyncFromEditor(); };
                editor.Resize += delegate { SyncFromEditor(); };
                editor.FontChanged += delegate { SyncFromEditor(); };
                editor.HandleCreated += delegate { SyncFromEditor(); };
                scrollBar.ValueChanged += OnScrollValueChanged;
                shell.Layout += delegate { LayoutControls(); };
                shell.Resize += delegate { LayoutControls(); };
                LayoutControls();
            }

            private void LayoutControls()
            {
                if (shell.IsDisposed || editor.IsDisposed || scrollBar.IsDisposed) return;
                int gutter = UiTheme.Dip(shell, 16);
                int barWidth = UiTheme.Dip(shell, 9);
                int left = shell.Padding.Left;
                int top = shell.Padding.Top;
                int height = Math.Max(1, shell.ClientSize.Height - shell.Padding.Vertical);
                int width = Math.Max(1, shell.ClientSize.Width - shell.Padding.Horizontal - gutter);
                editor.SetBounds(left, top, width, height);
                scrollBar.SetBounds(Math.Max(left, shell.ClientSize.Width - shell.Padding.Right - barWidth),
                    top, barWidth, height);
                scrollBar.BringToFront();
                SyncFromEditor();
            }

            private void SyncFromEditor()
            {
                if (synchronizing || !editor.IsHandleCreated || editor.IsDisposed) return;
                synchronizing = true;
                try
                {
                    int lineCount = Math.Max(1, SendMessage(editor.Handle, EmGetLineCount,
                        IntPtr.Zero, IntPtr.Zero).ToInt32());
                    int visibleLines = Math.Max(1, editor.ClientSize.Height / Math.Max(1, editor.Font.Height));
                    int maximum = Math.Max(0, lineCount - visibleLines);
                    int firstLine = Math.Max(0, SendMessage(editor.Handle, EmGetFirstVisibleLine,
                        IntPtr.Zero, IntPtr.Zero).ToInt32());
                    scrollBar.ViewportSize = visibleLines;
                    scrollBar.LargeChange = Math.Max(1, visibleLines - 1);
                    scrollBar.Maximum = maximum;
                    scrollBar.Value = Math.Min(maximum, firstLine);
                    scrollBar.Visible = maximum > 0;
                    scrollBar.BringToFront();
                }
                finally { synchronizing = false; }
            }

            private void OnScrollValueChanged(object sender, EventArgs e)
            {
                if (synchronizing || !editor.IsHandleCreated || editor.IsDisposed) return;
                int firstLine = Math.Max(0, SendMessage(editor.Handle, EmGetFirstVisibleLine,
                    IntPtr.Zero, IntPtr.Zero).ToInt32());
                int delta = scrollBar.Value - firstLine;
                if (delta == 0) return;
                synchronizing = true;
                try
                {
                    SendMessage(editor.Handle, EmLineScroll, IntPtr.Zero, new IntPtr(delta));
                    editor.Invalidate();
                }
                finally { synchronizing = false; }
                SyncFromEditor();
            }

            private void OnEditorMouseWheel(object sender, MouseEventArgs e)
            {
                if (!scrollBar.Visible || e.Delta == 0) return;
                wheelRemainder += e.Delta;
                int notches = wheelRemainder / 120;
                if (notches == 0) return;
                wheelRemainder -= notches * 120;
                int configuredLines = SystemInformation.MouseWheelScrollLines;
                int step = configuredLines < 0
                    ? Math.Max(1, scrollBar.ViewportSize - 1)
                    : Math.Max(1, configuredLines);
                scrollBar.ScrollBy(-notches * step);
            }
        }
    }

    internal sealed class HeroPanel : RoundedPanel
    {
        internal HeroPanel() { BorderColor = Color.FromArgb(48, 67, 111); }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Parent == null ? UiTheme.Background : Parent.BackColor);
            int edge = UiTheme.Dip(this, 1);
            Rectangle bounds = new Rectangle(0, 0, Math.Max(1, Width - edge), Math.Max(1, Height - edge));
            using (GraphicsPath path = UiTheme.RoundedRectangle(bounds, UiTheme.Dip(this, Radius)))
            using (LinearGradientBrush brush = new LinearGradientBrush(bounds,
                Color.FromArgb(13, 28, 58), Color.FromArgb(30, 47, 91), 15f))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.SetClip(path);
                using (SolidBrush glow = new SolidBrush(Color.FromArgb(28, 100, 131, 255)))
                {
                    e.Graphics.FillEllipse(glow, Width - UiTheme.Dip(this, 245), -UiTheme.Dip(this, 115),
                        UiTheme.Dip(this, 310), UiTheme.Dip(this, 310));
                    e.Graphics.FillEllipse(glow, Width - UiTheme.Dip(this, 430), UiTheme.Dip(this, 70),
                        UiTheme.Dip(this, 260), UiTheme.Dip(this, 260));
                }
                WhaleGlyph.Draw(e.Graphics, new RectangleF(Width - UiTheme.Dip(this, 210), UiTheme.Dip(this, 4),
                    UiTheme.Dip(this, 170), UiTheme.Dip(this, 170)),
                    Color.FromArgb(24, 255, 255, 255), UiTheme.Dip(this, 18f));
                e.Graphics.ResetClip();
            }
        }

    }

    internal enum ModernButtonKind { Primary, Secondary, Danger, Quiet }

    internal sealed class ModernButton : Control
    {
        private ModernButtonKind kind;
        private bool hovering;
        private bool pressed;

        internal ModernButtonKind Kind { get { return kind; } set { kind = value; Invalidate(); } }
        internal int LogicalWidth { get; set; }

        internal ModernButton()
        {
            kind = ModernButtonKind.Secondary;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                | ControlStyles.StandardClick | ControlStyles.Selectable, true);
            Cursor = Cursors.Hand;
            Font = UiTheme.Font(9.2f, FontStyle.Bold);
            Height = 42;
            TabStop = true;
            AccessibleRole = AccessibleRole.PushButton;
            MouseEnter += delegate { hovering = true; Invalidate(); };
            MouseLeave += delegate { hovering = false; pressed = false; Invalidate(); };
            MouseDown += delegate { pressed = true; Invalidate(); };
            MouseUp += delegate { pressed = false; Invalidate(); };
            EnabledChanged += delegate { Invalidate(); };
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter)
            {
                pressed = true; Invalidate(); e.Handled = true;
            }
            base.OnKeyDown(e);
        }

        protected override void OnKeyUp(KeyEventArgs e)
        {
            if ((e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) && pressed)
            {
                pressed = false; Invalidate(); OnClick(EventArgs.Empty); e.Handled = true;
            }
            base.OnKeyUp(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill;
            Color border;
            Color text;
            if (!Enabled)
            {
                fill = Color.FromArgb(239, 242, 247); border = Color.FromArgb(231, 235, 242); text = Color.FromArgb(158, 169, 187);
            }
            else if (kind == ModernButtonKind.Primary)
            {
                fill = hovering ? UiTheme.PrimaryHover : UiTheme.Primary; border = fill; text = Color.White;
            }
            else if (kind == ModernButtonKind.Danger)
            {
                fill = hovering ? Color.FromArgb(255, 240, 242) : Color.FromArgb(255, 247, 248);
                border = hovering ? Color.FromArgb(240, 168, 176) : Color.FromArgb(244, 207, 212); text = UiTheme.Danger;
            }
            else if (kind == ModernButtonKind.Quiet)
            {
                fill = hovering ? UiTheme.SidebarHover : UiTheme.Sidebar;
                border = hovering ? Color.FromArgb(49, 66, 94) : Color.FromArgb(31, 45, 68);
                text = Color.FromArgb(219, 227, 241);
            }
            else
            {
                fill = hovering ? Color.FromArgb(246, 248, 255) : UiTheme.Surface;
                border = hovering ? Color.FromArgb(180, 192, 226) : UiTheme.BorderStrong; text = UiTheme.Text;
            }
            if (pressed && Enabled) fill = ControlPaint.Dark(fill, 0.03f);
            int inset = UiTheme.Dip(this, 1);
            int reduction = UiTheme.Dip(this, 3);
            Rectangle bounds = new Rectangle(inset, inset, Math.Max(1, Width - reduction), Math.Max(1, Height - reduction));
            using (GraphicsPath path = UiTheme.RoundedRectangle(bounds, UiTheme.Dip(this, 11)))
            using (SolidBrush brush = new SolidBrush(fill))
            using (Pen pen = new Pen(border, UiTheme.Dip(this, 1f)))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }
            TextRenderer.DrawText(e.Graphics, Text, Font, bounds, text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            if (Focused && ShowFocusCues)
            {
                Rectangle focus = Rectangle.Inflate(bounds, -UiTheme.Dip(this, 3), -UiTheme.Dip(this, 3));
                using (GraphicsPath path = UiTheme.RoundedRectangle(focus, UiTheme.Dip(this, 8)))
                using (Pen pen = new Pen(Color.FromArgb(150, UiTheme.Primary), UiTheme.Dip(this, 2f))) e.Graphics.DrawPath(pen, path);
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? UiTheme.Sidebar : Parent.BackColor);
        }
    }

    internal enum NavGlyph { Overview, Tasks, Diagnostics, Source, Plugins }

    internal sealed class NavButton : Control
    {
        private bool selected;
        private bool hovering;
        internal NavGlyph Glyph { get; set; }
        internal bool Selected { get { return selected; } set { selected = value; Invalidate(); } }

        internal NavButton()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                | ControlStyles.StandardClick | ControlStyles.Selectable, true);
            Font = UiTheme.Font(9.4f, FontStyle.Regular);
            Height = 48;
            Cursor = Cursors.Hand;
            TabStop = true;
            AccessibleRole = AccessibleRole.PushButton;
            MouseEnter += delegate { hovering = true; Invalidate(); };
            MouseLeave += delegate { hovering = false; Invalidate(); };
        }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter)
            {
                OnClick(EventArgs.Empty); e.Handled = true;
            }
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle item = new Rectangle(UiTheme.Dip(this, 12), UiTheme.Dip(this, 3),
                Math.Max(1, Width - UiTheme.Dip(this, 24)), Math.Max(1, Height - UiTheme.Dip(this, 6)));
            if (selected || hovering)
            {
                using (GraphicsPath path = UiTheme.RoundedRectangle(item, UiTheme.Dip(this, 11)))
                using (SolidBrush brush = new SolidBrush(selected ? UiTheme.SidebarSelected : UiTheme.SidebarHover))
                    e.Graphics.FillPath(brush, path);
            }
            if (selected)
            {
                using (SolidBrush brush = new SolidBrush(Color.FromArgb(111, 137, 255)))
                    e.Graphics.FillRectangle(brush, UiTheme.Dip(this, 12), UiTheme.Dip(this, 14),
                        UiTheme.Dip(this, 3), UiTheme.Dip(this, 20));
            }
            Color color = selected ? Color.White : Color.FromArgb(183, 195, 215);
            DrawGlyph(e.Graphics, new Rectangle(UiTheme.Dip(this, 29), UiTheme.Dip(this, 15),
                UiTheme.Dip(this, 18), UiTheme.Dip(this, 18)), color);
            TextRenderer.DrawText(e.Graphics, Text, Font, new Rectangle(UiTheme.Dip(this, 58), 0,
                Math.Max(1, Width - UiTheme.Dip(this, 72)), Height), color,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            if (Focused && ShowFocusCues)
            {
                using (GraphicsPath path = UiTheme.RoundedRectangle(Rectangle.Inflate(item,
                    -UiTheme.Dip(this, 2), -UiTheme.Dip(this, 2)), UiTheme.Dip(this, 9)))
                using (Pen pen = new Pen(Color.FromArgb(130, UiTheme.Primary), UiTheme.Dip(this, 1.5f))) e.Graphics.DrawPath(pen, path);
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? UiTheme.Surface : Parent.BackColor);
        }

        private void DrawGlyph(Graphics graphics, Rectangle box, Color color)
        {
            float u = Math.Max(1f, box.Width / 18f);
            using (Pen pen = new Pen(color, UiTheme.Dip(this, 1.7f)))
            {
                pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                if (Glyph == NavGlyph.Overview)
                {
                    graphics.DrawRectangle(pen, box.X + u, box.Y + u, 6 * u, 6 * u); graphics.DrawRectangle(pen, box.X + (11 * u), box.Y + u, 6 * u, 6 * u);
                    graphics.DrawRectangle(pen, box.X + u, box.Y + (11 * u), 6 * u, 6 * u); graphics.DrawRectangle(pen, box.X + (11 * u), box.Y + (11 * u), 6 * u, 6 * u);
                }
                else if (Glyph == NavGlyph.Tasks)
                {
                    graphics.DrawLine(pen, box.X + (3 * u), box.Y + (5 * u), box.X + (15 * u), box.Y + (5 * u));
                    graphics.DrawLine(pen, box.X + (3 * u), box.Y + (9 * u), box.X + (12 * u), box.Y + (9 * u));
                    graphics.DrawLine(pen, box.X + (3 * u), box.Y + (13 * u), box.X + (9 * u), box.Y + (13 * u));
                    graphics.DrawLine(pen, box.X + (13 * u), box.Y + (11 * u), box.X + (16 * u), box.Y + (14 * u));
                    graphics.DrawLine(pen, box.X + (16 * u), box.Y + (14 * u), box.X + (13 * u), box.Y + (17 * u));
                }
                else if (Glyph == NavGlyph.Diagnostics)
                {
                    graphics.DrawEllipse(pen, box.X + (2 * u), box.Y + (2 * u), 11 * u, 11 * u);
                    graphics.DrawLine(pen, box.X + (12 * u), box.Y + (12 * u), box.X + (17 * u), box.Y + (17 * u));
                    graphics.DrawLine(pen, box.X + (7 * u), box.Y + (5 * u), box.X + (7 * u), box.Y + (10 * u));
                    graphics.DrawLine(pen, box.X + (5 * u), box.Y + (8 * u), box.X + (10 * u), box.Y + (8 * u));
                }
                else if (Glyph == NavGlyph.Source)
                {
                    graphics.DrawEllipse(pen, box.X + (2 * u), box.Y + u, 5 * u, 5 * u);
                    graphics.DrawEllipse(pen, box.X + (2 * u), box.Y + (12 * u), 5 * u, 5 * u);
                    graphics.DrawEllipse(pen, box.X + (12 * u), box.Y + u, 5 * u, 5 * u);
                    graphics.DrawLine(pen, box.X + (4.5f * u), box.Y + (6 * u), box.X + (4.5f * u), box.Y + (12 * u));
                    graphics.DrawBezier(pen, box.X + (4.5f * u), box.Y + (10 * u),
                        box.X + (6 * u), box.Y + (6 * u), box.X + (11 * u), box.Y + (7 * u),
                        box.X + (14.5f * u), box.Y + (6 * u));
                }
                else
                {
                    graphics.DrawRectangle(pen, box.X + (2 * u), box.Y + (2 * u), 6 * u, 6 * u);
                    graphics.DrawRectangle(pen, box.X + (10 * u), box.Y + (2 * u), 6 * u, 6 * u);
                    graphics.DrawRectangle(pen, box.X + (2 * u), box.Y + (10 * u), 6 * u, 6 * u);
                    graphics.DrawRectangle(pen, box.X + (10 * u), box.Y + (10 * u), 6 * u, 6 * u);
                    graphics.DrawLine(pen, box.X + (8 * u), box.Y + (5 * u), box.X + (10 * u), box.Y + (5 * u));
                    graphics.DrawLine(pen, box.X + (5 * u), box.Y + (8 * u), box.X + (5 * u), box.Y + (10 * u));
                }
            }
        }
    }

    internal sealed class ModernComboBox : Control
    {
        private readonly TextBox editor;
        private readonly ListBox choices;
        private readonly ToolStripDropDown popup;
        private bool hovering;
        private bool arrowHovering;
        private bool popupOpen;

        internal int SelectedIndex
        {
            get { return choices.SelectedIndex; }
            set
            {
                choices.SelectedIndex = value;
                if (value >= 0 && value < choices.Items.Count)
                    Text = Convert.ToString(choices.Items[value], CultureInfo.CurrentCulture);
            }
        }

        internal int ItemCount { get { return choices.Items.Count; } }

        public override string Text
        {
            get { return editor == null ? base.Text : editor.Text; }
            set
            {
                string normalized = value ?? String.Empty;
                if (editor != null && !String.Equals(editor.Text, normalized, StringComparison.Ordinal))
                    editor.Text = normalized;
                if (!String.Equals(base.Text, normalized, StringComparison.Ordinal)) base.Text = normalized;
            }
        }

        internal ModernComboBox()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.ResizeRedraw
                | ControlStyles.Selectable, true);
            BackColor = UiTheme.Surface;
            Cursor = Cursors.IBeam;
            TabStop = false;
            AccessibleRole = AccessibleRole.ComboBox;

            editor = new TextBox();
            editor.BorderStyle = BorderStyle.None;
            editor.BackColor = UiTheme.SurfaceSoft;
            editor.ForeColor = UiTheme.Text;
            editor.Font = UiTheme.Font(10f, FontStyle.Regular);
            editor.TabStop = true;
            editor.Enter += delegate { Invalidate(); };
            editor.Leave += delegate { if (!popupOpen) Invalidate(); };
            editor.MouseEnter += delegate { hovering = true; Invalidate(); };
            editor.MouseLeave += delegate { hovering = false; Invalidate(); };
            editor.TextChanged += delegate
            {
                if (!String.Equals(base.Text, editor.Text, StringComparison.Ordinal)) base.Text = editor.Text;
            };
            editor.KeyDown += EditorKeyDown;
            Controls.Add(editor);

            choices = new ListBox();
            choices.BorderStyle = BorderStyle.None;
            choices.BackColor = UiTheme.Surface;
            choices.ForeColor = UiTheme.Text;
            choices.Font = UiTheme.Font(9.6f, FontStyle.Regular);
            choices.DrawMode = DrawMode.OwnerDrawFixed;
            choices.IntegralHeight = false;
            choices.TabStop = false;
            choices.DrawItem += DrawChoice;
            choices.MouseClick += delegate(object sender, MouseEventArgs e)
            {
                int index = choices.IndexFromPoint(e.Location);
                if (index >= 0) CommitChoice(index);
            };

            ToolStripControlHost host = new ToolStripControlHost(choices);
            host.AutoSize = false;
            host.Margin = Padding.Empty;
            host.Padding = Padding.Empty;
            popup = new ToolStripDropDown();
            popup.AutoSize = false;
            popup.BackColor = UiTheme.BorderStrong;
            popup.DropShadowEnabled = true;
            popup.Padding = new Padding(UiTheme.Dip(this, 1));
            popup.Items.Add(host);
            popup.Closed += delegate
            {
                popupOpen = false;
                arrowHovering = false;
                Invalidate();
            };

            Size = new Size(320, 42);
            MouseEnter += delegate { hovering = true; Invalidate(); };
            MouseLeave += delegate { hovering = false; arrowHovering = false; Invalidate(); };
        }

        internal void SetItems(string[] items)
        {
            choices.Items.Clear();
            if (items != null && items.Length > 0) choices.Items.AddRange(items);
            choices.SelectedIndex = -1;
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            int left = UiTheme.Dip(this, 14);
            int arrowWidth = UiTheme.Dip(this, 42);
            int editorWidth = Math.Max(1, Width - left - arrowWidth);
            editor.SetBounds(left, Math.Max(UiTheme.Dip(this, 4), (Height - editor.PreferredHeight) / 2),
                editorWidth, editor.PreferredHeight);
        }

        protected override void OnEnabledChanged(EventArgs e)
        {
            base.OnEnabledChanged(e);
            editor.Enabled = Enabled;
            editor.BackColor = UiTheme.SurfaceSoft;
            if (!Enabled && popup.Visible) popup.Close();
            Invalidate();
        }

        protected override void OnMouseMove(MouseEventArgs e)
        {
            base.OnMouseMove(e);
            bool nextArrowHovering = e.X >= Width - UiTheme.Dip(this, 42);
            if (arrowHovering != nextArrowHovering)
            {
                arrowHovering = nextArrowHovering;
                Cursor = arrowHovering ? Cursors.Hand : Cursors.IBeam;
                Invalidate();
            }
        }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            base.OnMouseDown(e);
            if (e.Button == MouseButtons.Left && e.X >= Width - UiTheme.Dip(this, 42)) TogglePopup();
            else editor.Focus();
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            bool active = editor.Focused || popupOpen;
            Color fill = Enabled ? UiTheme.SurfaceSoft : Color.FromArgb(241, 244, 249);
            Color border = active ? UiTheme.Primary : hovering ? Color.FromArgb(180, 192, 226) : UiTheme.BorderStrong;
            editor.BackColor = fill;
            Rectangle bounds = new Rectangle(UiTheme.Dip(this, 1), UiTheme.Dip(this, 1),
                Math.Max(1, Width - UiTheme.Dip(this, 3)), Math.Max(1, Height - UiTheme.Dip(this, 3)));
            using (GraphicsPath path = UiTheme.RoundedRectangle(bounds, UiTheme.Dip(this, 11)))
            using (SolidBrush brush = new SolidBrush(fill))
            using (Pen pen = new Pen(border, UiTheme.Dip(this, active ? 1.7f : 1f)))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }

            int arrowSize = UiTheme.Dip(this, 26);
            Rectangle arrowButton = new Rectangle(Width - UiTheme.Dip(this, 35), (Height - arrowSize) / 2,
                arrowSize, arrowSize);
            if (arrowHovering || popupOpen)
            {
                using (SolidBrush brush = new SolidBrush(UiTheme.PrimarySoft))
                    e.Graphics.FillEllipse(brush, arrowButton);
            }
            float centerX = arrowButton.Left + (arrowButton.Width / 2f);
            float centerY = arrowButton.Top + (arrowButton.Height / 2f) + UiTheme.Dip(this, 1f);
            using (Pen pen = new Pen(active ? UiTheme.Primary : UiTheme.Muted, UiTheme.Dip(this, 1.8f)))
            {
                pen.StartCap = LineCap.Round;
                pen.EndCap = LineCap.Round;
                e.Graphics.DrawLine(pen, centerX - UiTheme.Dip(this, 4f), centerY - UiTheme.Dip(this, 2f),
                    centerX, centerY + UiTheme.Dip(this, 2f));
                e.Graphics.DrawLine(pen, centerX, centerY + UiTheme.Dip(this, 2f),
                    centerX + UiTheme.Dip(this, 4f), centerY - UiTheme.Dip(this, 2f));
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? UiTheme.Surface : Parent.BackColor);
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing) popup.Dispose();
            base.Dispose(disposing);
        }

        private void EditorKeyDown(object sender, KeyEventArgs e)
        {
            if (e.KeyCode == Keys.F4 || (e.Alt && e.KeyCode == Keys.Down))
            {
                TogglePopup();
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
            else if (popupOpen && (e.KeyCode == Keys.Down || e.KeyCode == Keys.Up))
            {
                int direction = e.KeyCode == Keys.Down ? 1 : -1;
                int next = choices.SelectedIndex < 0 ? 0 : choices.SelectedIndex + direction;
                choices.SelectedIndex = Math.Max(0, Math.Min(choices.Items.Count - 1, next));
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
            else if (popupOpen && e.KeyCode == Keys.Enter)
            {
                if (choices.SelectedIndex >= 0) CommitChoice(choices.SelectedIndex);
                else popup.Close();
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
            else if (popupOpen && e.KeyCode == Keys.Escape)
            {
                popup.Close();
                e.Handled = true;
                e.SuppressKeyPress = true;
            }
        }

        private void TogglePopup()
        {
            if (!Enabled || choices.Items.Count == 0) { editor.Focus(); return; }
            if (popup.Visible) { popup.Close(); return; }

            int itemHeight = UiTheme.Dip(this, 36);
            int visibleItems = Math.Min(6, Math.Max(1, choices.Items.Count));
            int popupHeight = (visibleItems * itemHeight) + UiTheme.Dip(this, 2);
            ToolStripControlHost host = (ToolStripControlHost)popup.Items[0];
            choices.ItemHeight = itemHeight;
            choices.Size = new Size(Math.Max(UiTheme.Dip(this, 140), Width - UiTheme.Dip(this, 2)),
                popupHeight - UiTheme.Dip(this, 2));
            host.Size = choices.Size;
            popup.Size = new Size(choices.Width + UiTheme.Dip(this, 2), popupHeight);
            int matchingIndex = choices.FindStringExact(editor.Text);
            if (matchingIndex >= 0) choices.SelectedIndex = matchingIndex;
            popupOpen = true;
            Invalidate();
            popup.Show(PointToScreen(new Point(0, Height + UiTheme.Dip(this, 4))));
            editor.Focus();
        }

        private void CommitChoice(int index)
        {
            if (index < 0 || index >= choices.Items.Count) return;
            choices.SelectedIndex = index;
            Text = Convert.ToString(choices.Items[index], CultureInfo.CurrentCulture);
            popup.Close();
            editor.SelectionStart = editor.TextLength;
        }

        private void DrawChoice(object sender, DrawItemEventArgs e)
        {
            if (e.Index < 0 || e.Index >= choices.Items.Count) return;
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (SolidBrush background = new SolidBrush(UiTheme.Surface))
                e.Graphics.FillRectangle(background, e.Bounds);
            bool selected = (e.State & DrawItemState.Selected) != 0;
            Rectangle item = Rectangle.Inflate(e.Bounds, -UiTheme.Dip(this, 5), -UiTheme.Dip(this, 3));
            if (selected)
            {
                using (GraphicsPath path = UiTheme.RoundedRectangle(item, UiTheme.Dip(this, 8)))
                using (SolidBrush brush = new SolidBrush(UiTheme.PrimarySoft)) e.Graphics.FillPath(brush, path);
            }
            string value = Convert.ToString(choices.Items[e.Index], CultureInfo.CurrentCulture);
            TextRenderer.DrawText(e.Graphics, value, choices.Font,
                new Rectangle(item.Left + UiTheme.Dip(this, 9), item.Top,
                    Math.Max(1, item.Width - UiTheme.Dip(this, 18)), item.Height),
                selected ? UiTheme.PrimaryHover : UiTheme.Text,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding | TextFormatFlags.EndEllipsis);
        }
    }

    internal sealed class ToggleSwitch : Control
    {
        private bool isChecked;
        private bool hovering;
        internal event EventHandler CheckedChanged;
        internal bool Checked
        {
            get { return isChecked; }
            set
            {
                if (isChecked == value) return;
                isChecked = value; Invalidate();
                EventHandler handler = CheckedChanged;
                if (handler != null) handler(this, EventArgs.Empty);
            }
        }

        internal ToggleSwitch()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Selectable, true);
            Size = new Size(48, 28);
            Cursor = Cursors.Hand;
            TabStop = true;
            AccessibleRole = AccessibleRole.CheckButton;
            MouseEnter += delegate { hovering = true; Invalidate(); };
            MouseLeave += delegate { hovering = false; Invalidate(); };
        }

        protected override void OnClick(EventArgs e) { Checked = !Checked; base.OnClick(e); }

        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) { Checked = !Checked; e.Handled = true; }
            base.OnKeyDown(e);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Rectangle track = new Rectangle(UiTheme.Dip(this, 2), UiTheme.Dip(this, 4),
                Math.Max(1, Width - UiTheme.Dip(this, 4)), Math.Max(1, Height - UiTheme.Dip(this, 8)));
            Color trackColor = Checked ? UiTheme.Primary : Color.FromArgb(196, 205, 219);
            if (hovering) trackColor = Checked ? UiTheme.PrimaryHover : Color.FromArgb(178, 189, 207);
            if (!Enabled) trackColor = Checked ? Color.FromArgb(145, 162, 247) : Color.FromArgb(220, 225, 234);
            using (GraphicsPath path = UiTheme.RoundedRectangle(track, track.Height / 2))
            using (SolidBrush brush = new SolidBrush(trackColor)) e.Graphics.FillPath(brush, path);
            int thumb = Math.Max(UiTheme.Dip(this, 8), Height - UiTheme.Dip(this, 12));
            int left = Checked ? Width - thumb - UiTheme.Dip(this, 6) : UiTheme.Dip(this, 6);
            using (SolidBrush shadow = new SolidBrush(Color.FromArgb(35, 17, 24, 39)))
                e.Graphics.FillEllipse(shadow, left, UiTheme.Dip(this, 7), thumb, thumb);
            using (SolidBrush brush = new SolidBrush(Color.White))
                e.Graphics.FillEllipse(brush, left, UiTheme.Dip(this, 6), thumb, thumb);
            if (Focused && ShowFocusCues)
            {
                using (GraphicsPath path = UiTheme.RoundedRectangle(new Rectangle(0, UiTheme.Dip(this, 2),
                    Math.Max(1, Width - UiTheme.Dip(this, 1)), Math.Max(1, Height - UiTheme.Dip(this, 4))), Height / 2))
                using (Pen pen = new Pen(Color.FromArgb(135, UiTheme.Primary), UiTheme.Dip(this, 2f))) e.Graphics.DrawPath(pen, path);
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? UiTheme.Surface : Parent.BackColor);
        }
    }

    internal sealed class PortField : Control
    {
        private readonly TextBox editor;
        private decimal value = 3080;
        private decimal minimum = 1;
        private decimal maximum = 65535;
        internal event EventHandler ValueChanged;
        internal decimal Minimum { get { return minimum; } set { minimum = value; } }
        internal decimal Maximum { get { return maximum; } set { maximum = value; } }
        internal decimal Value
        {
            get { return value; }
            set
            {
                decimal normalized = Math.Max(minimum, Math.Min(maximum, value));
                if (this.value == normalized && editor.Text == normalized.ToString(CultureInfo.InvariantCulture)) return;
                this.value = normalized; editor.Text = normalized.ToString(CultureInfo.InvariantCulture);
                EventHandler handler = ValueChanged;
                if (handler != null) handler(this, EventArgs.Empty);
            }
        }

        internal PortField()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint
                | ControlStyles.OptimizedDoubleBuffer | ControlStyles.Selectable, true);
            BackColor = UiTheme.Surface; Cursor = Cursors.IBeam; TabStop = true;
            editor = new TextBox();
            editor.BorderStyle = BorderStyle.None; editor.BackColor = UiTheme.Surface; editor.ForeColor = UiTheme.Text;
            editor.Font = UiTheme.Font(10f, FontStyle.Regular); editor.Text = "3080";
            editor.KeyPress += delegate(object sender, KeyPressEventArgs e)
            {
                if (!Char.IsControl(e.KeyChar) && !Char.IsDigit(e.KeyChar)) e.Handled = true;
            };
            editor.TextChanged += delegate
            {
                decimal parsed;
                if (!Decimal.TryParse(editor.Text, NumberStyles.None, CultureInfo.InvariantCulture, out parsed)
                    || parsed < minimum || parsed > maximum || value == parsed) { Invalidate(); return; }
                value = parsed;
                EventHandler handler = ValueChanged;
                if (handler != null) handler(this, EventArgs.Empty);
                Invalidate();
            };
            editor.Leave += delegate { editor.Text = value.ToString(CultureInfo.InvariantCulture); Invalidate(); };
            editor.Enter += delegate { Invalidate(); };
            Controls.Add(editor);
            Size = new Size(112, 40);
        }

        protected override void OnResize(EventArgs e)
        {
            base.OnResize(e);
            editor.SetBounds(UiTheme.Dip(this, 12), Math.Max(UiTheme.Dip(this, 7),
                (Height - editor.PreferredHeight) / 2), Math.Max(1, Width - UiTheme.Dip(this, 24)), editor.PreferredHeight);
        }

        protected override void OnEnabledChanged(EventArgs e)
        {
            base.OnEnabledChanged(e); editor.Enabled = Enabled;
            editor.BackColor = Enabled ? UiTheme.Surface : UiTheme.SurfaceSoft; Invalidate();
        }

        protected override void OnClick(EventArgs e) { editor.Focus(); base.OnClick(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            Color fill = Enabled ? UiTheme.Surface : UiTheme.SurfaceSoft;
            Color border = editor.Focused ? UiTheme.Primary : UiTheme.BorderStrong;
            using (GraphicsPath path = UiTheme.RoundedRectangle(new Rectangle(UiTheme.Dip(this, 1), UiTheme.Dip(this, 1),
                Math.Max(1, Width - UiTheme.Dip(this, 3)), Math.Max(1, Height - UiTheme.Dip(this, 3))), UiTheme.Dip(this, 10)))
            using (SolidBrush brush = new SolidBrush(fill))
            using (Pen pen = new Pen(border, UiTheme.Dip(this, editor.Focused ? 1.7f : 1f)))
            {
                e.Graphics.FillPath(brush, path); e.Graphics.DrawPath(pen, path);
            }
        }
    }

    internal sealed class StatusIndicator : Control
    {
        private Color indicatorColor = UiTheme.Warning;
        internal Color IndicatorColor
        {
            get { return indicatorColor; }
            set { if (indicatorColor != value) { indicatorColor = value; Invalidate(); } }
        }
        internal StatusIndicator()
        {
            SetStyle(ControlStyles.SupportsTransparentBackColor | ControlStyles.UserPaint
                | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            BackColor = Color.Transparent; Size = new Size(14, 14);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (SolidBrush glow = new SolidBrush(Color.FromArgb(45, indicatorColor))) e.Graphics.FillEllipse(glow, 0, 0, Width, Height);
            int inset = UiTheme.Dip(this, 3);
            using (SolidBrush brush = new SolidBrush(indicatorColor)) e.Graphics.FillEllipse(brush, inset, inset,
                Math.Max(1, Width - (inset * 2)), Math.Max(1, Height - (inset * 2)));
        }
    }

    internal sealed class BrandMark : Control
    {
        internal BrandMark()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer, true);
            Size = new Size(48, 48);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            WhaleGlyph.DrawBadge(e.Graphics, new RectangleF(1f, 1f, Width - 2f, Height - 2f));
        }
    }
}
