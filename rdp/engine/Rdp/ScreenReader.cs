using System.Drawing.Imaging;
using System.Runtime.InteropServices.WindowsRuntime;
using System.Text.RegularExpressions;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;
using Windows.Storage.Streams;

namespace RemoteHub.Rdp;

/// <summary>
/// Reads the session picture with the built-in Windows OCR to tell WALLIX screens apart:
/// the bastion's own login page (step 1) and the "Target Information Required" page (step 2) look
/// identical by colour (dark blue + two white fields), but their text is different.
/// </summary>
internal static class ScreenReader
{
    public enum Screen { Unknown, BastionLogin, TargetPrompt, Selector }

    private static readonly Lazy<OcrEngine?> Engine = new(() =>
    {
        try
        {
            return OcrEngine.TryCreateFromLanguage(new Windows.Globalization.Language("en-US"))
                   ?? OcrEngine.TryCreateFromUserProfileLanguages();
        }
        catch
        {
            return null;
        }
    });

    public static bool Available => Engine.Value != null;

    public static async Task<(Screen screen, string text)> ClassifyAsync(Bitmap bmp)
    {
        var text = await ReadAsync(bmp);
        return (Classify(text), text);
    }

    public static Screen Classify(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return Screen.Unknown;
        var t = Regex.Replace(text, @"\s+", " ");
        bool has(string pattern) => Regex.IsMatch(t, pattern, RegexOptions.IgnoreCase);

        if (has(@"Target\s*Info|Information\s*Req") || (has(@"\bDevice\b") && has("Password")))
            return Screen.TargetPrompt;
        if (has("Authori[sz]ation") && has("Protocol"))
            return Screen.Selector;
        if (has(@"Log\s*in|User\s*name") && has("Pass\\s*word"))
            return Screen.BastionLogin;
        return Screen.Unknown;
    }

    public static async Task<string> ReadAsync(Bitmap source)
    {
        var engine = Engine.Value;
        if (engine == null) return "";

        // Small UI fonts read much better when enlarged.
        double scale = Math.Min(2.0, (OcrEngine.MaxImageDimension - 1) / (double)Math.Max(source.Width, source.Height));
        using var big = scale > 1.05
            ? new Bitmap(source, (int)(source.Width * scale), (int)(source.Height * scale))
            : new Bitmap(source);

        using var ms = new MemoryStream();
        big.Save(ms, ImageFormat.Png);
        using var ras = new InMemoryRandomAccessStream();
        await ras.WriteAsync(ms.ToArray().AsBuffer());
        ras.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(ras);
        using var sb = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied);
        var result = await engine.RecognizeAsync(sb);
        return result.Text ?? "";
    }
}
