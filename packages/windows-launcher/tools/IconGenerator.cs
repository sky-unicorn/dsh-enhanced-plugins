using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;

namespace DshEnhanced.WindowsLauncher.Tools
{
    internal static class IconGenerator
    {
        private static int Main(string[] args)
        {
            if (args.Length != 1) return 2;
            int[] sizes = { 16, 20, 24, 32, 40, 48, 64, 128, 256 };
            List<byte[]> frames = new List<byte[]>();
            foreach (int size in sizes)
            {
                using (Bitmap bitmap = new Bitmap(size, size, PixelFormat.Format32bppArgb))
                using (Graphics graphics = Graphics.FromImage(bitmap))
                using (MemoryStream stream = new MemoryStream())
                {
                    graphics.Clear(Color.Transparent);
                    WhaleGlyph.DrawBadge(graphics, new RectangleF(0f, 0f, size, size));
                    bitmap.Save(stream, ImageFormat.Png);
                    frames.Add(stream.ToArray());
                }
            }

            using (FileStream file = File.Create(args[0]))
            using (BinaryWriter writer = new BinaryWriter(file))
            {
                writer.Write((ushort)0);
                writer.Write((ushort)1);
                writer.Write((ushort)sizes.Length);
                int offset = 6 + sizes.Length * 16;
                for (int index = 0; index < sizes.Length; index++)
                {
                    int size = sizes[index];
                    writer.Write((byte)(size >= 256 ? 0 : size));
                    writer.Write((byte)(size >= 256 ? 0 : size));
                    writer.Write((byte)0);
                    writer.Write((byte)0);
                    writer.Write((ushort)1);
                    writer.Write((ushort)32);
                    writer.Write((uint)frames[index].Length);
                    writer.Write((uint)offset);
                    offset += frames[index].Length;
                }
                foreach (byte[] frame in frames) writer.Write(frame);
            }
            return 0;
        }
    }
}
