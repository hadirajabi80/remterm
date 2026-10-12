using RemoteHub.Security;

namespace RemoteHub;

/// <summary>In-memory app state backed by the encrypted vault.</summary>
internal sealed class Store(Vault vault, AppData data)
{
    public Vault Vault { get; } = vault;
    public AppData Data { get; } = data;

    public event EventHandler? Changed;

    public void Save(bool notify = true)
    {
        Vault.Save(Data);
        if (notify) Changed?.Invoke(this, EventArgs.Empty);
    }

    public CredentialProfile? ResolveCredential(Machine m)
    {
        if (m.CredentialId == Machine.NoCredential) return null;
        if (!string.IsNullOrEmpty(m.CredentialId))
            return Data.Credentials.FirstOrDefault(c => c.Id == m.CredentialId);
        return Data.Credentials.FirstOrDefault(c => c.Id == Data.Settings.DefaultCredentialId)
               ?? Data.Credentials.FirstOrDefault();
    }

    /// <summary>
    /// WALLIX selector bypass: "Interactive@NFCore-172.16.170.221:RDP" + ":" + authorization + ":" + primary user.
    /// An empty target opens the normal WALLIX selector with just the primary user.
    /// </summary>
    public static string BuildBastionLogin(BastionConfig b, Machine m)
    {
        if (string.IsNullOrWhiteSpace(m.Target)) return b.PrimaryUser;
        var tpl = string.IsNullOrWhiteSpace(b.LoginTemplate) ? "{target}:{auth}:{user}" : b.LoginTemplate;
        var s = tpl.Replace("{target}", m.Target.Trim())
                   .Replace("{auth}", b.Authorization.Trim())
                   .Replace("{user}", b.PrimaryUser.Trim());
        while (s.Contains("::")) s = s.Replace("::", ":");
        return s.Trim(':');
    }

    public IEnumerable<string> Groups =>
        Data.Machines.Select(m => m.Group).Where(g => !string.IsNullOrWhiteSpace(g)).Distinct(StringComparer.OrdinalIgnoreCase).Order();
}
