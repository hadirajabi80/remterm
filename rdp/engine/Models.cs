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

    /// <summary>null/empty = default profile, "none" = never type credentials.</summary>
    public string? CredentialId { get; set; }
    public AutoTypeMode AutoType { get; set; } = AutoTypeMode.Auto;
    public bool Favorite { get; set; }
    public DateTime? LastUsed { get; set; }
    public string Notes { get; set; } = "";

    /// <summary>Keep the session alive: reconnect when it drops and stop the server signing it out for idleness.</summary>
    public bool KeepAlive { get; set; }

    /// <summary>A one-off machine typed into Quick Connect; never saved to the vault.</summary>
    [System.Text.Json.Serialization.JsonIgnore]
    public bool IsAdHoc { get; set; }

    public string Display => string.IsNullOrEmpty(Ip) ? Name : $"{Name}  ·  {Ip}";

    /// <summary>True when a specific credential profile was assigned to this machine (not default/none).</summary>
    public bool HasOwnCredential => !string.IsNullOrEmpty(CredentialId) && CredentialId != NoCredential;

    public bool IsInteractiveTarget =>
        Mode == ConnectionMode.Bastion && Target.StartsWith("Interactive@", StringComparison.OrdinalIgnoreCase);

    public static string MakeTarget(string name, string ip) =>
        string.IsNullOrWhiteSpace(ip) ? $"Interactive@{name}:RDP" : $"Interactive@{name}-{ip}:RDP";
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
