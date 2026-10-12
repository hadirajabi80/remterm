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

    public static Bitmap? CaptureSession(Control c)
    {
        var bmp = new Bitmap(c.Width, c.Height);
        try
        {
            using (var g = Graphics.FromImage(bmp))
            {
                var hdc = g.GetHdc();
                bool ok;
                try { ok = PrintWindow(c.Handle, hdc, PW_RENDERFULLCONTENT); }
                finally { g.ReleaseHdc(hdc); }
                if (ok && !IsBlank(bmp)) return bmp;
            }

            // Fallback: read the screen, only valid while our window is in front.
            var form = c.FindForm();
            if (form == null || GetForegroundWindow() != form.Handle) { bmp.Dispose(); return null; }
            using (var g = Graphics.FromImage(bmp))
                g.CopyFromScreen(c.PointToScreen(Point.Empty), Point.Empty, c.Size);
            return bmp;
        }
        catch
        {
            bmp.Dispose();
            return null;
        }
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
}
