using System.Drawing.Imaging;
using System.Runtime.InteropServices;

namespace RemoteHub.Rdp;

/// <summary>
/// Looks at the session picture to decide whether the WALLIX "Target Information Required" screen is showing:
/// an almost entirely dark-navy screen with only two small white input fields. The machine list (selector)
/// is mostly light rows, and a Windows desktop is neither, so we never type a password into the wrong place.
/// </summary>
internal static class PromptDetector
{
    public enum Result { Prompt, NotPrompt, Unknown }

    public static Result Detect(Control rdp)
    {
        if (!rdp.IsHandleCreated || rdp.Width < 100 || rdp.Height < 100) return Result.Unknown;
        using var bmp = CaptureSession(rdp);
        return bmp == null ? Result.Unknown : Analyze(bmp);
    }

    public static Result Analyze(Bitmap bmp)
    {
        int navy = 0, light = 0, black = 0, total = 0;
        const int cols = 32, rows = 20;
        // Sample the central 90% so window borders / scrollbars don't count.
        for (int y = 0; y < rows; y++)
        for (int x = 0; x < cols; x++)
        {
            int px = (int)(bmp.Width * (0.05 + 0.9 * (x + 0.5) / cols));
            int py = (int)(bmp.Height * (0.05 + 0.9 * (y + 0.5) / rows));
            var c = bmp.GetPixel(px, py);
            total++;
            if (c.R < 8 && c.G < 8 && c.B < 8) black++;
            else if (c.B >= 60 && c.B - c.R >= 35 && c.B - c.G >= 20 && c.R <= 70) navy++;
            else if (c.R >= 190 && c.G >= 190 && c.B >= 190) light++;
        }

        if (black > total * 0.9) return Result.Unknown; // capture produced nothing useful
        double navyRatio = (double)navy / total, lightRatio = (double)light / total;
        return navyRatio >= 0.72 && lightRatio <= 0.15 ? Result.Prompt : Result.NotPrompt;
    }

    /// <summary>
    /// The white text boxes on a sign-in screen, found by their straight edges: rows of near-white
    /// pixels that start and end at the same columns. Windows' lock screen has one (the password), its
    /// "Other user" screen and WALLIX's pages two. Text inside a box breaks the middle rows, the rows
    /// above and below it still line up. Wallpaper clouds have ragged edges and never line up.
    /// </summary>
    public static List<Rectangle> FindInputBoxes(Bitmap bmp)
    {
        int w = bmp.Width, h = bmp.Height;
        var boxes = new List<Rectangle>();
        if (w < 200 || h < 150) return boxes;
        int minRun = Math.Max(60, w * 7 / 100), maxRun = w * 55 / 100;
        int x0 = w * 3 / 100, x1 = w - x0, y0 = h * 10 / 100, y1 = h * 97 / 100;
        int tol = Math.Max(2, w / 640), maxH = h * 9 / 100;
        static bool White(int p) => ((p >> 16) & 0xFF) >= 236 && ((p >> 8) & 0xFF) >= 236 && (p & 0xFF) >= 236;

        // (top, bottom, left, right, rows, white-until) of runs that line up. Rows join a box only while
        // its right edge stays white in between: the hint text never reaches it, the gap between two
        // stacked boxes (Windows' "Other user", WALLIX) does not have it.
        var groups = new List<int[]>();
        var data = bmp.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppArgb);
        try
        {
            var row = new int[w];
            for (int y = y0; y < y1; y++)
            {
                Marshal.Copy(data.Scan0 + y * data.Stride, row, 0, w);
                foreach (var gr in groups)
                    if (gr[5] == y - 1 && y - gr[0] <= maxH && White(row[Math.Max(0, gr[3] - tol - 1)])) gr[5] = y;
                int start = -1;
                for (int x = x0; x <= x1; x++)
                {
                    bool white = x < x1 && White(row[x]);
                    if (white) { if (start < 0) start = x; continue; }
                    if (start < 0) continue;
                    int len = x - start;
                    if (len >= minRun && len <= maxRun) AddRun(groups, y, start, x - 1, tol);
                    start = -1;
                }
            }
        }
        finally { bmp.UnlockBits(data); }

