using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;

namespace DshEnhanced.WindowsLauncher
{
    /// <summary>Renders the official DeepSeek whale silhouette used by DSH.</summary>
    internal static class WhaleGlyph
    {
        private const string PathData = @"M48.8354 10.0479 C48.3232 9.79199 48.1025 10.2798 47.8032 10.5278 C47.7007 10.6079 47.6143 10.7119 47.5273 10.8076 C46.7793 11.624 45.9048 12.1597 44.7622 12.0957 C43.0923 12 41.666 12.5356 40.4058 13.8398 C40.1377 12.2319 39.2476 11.272 37.8926 10.6558 C37.1836 10.3359 36.4668 10.0156 35.9702 9.31982 C35.6235 8.82373 35.5293 8.27197 35.356 7.72754 C35.2456 7.3999 35.1353 7.06396 34.7651 7.00781 C34.3633 6.94385 34.2056 7.2876 34.0479 7.57568 C33.418 8.75195 33.1733 10.0479 33.1973 11.3599 C33.2524 14.312 34.4736 16.6641 36.8999 18.3359 C37.1758 18.5278 37.2466 18.7197 37.1597 19 C36.9946 19.5757 36.7974 20.1357 36.624 20.7119 C36.5137 21.0801 36.3486 21.1597 35.9624 21 C34.6309 20.4321 33.481 19.5918 32.4644 18.5757 C30.7393 16.8721 29.1792 14.9917 27.2334 13.52 C26.7764 13.1758 26.3193 12.856 25.8467 12.5518 C23.8618 10.584 26.1069 8.96777 26.627 8.77588 C27.1704 8.57568 26.8159 7.8877 25.0591 7.896 C23.3022 7.90381 21.6953 8.50391 19.647 9.30371 C19.3477 9.42383 19.0322 9.51172 18.7095 9.58398 C16.8501 9.22363 14.9199 9.14355 12.9033 9.37598 C9.10596 9.80762 6.07275 11.6396 3.84326 14.7681 C1.16455 18.5278 0.53418 22.7998 1.30664 27.2559 C2.11768 31.9521 4.46582 35.8398 8.07373 38.8799 C11.8159 42.0322 16.1255 43.5762 21.041 43.2803 C24.0269 43.104 27.3516 42.6963 31.1016 39.4561 C32.0469 39.936 33.0396 40.1279 34.686 40.272 C35.9546 40.3921 37.1758 40.208 38.1211 40.0078 C39.6021 39.688 39.4995 38.2881 38.9639 38.0322 C34.623 35.9678 35.5762 36.8081 34.71 36.1279 C36.9155 33.4639 40.2402 30.6958 41.54 21.728 C41.6426 21.0161 41.5557 20.5679 41.54 19.9917 C41.5322 19.6396 41.6108 19.5039 42.0049 19.4639 C43.0923 19.3359 44.1479 19.0317 45.1167 18.4878 C47.9292 16.9199 49.064 14.3438 49.3315 11.2559 C49.3711 10.7837 49.3237 10.2959 48.8354 10.0479 Z M24.3262 37.8398 C20.1196 34.4639 18.0791 33.3521 17.2358 33.3999 C16.4482 33.4482 16.5898 34.3682 16.7632 34.9678 C16.9443 35.5601 17.1812 35.9683 17.5117 36.4878 C17.7402 36.832 17.8979 37.3442 17.2832 37.728 C15.9282 38.584 13.5728 37.4399 13.4624 37.3838 C10.7207 35.7358 8.42822 33.5601 6.81348 30.584 C5.25342 27.7197 4.34766 24.6479 4.19775 21.3677 C4.1582 20.5757 4.38672 20.2959 5.15869 20.1519 C6.17529 19.96 7.22314 19.9199 8.23926 20.0718 C12.5327 20.7119 16.1885 22.6719 19.2529 25.7759 C21.002 27.5439 22.3252 29.6558 23.6885 31.7202 C25.1377 33.9121 26.6978 36 28.6831 37.7119 C29.3843 38.312 29.9434 38.7681 30.479 39.104 C28.8643 39.2881 26.1699 39.3281 24.3262 37.8398 Z M26.3433 24.6001 C26.3433 24.248 26.6191 23.9678 26.9658 23.9678 C27.0444 23.9678 27.1152 23.9839 27.1782 24.0078 C27.2651 24.04 27.3438 24.0879 27.4067 24.1602 C27.5171 24.272 27.5801 24.4321 27.5801 24.6001 C27.5801 24.9521 27.3042 25.2319 26.9575 25.2319 C26.6108 25.2319 26.3433 24.9521 26.3433 24.6001 Z M32.6064 27.8799 C32.2046 28.0479 31.8027 28.1919 31.4165 28.208 C30.8179 28.2397 30.1641 27.9922 29.8096 27.688 C29.2583 27.2158 28.8643 26.9521 28.6987 26.1279 C28.6279 25.7759 28.6675 25.2319 28.7305 24.9199 C28.8721 24.248 28.7144 23.8159 28.2495 23.4238 C27.8716 23.104 27.3911 23.0161 26.8633 23.0161 C26.666 23.0161 26.4849 22.9277 26.3511 22.856 C26.1304 22.7441 25.9492 22.4639 26.1226 22.1201 C26.1777 22.0078 26.4458 21.7358 26.5088 21.688 C27.2256 21.272 28.0527 21.4077 28.8169 21.7197 C29.5259 22.0161 30.0615 22.5601 30.834 23.3281 C31.6216 24.2559 31.7632 24.5117 32.2124 25.208 C32.5669 25.752 32.8901 26.312 33.1104 26.9521 C33.2446 27.3521 33.0713 27.6802 32.6064 27.8799 Z";

