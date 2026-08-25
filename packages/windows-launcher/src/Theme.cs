using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
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
            using (GraphicsPath path = UiTheme.RoundedRectangle(new Rectangle(0, 0, Width - 1, Height - 1), radius))
            using (SolidBrush brush = new SolidBrush(BackColor)) e.Graphics.FillPath(brush, path);
        }

        protected override void OnPaint(PaintEventArgs e)
        {
            base.OnPaint(e);
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = UiTheme.RoundedRectangle(new Rectangle(1, 1, Width - 3, Height - 3), Math.Max(3, radius - 1)))
            using (Pen pen = new Pen(borderColor)) e.Graphics.DrawPath(pen, path);
        }
    }

    internal sealed class HeroPanel : RoundedPanel
    {
        internal HeroPanel() { BorderColor = Color.FromArgb(48, 67, 111); }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode = SmoothingMode.AntiAlias;
            e.Graphics.Clear(Parent == null ? UiTheme.Background : Parent.BackColor);
            Rectangle bounds = new Rectangle(0, 0, Math.Max(1, Width - 1), Math.Max(1, Height - 1));
            using (GraphicsPath path = UiTheme.RoundedRectangle(bounds, Radius))
            using (LinearGradientBrush brush = new LinearGradientBrush(bounds,
                Color.FromArgb(13, 28, 58), Color.FromArgb(30, 47, 91), 15f))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.SetClip(path);
                using (SolidBrush glow = new SolidBrush(Color.FromArgb(28, 100, 131, 255)))
                {
                    e.Graphics.FillEllipse(glow, Width - 245, -115, 310, 310);
                    e.Graphics.FillEllipse(glow, Width - 430, 70, 260, 260);
                }
                WhaleGlyph.Draw(e.Graphics, new RectangleF(Width - 210, 4, 170, 170),
                    Color.FromArgb(24, 255, 255, 255), 18f);
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
            Rectangle bounds = new Rectangle(1, 1, Width - 3, Height - 3);
            using (GraphicsPath path = UiTheme.RoundedRectangle(bounds, 11))
            using (SolidBrush brush = new SolidBrush(fill))
            using (Pen pen = new Pen(border))
            {
                e.Graphics.FillPath(brush, path);
                e.Graphics.DrawPath(pen, path);
            }
            TextRenderer.DrawText(e.Graphics, Text, Font, bounds, text,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            if (Focused && ShowFocusCues)
            {
                Rectangle focus = Rectangle.Inflate(bounds, -3, -3);
                using (GraphicsPath path = UiTheme.RoundedRectangle(focus, 8))
                using (Pen pen = new Pen(Color.FromArgb(150, UiTheme.Primary), 2f)) e.Graphics.DrawPath(pen, path);
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? UiTheme.Sidebar : Parent.BackColor);
        }
    }

    internal enum NavGlyph { Overview, Tasks, Diagnostics }

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
            Rectangle item = new Rectangle(12, 3, Width - 24, Height - 6);
            if (selected || hovering)
            {
                using (GraphicsPath path = UiTheme.RoundedRectangle(item, 11))
                using (SolidBrush brush = new SolidBrush(selected ? UiTheme.SidebarSelected : UiTheme.SidebarHover))
                    e.Graphics.FillPath(brush, path);
            }
            if (selected)
            {
                using (SolidBrush brush = new SolidBrush(Color.FromArgb(111, 137, 255)))
                    e.Graphics.FillRectangle(brush, 12, 14, 3, 20);
            }
            Color color = selected ? Color.White : Color.FromArgb(183, 195, 215);
            DrawGlyph(e.Graphics, new Rectangle(29, 15, 18, 18), color);
            TextRenderer.DrawText(e.Graphics, Text, Font, new Rectangle(58, 0, Width - 72, Height), color,
                TextFormatFlags.Left | TextFormatFlags.VerticalCenter | TextFormatFlags.NoPadding);
            if (Focused && ShowFocusCues)
            {
                using (GraphicsPath path = UiTheme.RoundedRectangle(Rectangle.Inflate(item, -2, -2), 9))
                using (Pen pen = new Pen(Color.FromArgb(130, UiTheme.Primary), 1.5f)) e.Graphics.DrawPath(pen, path);
            }
        }

        protected override void OnPaintBackground(PaintEventArgs e)
        {
            e.Graphics.Clear(Parent == null ? UiTheme.Surface : Parent.BackColor);
        }

        private void DrawGlyph(Graphics graphics, Rectangle box, Color color)
        {
            using (Pen pen = new Pen(color, 1.7f))
            {
                pen.StartCap = LineCap.Round; pen.EndCap = LineCap.Round;
                if (Glyph == NavGlyph.Overview)
                {
                    graphics.DrawRectangle(pen, box.X + 1, box.Y + 1, 6, 6); graphics.DrawRectangle(pen, box.X + 11, box.Y + 1, 6, 6);
                    graphics.DrawRectangle(pen, box.X + 1, box.Y + 11, 6, 6); graphics.DrawRectangle(pen, box.X + 11, box.Y + 11, 6, 6);
                }
                else if (Glyph == NavGlyph.Tasks)
                {
                    graphics.DrawLine(pen, box.X + 3, box.Y + 5, box.X + 15, box.Y + 5);
                    graphics.DrawLine(pen, box.X + 3, box.Y + 9, box.X + 12, box.Y + 9);
                    graphics.DrawLine(pen, box.X + 3, box.Y + 13, box.X + 9, box.Y + 13);
                    graphics.DrawLine(pen, box.X + 13, box.Y + 11, box.X + 16, box.Y + 14);
                    graphics.DrawLine(pen, box.X + 16, box.Y + 14, box.X + 13, box.Y + 17);
                }
                else
                {
                    graphics.DrawEllipse(pen, box.X + 2, box.Y + 2, 11, 11);
                    graphics.DrawLine(pen, box.X + 12, box.Y + 12, box.X + 17, box.Y + 17);
                    graphics.DrawLine(pen, box.X + 7, box.Y + 5, box.X + 7, box.Y + 10);
                    graphics.DrawLine(pen, box.X + 5, box.Y + 8, box.X + 10, box.Y + 8);
                }
            }
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
            Rectangle track = new Rectangle(2, 4, Width - 4, Height - 8);
            Color trackColor = Checked ? UiTheme.Primary : Color.FromArgb(196, 205, 219);
            if (hovering) trackColor = Checked ? UiTheme.PrimaryHover : Color.FromArgb(178, 189, 207);
            if (!Enabled) trackColor = Color.FromArgb(220, 225, 234);
            using (GraphicsPath path = UiTheme.RoundedRectangle(track, track.Height / 2))
            using (SolidBrush brush = new SolidBrush(trackColor)) e.Graphics.FillPath(brush, path);
            int thumb = Height - 12;
            int left = Checked ? Width - thumb - 6 : 6;
            using (SolidBrush shadow = new SolidBrush(Color.FromArgb(35, 17, 24, 39))) e.Graphics.FillEllipse(shadow, left, 7, thumb, thumb);
            using (SolidBrush brush = new SolidBrush(Color.White)) e.Graphics.FillEllipse(brush, left, 6, thumb, thumb);
            if (Focused && ShowFocusCues)
            {
                using (GraphicsPath path = UiTheme.RoundedRectangle(new Rectangle(0, 2, Width - 1, Height - 4), Height / 2))
                using (Pen pen = new Pen(Color.FromArgb(135, UiTheme.Primary), 2f)) e.Graphics.DrawPath(pen, path);
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
            editor.SetBounds(12, Math.Max(7, (Height - editor.PreferredHeight) / 2), Width - 24, editor.PreferredHeight);
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
            using (GraphicsPath path = UiTheme.RoundedRectangle(new Rectangle(1, 1, Width - 3, Height - 3), 10))
            using (SolidBrush brush = new SolidBrush(fill))
            using (Pen pen = new Pen(border, editor.Focused ? 1.7f : 1f))
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
            using (SolidBrush brush = new SolidBrush(indicatorColor)) e.Graphics.FillEllipse(brush, 3, 3, Width - 6, Height - 6);
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
