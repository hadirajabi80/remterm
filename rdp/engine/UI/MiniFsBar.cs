using System.Drawing.Drawing2D;

namespace RemoteHub.UI;

/// <summary>
/// The fullscreen connection bar (like mstsc): shows the server name with controls to exit fullscreen and
/// close. A pin keeps it visible; unpinned it auto-hides and reveals when the mouse touches the top edge.
/// It is a separate top-level window so it floats above the RDP session.
/// </summary>
internal sealed class MiniFsBar : Form
{
    private readonly Action _exitFullscreen;
    private readonly Action _close;
    private readonly Label _pin, _exit, _btnClose;
    private readonly System.Windows.Forms.Timer _auto = new() { Interval = 120 };
    private Screen _screen = Screen.PrimaryScreen!;
    private string _title = "";
    private TabStatus _status = TabStatus.Connected;
    private bool _pinned = true;
    private bool _dragging;
    private Point _down;
    private Point _savedLocation;

    public MiniFsBar(Action exitFullscreen, Action close)
    {
        _exitFullscreen = exitFullscreen;
        _close = close;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        TopMost = true;
        DoubleBuffered = true;
        BackColor = Theme.Surface;
        Height = Theme.S(34);
        Width = Theme.S(300);
        SetStyle(ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer | ControlStyles.UserPaint | ControlStyles.ResizeRedraw, true);

        _pin = MakeBtn("", "Pin the bar (keep it visible)");
        _exit = MakeBtn("", "Exit fullscreen");
        _btnClose = MakeBtn("", "Close");
        Controls.AddRange([_pin, _exit, _btnClose]);

        _pin.Click += (_, _) => SetPinned(!_pinned);
        _exit.Click += (_, _) => _exitFullscreen();
        _btnClose.Click += (_, _) => _close();

        _auto.Tick += (_, _) => AutoHideTick();
    }

    private Label MakeBtn(string glyph, string tip)
    {
        var l = new Label { Text = glyph, Font = Theme.Icon, ForeColor = Theme.Text, BackColor = Color.Transparent, TextAlign = ContentAlignment.MiddleCenter, Size = new Size(Theme.S(32), Height), Cursor = Cursors.Hand };
        l.MouseEnter += (_, _) => { l.BackColor = Theme.Hover; l.Invalidate(); };
        l.MouseLeave += (_, _) => { l.BackColor = Color.Transparent; l.Invalidate(); };
        new ToolTip().SetToolTip(l, tip);
        return l;
    }

    protected override bool ShowWithoutActivation => true;
    protected override CreateParams CreateParams
    {
        get { var cp = base.CreateParams; cp.ExStyle |= 0x08000000 /* NOACTIVATE */; return cp; }
    }

    public void ShowOn(Screen screen, string title, TabStatus status)
    {
        _screen = screen;
        _title = title;
        _status = status;
        Width = Math.Clamp(Theme.S(150) + TextRenderer.MeasureText(title, Theme.UiBold).Width, Theme.S(220), Theme.S(520));
        LayoutButtons();
        _savedLocation = new Point(screen.Bounds.X + (screen.Bounds.Width - Width) / 2, screen.Bounds.Y + Theme.S(2));
        Location = _savedLocation;
        UpdateRegion();
        Show();
        BringToFront();
        _auto.Start();
        Invalidate();
    }

    /// <summary>For static preview/screenshots only: set title and lay out without showing or auto-hide.</summary>
    public void PrepareForPreview(string title, TabStatus status)
    {
        _title = title; _status = status;
        Width = Math.Clamp(Theme.S(150) + TextRenderer.MeasureText(title, Theme.UiBold).Width, Theme.S(220), Theme.S(520));
        LayoutButtons();
        if (IsHandleCreated) UpdateRegion();
    }

    public void HideBar()
    {
        _auto.Stop();
        Hide();
    }

    private void SetPinned(bool p)
    {
        _pinned = p;
        _pin.ForeColor = p ? Theme.Accent : Theme.TextDim;
        Invalidate();
        if (!p) AutoHideTick();
    }

    private void AutoHideTick()
    {
        if (_pinned) { if (!Visible) { Location = _savedLocation; Show(); BringToFront(); } return; }
        var c = Cursor.Position;
        bool nearTop = c.Y <= _screen.Bounds.Y + Theme.S(3);
        bool over = Bounds.Contains(c);
        if (nearTop || over) { if (!Visible) { Location = _savedLocation; Show(); BringToFront(); } }
        else if (Visible) Hide();
    }

    private void LayoutButtons()
    {
        if (_btnClose is null) return; // resize can fire during construction, before the buttons exist
        int bw = Theme.S(32);
        _btnClose.Bounds = new Rectangle(Width - bw - Theme.S(4), 0, bw, Height);
        _exit.Bounds = new Rectangle(Width - bw * 2 - Theme.S(4), 0, bw, Height);
        _pin.Bounds = new Rectangle(Theme.S(4), 0, bw, Height);
        _pin.ForeColor = _pinned ? Theme.Accent : Theme.TextDim;
    }

    private void UpdateRegion()
    {
        using var path = Round(new Rectangle(0, 0, Width, Height), Theme.S(8));
        Region = new Region(path);
    }

    protected override void OnResize(EventArgs e) { base.OnResize(e); LayoutButtons(); if (IsHandleCreated) UpdateRegion(); }

    protected override void OnPaint(PaintEventArgs e)
    {
        if (_pin is null) return;
        var g = e.Graphics;
        g.SmoothingMode = SmoothingMode.AntiAlias;
        using (var bg = new SolidBrush(Theme.Surface)) g.FillRectangle(bg, ClientRectangle);
        using (var path = Round(new Rectangle(0, 0, Width - 1, Height - 1), Theme.S(8)))
        using (var pen = new Pen(Theme.Border)) g.DrawPath(pen, path);

        // status dot + server name, centered between the pin and the right buttons
        int left = _pin.Right + Theme.S(8);
        int right = _exit.Left - Theme.S(6);
        int dot = Theme.S(8);
        using (var db = new SolidBrush(_status switch { TabStatus.Connected => Theme.Green, TabStatus.Connecting => Theme.Yellow, _ => Theme.Red }))
            g.FillEllipse(db, left, (Height - dot) / 2, dot, dot);
        TextRenderer.DrawText(g, _title, Theme.UiBold, new Rectangle(left + dot + Theme.S(8), 0, right - left - dot - Theme.S(8), Height),
            Theme.Text, TextFormatFlags.VerticalCenter | TextFormatFlags.Left | TextFormatFlags.EndEllipsis | TextFormatFlags.NoPrefix);
    }

    // drag the bar around by its body (not the buttons)
    protected override void OnMouseDown(MouseEventArgs e) { if (e.Button == MouseButtons.Left) { _dragging = true; _down = e.Location; } }
    protected override void OnMouseMove(MouseEventArgs e)
    {
        if (_dragging)
        {
            Location = new Point(Location.X + e.X - _down.X, Location.Y + e.Y - _down.Y);
            _savedLocation = Location;
        }
    }
    protected override void OnMouseUp(MouseEventArgs e) => _dragging = false;

    private static GraphicsPath Round(Rectangle r, int radius)
    {
        var p = new GraphicsPath();
        int d = radius * 2;
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    protected override void Dispose(bool disposing)
    {
        if (disposing) _auto.Dispose();
        base.Dispose(disposing);
    }
}
