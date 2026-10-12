using System.Drawing.Drawing2D;
using System.Drawing.Imaging;

namespace RemoteHub;

/// <summary>Draws the app icon at any size and can write a multi-resolution .ico (PNG-in-ICO).</summary>
internal static class Icons
{
    public static Bitmap Draw(int size)
    {
        var bmp = new Bitmap(size, size, PixelFormat.Format32bppArgb);
        using var g = Graphics.FromImage(bmp);
        g.SmoothingMode = SmoothingMode.AntiAlias;
        g.InterpolationMode = InterpolationMode.HighQualityBicubic;
        g.PixelOffsetMode = PixelOffsetMode.HighQuality;
        g.Clear(Color.Transparent);

        float s = size / 256f;
        RectangleF bg = new(8 * s, 8 * s, 240 * s, 240 * s);

        // Rounded gradient tile.
        using (var path = Round(bg, 56 * s))
        using (var brush = new LinearGradientBrush(bg, Color.FromArgb(70, 150, 255), Color.FromArgb(138, 92, 246), 55f))
        {
            g.FillPath(brush, path);
            // subtle top sheen
            using var sheen = new LinearGradientBrush(bg, Color.FromArgb(60, 255, 255, 255), Color.FromArgb(0, 255, 255, 255), 90f);
            g.FillPath(sheen, path);
        }

        // Monitor screen (white rounded rect) with a gradient "remote" area inside.
        RectangleF mon = new(64 * s, 70 * s, 128 * s, 92 * s);
        using (var mp = Round(mon, 14 * s))
        {
            using var white = new SolidBrush(Color.White);
            g.FillPath(white, mp);
        }
        RectangleF inner = new(mon.X + 12 * s, mon.Y + 12 * s, mon.Width - 24 * s, mon.Height - 24 * s);
        using (var ip = Round(inner, 7 * s))
        using (var ig = new LinearGradientBrush(inner, Color.FromArgb(56, 139, 253), Color.FromArgb(137, 87, 229), 45f))
            g.FillPath(ig, ip);

        // Connect "play" triangle inside the screen.
        using (var tb = new SolidBrush(Color.White))
        {
            float cx = inner.X + inner.Width / 2, cy = inner.Y + inner.Height / 2, r = 16 * s;
            PointF[] tri = { new(cx - r * 0.7f, cy - r), new(cx - r * 0.7f, cy + r), new(cx + r, cy) };
            g.FillPolygon(tb, tri);
        }

        // Stand + base.
        using (var wb = new SolidBrush(Color.White))
        {
            g.FillRectangle(wb, 122 * s, 162 * s, 12 * s, 20 * s);
            using var baseP = Round(new RectangleF(96 * s, 180 * s, 64 * s, 12 * s), 6 * s);
            g.FillPath(wb, baseP);
        }

        return bmp;
    }

    private static GraphicsPath Round(RectangleF r, float radius)
    {
        var p = new GraphicsPath();
        float d = Math.Max(1f, radius * 2);
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static Icon ToIcon(int size = 64)
    {
        using var bmp = Draw(size);
        return Icon.FromHandle(bmp.GetHicon());
    }

    /// <summary>Writes a Windows .ico containing PNG images at several sizes.</summary>
    public static void WriteIco(string path, int[]? sizes = null)
    {
        sizes ??= new[] { 16, 24, 32, 48, 64, 128, 256 };
        var pngs = new List<byte[]>();
        foreach (var sz in sizes)
        {
            using var bmp = Draw(sz);
            using var ms = new MemoryStream();
            bmp.Save(ms, ImageFormat.Png);
            pngs.Add(ms.ToArray());
        }

        using var fs = new FileStream(path, FileMode.Create);
        using var w = new BinaryWriter(fs);
        w.Write((short)0);              // reserved
        w.Write((short)1);              // type = icon
        w.Write((short)sizes.Length);   // image count
        int offset = 6 + 16 * sizes.Length;
        for (int i = 0; i < sizes.Length; i++)
        {
            int dim = sizes[i];
            w.Write((byte)(dim >= 256 ? 0 : dim)); // width
            w.Write((byte)(dim >= 256 ? 0 : dim)); // height
            w.Write((byte)0);           // palette
            w.Write((byte)0);           // reserved
            w.Write((short)1);          // planes
            w.Write((short)32);         // bpp
            w.Write(pngs[i].Length);    // bytes in resource
            w.Write(offset);            // offset
            offset += pngs[i].Length;
        }
        foreach (var png in pngs) w.Write(png);
    }
}
