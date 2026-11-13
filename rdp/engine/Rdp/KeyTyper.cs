using System.Runtime.InteropServices;
namespace RemoteHub.Rdp;

/// <summary>
/// Turns text into US-layout scan codes and sends them through IMsRdpClientNonScriptable.SendKeys.
/// The session is opened with the US keyboard layout (see SessionView) so the bastion decodes them correctly.
/// </summary>
internal static class KeyTyper
{
    internal sealed class PartialInputException(uint sent, int total)
        : InvalidOperationException($"SendInput sent {sent}/{total} keystrokes; the batch must not be replayed.");
    private const int Shift = 0x2A;
    private const int Ctrl = 0x1D;
    private const int A = 0x1E;
    private const int V = 0x2F;
    public const int Tab = 0x0F;
    public const int Enter = 0x1C;
    public const int CapsLock = 0x3A;

    /// <summary>CapsLock flips the case of every letter typed (Shift+a gives 'a'), so typing must happen with it off.</summary>
    public static bool CapsLockOn => (GetKeyState(0x14 /* VK_CAPITAL */) & 1) != 0;

    [DllImport("user32.dll")]
    private static extern short GetKeyState(int nVirtKey);

    /// <summary>Ctrl+A, so the text typed next replaces whatever is already in the focused field.</summary>
    public static void AppendSelectAll(List<(int sc, bool up)> keys)
    {
        keys.Add((Ctrl, false));
        keys.Add((A, false));
        keys.Add((A, true));
        keys.Add((Ctrl, true));
    }

    /// <summary>Ctrl+A, then the text: replaces what the focused field holds.</summary>
    public static List<(int sc, bool up)> SelectAllThen(string text)
    {
        var keys = new List<(int sc, bool up)>();
        AppendSelectAll(keys);
        AppendText(keys, text);
        return keys;
    }

    /// <summary>Splits keys into groups of about <paramref name="size"/>, never while Shift or Ctrl is held down.</summary>
    public static IEnumerable<List<(int sc, bool up)>> Chunks(List<(int sc, bool up)> keys, int size)
    {
        var chunk = new List<(int sc, bool up)>();
        int held = 0;
        foreach (var k in keys)
        {
            chunk.Add(k);
            if (k.sc is Shift or Ctrl) held += k.up ? -1 : 1;
            if (held <= 0 && chunk.Count >= size)
            {
                yield return chunk;
                chunk = new List<(int sc, bool up)>();
                held = 0;
            }
        }
        if (chunk.Count > 0) yield return chunk;
    }

    public static List<(int sc, bool up)> KeyPress(int scanCode) => new() { (scanCode, false), (scanCode, true) };
    public static List<(int sc, bool up)> SelectAll() => new() { (Ctrl, false), (A, false), (A, true), (Ctrl, true) };
    public static List<(int sc, bool up)> Paste() => new() { (Ctrl, false), (V, false), (V, true), (Ctrl, true) };

    private static readonly Dictionary<char, (int sc, bool shift)> Map = BuildMap();

    private static Dictionary<char, (int, bool)> BuildMap()
    {
        var m = new Dictionary<char, (int, bool)>();
        void Row(string plain, string shifted, int first)
        {
            for (int i = 0; i < plain.Length; i++)
            {
                m[plain[i]] = (first + i, false);
                m[shifted[i]] = (first + i, true);
            }
        }
        Row("1234567890-=", "!@#$%^&*()_+", 0x02);
        Row("qwertyuiop[]", "QWERTYUIOP{}", 0x10);
        Row("asdfghjkl;'`", "ASDFGHJKL:\"~", 0x1E);
        Row("zxcvbnm,./", "ZXCVBNM<>?", 0x2C);
        m['\\'] = (0x2B, false);
        m['|'] = (0x2B, true);
        m[' '] = (0x39, false);
        return m;
    }

    public static bool CanType(string text, out char bad)
    {
        foreach (var c in text)
        {
            if (!Map.ContainsKey(c)) { bad = c; return false; }
        }
        bad = '\0';
        return true;
    }

    public static void AppendText(List<(int sc, bool up)> keys, string text)
    {
        foreach (var c in text)
        {
            if (!Map.TryGetValue(c, out var k))
                throw new InvalidOperationException($"Character '{c}' cannot be typed with the US layout.");
            if (k.shift) keys.Add((Shift, false));
            keys.Add((k.sc, false));
            keys.Add((k.sc, true));
            if (k.shift) keys.Add((Shift, true));
        }
    }

    public static void AppendKey(List<(int sc, bool up)> keys, int scanCode)
    {
        keys.Add((scanCode, false));
        keys.Add((scanCode, true));
    }

    /// <summary>Types via the RDP control's own COM method (needs the control focused; can be flaky on some proxies).</summary>
    public static void SendCom(IMsRdpClientNonScriptable client, List<(int sc, bool up)> keys)
    {
        if (keys.Count == 0) return;
        var ups = new short[keys.Count];
        var codes = new int[keys.Count];
        for (int i = 0; i < keys.Count; i++)
        {
            ups[i] = keys[i].up ? (short)-1 : (short)0; // VARIANT_BOOL
            codes[i] = keys[i].sc;
        }
        try { client.SendKeys(keys.Count, ups, codes); }
        finally { Array.Clear(codes); }
    }

