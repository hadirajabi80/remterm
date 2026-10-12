using System.Runtime.InteropServices;

namespace RemoteHub.Host;

/// <summary>Win32 helpers for sessions that live inside another process's window.</summary>
internal static class Win
{
    /// <summary>The top-level window a control is in: Remterm's main window when embedded, or our own pop-out window.</summary>
    public static IntPtr Root(Control c) => c.IsHandleCreated ? GetAncestor(c.Handle, GA_ROOT) : IntPtr.Zero;

    public static bool IsForeground(Control c)
    {
        var root = Root(c);
        return root != IntPtr.Zero && GetForegroundWindow() == root;
    }

    public static bool IsMinimized(IntPtr hwnd) => hwnd != IntPtr.Zero && IsIconic(hwnd);

    /// <summary>The window that has keyboard focus in the foreground thread (works across processes).</summary>
    public static IntPtr FocusedWindow()
    {
        var fg = GetForegroundWindow();
        if (fg == IntPtr.Zero) return IntPtr.Zero;
        uint tid = GetWindowThreadProcessId(fg, out _);
        var info = new GUITHREADINFO { cbSize = Marshal.SizeOf<GUITHREADINFO>() };
        return GetGUIThreadInfo(tid, ref info) ? info.hwndFocus : IntPtr.Zero;
    }

    public static bool Contains(Control c, IntPtr hwnd) =>
        c.IsHandleCreated && hwnd != IntPtr.Zero && (hwnd == c.Handle || IsChild(c.Handle, hwnd));

    public static void BringToTop(Control c)
    {
        if (c.IsHandleCreated) SetWindowPos(c.Handle, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
    }

    /// <summary>Wraps a foreign window handle so it can own our dialogs.</summary>
    public sealed class Owner(IntPtr handle) : IWin32Window
    {
        public IntPtr Handle { get; } = handle;
    }

    public static Rectangle ClientScreenRect(IntPtr hwnd)
    {
        if (!GetClientRect(hwnd, out var r)) return Rectangle.Empty;
        var p = new POINT { X = 0, Y = 0 };
        ClientToScreen(hwnd, ref p);
        return new Rectangle(p.X, p.Y, r.Right - r.Left, r.Bottom - r.Top);
    }

    public const int WS_CHILD = 0x40000000, WS_POPUP = unchecked((int)0x80000000), WS_VISIBLE = 0x10000000;
    public const int WS_CLIPSIBLINGS = 0x04000000, WS_CLIPCHILDREN = 0x02000000;
    private const uint GA_ROOT = 2;
    private static readonly IntPtr HWND_TOP = IntPtr.Zero;
    private const uint SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOACTIVATE = 0x10;

    [StructLayout(LayoutKind.Sequential)]
    private struct RECT { public int Left, Top, Right, Bottom; }

    [StructLayout(LayoutKind.Sequential)]
    private struct POINT { public int X, Y; }

    [StructLayout(LayoutKind.Sequential)]
    private struct GUITHREADINFO
    {
        public int cbSize;
        public uint flags;
        public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
        public RECT rcCaret;
    }

    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern bool IsChild(IntPtr parent, IntPtr hwnd);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint tid, ref GUITHREADINFO info);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] private static extern bool GetClientRect(IntPtr hwnd, out RECT r);
    [DllImport("user32.dll")] private static extern bool ClientToScreen(IntPtr hwnd, ref POINT p);
    [DllImport("user32.dll")] public static extern bool RegisterHotKey(IntPtr hWnd, int id, uint fsModifiers, uint vk);
    [DllImport("user32.dll")] public static extern bool UnregisterHotKey(IntPtr hWnd, int id);
    [DllImport("user32.dll")] public static extern bool AllowSetForegroundWindow(int pid);

    [StructLayout(LayoutKind.Sequential)]
    private struct LASTINPUTINFO { public uint cbSize; public uint dwTime; }

    [DllImport("user32.dll")] private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

    /// <summary>Milliseconds since the last keyboard/mouse input anywhere in the session.</summary>
    public static long IdleMs()
    {
        var info = new LASTINPUTINFO { cbSize = (uint)Marshal.SizeOf<LASTINPUTINFO>() };
        if (!GetLastInputInfo(ref info)) return 0;
        return unchecked((uint)Environment.TickCount - info.dwTime); // both wrap at 49.7 days
    }
}