        int minH = Math.Max(8, h * 8 / 1000);
        foreach (var gr in groups)
        {
            int height = gr[1] - gr[0] + 1;
            if (gr[4] < 4 || height < minH || height > maxH || gr[4] * 10 < height * 2) continue;
            var box = new Rectangle(gr[2], gr[0], gr[3] - gr[2] + 1, height);
            // The rows beside the hint text ("Password" ends, white goes on) line up too: same box.
            var near = Rectangle.Inflate(box, tol, 1);
            int same = boxes.FindIndex(b => b.IntersectsWith(near));
            if (same >= 0) boxes[same] = Rectangle.Union(boxes[same], box);
            else boxes.Add(box);
        }
        boxes.Sort((a, b) => a.Y.CompareTo(b.Y));
        return boxes;
    }

    private static void AddRun(List<int[]> groups, int y, int left, int right, int tol)
    {
        foreach (var gr in groups)
        {
            if (gr[5] < y - 1 || Math.Abs(gr[2] - left) > tol || Math.Abs(gr[3] - right) > tol) continue;
            gr[1] = gr[5] = y;
            gr[4]++;
            return;
        }
        groups.Add([y, y, left, right, 1, y]);
    }

    /// <summary>The boxes of <paramref name="boxes"/> centred across the screen, the way sign-in screens place them.</summary>
    public static List<Rectangle> Centred(List<Rectangle> boxes, int width) =>
        boxes.Where(b => Math.Abs(b.X + b.Width / 2 - width / 2) <= width * 8 / 100).ToList();

    /// <summary>
    /// The session picture. While its window is in front it is copied from the screen: PrintWindow makes
    /// the RDP control repaint itself into our bitmap, and on some graphics drivers that flashes the live
    /// session black — every 250 ms while auto-fill watches the screen. PrintWindow is only the fallback
    /// for a session that is not on screen (tab previews), or when asked for (<paramref name="preferScreen"/>
    /// false: a still taken while Remterm's own menus may be cut into the session).
    /// </summary>
    public static Bitmap? CaptureSession(Control c, bool preferScreen = true)
    {
        if (!c.IsHandleCreated || c.Width < 1 || c.Height < 1) return null;
        var bmp = new Bitmap(c.Width, c.Height);
        try
        {
            if (preferScreen && OnScreen(c))
            {
                using var g = Graphics.FromImage(bmp);
                g.CopyFromScreen(c.PointToScreen(Point.Empty), Point.Empty, c.Size);
                return bmp;
            }

            using (var g = Graphics.FromImage(bmp))
            {
                var hdc = g.GetHdc();
                bool ok;
                try { ok = PrintWindow(c.Handle, hdc, PW_RENDERFULLCONTENT); }
                finally { g.ReleaseHdc(hdc); }
                if (ok && !IsBlank(bmp)) return bmp;
            }
            bmp.Dispose();
            return null;
        }
        catch
        {
            bmp.Dispose();
            return null;
        }
    }

    /// <summary>Visible, in the window that is in front, and that window not minimized: what the screen shows is the session.</summary>
    private static bool OnScreen(Control c)
    {
        if (!c.Visible || !IsWindowVisible(c.Handle)) return false;
        var root = GetAncestor(c.Handle, GA_ROOT);
        return root != IntPtr.Zero && GetForegroundWindow() == root && !IsIconic(root);
    }

    private static bool IsBlank(Bitmap b)
    {
        for (int i = 1; i < 10; i++)
        {
            var c = b.GetPixel(b.Width * i / 10, b.Height * i / 10);
            if (c.R > 8 || c.G > 8 || c.B > 8) return false;
        }
        return true;
    }

    private const uint PW_RENDERFULLCONTENT = 0x2;

    [DllImport("user32.dll")]
    private static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    private const uint GA_ROOT = 2;
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
}
