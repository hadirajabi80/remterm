using RemoteHub.Rdp;

// Headless regression tests: no native input is injected into the desktop and
// no real credentials or remote sessions are used.
internal static class Program
{
    private static async Task Main()
    {
        UnicodePacketsPreserveCredentials();
        MobileTextPacketsBypassAccelerators();
        PartialInputIsNotReplayable();
        FillTargetsDoNotGuessAnUnknownScreen();
        await FillSequenceStopsBeforeSubmittingIncompleteCredentials();
        Console.WriteLine("PASS: Unicode packets, mobile text routing, partial delivery, screen selection and credential sequencing");
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException(message);
    }

    private static void UnicodePacketsPreserveCredentials()
    {
        const string text = "aAZz09!@#$%^&*()_+-=[]{};:'\"`~\\|,.<>/? فارسی é 😀";
        var inputs = KeyTyper.UnicodeInputs(text);
        Assert(inputs.Length == text.Length * 2, "Missing UTF-16 key events");
        for (int i = 0; i < text.Length; i++)
        {
            var down = inputs[2 * i];
            var up = inputs[2 * i + 1];
            Assert(down.type == 1 && up.type == 1, "Not keyboard input");
            Assert(down.u.ki.wVk == 0 && up.u.ki.wVk == 0, "A layout-dependent virtual key was used");
            Assert(down.u.ki.wScan == text[i] && up.u.ki.wScan == text[i], "Credential character changed");
            Assert(down.u.ki.dwFlags == 4 && up.u.ki.dwFlags == 6, "Expected Unicode down/up, without scancode flags");
        }
        Array.Clear(inputs);
        Assert(KeyTyper.UnicodeInputs("").Length == 0, "Empty text generated keys");
        Assert(KeyTyper.NativeInputSize == 40, "Wrong x64 INPUT size");
        try
        {
            KeyTyper.UnicodeInputs("private-value\n");
            throw new Exception("Control characters accepted");
        }
        catch (InvalidOperationException e)
        {
            Assert(!e.Message.Contains("private-value"), "Validation error leaked credential content");
        }
        try { KeyTyper.UnicodeInputs("\uD800"); throw new Exception("Unpaired surrogate accepted"); }
        catch (InvalidOperationException) { }
    }

    private static void PartialInputIsNotReplayable()
    {
        KeyTyper.CheckInputCount(4, 4);
        KeyTyper.CheckInputCount(0, 0);
        try { KeyTyper.CheckInputCount(1, 4); throw new Exception("Partial batch was accepted"); }
        catch (KeyTyper.PartialInputException) { }
        try { KeyTyper.CheckInputCount(0, 4); throw new Exception("Dropped batch was accepted"); }
        catch (KeyTyper.PartialInputException) { throw new Exception("Zero delivery incorrectly marked partial"); }
        catch (InvalidOperationException) { }
    }

    private static void MobileTextPacketsBypassAccelerators()
    {
        Assert(RdpHost.IsUnicodePacket(0x100, (IntPtr)0xE7), "Phone text key-down reached the accelerator translator");
        Assert(RdpHost.IsUnicodePacket(0x101, (IntPtr)0xE7), "Phone text key-up reached the accelerator translator");
        // Shortcuts and physical keys must still use the ActiveX keyboard path.
        foreach (int key in new[] { 0x41, 0x0D, 0x09, 0x08, 0x10, 0x11, 0x12, 0x5B, 0x70 })
            foreach (int message in new[] { 0x100, 0x101, 0x104, 0x105 })
                Assert(!RdpHost.IsUnicodePacket(message, (IntPtr)key), "A physical key or shortcut bypassed ActiveX processing");
        Assert(!RdpHost.IsUnicodePacket(0x102, (IntPtr)0xE7), "WM_CHAR was mistaken for a key packet");
        Assert(!RdpHost.IsUnicodePacket(0x104, (IntPtr)0xE7), "An Alt shortcut was mistaken for plain phone text");
        Assert(!RdpHost.IsUnicodePacket(0x201, (IntPtr)0xE7), "A mouse message was mistaken for phone text");
    }

    private static void FillTargetsDoNotGuessAnUnknownScreen()
    {
        Assert(CredentialFill.Resolve(ScreenReader.Screen.WindowsPassword, false, false) == FillTarget.PasswordOnly, "Lock screen got a username");
        Assert(CredentialFill.Resolve(ScreenReader.Screen.WindowsLogin, false, false) == FillTarget.WindowsLogin, "Windows login lost Unicode mode");
        Assert(CredentialFill.Resolve(ScreenReader.Screen.TargetPrompt, true, false) == FillTarget.LoginAndPassword, "WALLIX lost both fields");
        Assert(CredentialFill.Resolve(ScreenReader.Screen.Unknown, false, false) == FillTarget.Unknown, "Unknown screen guessed a username field");
        Assert(CredentialFill.Resolve(ScreenReader.Screen.Selector, true, false) == FillTarget.Unknown, "Selector got credentials");
        Assert(CredentialFill.Resolve(ScreenReader.Screen.WindowsPassword, true, false) == FillTarget.Unknown, "Ambiguous WALLIX reading guessed password-only");
        Assert(CredentialFill.Resolve(ScreenReader.Screen.Unknown, true, true) == FillTarget.PasswordOnly, "Explicit password-only still depended on OCR");
        Assert(CredentialFill.Resolve(ScreenReader.Screen.Unknown, false, false, true) == FillTarget.LoginAndPassword, "Explicit login filling still depended on OCR");
    }

    private static async Task FillSequenceStopsBeforeSubmittingIncompleteCredentials()
    {
        foreach (bool passwordOnly in new[] { true, false })
        {
            int totalSteps = passwordOnly ? 2 : 4;
            for (int failAt = 0; failAt <= totalSteps; failAt++)
            {
                var events = new List<string>();
                int step = 0;
                Task<bool> Field(string value)
                {
                    events.Add(value == "test-login" ? "login" : "password");
                    return Task.FromResult(++step != failAt);
                }
                Task<bool> Key(int key)
                {
                    events.Add(key == KeyTyper.Enter ? "enter" : "tab");
                    return Task.FromResult(++step != failAt);
                }
                bool ok = await CredentialFill.RunAsync("test-login", "test-password", passwordOnly, Field, Key);
                Assert(ok == (failAt == 0), "Delivery failure was ignored");
                Assert(events.Count == (failAt == 0 ? totalSteps : failAt), "Continued after a failed step");
                if (passwordOnly) Assert(!events.Contains("login") && !events.Contains("tab"), "Password-only moved through a username field");
                if (failAt > 0 && failAt < totalSteps) Assert(!events.Contains("enter"), "Submitted an incomplete credential");
            }
        }

        bool enterSent = false;
        try
        {
            await CredentialFill.RunAsync("user", "password", true,
                _ => throw new KeyTyper.PartialInputException(1, 2),
                _ => { enterSent = true; return Task.FromResult(true); });
            throw new Exception("Partial delivery did not stop filling");
        }
        catch (KeyTyper.PartialInputException) { }
        Assert(!enterSent, "Submitted after partial input exception");
    }
}
