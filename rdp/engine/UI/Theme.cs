using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;

namespace RemoteHub.UI;

internal static class Theme
{
    // Same palette as Remterm's web UI (styles.css), so embedded sessions look like part of it.
    public static readonly Color Bg = Color.FromArgb(13, 17, 23);         // --term-bg
    public static readonly Color Surface = Color.FromArgb(19, 25, 34);    // --panel
    public static readonly Color Surface2 = Color.FromArgb(25, 32, 43);   // --panel-2
    public static readonly Color Hover = Color.FromArgb(33, 42, 55);     // --border
    public static readonly Color Border = Color.FromArgb(44, 55, 71);    // --border-2
    public static readonly Color Text = Color.FromArgb(216, 222, 233);   // --text
    public static readonly Color TextDim = Color.FromArgb(167, 177, 194); // --text-2
    public static readonly Color Accent = Color.FromArgb(122, 162, 247); // --accent
    public static readonly Color AccentDark = Color.FromArgb(93, 132, 230); // --accent-2
    public static readonly Color Green = Color.FromArgb(158, 206, 106);  // --ok
    public static readonly Color Yellow = Color.FromArgb(224, 175, 104); // --warn
    public static readonly Color Red = Color.FromArgb(247, 118, 142);    // --danger
    public static readonly Color Gold = Color.FromArgb(224, 175, 104);

    public static readonly Font Ui = new("Segoe UI", 9.75f);
    public static readonly Font UiBold = new("Segoe UI Semibold", 9.75f);
    public static readonly Font Small = new("Segoe UI", 8.5f);
    public static readonly Font Title = new("Segoe UI Semibold", 15f);
    public static readonly Font Heading = new("Segoe UI Semibold", 11f);
    public static readonly Font Icon = new("Segoe Fluent Icons", 11f);
    public static readonly Font Mono = new("Cascadia Mono", 9.5f);

    private static float? _scale;
    public static float Scale
    {
        get
        {
            if (_scale is null)
            {
                using var g = Graphics.FromHwnd(IntPtr.Zero);
                _scale = g.DpiX / 96f;
            }
            return _scale.Value;
        }
    }

    public static int S(int px) => (int)Math.Round(px * Scale);

    // Segoe Fluent Icons glyphs
    public const string IcoAdd = "";
    public const string IcoSettings = "";
    public const string IcoFullscreen = "";
    public const string IcoBackToWindow = "";
    public const string IcoLock = "";
    public const string IcoKey = "";
    public const string IcoSidebar = "";
    public const string IcoImport = "";
    public const string IcoSearch = "";
    public const string IcoServer = "";
    public const string IcoBastion = "";
    public const string IcoKeyboard = "";

    public static void UseDarkTitleBar(IWin32Window w)
    {
        int on = 1;
        _ = DwmSetWindowAttribute(w.Handle, 20, ref on, sizeof(int)); // DWMWA_USE_IMMERSIVE_DARK_MODE
        int caption = ColorTranslator.ToWin32(Bg);
        _ = DwmSetWindowAttribute(w.Handle, 35, ref caption, sizeof(int)); // DWMWA_CAPTION_COLOR (Win11)
    }

    public static void UseDarkScrollbars(Control c)
    {
        if (c.IsHandleCreated) _ = SetWindowTheme(c.Handle, "DarkMode_Explorer", null);
        else c.HandleCreated += (_, _) => SetWindowTheme(c.Handle, "DarkMode_Explorer", null);
    }

    public static Button Button(string text, bool primary = false, int width = 0)
    {
        var b = new Button
        {
            Text = text,
            FlatStyle = FlatStyle.Flat,
            BackColor = primary ? Accent : Surface2,
            ForeColor = primary ? Bg : Text,
            Font = primary ? UiBold : Ui,
            Height = S(32),
            Cursor = Cursors.Hand,
            UseVisualStyleBackColor = false,
            AutoSize = width == 0,
            AutoSizeMode = AutoSizeMode.GrowOnly,
            Padding = new Padding(S(10), 0, S(10), 0),
        };
        if (width > 0) b.Width = S(width);
        b.FlatAppearance.BorderColor = primary ? Accent : Border;
        b.FlatAppearance.MouseOverBackColor = primary ? AccentDark : Hover;
        b.FlatAppearance.MouseDownBackColor = primary ? AccentDark : Border;
        return b;
    }

    public static Label IconButton(string glyph, string tip, ToolTip tt)
    {
        var b = new GlyphButton(glyph) { Size = new Size(S(38), S(34)) };
        tt.SetToolTip(b, tip);
        return b;
    }

    /// <summary>Borderless toolbar button (a Label, so the dark-mode button renderer can't add borders).</summary>
    private sealed class GlyphButton : Label
    {
        public GlyphButton(string glyph)
        {
            Text = glyph;
            Font = Theme.Icon;
            ForeColor = Theme.Text;
            BackColor = Theme.Bg;
            TextAlign = ContentAlignment.MiddleCenter;
            AutoSize = false;
            Cursor = Cursors.Hand;
            Margin = new Padding(S(1), 0, S(1), 0);
        }

        protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); BackColor = Hover; }
        protected override void OnMouseLeave(EventArgs e) { base.OnMouseLeave(e); BackColor = Bg; }
        protected override void OnMouseDown(MouseEventArgs e) { base.OnMouseDown(e); BackColor = Border; }
        protected override void OnMouseUp(MouseEventArgs e) { base.OnMouseUp(e); BackColor = ClientRectangle.Contains(e.Location) ? Hover : Bg; }
    }

    public static TextBox TextBox(string text = "", bool password = false)
    {
        var t = new TextBox
        {
            Text = text,
            BackColor = Surface2,
            ForeColor = Text,
            BorderStyle = BorderStyle.FixedSingle,
            Font = Ui,
            UseSystemPasswordChar = password,
        };
        return t;
    }

    public static ComboBox Combo(bool editable = false)
    {
        var c = new ComboBox
        {
            DropDownStyle = editable ? ComboBoxStyle.DropDown : ComboBoxStyle.DropDownList,
            FlatStyle = FlatStyle.Flat,
            BackColor = Surface2,
            ForeColor = Text,
            Font = Ui,
        };
        return c;
    }

    public static CheckBox Check(string text, bool value)
    {
        return new CheckBox { Text = text, Checked = value, ForeColor = Text, AutoSize = true, Font = Ui, FlatStyle = FlatStyle.Flat };
    }

    public static NumericUpDown Number(int value, int min, int max, int step = 1)
    {
        return new NumericUpDown
        {
            Minimum = min, Maximum = max, Value = Math.Clamp(value, min, max), Increment = step,
            BackColor = Surface2, ForeColor = Text, BorderStyle = BorderStyle.FixedSingle, Font = Ui, Width = S(110),
        };
    }

    public static Label Label(string text, bool dim = false, Font? font = null)
    {
        return new Label
        {
            Text = text, AutoSize = true, ForeColor = dim ? TextDim : Text, Font = font ?? Ui,
            Margin = new Padding(0, S(7), S(8), 0),
        };
    }

    public static GraphicsPath RoundRect(RectangleF r, float radius)
    {
        var p = new GraphicsPath();
        float d = radius * 2;
        if (d <= 0) { p.AddRectangle(r); return p; }
        p.AddArc(r.X, r.Y, d, d, 180, 90);
        p.AddArc(r.Right - d, r.Y, d, d, 270, 90);
        p.AddArc(r.Right - d, r.Bottom - d, d, d, 0, 90);
        p.AddArc(r.X, r.Bottom - d, d, d, 90, 90);
        p.CloseFigure();
        return p;
    }

    public static System.Drawing.Icon AppIcon { get; } = LoadAppIcon();

    private static System.Drawing.Icon LoadAppIcon()
    {
        try { return System.Drawing.Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? RemoteHub.Icons.ToIcon(64); }
        catch { return RemoteHub.Icons.ToIcon(64); }
    }

    private static System.Drawing.Icon MakeIcon()
    {
        using var bmp = new Bitmap(64, 64);
        using (var g = Graphics.FromImage(bmp))
        {
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.Clear(Color.Transparent);
            using var path = RoundRect(new RectangleF(2, 2, 60, 60), 14);
            using var brush = new LinearGradientBrush(new Rectangle(0, 0, 64, 64), Color.FromArgb(56, 139, 253), Color.FromArgb(137, 87, 229), 45f);
            g.FillPath(brush, path);
            using var pen = new Pen(Color.White, 5) { StartCap = LineCap.Round, EndCap = LineCap.Round };
            g.DrawRectangle(pen, 14, 16, 36, 24);
            g.DrawLine(pen, 24, 48, 40, 48);
            g.DrawLine(pen, 32, 40, 32, 48);
        }
        return System.Drawing.Icon.FromHandle(bmp.GetHicon());
    }

    public sealed class DarkRenderer : ToolStripProfessionalRenderer
    {
        public DarkRenderer() : base(new DarkColors()) { RoundedEdges = false; }

        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? Text : TextDim;
            base.OnRenderItemText(e);
        }

        protected override void OnRenderArrow(ToolStripArrowRenderEventArgs e)
        {
            e.ArrowColor = Text;
            base.OnRenderArrow(e);
        }
    }

    private sealed class DarkColors : ProfessionalColorTable
    {
        public override Color ToolStripDropDownBackground => Surface;
        public override Color MenuBorder => Border;
        public override Color MenuItemBorder => Hover;
        public override Color MenuItemSelected => Hover;
        public override Color MenuItemSelectedGradientBegin => Hover;
        public override Color MenuItemSelectedGradientEnd => Hover;
        public override Color ImageMarginGradientBegin => Surface;
        public override Color ImageMarginGradientMiddle => Surface;
        public override Color ImageMarginGradientEnd => Surface;
        public override Color SeparatorDark => Border;
        public override Color SeparatorLight => Border;
        public override Color CheckBackground => AccentDark;
        public override Color CheckSelectedBackground => Accent;
    }

    public static ContextMenuStrip Menu()
    {
        return new ContextMenuStrip { Renderer = new DarkRenderer(), BackColor = Surface, ForeColor = Text, Font = Ui, ShowImageMargin = false };
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

    [DllImport("uxtheme.dll", CharSet = CharSet.Unicode)]
    private static extern int SetWindowTheme(IntPtr hwnd, string? appName, string? idList);
}