        private static readonly string[] Tokens = Tokenize(PathData);
        private static readonly GraphicsPath BasePath = ParsePath();

        internal static GraphicsPath CreatePath(RectangleF bounds, float inset)
        {
            GraphicsPath path = (GraphicsPath)BasePath.Clone();
            float usableWidth = Math.Max(1f, bounds.Width - inset * 2f);
            float usableHeight = Math.Max(1f, bounds.Height - inset * 2f);
            float scale = Math.Min(usableWidth / 50f, usableHeight / 50f);
            float left = bounds.Left + (bounds.Width - 50f * scale) / 2f;
            float top = bounds.Top + (bounds.Height - 50f * scale) / 2f;
            using (Matrix matrix = new Matrix(scale, 0f, 0f, scale, left, top)) path.Transform(matrix);
            return path;
        }

        internal static void Draw(Graphics graphics, RectangleF bounds, Color color, float inset)
        {
            SmoothingMode previous = graphics.SmoothingMode;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            using (GraphicsPath path = CreatePath(bounds, inset))
            using (SolidBrush brush = new SolidBrush(color)) graphics.FillPath(brush, path);
            graphics.SmoothingMode = previous;
        }

        internal static void DrawBadge(Graphics graphics, RectangleF bounds)
        {
            SmoothingMode previous = graphics.SmoothingMode;
            graphics.SmoothingMode = SmoothingMode.AntiAlias;
            float radius = Math.Max(3f, bounds.Width * 0.24f);
            using (GraphicsPath background = RoundedRectangle(bounds, radius))
            using (LinearGradientBrush brush = new LinearGradientBrush(bounds,
                Color.FromArgb(92, 123, 255), Color.FromArgb(63, 83, 238), 55f))
            {
                graphics.FillPath(brush, background);
            }
            Draw(graphics, bounds, Color.White, bounds.Width * 0.16f);
            graphics.SmoothingMode = previous;
        }

        private static GraphicsPath ParsePath()
        {
            GraphicsPath path = new GraphicsPath(FillMode.Winding);
            PointF current = PointF.Empty;
            int index = 0;
            while (index < Tokens.Length)
            {
                string command = Tokens[index++];
                if (command == "M")
                {
                    current = ReadPoint(ref index);
                    path.StartFigure();
                }
                else if (command == "L")
                {
                    PointF next = ReadPoint(ref index);
                    path.AddLine(current, next);
                    current = next;
                }
                else if (command == "C")
                {
                    PointF control1 = ReadPoint(ref index);
                    PointF control2 = ReadPoint(ref index);
                    PointF next = ReadPoint(ref index);
                    path.AddBezier(current, control1, control2, next);
                    current = next;
                }
                else if (command == "Z") path.CloseFigure();
                else throw new InvalidOperationException("Unsupported whale path command: " + command);
            }
            return path;
        }

        private static PointF ReadPoint(ref int index)
        {
            float x = Single.Parse(Tokens[index++], CultureInfo.InvariantCulture);
            float y = Single.Parse(Tokens[index++], CultureInfo.InvariantCulture);
            return new PointF(x, y);
        }

        private static string[] Tokenize(string value)
        {
            List<string> tokens = new List<string>();
            int index = 0;
            while (index < value.Length)
            {
                char character = value[index];
                if (Char.IsWhiteSpace(character) || character == ',') { index++; continue; }
                if (Char.IsLetter(character)) { tokens.Add(character.ToString().ToUpperInvariant()); index++; continue; }
                int start = index++;
                while (index < value.Length)
                {
                    character = value[index];
                    if (Char.IsDigit(character) || character == '.' || character == '-' || character == '+'
                        || character == 'e' || character == 'E') index++;
                    else break;
                }
                tokens.Add(value.Substring(start, index - start));
            }
            return tokens.ToArray();
        }

        private static GraphicsPath RoundedRectangle(RectangleF bounds, float radius)
        {
            float diameter = radius * 2f;
            GraphicsPath path = new GraphicsPath();
            path.AddArc(bounds.Left, bounds.Top, diameter, diameter, 180f, 90f);
            path.AddArc(bounds.Right - diameter, bounds.Top, diameter, diameter, 270f, 90f);
            path.AddArc(bounds.Right - diameter, bounds.Bottom - diameter, diameter, diameter, 0f, 90f);
            path.AddArc(bounds.Left, bounds.Bottom - diameter, diameter, diameter, 90f, 90f);
            path.CloseFigure();
            return path;
        }
    }
}
