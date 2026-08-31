using System;
using System.Text;

namespace DshEnhanced.WindowsLauncher
{
    /// <summary>
    /// Projects terminal output into plain text for WinForms controls that do not
    /// interpret ANSI/ECMA-48 control sequences. Raw UTF-8 log files remain intact.
    /// </summary>
    internal static class TerminalText
    {
        private const char Escape = '\u001B';

        internal static string ForDisplay(string value)
        {
            if (String.IsNullOrEmpty(value)) return value ?? String.Empty;

            StringBuilder output = new StringBuilder(value.Length);
            int index = 0;
            while (index < value.Length)
            {
                char current = value[index];
                if (current == Escape)
                {
                    index = SkipEscape(value, index + 1);
                    continue;
                }
                if (current == '\u009B')
                {
                    index = SkipControlSequence(value, index + 1);
                    continue;
                }
                if (current == '\u009D')
                {
                    index = SkipControlString(value, index + 1, true);
                    continue;
                }
                if (current == '\u0090' || current == '\u0098' || current == '\u009E' || current == '\u009F')
                {
                    index = SkipControlString(value, index + 1, false);
                    continue;
                }
                if (current == '\u009C')
                {
                    index++;
                    continue;
                }
                if (current == '\r')
                {
                    output.Append(Environment.NewLine);
                    index += index + 1 < value.Length && value[index + 1] == '\n' ? 2 : 1;
                    continue;
                }
                if (current == '\n')
                {
                    output.Append(Environment.NewLine);
                    index++;
                    continue;
                }
                if (current == '\b')
                {
                    RemovePreviousCharacter(output);
                    index++;
                    continue;
                }
                if (current == '\t')
                {
                    output.Append(current);
                    index++;
                    continue;
                }
                if (Char.IsControl(current))
                {
                    index++;
                    continue;
                }

                output.Append(current);
                index++;
            }
            return output.ToString();
        }

        private static int SkipEscape(string value, int index)
        {
            if (index >= value.Length) return index;
            char introducer = value[index];
            if (introducer == '[') return SkipControlSequence(value, index + 1);
            if (introducer == ']') return SkipControlString(value, index + 1, true);
            if (introducer == 'P' || introducer == 'X' || introducer == '^' || introducer == '_')
                return SkipControlString(value, index + 1, false);

            // A two-character escape sequence can contain zero or more
            // intermediate bytes before its final byte.
            while (index < value.Length && value[index] >= '\u0020' && value[index] <= '\u002F') index++;
            if (index < value.Length && value[index] >= '\u0030' && value[index] <= '\u007E') index++;
            return index;
        }

        private static int SkipControlSequence(string value, int index)
        {
            while (index < value.Length)
            {
                char current = value[index];
                if (current >= '\u0040' && current <= '\u007E') return index + 1;
                if (current == '\r' || current == '\n') return index;
                index++;
            }
            return index;
        }

        private static int SkipControlString(string value, int index, bool bellTerminates)
        {
            while (index < value.Length)
            {
                char current = value[index];
                if ((bellTerminates && current == '\u0007') || current == '\u009C') return index + 1;
                if (current == Escape && index + 1 < value.Length && value[index + 1] == '\\') return index + 2;
                index++;
            }
            return index;
        }

        private static void RemovePreviousCharacter(StringBuilder output)
        {
            if (output.Length == 0 || output[output.Length - 1] == '\n' || output[output.Length - 1] == '\r') return;
            int start = output.Length - 1;
            if (start > 0 && Char.IsLowSurrogate(output[start]) && Char.IsHighSurrogate(output[start - 1])) start--;
            output.Length = start;
        }

        internal static bool SelfTest()
        {
            string styled = Escape + "[?25l" + Escape + "[2mdist/" + Escape + "[22masset.js "
                + Escape + "[1m16.03 kB" + Escape + "[0m" + Escape + "[?25h";
            string hyperlink = Escape + "]8;;https://example.invalid\u0007文档" + Escape + "]8;;\u0007";
            string c1 = "\u009B31m错误\u009B0m";
            string redraw = "abc\bX\r\nnext\tvalue";
            return ForDisplay(styled) == "dist/asset.js 16.03 kB"
                && ForDisplay(hyperlink) == "文档"
                && ForDisplay(c1) == "错误"
                && ForDisplay(redraw) == "abX" + Environment.NewLine + "next\tvalue"
                && ForDisplay(null) == String.Empty;
        }
    }
}
