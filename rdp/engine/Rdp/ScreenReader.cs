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
    public enum Screen { Unknown, BastionLogin, TargetPrompt, Selector, WindowsPassword, WindowsLogin }

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

    public sealed record Reading(Screen Screen, string Text, bool Wallix, int Boxes);

    /// <summary>
    /// What a sign-in screen asks for, from its text and its input boxes together. OCR often misses the
    /// grey "Password" hint in Windows' lock-screen box: one box centred on a quiet screen is that box.
    /// It also misses the "User name" hint: two stacked boxes are a user name and a password.
    /// </summary>
    public static async Task<Reading> ReadScreenAsync(Bitmap bmp)
    {
        bool wallix = PromptDetector.Analyze(bmp) == PromptDetector.Result.Prompt;
        var (screen, text) = Available ? await ClassifyAsync(bmp) : (Screen.Unknown, "");
        var boxes = PromptDetector.Centred(PromptDetector.FindInputBoxes(bmp), bmp.Width);
        if (!wallix)
        {
            int words = Regex.Matches(text, @"\S+").Count;
            if (screen == Screen.Unknown && boxes.Count == 1 && words <= 20) screen = Screen.WindowsPassword;
            else if (screen == Screen.WindowsPassword && boxes.Count == 2) screen = Screen.WindowsLogin;
        }
        return new Reading(screen, text, wallix, boxes.Count);
    }

    /// <summary>
    /// "Password", also as OCR reads it with the text cursor blinking in front of it ("assword",
    /// "|Password") or with a zero for the o.
    /// </summary>
    private const string Pw = @"ass\s*w[o0]rd";

    public static Screen Classify(string text)
    {
        if (string.IsNullOrWhiteSpace(text)) return Screen.Unknown;
        var t = Regex.Replace(text, @"\s+", " ");
        bool has(string pattern) => Regex.IsMatch(t, pattern, RegexOptions.IgnoreCase);

        if (has(@"Target\s*Info|Information\s*Req") || (has(@"\bDevice\b") && has(Pw)))
            return Screen.TargetPrompt;
        if (has("Authori[sz]ation") && has("Protocol"))
            return Screen.Selector;
        // Windows' "Other user" sign-in: a user name box and a password box (the grey "User name"
        // placeholder is often missed by OCR, the "Sign in to: DOMAIN" line is not).
        if (has(@"Other\s*user|Sign\s*in\s*to\s*:|another\s*domain") && has(Pw))
            return Screen.WindowsLogin;
        if (has(@"Log\s*in|User\s*name") && has(Pw))
            return Screen.BastionLogin;
        // Windows' own sign-in / lock screen: the user is already chosen, only a password box.
        if (has(Pw) && !has(@"User\s*name|Username|Log\s*[il1]n|\bDevice\b|Authori[sz]ation|Sign\s*in\s*to|Other\s*user"))
            return Screen.WindowsPassword;
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
