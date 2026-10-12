using System.Diagnostics;
using RemoteHub.Security;

namespace RemoteHub;

/// <summary>
/// Lightweight troubleshooting log. Off by default; turn on in Settings (or REMOTEHUB_DIAG=1).
/// Writes a text log and saves the screen captures the auto-type logic acted on, so a failing
/// bastion flow can be diagnosed without access to the server.
/// </summary>
internal static class Diag
{
    private static readonly object Lock = new();
    private static int _captureCount;

    public static bool Enabled { get; set; } =
        Environment.GetEnvironmentVariable("REMOTEHUB_DIAG") == "1";

    public static string Folder { get; } = Path.Combine(Vault.Folder, "diag");
    public static string LogPath => Path.Combine(Folder, "remotehub.log");

    public static void Log(string message)
    {
        if (!Enabled) return;
        try
        {
            lock (Lock)
            {
                Directory.CreateDirectory(Folder);
                var line = $"{DateTime.Now:HH:mm:ss.fff}  {message}{Environment.NewLine}";
                File.AppendAllText(LogPath, line);
                if (new FileInfo(LogPath).Length > 512 * 1024) // keep the log small
                {
                    var tail = File.ReadAllLines(LogPath);
                    File.WriteAllLines(LogPath, tail[^2000..]);
                }
            }
            Debug.WriteLine(message);
        }
        catch { /* diagnostics must never break the app */ }
    }

    /// <summary>Saves a capture (max ~20 per run) and returns the file name for the log.</summary>
    public static string SaveCapture(Bitmap? bmp, string tag)
    {
        if (!Enabled || bmp == null) return "(no image)";
        try
        {
            lock (Lock)
            {
                if (_captureCount >= 20) return "(capture limit reached)";
                Directory.CreateDirectory(Folder);
                var name = $"cap_{DateTime.Now:HHmmss}_{_captureCount++}_{tag}.png";
                using var copy = new Bitmap(bmp);
                copy.Save(Path.Combine(Folder, name));
                return name;
            }
        }
        catch
        {
            return "(save failed)";
        }
    }

    public static void Open()
    {
        try
        {
            Directory.CreateDirectory(Folder);
            Process.Start(new ProcessStartInfo("explorer.exe", $"\"{Folder}\"") { UseShellExecute = true });
        }
        catch { /* ignore */ }
    }
}
