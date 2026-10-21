using System.Text.RegularExpressions;
using RemoteHub.Host;
using RemoteHub.Security;

namespace RemoteHub;

internal static class Program
{
    // RemtermRdp.exe --pipe <name> --token <secret> --parent <hwnd>   (started by Remterm.exe)
    // RemtermRdp.exe --import <file> | --set-host <ip> | --dump        (maintenance, no window)
    [STAThread]
    private static int Main(string[] args)
    {
        if (args.Length >= 2 && args[0] == "--import") return ImportFile(args[1]);
        if (args.Length >= 2 && args[0] == "--set-host") return SetHost(args[1]);
        if (args.Length >= 1 && args[0] == "--dump") return Dump();
        if (args.Length >= 2 && args[0] == "--makeicon") { Icons.WriteIco(args[1]); return 0; }
        if (args.Length >= 2 && args[0] == "--read-screen") return ReadScreen(args[1]);

        string? pipe = Arg(args, "--pipe"), token = Arg(args, "--token"), parent = Arg(args, "--parent");
        ApplicationConfiguration.Initialize();
        Application.SetColorMode(SystemColorMode.Dark);
        if (pipe == null || token == null || parent == null || !long.TryParse(parent, out var hwnd))
        {
            MessageBox.Show("This is the Remote Desktop engine of Remterm.\n\nOpen Remterm instead — it starts this part by itself.",
                App.Name, MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 0;
        }

        Application.ThreadException += (_, e) => Diag.Log("UI exception: " + e.Exception);
        EngineHost host;
        try
        {
            host = new EngineHost(pipe, token, new IntPtr(hwnd));
        }
        catch (Exception ex)
        {
            Diag.Log("engine start failed: " + ex.Message);
            return 1;
        }
        Application.Run(host);
        return 0;
    }

    private static string? Arg(string[] args, string name)
    {
        int i = Array.IndexOf(args, name);
        return i >= 0 && i + 1 < args.Length ? args[i + 1] : null;
    }

    private static int ImportFile(string path)
    {
        try
        {
            if (Vault.Exists && Vault.FileNeedsMasterPassword()) { Console.WriteLine("vault is locked with a master password; import from inside the app"); return 1; }
            var (v, d) = Vault.Exists ? Vault.Open(null) : Vault.CreateNew();
            var r = Importer.Parse(File.ReadAllText(path), d.Machines);
            d.Machines.AddRange(r.Machines);
            v.Save(d);
            Console.WriteLine($"imported {r.Machines.Count} machine(s); total now {d.Machines.Count}");
            return 0;
        }
        catch (Exception ex) { Console.WriteLine("ERROR: " + ex.Message); return 1; }
    }

    /// <summary>How auto-fill reads a saved session picture (a screenshot or a Diag capture).</summary>
    private static int ReadScreen(string path)
    {
        try
        {
            using var bmp = new Bitmap(path);
            var r = Rdp.ScreenReader.ReadScreenAsync(bmp).GetAwaiter().GetResult();
            foreach (var b in Rdp.PromptDetector.FindInputBoxes(bmp)) Console.WriteLine($"box {b}");
            Console.WriteLine($"screen={r.Screen} wallixColours={r.Wallix} centredBoxes={r.Boxes} ocr={Rdp.ScreenReader.Available}");
            Console.WriteLine("text: " + r.Text.Replace('\n', ' '));
            return 0;
        }
        catch (Exception ex) { Console.WriteLine("ERROR: " + ex.Message); return 1; }
    }

    private static int SetHost(string host)
    {
        try
        {
            if (!Vault.Exists || Vault.FileNeedsMasterPassword()) { Console.WriteLine("cannot open vault"); return 1; }
            var (v, d) = Vault.Open(null);
            d.Bastion.Host = host;
            v.Save(d);
            Console.WriteLine($"bastion.host set to {host}");
            return 0;
        }
        catch (Exception ex) { Console.WriteLine("ERROR: " + ex.Message); return 1; }
    }

    private static int Dump()
    {
        try
        {
            if (!Vault.Exists) { Console.WriteLine("NO VAULT"); return 0; }
            if (Vault.FileNeedsMasterPassword()) { Console.WriteLine("VAULT NEEDS MASTER PASSWORD"); return 0; }
            var (_, d) = Vault.Open(null);
            Console.WriteLine($"bastion.host={d.Bastion.Host} user={d.Bastion.PrimaryUser} auth={d.Bastion.Authorization} hasPwd={d.Bastion.PrimaryPassword.Length > 0}");
            Console.WriteLine($"credentials={d.Credentials.Count}: " + string.Join(", ", d.Credentials.Select(c => $"{c.Name}/{c.Username}")));
            Console.WriteLine($"machines={d.Machines.Count}");
            foreach (var m in d.Machines.OrderByDescending(m => m.LastUsed ?? DateTime.MinValue))
                Console.WriteLine($"  {m.Name}  ip={m.Ip}  mode={m.Mode}  group={m.Group}  lastUsed={m.LastUsed:yyyy-MM-dd HH:mm}");
            return 0;
        }
        catch (Exception ex) { Console.WriteLine("ERROR: " + ex.Message); return 1; }
    }
}

/// <summary>Turns a pasted WALLIX target list into machines (Interactive@NFCore-172.16.170.221:RDP rows).</summary>
internal static class Importer
{
    private static readonly Regex TargetRx = new(
        @"(?<target>(?<account>[^\s@]+)@(?<device>[^\s:@]+):(?<proto>[A-Za-z0-9_]+))", RegexOptions.Compiled);
    private static readonly Regex IpSuffix = new(@"^(?<name>.+?)-(?<ip>\d{1,3}(?:\.\d{1,3}){3})$", RegexOptions.Compiled);

    public sealed record Result(List<Machine> Machines, int Duplicates, int SkippedProtocols);

    public static Result Parse(string text, IEnumerable<Machine> existingMachines)
    {
        var existing = existingMachines.Select(m => m.Target).ToHashSet(StringComparer.OrdinalIgnoreCase);
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var list = new List<Machine>();
        int skipped = 0, dup = 0;
        foreach (Match m in TargetRx.Matches(text))
        {
            var target = m.Groups["target"].Value;
            if (!m.Groups["proto"].Value.Equals("RDP", StringComparison.OrdinalIgnoreCase)) { skipped++; continue; }
            if (existing.Contains(target) || !seen.Add(target)) { dup++; continue; }
            var device = m.Groups["device"].Value;
            string name = device, ip = "";
            var ipm = IpSuffix.Match(device);
            if (ipm.Success) { name = ipm.Groups["name"].Value; ip = ipm.Groups["ip"].Value; }
            list.Add(new Machine { Name = name, Ip = ip, Target = target, Mode = ConnectionMode.Bastion, Group = GuessGroup(name) });
        }
        return new Result(list, dup, skipped);
    }

    internal static string GuessGroup(string name)
    {
        if (name.StartsWith("PTN", StringComparison.OrdinalIgnoreCase)) return "PTN";
        foreach (var k in new[] { "IRPT", "CSDI", "NF", "RC" })
            if (name.StartsWith(k, StringComparison.Ordinal)) return k;

        // Leading run of capitals ("NFCore" -> "NF"), else the first capitalised word ("IrenexAPI" -> "Irenex").
        var caps = Regex.Match(name, @"^[A-Z]+").Value;
        if (caps.Length < name.Length && caps.Length > 0 && char.IsLower(name[caps.Length])) caps = caps[..^1];
        if (caps.Length >= 2) return caps;
        var word = Regex.Match(name, @"^[A-Z][a-z]+");
        return word.Success ? word.Value : "Other";
    }
}
