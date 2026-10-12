namespace RemoteHub;

/// <summary>
/// App identity. The display name is "Remterm"; the on-disk storage folder and the DPAPI entropy keep the
/// original "RemoteHub" identifier so vaults created by Remora (and RemoteHub before it) keep working.
/// </summary>
internal static class App
{
    public const string Name = "Remterm";
}
