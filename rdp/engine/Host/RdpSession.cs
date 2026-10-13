using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using RemoteHub.Rdp;
using RemoteHub.UI;

namespace RemoteHub.Host;

/// <summary>
/// One RDP session. Docked, its view lives in an <see cref="EmbedHost"/>: a native child window of
/// Remterm's main window that Remterm positions over the tab's content area. The same view can move into
/// its own window (pop-out) or fullscreen and back without disconnecting.
/// </summary>
internal sealed class RdpSession
{
    private readonly EngineHost _engine;
    private readonly EmbedHost _host;
    private SessionWindow? _window;
    private Rectangle _bounds;
    private bool _wantVisible;
    private bool _started;
    private bool _locked;
    private Rectangle[] _clip = [];

    public string Id { get; }
    public SessionView View { get; }

    public RdpSession(string id, EngineHost engine, SessionView view)
    {
        Id = id;
        _engine = engine;
        View = view;
        // Starts hidden (its window is created without WS_VISIBLE; keep WinForms' flag in step) and
        // is shown by the first bounds update from Remterm.
        _host = new EmbedHost(engine.Parent) { BackColor = Theme.Bg, Visible = false };
        view.Dock = DockStyle.Fill;
        _host.Controls.Add(view);
        _ = _host.Handle;

        view.StatusChanged += (_, _) => Report();
        view.Notify += (_, text) => engine.Emit("notify", new { text, id = Id });
        view.CloseTabRequested += (_, _) => engine.Emit("closeRequest", new { id = Id });
        view.Closed += (_, _) => Finish();
    }

    public string Mode => _window == null ? "docked" : _window.IsFullscreen ? "fullscreen" : "window";

    public void Report() => _engine.Emit("session", new
    {
        id = Id,
        title = View.Title,
        status = View.Status.ToString().ToLowerInvariant(),
        message = View.OverlayText,
        mode = Mode,
    });

    // ------------------------------------------------------------------ placement

    /// <summary>Called by Remterm whenever the tab's content area moves, resizes, shows or hides.</summary>
    public void SetBounds(Rectangle r, bool visible)
    {
        // While Remterm is minimized the page reports a tiny area: keep the session's size.
        if (Win.IsMinimized(_engine.Parent)) return;
        if (visible && (r.Width < 120 || r.Height < 90)) return;
        _bounds = r;
        _wantVisible = visible;
        Apply();
    }

    public void ApplyLock(bool locked)
    {
        _locked = locked;
        if (_window != null)
        {
            if (locked) _window.Hide(); else _window.Show();
        }
        Apply();
    }

    private void Apply()
    {
        if (_window != null) { _host.Visible = false; return; }
        bool show = _wantVisible && !_locked && _bounds.Width > 20 && _bounds.Height > 20;
        if (show)
        {
            _host.SetBounds(_bounds.X, _bounds.Y, _bounds.Width, _bounds.Height);
            if (!_host.Visible) _host.Visible = true;
            ApplyClip();
            Win.BringToTop(_host);
            if (!_started)
            {
                _started = true;
                View.Connect(); // first connect only once the session has a real size
            }
        }
        else if (_host.Visible)
        {
            bool hadFocus = Win.Contains(_host, Win.FocusedWindow());
            _host.Visible = false;
            _clip = [];
            ApplyClip();
            if (hadFocus) SetFocus(_engine.Parent); // give the keyboard back to Remterm's web view
        }
    }

    /// <summary>Redraws the session (after Remterm comes back from minimized / another app).</summary>
    public void Refresh()
    {
        if (_window != null || !_host.Visible) return;
        _host.Visible = false;
        _host.Visible = true;
        Win.BringToTop(_host);
        View.PerformLayout();
        View.Invalidate(true);
        View.Rdp?.Invalidate(true);
    }

    public void Focus()
    {
        if (_window != null) { _window.Activate(); View.FocusRemote(); return; }
        if (_host.Visible) View.FocusRemote();
    }

