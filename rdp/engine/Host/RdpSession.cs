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
            if (hadFocus) SetFocus(_engine.Parent); // give the keyboard back to Remterm's web view
        }
    }

    public void Focus()
    {
        if (_window != null) { _window.Activate(); View.FocusRemote(); return; }
        if (_host.Visible) View.FocusRemote();
    }

    public bool HasFocus(IntPtr focus, IntPtr foreground) =>
        _window != null ? foreground == _window.Handle || Win.Contains(_window, focus) : _host.Visible && Win.Contains(_host, focus);

    // ------------------------------------------------------------------ pop-out / fullscreen

    public void PopOut() => Detach(fullscreen: false);

    public void ToggleFullscreen()
    {
        if (_window == null) Detach(fullscreen: true);
        else _window.ToggleFullscreen();
    }

    private void Detach(bool fullscreen)
    {
        if (_window != null) { _window.Activate(); return; }
        bool wasStarted = _started;
        _host.Controls.Remove(View);
        var screen = Screen.FromHandle(_engine.Parent);
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
            : new Point(wa.X + (wa.Width - _window.Width) / 2, wa.Y + (wa.Height - _window.Height) / 2);
        _host.Visible = false;
        _window.Show();
        _window.Activate();
        if (!wasStarted) { _started = true; View.Connect(); }
        Report();
    }

    public void Dock()
    {
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
