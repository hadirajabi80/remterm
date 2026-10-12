namespace RemoteHub.UI;

internal sealed record FillEntry(string Label, string Sub, string Login, string Password, bool IsBastion = false);

/// <summary>
/// A quick list of saved logins. The user picks one (click, Enter, or number key) and it is typed into
/// whatever screen is currently showing in the session — no screen detection involved.
/// </summary>
internal sealed class CredentialPicker : Form
{
    private readonly List<FillEntry> _all;
    private readonly TextBox _search;
    private readonly ListBox _list;

    public FillEntry? Result { get; private set; }

    public CredentialPicker(IEnumerable<FillEntry> entries)
    {
        _all = entries.ToList();
        AutoScaleMode = AutoScaleMode.None;
        FormBorderStyle = FormBorderStyle.None;
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        BackColor = Theme.Accent;
        Padding = new Padding(1);
        Size = new Size(Theme.S(560), Theme.S(420));
        KeyPreview = true;

        var inner = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Surface, Padding = new Padding(Theme.S(10)) };
        var title = new Label
        {
            Dock = DockStyle.Top, Text = "Fill login  —  pick one, it types on the current screen", AutoSize = false,
            Height = Theme.S(22), ForeColor = Theme.TextDim, Font = Theme.Small,
        };
        _search = new TextBox
        {
            Dock = DockStyle.Top, BorderStyle = BorderStyle.None, BackColor = Theme.Surface, ForeColor = Theme.Text,
            Font = new Font("Segoe UI", 14f), PlaceholderText = "Search a login…  (or press 1–9)",
        };
        var sep = new Panel { Dock = DockStyle.Top, Height = Theme.S(8), BackColor = Theme.Surface };
        _list = new ListBox
        {
            Dock = DockStyle.Fill, BorderStyle = BorderStyle.None, BackColor = Theme.Surface, ForeColor = Theme.Text,
            DrawMode = DrawMode.OwnerDrawFixed, ItemHeight = Theme.S(36), IntegralHeight = false, Font = Theme.Ui,
        };
        Theme.UseDarkScrollbars(_list);
        _list.DrawItem += DrawItem;
        _list.DoubleClick += (_, _) => Accept();
        inner.Controls.Add(_list);
        inner.Controls.Add(sep);
        inner.Controls.Add(_search);
        inner.Controls.Add(title);
        Controls.Add(inner);

        _search.TextChanged += (_, _) => Filter();
        Filter();
    }

    protected override void OnShown(EventArgs e)
    {
        base.OnShown(e);
        Activate();
        _search.Focus();
    }

    protected override void OnDeactivate(EventArgs e)
    {
        base.OnDeactivate(e);
        if (DialogResult == DialogResult.None) { DialogResult = DialogResult.Cancel; Close(); }
    }

    protected override bool ProcessCmdKey(ref Message msg, Keys keyData)
    {
        switch (keyData)
        {
            case Keys.Escape: DialogResult = DialogResult.Cancel; Close(); return true;
            case Keys.Enter: Accept(); return true;
            case Keys.Down: MoveSel(1); return true;
            case Keys.Up: MoveSel(-1); return true;
            case >= Keys.D1 and <= Keys.D9 when !_search.Focused || _search.Text.Length == 0:
                PickNumber(keyData - Keys.D1); return true;
            case >= Keys.NumPad1 and <= Keys.NumPad9:
                PickNumber(keyData - Keys.NumPad1); return true;
        }
        return base.ProcessCmdKey(ref msg, keyData);
    }

    private void PickNumber(int i)
    {
        if (i >= 0 && i < _list.Items.Count) { _list.SelectedIndex = i; Accept(); }
    }

    private void MoveSel(int d)
    {
        if (_list.Items.Count == 0) return;
        _list.SelectedIndex = Math.Clamp(_list.SelectedIndex + d, 0, _list.Items.Count - 1);
    }

    private void Accept()
    {
        if (_list.SelectedItem is FillEntry f)
        {
            Result = f;
            DialogResult = DialogResult.OK;
            Close();
        }
    }

    private void Filter()
    {
        var tokens = _search.Text.ToLowerInvariant().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        var items = _all.Where(f =>
        {
            var hay = $"{f.Label} {f.Sub} {f.Login}".ToLowerInvariant();
            return tokens.All(hay.Contains);
        }).ToList();
        _list.BeginUpdate();
        _list.Items.Clear();
        foreach (var f in items) _list.Items.Add(f);
        _list.EndUpdate();
        if (_list.Items.Count > 0) _list.SelectedIndex = 0;
    }

    private void DrawItem(object? sender, DrawItemEventArgs e)
    {
        if (e.Index < 0) return;
        var f = (FillEntry)_list.Items[e.Index];
        bool sel = (e.State & DrawItemState.Selected) != 0;
        using (var bg = new SolidBrush(sel ? Theme.AccentDark : Theme.Surface))
            e.Graphics.FillRectangle(bg, e.Bounds);
        var r = e.Bounds;

        // number badge for the first 9
        if (e.Index < 9)
        {
            var badge = new Rectangle(r.X + Theme.S(8), r.Y + (r.Height - Theme.S(20)) / 2, Theme.S(20), Theme.S(20));
            using var bb = new SolidBrush(sel ? Theme.Accent : Theme.Surface2);
            e.Graphics.FillRectangle(bb, badge);
            TextRenderer.DrawText(e.Graphics, (e.Index + 1).ToString(), Theme.Small, badge, sel ? Color.White : Theme.TextDim,
                TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter);
        }
        int x = r.X + Theme.S(38);
        var icon = f.IsBastion ? Theme.IcoBastion + "  " : Theme.IcoKey + "  ";
        TextRenderer.DrawText(e.Graphics, icon, Theme.Icon, new Point(x, r.Y + (r.Height - Theme.S(22)) / 2), f.IsBastion ? Theme.Accent : Theme.Gold);
        x += Theme.S(26);
        var label = f.Label;
        var sz = TextRenderer.MeasureText(label, Theme.UiBold);
        TextRenderer.DrawText(e.Graphics, label, Theme.UiBold, new Point(x, r.Y + (r.Height - sz.Height) / 2), Theme.Text);
        TextRenderer.DrawText(e.Graphics, f.Login, Theme.Ui, new Rectangle(x + sz.Width + Theme.S(10), r.Y, r.Width - x - sz.Width - Theme.S(20), r.Height),
            sel ? Theme.Text : Theme.TextDim, TextFormatFlags.VerticalCenter | TextFormatFlags.EndEllipsis);
    }
}