    public bool HasFocus(IntPtr focus, IntPtr foreground) =>
        _window != null ? foreground == _window.Handle || Win.Contains(_window, focus) : _host.Visible && Win.Contains(_host, focus);

    // ------------------------------------------------------------------ pop-out / fullscreen

    /// <summary>Menus and popups of Remterm drawn over the session: these areas are cut out of it.</summary>
    public void SetClip(Rectangle[] rects)
    {
        _clip = rects;
        ApplyClip();
    }

    private void ApplyClip()
    {
        if (!_host.IsHandleCreated) return;
        if (_clip.Length == 0) { SetWindowRgn(_host.Handle, IntPtr.Zero, true); return; }
        var rgn = CreateRectRgn(0, 0, _host.Width, _host.Height);
        foreach (var r in _clip)
        {
            var hole = CreateRectRgn(r.X, r.Y, r.Right, r.Bottom);
            CombineRgn(rgn, rgn, hole, 4 /* RGN_DIFF */);
            DeleteObject(hole);
        }
        if (SetWindowRgn(_host.Handle, rgn, true) == 0) DeleteObject(rgn); // on success Windows owns it
    }

    /// <summary>Into its own window; at a screen point (a tab dropped outside Remterm) or on Remterm's monitor.</summary>
    public void PopOut(Point? at = null, bool follow = false)
    {
        Detach(fullscreen: false, at, activate: !follow);
        if (follow && _window != null) StartFollow();
    }

    // A tab dragged out of Remterm: its new window sticks to the mouse until the button is released.
    private System.Windows.Forms.Timer? _follow;

    private void StartFollow()
    {
        StopFollow();
        var w = _window!;
        var grab = new Point(w.Width / 2, Theme.S(16)); // the pointer holds the window by its title bar
        void Place() => w.Location = new Point(Cursor.Position.X - grab.X, Cursor.Position.Y - grab.Y);
        Place();
        _follow = new System.Windows.Forms.Timer { Interval = 10 };
        _follow.Tick += (_, _) =>
        {
            if (_window != w) { StopFollow(); return; }
            if ((Control.MouseButtons & MouseButtons.Left) == 0)
            {
                StopFollow();
                w.Activate();
                View.FocusRemote();
                return;
            }
            Place();
        };
        _follow.Start();
    }

    private void StopFollow()
    {
        _follow?.Stop();
        _follow?.Dispose();
        _follow = null;
    }

    public void ToggleFullscreen()
    {
        if (_window == null) Detach(fullscreen: true);
        else _window.ToggleFullscreen();
    }

    private void Detach(bool fullscreen, Point? at = null, bool activate = true)
    {
        if (_window != null) { _window.Activate(); return; }
        bool wasStarted = _started;
        _host.Controls.Remove(View);
        var screen = at is { } pt ? Screen.FromPoint(pt) : Screen.FromHandle(_engine.Parent);
        _window = new SessionWindow(View, v => _engine.ShowFillPicker(this), _engine.ToolTips, fullscreen, dockOnExitFullscreen: fullscreen);
        _window.DockBackRequested += (_, _) => Dock();
        _window.CloseSessionRequested += (_, _) =>
        {
            // Take the view back before the window disposes its children.
            var w = _window;
            _window = null;
            w?.ReleaseView();
            View.Dock = DockStyle.Fill;
            _host.Controls.Add(View);
            if (View.IsConnected && _engine.ConfirmCloseConnected &&
                MessageBox.Show($"Disconnect from {View.Machine.Name}?", App.Name, MessageBoxButtons.YesNo, MessageBoxIcon.Question) != DialogResult.Yes)
            {
                Apply(); // keep it: back into its tab
                Report();
                return;
            }
            View.CloseSession();
        };
        var wa = screen.WorkingArea;
        _window.StartPosition = FormStartPosition.Manual;
        _window.Location = fullscreen
            ? screen.Bounds.Location
            : at is { } drop
                ? new Point(Math.Clamp(drop.X - _window.Width / 2, wa.Left, wa.Right - _window.Width), Math.Clamp(drop.Y - Theme.S(20), wa.Top, wa.Bottom - _window.Height))
                : new Point(wa.X + (wa.Width - _window.Width) / 2, wa.Y + (wa.Height - _window.Height) / 2);
        _host.Visible = false;
        _window.ShowInactive = !activate; // a tab still being dragged must keep the mouse
        _window.Show();
        if (activate) _window.Activate();
        if (!wasStarted) { _started = true; View.Connect(); }
        Report();
    }