    /// <summary>
    /// Types by injecting real keyboard scancodes with Win32 SendInput. These go to the focused window,
    /// so the caller must make sure the RDP session (inside our foreground window) has keyboard focus.
    /// This is far more reliable than the COM SendKeys on bastion/proxy setups.
    /// </summary>
    public static void SendInputKeys(List<(int sc, bool up)> keys)
    {
        if (keys.Count == 0) return;
        var inputs = new INPUT[keys.Count];
        for (int i = 0; i < keys.Count; i++)
        {
            inputs[i] = new INPUT
            {
                type = INPUT_KEYBOARD,
                u = new InputUnion
                {
                    ki = new KEYBDINPUT
                    {
                        wVk = 0,
                        wScan = (ushort)keys[i].sc,
                        dwFlags = KEYEVENTF_SCANCODE | (keys[i].up ? KEYEVENTF_KEYUP : 0u),
                        time = 0,
                        dwExtraInfo = IntPtr.Zero,
                    },
                },
            };
        }
        uint sent = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>());
        Array.Clear(inputs);
        CheckInputCount(sent, inputs.Length);
    }

    internal static void CheckInputCount(uint sent, int expected)
    {
        if (sent > 0 && sent != expected) throw new PartialInputException(sent, expected);
        if (sent == 0 && expected > 0) throw new InvalidOperationException("SendInput did not send any keystrokes.");
    }

    // Unicode packets express the actual characters rather than positions on a
    // keyboard. Windows sign-in must not reinterpret a saved password through
    // the current remote layout or Caps Lock, and cannot depend on clipboard paste.
    internal static INPUT[] UnicodeInputs(string text)
    {
        if (text.Any(char.IsControl)) throw new InvalidOperationException("A credential contains an unsupported control character.");
        for (int i = 0; i < text.Length; i++)
        {
            if (!char.IsSurrogate(text[i])) continue;
            if (!char.IsHighSurrogate(text[i]) || i + 1 >= text.Length || !char.IsLowSurrogate(text[++i]))
                throw new InvalidOperationException("A credential contains invalid Unicode text.");
        }
        var inputs = new INPUT[text.Length * 2];
        for (int i = 0; i < text.Length; i++)
        {
            for (int up = 0; up < 2; up++)
                inputs[2 * i + up] = new INPUT
                {
                    type = INPUT_KEYBOARD,
                    u = new InputUnion { ki = new KEYBDINPUT { wVk = 0, wScan = text[i], dwFlags = KEYEVENTF_UNICODE | (up == 1 ? KEYEVENTF_KEYUP : 0u) } },
                };
        }
        return inputs;
    }

    public static void SendUnicodeText(string text)
    {
        var inputs = UnicodeInputs(text);
        try
        {
            if (inputs.Length > 0) CheckInputCount(SendInput((uint)inputs.Length, inputs, Marshal.SizeOf<INPUT>()), inputs.Length);
        }
        finally { Array.Clear(inputs); }
    }

    /// <summary>For self-test: the marshaled INPUT size (must be 40 on x64, 28 on x86).</summary>
    public static int NativeInputSize => Marshal.SizeOf<INPUT>();

    private const int INPUT_KEYBOARD = 1;
    private const uint KEYEVENTF_KEYUP = 0x0002;
    private const uint KEYEVENTF_SCANCODE = 0x0008;
    private const uint KEYEVENTF_UNICODE = 0x0004;

    [StructLayout(LayoutKind.Sequential)]
    internal struct INPUT { public uint type; public InputUnion u; }

    // The union must be the size of its LARGEST member (MOUSEINPUT) so that sizeof(INPUT) is the value
    // Windows expects for cbSize (40 on x64). A union holding only KEYBDINPUT made INPUT too small and
    // SendInput silently rejected every call (returned 0).
    [StructLayout(LayoutKind.Explicit)]
    internal struct InputUnion
    {
        [FieldOffset(0)] public MOUSEINPUT mi;
        [FieldOffset(0)] public KEYBDINPUT ki;
        [FieldOffset(0)] public HARDWAREINPUT hi;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct KEYBDINPUT
    {
        public ushort wVk;
        public ushort wScan;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct MOUSEINPUT
    {
        public int dx;
        public int dy;
        public uint mouseData;
        public uint dwFlags;
        public uint time;
        public IntPtr dwExtraInfo;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct HARDWAREINPUT
    {
        public uint uMsg;
        public ushort wParamL;
        public ushort wParamH;
    }

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    /// <summary>
    /// Parses a sequence such as "{login}{TAB}{password}{ENTER}" into steps.
    /// Supported tokens: {login} {password} {TAB} {ENTER} {SPACE} {DELAY:ms}; anything else is literal text.
    /// </summary>
    public static IEnumerable<Step> Parse(string sequence)
    {
        int i = 0;
        while (i < sequence.Length)
        {
            if (sequence[i] == '{')
            {
                int end = sequence.IndexOf('}', i);
                if (end > i)
                {
                    var token = sequence.Substring(i + 1, end - i - 1);
                    i = end + 1;
                    var upper = token.ToUpperInvariant();
                    if (upper == "LOGIN" || upper == "USERNAME") yield return new Step(StepKind.Login);
                    else if (upper == "PASSWORD") yield return new Step(StepKind.Password);
                    else if (upper == "TAB") yield return new Step(StepKind.Key, Tab);
                    else if (upper == "ENTER") yield return new Step(StepKind.Key, Enter);
                    else if (upper == "SPACE") yield return new Step(StepKind.Key, 0x39);
                    else if (upper.StartsWith("DELAY:") && int.TryParse(upper[6..], out var ms)) yield return new Step(StepKind.Delay, ms);
                    else yield return new Step(StepKind.Text, 0, "{" + token + "}");
                    continue;
                }
            }
            int next = sequence.IndexOf('{', i + 1);
            if (next < 0) next = sequence.Length;
            yield return new Step(StepKind.Text, 0, sequence[i..next]);
            i = next;
        }
    }

    public enum StepKind { Login, Password, Key, Text, Delay }

    public readonly record struct Step(StepKind Kind, int Value = 0, string Text = "");
}
