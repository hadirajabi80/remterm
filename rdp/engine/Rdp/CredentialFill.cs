namespace RemoteHub.Rdp;

internal enum FillTarget { Unknown, LoginAndPassword, PasswordOnly, WindowsLogin }

internal static class CredentialFill
{
    // An unreadable screen is not evidence that it has a username field.
    public static FillTarget Resolve(ScreenReader.Screen screen, bool wallix, bool passwordOnly, bool loginAndPassword = false) =>
        passwordOnly ? FillTarget.PasswordOnly : loginAndPassword ? FillTarget.LoginAndPassword : screen switch
        {
            ScreenReader.Screen.WindowsPassword when !wallix => FillTarget.PasswordOnly,
            ScreenReader.Screen.WindowsLogin when !wallix => FillTarget.WindowsLogin,
            ScreenReader.Screen.BastionLogin or ScreenReader.Screen.TargetPrompt => FillTarget.LoginAndPassword,
            _ => FillTarget.Unknown,
        };

    // Do not tab to another field or submit a partially sent credential.
    public static async Task<bool> RunAsync(string login, string password, bool passwordOnly,
        Func<string, Task<bool>> fillField, Func<int, Task<bool>> pressKey)
    {
        if (!passwordOnly && (!await fillField(login) || !await pressKey(KeyTyper.Tab))) return false;
        if (!await fillField(password)) return false;
        return await pressKey(KeyTyper.Enter);
    }
}