    public void Dock()
    {
        StopFollow();
        var w = _window;
        if (w == null) return;
        _window = null;
        w.ReleaseView();
        w.Close();
        View.Dock = DockStyle.Fill;
        _host.Controls.Add(View);
        View.Visible = true;
        Apply();
        Report();
        if (_host.Visible) View.FocusRemote();
    }

    // ------------------------------------------------------------------ closing & snapshot

    public void Close()
    {
        if (_window != null)
        {
            var w = _window;
            _window = null;
            w.ReleaseView();
            w.Close();
        }
        _host.Visible = false;
        View.CloseSession(); // raises Closed when the disconnect finishes
    }

    private bool _finished;

    private void Finish()
    {
        if (_finished) return;
        _finished = true;
        if (_window != null)
        {
            var w = _window;
            _window = null;
            w.ReleaseView();
            w.Close();
        }
        try
        {
            _host.Controls.Remove(View);
            View.Dispose();
            _host.Dispose();
        }
        catch { /* the RDP control can throw while tearing down */ }
        _engine.OnSessionClosed(this);
    }

    /// <summary>A still picture of the session (JPEG data URL) shown by Remterm while a dialog covers the tab.</summary>
    public string Snapshot()
    {
        if (_window != null || !_host.Visible) return "";
        Bitmap? bmp = null;
        try
        {
            if (View.IsConnected && View.Rdp != null) bmp = PromptDetector.CaptureSession(View.Rdp);
            if (bmp == null && View.Width > 0 && View.Height > 0)
            {
                bmp = new Bitmap(View.Width, View.Height);
                View.DrawToBitmap(bmp, new Rectangle(Point.Empty, View.Size));
            }
            if (bmp == null) return "";
            using var ms = new MemoryStream();
            var jpeg = ImageCodecInfo.GetImageEncoders().First(c => c.FormatID == ImageFormat.Jpeg.Guid);
            using var p = new EncoderParameters(1);
            p.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, 72L);
            bmp.Save(ms, jpeg, p);
            return "data:image/jpeg;base64," + Convert.ToBase64String(ms.ToArray());
        }
        catch (Exception ex)
        {
            Diag.Log("snapshot: " + ex.Message);
            return "";
        }
        finally
        {
            bmp?.Dispose();
        }
    }

    [DllImport("user32.dll")] private static extern IntPtr SetFocus(IntPtr hwnd);
    [DllImport("user32.dll")] private static extern int SetWindowRgn(IntPtr hwnd, IntPtr rgn, bool redraw);
    [DllImport("gdi32.dll")] private static extern IntPtr CreateRectRgn(int l, int t, int r, int b);
    [DllImport("gdi32.dll")] private static extern int CombineRgn(IntPtr dst, IntPtr a, IntPtr b, int mode);
    [DllImport("gdi32.dll")] private static extern bool DeleteObject(IntPtr obj);
}

/// <summary>
/// A control created directly as a child of another process's window (Remterm's main window), the
/// documented way to host Windows Forms content inside a foreign HWND.
/// </summary>
internal sealed class EmbedHost(IntPtr parent) : ContainerControl
{
    protected override CreateParams CreateParams
    {
        get
        {
            var cp = base.CreateParams;
            cp.Parent = parent;
            cp.Style = Win.WS_CHILD | Win.WS_CLIPCHILDREN | Win.WS_CLIPSIBLINGS;
            cp.ExStyle = 0x00010000; // WS_EX_CONTROLPARENT: Tab moves into the RDP control
            return cp;
        }
    }
}
