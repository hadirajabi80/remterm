namespace RemoteHub;

public sealed class AppData
{
    public int Version { get; set; } = 1;
    public BastionConfig Bastion { get; set; } = new();
    public List<CredentialProfile> Credentials { get; set; } = new();
    public List<Machine> Machines { get; set; } = new();
    public AppSettings Settings { get; set; } = new();

    /// <summary>Host -> SHA-256 of the server public key seen on first connect (TOFU pinning).</summary>
    public Dictionary<string, string> PinnedKeys { get; set; } = new();
}

public sealed class BastionConfig
{
    public string Host { get; set; } = "";
    public int Port { get; set; } = 3389;
    public string PrimaryUser { get; set; } = "";
    public string PrimaryPassword { get; set; } = "";
    public string Authorization { get; set; } = "";

    /// <summary>WALLIX selector-bypass login (for the RDP username field). Tokens: {target} {auth} {user}. Empty segments are dropped.</summary>
    public string LoginTemplate { get; set; } = "{target}:{auth}:{user}";
    public bool UseNla { get; set; } = true;

    /// <summary>
    /// What to type on WALLIX's own interactive login page (the "Redemption" page):
    /// false = the plain primary username; true = the full selector-bypass string (to also skip the machine list there).
    /// </summary>
    public bool InteractiveLoginUsesTarget { get; set; }

    /// <summary>0 = connect without warning (we pin keys ourselves), 1 = require valid cert, 2 = warn.</summary>
    public int AuthLevel { get; set; } = 0;
}

public sealed class CredentialProfile
{
    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
    public override string ToString() => string.IsNullOrEmpty(Username) ? Name : $"{Name}  ({Username})";
}

public enum ConnectionMode { Bastion, Direct }

public enum AutoTypeMode { Auto, Always, Never }

public sealed class Machine
{
    public const string NoCredential = "none";

    public string Id { get; set; } = Guid.NewGuid().ToString("N");
    public string Name { get; set; } = "";
    public string Ip { get; set; } = "";

    /// <summary>WALLIX target, e.g. "Interactive@NFCore-172.16.170.221:RDP". Empty = open the WALLIX selector.</summary>
    public string Target { get; set; } = "";
    public string Group { get; set; } = "";
    public ConnectionMode Mode { get; set; } = ConnectionMode.Bastion;

    /// <summary>null/empty = default profile, "none" = never type credentials. Ignored when <see cref="Username"/> is set.</summary>
    public string? CredentialId { get; set; }

    /// <summary>The machine's own login, typed in its dialog; empty = use <see cref="CredentialId"/>.</summary>
    public string Username { get; set; } = "";
    public string Password { get; set; } = "";
    public AutoTypeMode AutoType { get; set; } = AutoTypeMode.Auto;
    public bool Favorite { get; set; }
    public DateTime? LastUsed { get; set; }
    public string Notes { get; set; } = "";

    /// <summary>Keep the session alive: reconnect when it drops and stop the server signing it out for idleness.</summary>
    public bool KeepAlive { get; set; }

    /// <summary>Picture quality for this machine (see <see cref="RdpQuality"/>); empty = the global setting.</summary>
    public string Quality { get; set; } = "";

    /// <summary>A one-off machine typed into Quick Connect; never saved to the vault.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool IsAdHoc { get; set; }

    /// <summary>A detached copy (same id) for a session that uses a one-time login.</summary>
    public Machine Copy() => (Machine)MemberwiseClone();

    public string Display =>string.IsNullOrEmpty(Ip) ? Name : $"{Name}  ·  {Ip}";

    /// <summary>True when the machine has its own login or a specific credential profile assigned (not default/none).</summary>
    public bool HasOwnCredential => Username.Length > 0 || (!string.IsNullOrEmpty(CredentialId) && CredentialId != NoCredential);

    public bool IsInteractiveTarget =>
        Mode == ConnectionMode.Bastion && Target.StartsWith("Interactive@", StringComparison.OrdinalIgnoreCase);

    public static string MakeTarget(string name, string ip) =>
        string.IsNullOrWhiteSpace(ip) ? $"Interactive@{name}:RDP" : $"Interactive@{name}-{ip}:RDP";
}

/// <summary>
/// How much picture the server sends. Lower levels trade looks for speed on slow links:
/// <list type="bullet">
/// <item>best — the Colors setting and every desktop effect, as before.</item>
/// <item>balanced — no wallpaper, animations, window contents while dragging, or cursor shadow.</item>
/// <item>fast — also 16-bit colours, no visual styles, and the low-bandwidth mode of RDP.</item>
/// <item>fastest — also a 25% smaller remote screen, scaled up to fit (fewer pixels to send, softer text).</item>
/// </list>
/// </summary>
public static class RdpQuality
{
    public const string Best = "best", Balanced = "balanced", Fast = "fast", Fastest = "fastest";

    public static string Normalize(string? q, string fallback = Best)
    {
        var v = (q ?? "").Trim().ToLowerInvariant();
        return v is Best or Balanced or Fast or Fastest ? v : fallback;
    }

    public static int Level(string q) => q switch { Balanced => 1, Fast => 2, Fastest => 3, _ => 0 };
}

public sealed class AppSettings
{
    public string? DefaultCredentialId { get; set; }

    public bool AutoTypeEnabled { get; set; } = true;
    /// <summary>When on, auto-fill fires on connect using screen detection. Off (default) = manual picker only.</summary>
    public bool AutoFillOnConnect { get; set; }
    public int AutoTypeDelayMs { get; set; } = 500;
    public string AutoTypeSequence { get; set; } = "{login}{TAB}{password}{ENTER}";
    public bool AutoTypeDetectScreen { get; set; } = true;

    /// <summary>true = sessions always use the monitor resolution (exact in fullscreen, scaled in a window).</summary>
    public bool SessionUsesScreenSize { get; set; } = true;
    public int ColorDepth { get; set; } = 32;
    /// <summary>Picture quality: best, balanced, fast or fastest (see <see cref="RdpQuality"/>).</summary>
    public string Quality { get; set; } = RdpQuality.Best;
    public bool SmartSizing { get; set; } = true;
    public bool DynamicResize { get; set; } = true;
    public bool RedirectClipboard { get; set; } = true;
    public bool RedirectDrives { get; set; }
    public bool PlayAudioLocally { get; set; } = true;
    public bool WindowsKeysToRemote { get; set; }
    public bool ForceUsKeyboard { get; set; } = true;

    public bool ConfirmCloseConnected { get; set; } = true;
    public int AutoLockMinutes { get; set; }
    public int SidebarWidth { get; set; } = 290;
    public bool DiagEnabled { get; set; }
    public bool StartFullscreen { get; set; }
}
