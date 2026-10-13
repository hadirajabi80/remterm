using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using RemoteHub.Host;
using RemoteHub.Rdp;

namespace RemoteHub.UI;

public enum TabStatus { Connecting, Connected, Disconnected }

/// <summary>One RDP session (one tab).</summary>
internal sealed class SessionView : UserControl
{
    private readonly Store _store;
    private RdpHost? _rdp;

    private readonly Panel _overlay;
    private readonly Label _overlayTitle;
    private readonly Label _overlayText;
    private readonly Button _btnReconnect;
    private readonly Button _btnTrustKey;
    private readonly Button _btnClose;

    private readonly System.Windows.Forms.Timer _resizeTimer = new() { Interval = 450 };
    private readonly System.Windows.Forms.Timer _autoTypeTimer = new() { Interval = 250 };
    private DateTime _autoTypeStart;
    private int _visibleWaitMs;
    private bool _loggedIn;
    private bool _closing;
    private bool _typing;
    private string? _pendingKeyHash;
    private System.Windows.Forms.Timer? _closeTimeout;

    public Machine Machine { get; }
    public string Title { get; set; }
    public string ToolTip { get; }
    public TabStatus Status { get; private set; } = TabStatus.Connecting;
    public bool IsConnected { get; private set; }
    internal RdpHost? Rdp => _rdp;
    internal string OverlayText => _overlay.Visible ? $"{_overlayTitle.Text} | {_overlayText.Text}" : "";

    public event EventHandler? StatusChanged;
    public event EventHandler<string>? Notify;
    public event EventHandler? Closed;
    public event EventHandler? CloseTabRequested;

    public SessionView(Store store, Machine machine)
    {
        _store = store;
        Machine = machine;
        Title = machine.Name;
        ToolTip = Describe(machine);
        BackColor = Color.Black;
        Dock = DockStyle.Fill;

        _overlay = new Panel { Dock = DockStyle.Fill, BackColor = Theme.Bg };
        var card = new TableLayoutPanel
        {
            AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink, ColumnCount = 1, Anchor = AnchorStyles.None,
            BackColor = Theme.Bg,
        };
        _overlayTitle = new Label { AutoSize = true, Font = Theme.Title, ForeColor = Theme.Text, Anchor = AnchorStyles.None, Margin = new Padding(0, 0, 0, Theme.S(8)) };
        _overlayText = new Label
        {
            AutoSize = true, Font = Theme.Ui, ForeColor = Theme.TextDim, Anchor = AnchorStyles.None,
            MaximumSize = new Size(Theme.S(560), 0), TextAlign = ContentAlignment.MiddleCenter, Margin = new Padding(0, 0, 0, Theme.S(18)),
        };
        var buttons = new FlowLayoutPanel { AutoSize = true, Anchor = AnchorStyles.None, BackColor = Theme.Bg, WrapContents = false };
        _btnReconnect = Theme.Button("Reconnect", primary: true);
        _btnTrustKey = Theme.Button("Trust new key && reconnect");
        _btnClose = Theme.Button("Close tab");
        _btnReconnect.Click += (_, _) => Connect();
        _btnTrustKey.Click += (_, _) => TrustNewKey();
        _btnClose.Click += (_, _) => CloseTabRequested?.Invoke(this, EventArgs.Empty);
        buttons.Controls.AddRange([_btnReconnect, _btnTrustKey, _btnClose]);
        card.Controls.Add(_overlayTitle);
        card.Controls.Add(_overlayText);
        card.Controls.Add(buttons);
        var center = new TableLayoutPanel { Dock = DockStyle.Fill, ColumnCount = 1, RowCount = 1, BackColor = Theme.Bg };
        center.Controls.Add(card);
        _overlay.Controls.Add(center);
        Controls.Add(_overlay);

        _resizeTimer.Tick += (_, _) => { _resizeTimer.Stop(); SyncDisplaySize(); };
        _autoTypeTimer.Tick += AutoTypeTick;
    }

    private static string Describe(Machine m) =>
        m.Mode == ConnectionMode.Direct ? $"{m.Name}\nDirect: {m.Ip}" : $"{m.Name}\n{(string.IsNullOrEmpty(m.Target) ? "WALLIX selector" : m.Target)}";

    // ---------------------------------------------------------------- connection

    public void Connect()
    {
        _closing = false;
        _loggedIn = false;
        IsConnected = false;
        StopAutoType();
        DestroyRdp();
        SetStatus(TabStatus.Connecting);
        ShowOverlay($"Connecting to {Machine.Name}…",
            Machine.Mode == ConnectionMode.Direct ? Machine.Ip : $"via bastion {_store.Data.Bastion.Host}", reconnect: false);

        var b = _store.Data.Bastion;
        var s = _store.Data.Settings;
        string server, user, pass;
        int port;

        if (Machine.Mode == ConnectionMode.Direct)
        {
            (server, port) = ParseHost(Machine.Ip, 3389);
            var cred = _store.ResolveCredential(Machine);
            user = cred?.Username ?? "";
            pass = cred?.Password ?? "";
        }
        else
        {
            if (string.IsNullOrWhiteSpace(b.Host))
            {
                ShowError("Bastion not configured", "Open Settings (⚙) and enter the bastion address and your primary login.");
                return;
            }
            server = b.Host.Trim();
            port = b.Port;
            user = Store.BuildBastionLogin(b, Machine);
            pass = b.PrimaryPassword;
        }

        try
        {
            _rdp = new RdpHost { Dock = DockStyle.Fill };
            _rdp.Connecting += (_, _) => SetStatus(TabStatus.Connecting);
            _rdp.Connected += OnConnected;
            _rdp.LoginComplete += OnLoginComplete;
            _rdp.Disconnected += OnDisconnected;
            _rdp.FatalError += (_, code) => ShowError("RDP fatal error", $"The RDP control reported fatal error {code}.");
            _rdp.ReceivedPublicKey += OnPublicKey;
            _rdp.AutoReconnecting += (_, _) => SetStatus(TabStatus.Connecting);
            _rdp.AutoReconnected += (_, _) => { SetStatus(TabStatus.Connected); StartAutoType(); };
            Controls.Add(_rdp);
            _overlay.BringToFront();
            _rdp.CreateControl();
            _ = _rdp.Handle;

            dynamic ocx = _rdp.Ocx;
            var size = DesktopSize();
            ocx.Server = server;
            ocx.UserName = user;
            ocx.DesktopWidth = size.Width;
            ocx.DesktopHeight = size.Height;
            ocx.ColorDepth = s.ColorDepth;
            ocx.ConnectingText = "";
            ocx.DisconnectedText = "";

            dynamic adv = ocx.AdvancedSettings9;
            adv.RDPPort = port;
            if (!string.IsNullOrEmpty(pass)) adv.ClearTextPassword = pass;
            adv.EnableCredSspSupport = b.UseNla;
            adv.AuthenticationLevel = (uint)Math.Clamp(b.AuthLevel, 0, 2);
            adv.NotifyTSPublicKey = true;
            adv.SmartSizing = s.SmartSizing || s.SessionUsesScreenSize;
            adv.RedirectClipboard = s.RedirectClipboard;
            adv.RedirectDrives = s.RedirectDrives;
            adv.EnableAutoReconnect = true;
            adv.MaxReconnectAttempts = 20;
            adv.BitmapPersistence = 1;
            adv.GrabFocusOnConnect = true;
            if (s.ForceUsKeyboard) adv.KeyBoardLayoutStr = "0x00000409";

            try
            {
                dynamic sec = ocx.SecuredSettings2;
                sec.KeyboardHookMode = s.WindowsKeysToRemote ? 1 : 0;
                sec.AudioRedirectionMode = s.PlayAudioLocally ? 0 : 2;
            }
            catch (COMException) { /* not fatal */ }

            Diag.Log($"[{Machine.Name}] CONNECT server={server}:{port} rdpUser=\"{user}\" nla={b.UseNla} mode={Machine.Mode} target=\"{Machine.Target}\" ocr={ScreenReader.Available} detect={s.AutoTypeDetectScreen}");
            ocx.Connect();
        }
        catch (Exception ex)
        {
            ShowError("Could not start the connection", ex.Message);
        }
    }

    private Size DesktopSize()
    {
        var sz = ClientSize;
        if (_store.Data.Settings.SessionUsesScreenSize || sz.Width < 400 || sz.Height < 300)
            sz = Screen.FromControl(this).Bounds.Size;
        int w = Math.Clamp(sz.Width, 640, 8192) & ~1;
        int h = Math.Clamp(sz.Height, 480, 8192) & ~1;
        return new Size(w, h);
    }

    private static (string host, int port) ParseHost(string value, int defaultPort)
    {
        value = value.Trim();
        int idx = value.LastIndexOf(':');
        if (idx > 0 && value.IndexOf(':') == idx && int.TryParse(value[(idx + 1)..], out var p))
            return (value[..idx], p);
        return (value, defaultPort);
    }

    private void OnConnected(object? sender, EventArgs e)
    {
        IsConnected = true;
        HideOverlay();
        SetStatus(TabStatus.Connected);
        Diag.Log($"[{Machine.Name}] CONNECTED (auto-type watch starting)");
        Machine.LastUsed = DateTime.Now;
        try { _store.Save(); } catch { /* best effort */ }
        StartAutoType();
    }

    private void OnLoginComplete(object? sender, EventArgs e)
    {
        _loggedIn = true;
        _resizeTimer.Stop();
        _resizeTimer.Start();
    }

    private void OnDisconnected(object? sender, int reason)
    {
        IsConnected = false;
        _loggedIn = false;
        StopAutoType();
        SetStatus(TabStatus.Disconnected);

        if (_closing)
        {
            FinishClose();
            return;
        }

        if (_pendingKeyHash != null)
        {
            ShowOverlay("⚠ Server identity changed",
                $"The public key of {_store.Data.Bastion.Host} is different from the one seen before.\n" +
                "This can mean the server was reinstalled — or that someone is intercepting the connection.\n" +
                "Connect only if your admins confirm the change.",
                reconnect: true, trustKey: true);
            return;
        }

        string detail;
        try
        {
            dynamic ocx = _rdp!.Ocx;
            detail = (string)ocx.GetErrorDescription((uint)reason, (uint)ocx.ExtendedDisconnectReason);
        }
        catch
        {
            detail = "";
        }
        if (reason is 1 or 2 or 3 || string.IsNullOrWhiteSpace(detail))
            detail = reason switch
            {
                1 => "You disconnected.",
                2 => "The session was closed by the server (logoff or disconnect).",
                3 => "The server ended the session.",
                _ => $"Disconnected (code {reason}).",
            };
        ShowOverlay($"{Machine.Name} disconnected", detail, reconnect: true);
    }

    private void OnPublicKey(object? sender, PublicKeyEventArgs e)
    {
        var b = _store.Data.Bastion;
        string host = Machine.Mode == ConnectionMode.Direct ? ParseHost(Machine.Ip, 3389).host : $"{b.Host}:{b.Port}";
        var hash = Convert.ToHexString(SHA256.HashData(Encoding.Unicode.GetBytes(e.PublicKey)));
        if (_store.Data.PinnedKeys.TryGetValue(host, out var known))
        {
            if (!string.Equals(known, hash, StringComparison.OrdinalIgnoreCase))
            {
                _pendingKeyHash = hash;
                e.Cancel = true;
            }
            return;
        }
        _store.Data.PinnedKeys[host] = hash; // trust on first use
        try { _store.Save(notify: false); } catch { /* ignore */ }
    }

    private void TrustNewKey()
    {
        if (_pendingKeyHash == null) return;
        var b = _store.Data.Bastion;
        string host = Machine.Mode == ConnectionMode.Direct ? ParseHost(Machine.Ip, 3389).host : $"{b.Host}:{b.Port}";
        _store.Data.PinnedKeys[host] = _pendingKeyHash;
        _pendingKeyHash = null;
        _store.Save(notify: false);
        Connect();
    }

    public void Disconnect()
    {
        if (_rdp != null && IsConnected)
        {
            try { _rdp.Ocx.Disconnect(); } catch { /* ignore */ }
        }
    }

    /// <summary>Disconnects (if needed) and raises <see cref="Closed"/> when done.</summary>
    public void CloseSession()
    {
        _closing = true;
        StopAutoType();
        _resizeTimer.Stop();
        if (_rdp != null && IsConnected)
        {
            try
            {
                _rdp.Ocx.Disconnect();
                _closeTimeout = new System.Windows.Forms.Timer { Interval = 4000 };
                _closeTimeout.Tick += (_, _) => FinishClose();
                _closeTimeout.Start();
                return;
            }
            catch { /* fall through */ }
        }
        FinishClose();
    }

    private void FinishClose()
    {
        _closeTimeout?.Stop();
        _closeTimeout?.Dispose();
        _closeTimeout = null;
        DestroyRdp();
        Closed?.Invoke(this, EventArgs.Empty);
    }

    private void DestroyRdp()
    {
        if (_rdp == null) return;
        var r = _rdp;
        _rdp = null;
        try
        {
            Controls.Remove(r);
            r.Dispose();
        }
        catch { /* the control can throw while tearing down */ }
    }

    // ---------------------------------------------------------------- display

    protected override void OnResize(EventArgs e)
    {
        base.OnResize(e);
        if (IsConnected && _loggedIn && _store.Data.Settings.DynamicResize && !_store.Data.Settings.SessionUsesScreenSize)
        {
            _resizeTimer.Stop();
            _resizeTimer.Start();
        }
    }

    private void SyncDisplaySize()
    {
        if (_rdp == null || !IsConnected || !_store.Data.Settings.DynamicResize || !Visible) return;
        var sz = DesktopSize();
        try
        {
            dynamic ocx = _rdp.Ocx;
            if ((int)ocx.DesktopWidth == sz.Width && (int)ocx.DesktopHeight == sz.Height) return;
            ocx.UpdateSessionDisplaySettings((uint)sz.Width, (uint)sz.Height,
                (uint)(sz.Width * 0.2645), (uint)(sz.Height * 0.2645), 0u, 100u, 100u);
        }
        catch
        {
            // Proxy or server does not support dynamic resolution; SmartSizing keeps the picture scaled.
        }
    }

    public void FocusRemote()
    {
        if (_rdp != null && IsConnected) _rdp.Focus();
    }

    // ---------------------------------------------------------------- auto-type

    private bool _typedBastion, _typedTarget, _typedWindows, _reading;
    private int _otherTicks;

    /// <summary>
    /// Auto-fill runs only when the machine has its own assigned credential (right-click → Credentials),
    /// or the global "auto-fill on connect" setting is on. Otherwise nothing is typed automatically.
    /// </summary>
    private bool AutoEligible => Machine.AutoType != AutoTypeMode.Never &&
                                 (Machine.HasOwnCredential || _store.Data.Settings.AutoFillOnConnect);
    private bool TargetTypingAllowed() => AutoEligible && _store.ResolveCredential(Machine) != null;
    private bool BastionTypingAllowed() => AutoEligible && Machine.Mode == ConnectionMode.Bastion &&
                                           !string.IsNullOrEmpty(_store.Data.Bastion.PrimaryPassword);

    private void StartAutoType()
    {
        StopAutoType();
        if (!TargetTypingAllowed() && !BastionTypingAllowed()) return;
        _typedBastion = _typedTarget = _typedWindows = false;
        _otherTicks = 0;
        _autoTypeStart = DateTime.UtcNow;
        _visibleWaitMs = 0;
        _autoTypeTimer.Start();
    }

    private void StopAutoType() => _autoTypeTimer.Stop();

    private async void AutoTypeTick(object? sender, EventArgs e)
    {
        if (_reading || _typing) return;
        var s = _store.Data.Settings;
        if (!IsConnected || _rdp == null) { StopAutoType(); return; }
        var elapsed = DateTime.UtcNow - _autoTypeStart;
        int delay = s.AutoTypeDelayMs == 1500 ? 500 : s.AutoTypeDelayMs; // 1500 was the old default
        if (elapsed.TotalMilliseconds < delay) return;
        if (elapsed.TotalMinutes > 15) { StopAutoType(); return; }

        // Only fill into a session the user can actually see and that is the active window.
        if (!IsOnScreen() || !Win.IsForeground(this)) return;
        _visibleWaitMs += _autoTypeTimer.Interval;

        using var bmp = PromptDetector.CaptureSession(_rdp);
        if (bmp == null) return;

        var color = PromptDetector.Analyze(bmp);
        if (color != PromptDetector.Result.Prompt)
        {
            // Not a WALLIX page. Now and then read it, to catch Windows' own password screen.
            if (_typedWindows || !ScreenReader.Available || !TargetTypingAllowed() || ++_otherTicks % 4 != 0) { CheckTimeout(); return; }
            var other = ScreenReader.Screen.Unknown;
            _reading = true;
            try { (other, _) = await ScreenReader.ClassifyAsync(bmp); }
            catch (Exception ex) { Diag.Log($"[{Machine.Name}] OCR error: {ex.Message}"); }
            finally { _reading = false; }
            if (other == ScreenReader.Screen.WindowsPassword && IsConnected && !_typing && _store.ResolveCredential(Machine) is { } wc)
            {
                _typedWindows = true;
                Diag.Log($"[{Machine.Name}] auto: Windows password screen");
                FillPassword(wc.Password);
            }
            else CheckTimeout();
            return;
        }

        // A dark-blue login page is showing. Use OCR (when available) to fill the right credential.
        ScreenReader.Screen screen = ScreenReader.Screen.Unknown;
        if (ScreenReader.Available)
        {
            _reading = true;
            try { (screen, _) = await ScreenReader.ClassifyAsync(bmp); }
            catch (Exception ex) { Diag.Log($"[{Machine.Name}] OCR error: {ex.Message}"); }
            finally { _reading = false; }
            if (!IsConnected || _rdp == null || _typing) return;
            Diag.Log($"[{Machine.Name}] auto: login page, screen={screen}");
        }

        var b2 = _store.Data.Bastion;
        switch (screen)
        {
            case ScreenReader.Screen.BastionLogin:
                if (!_typedBastion && BastionTypingAllowed())
                {
                    _typedBastion = true; _visibleWaitMs = 0;
                    var login = b2.InteractiveLoginUsesTarget ? Store.BuildBastionLogin(b2, Machine) : b2.PrimaryUser;
                    FillLogin(login, b2.PrimaryPassword);           // step 1; keep watching for step 2
                }
                return;

            case ScreenReader.Screen.WindowsPassword:
                if (!_typedWindows && TargetTypingAllowed() && _store.ResolveCredential(Machine) is { } pc)
                {
                    _typedWindows = true;
                    FillPassword(pc.Password);
                }
                return;

            case ScreenReader.Screen.TargetPrompt:
                if (!_typedTarget && TargetTypingAllowed())
                {
                    var c = _store.ResolveCredential(Machine);
                    if (c != null) { _typedTarget = true; StopAutoType(); FillLogin(c.Username, c.Password); }
                }
                return;

            default:
                // Login-coloured screen, but OCR unavailable or unsure. After a short wait, fill the
                // assigned credential (the common single-login case).
                if (!_typedTarget && TargetTypingAllowed() && (!ScreenReader.Available || _visibleWaitMs > 1500))
                {
                    var c = _store.ResolveCredential(Machine);
                    if (c != null) { _typedTarget = true; StopAutoType(); FillLogin(c.Username, c.Password); }
                }
                else CheckTimeout();
                return;
        }
    }

    private void CheckTimeout()
    {
        if (string.IsNullOrEmpty(Machine.Target)) { if (_visibleWaitMs > 10 * 60_000) StopAutoType(); }
        else if (_visibleWaitMs > 30000) StopAutoType();
    }

    private bool IsOnScreen()
    {
        var root = Win.Root(this);
        return Visible && root != IntPtr.Zero && !Win.IsMinimized(root);
    }

    /// <summary>
    /// Manual trigger (Ctrl+Alt+K): reads the screen and types the step-1 login on WALLIX's login page,
    /// otherwise the step-2 login.
    /// </summary>
    public async void TypeCredentials()
    {
        if (_typing || _rdp == null || !IsConnected) { if (!IsConnected) Notify?.Invoke(this, "Not connected."); return; }
        var screen = ScreenReader.Screen.Unknown;
        if (ScreenReader.Available)
        {
            using var bmp = PromptDetector.CaptureSession(_rdp);
            if (bmp != null)
            {
                try { (screen, _) = await ScreenReader.ClassifyAsync(bmp); } catch { /* fall back to step 2 */ }
            }
        }
        if (screen == ScreenReader.Screen.BastionLogin)
        {
            var b = _store.Data.Bastion;
            if (string.IsNullOrEmpty(b.PrimaryPassword)) { Notify?.Invoke(this, "No step-1 password saved in ⚙ Settings."); return; }
            var login = b.InteractiveLoginUsesTarget ? Store.BuildBastionLogin(b, Machine) : b.PrimaryUser;
            await TypeAsync(login, b.PrimaryPassword, "{login}{TAB}{password}{ENTER}");
            return;
        }
        StopAutoType();
        await TypeTargetAsync();
    }

    /// <summary>
    /// Fills login + password on whatever screen is currently showing, using clipboard paste (reliable,
    /// layout-independent). One paste per field instead of dozens of fragile keystrokes.
    /// </summary>
    public async void FillLogin(string login, string password)
    {
        if (_typing || _rdp == null || !IsConnected) { if (!IsConnected) Notify?.Invoke(this, "Not connected."); return; }
        // Never type unless THIS session is the one on screen and no dialog is open — otherwise the
        // keystrokes (incl. Ctrl+A) would land in the app's own fields and wipe them.
        if (!IsOnScreen() || !Win.IsForeground(this))
        {
            Notify?.Invoke(this, "Bring the session tab to the front (close any open dialog), then press Ctrl+Alt+K.");
            return;
        }
        StopAutoType();
        _typing = true;
        bool ok = true;
        Diag.Log($"[{Machine.Name}] FILL (clipboard) login=\"{login}\" (password {password.Length} chars) clipboardRedirect={_store.Data.Settings.RedirectClipboard}");
        try
        {
            if (!FocusSession())
            {
                Notify?.Invoke(this, "Click once inside the session, then press Ctrl+Alt+K again.");
                return;
            }
            await Task.Delay(150);

            // Wake the input channel; the RDP session drops the first keystrokes after focus lands.
            SendKeysRobust(KeyTyper.KeyPress(0x2A)); // Shift tap (harmless)
            await Task.Delay(90);

            if (_store.Data.Settings.ForceUsKeyboard && KeyTyper.CanType(login + password, out _))
            {
                // Fast path: the session uses the US layout, so type the keys directly (no clipboard round-trip).
                var keys = new List<(int sc, bool up)>();
                KeyTyper.AppendSelectAll(keys);
                KeyTyper.AppendText(keys, login);
                KeyTyper.AppendKey(keys, KeyTyper.Tab);
                ok &= SendKeysRobust(keys);
                await Task.Delay(120);
                keys.Clear();
                KeyTyper.AppendSelectAll(keys);
                KeyTyper.AppendText(keys, password);
                KeyTyper.AppendKey(keys, KeyTyper.Enter);
                ok &= SendKeysRobust(keys);
            }
            else
            {
                ok &= await PasteField(login);              // login field
                await Task.Delay(100);
                SendKeysRobust(KeyTyper.KeyPress(KeyTyper.Tab));
                await Task.Delay(150);
                ok &= await PasteField(password);           // password field
                await Task.Delay(100);
                SendKeysRobust(KeyTyper.KeyPress(KeyTyper.Enter));
            }
            await Task.Delay(300);

            Diag.Log($"[{Machine.Name}] FILL done ok={ok}  after={Diag.SaveCapture(PromptDetector.CaptureSession(_rdp), "afterfill")}");
        }
        catch (Exception ex)
        {
            ok = false;
            Diag.Log($"[{Machine.Name}] FILL error: {ex.Message}");
        }
        finally
        {
            ClearClipboard();
            _typing = false;
        }
        if (!ok) Notify?.Invoke(this, "Fill may be incomplete — press Ctrl+Alt+K and pick again, or check that clipboard redirection is on in ⚙ Settings.");
    }

    /// <summary>Windows' sign-in / lock screen: only the password box (the user is already chosen).</summary>
    public async void FillPassword(string password)
    {
        if (_typing || _rdp == null || !IsConnected) return;
        if (!IsOnScreen() || !Win.IsForeground(this))
        {
            Notify?.Invoke(this, "Bring the session tab to the front, then press Ctrl+Alt+K.");
            return;
        }
        _typing = true;
        bool ok = true;
        try
        {
            if (!FocusSession()) { Notify?.Invoke(this, "Click once inside the session, then press Ctrl+Alt+K again."); return; }
            await Task.Delay(150);
            SendKeysRobust(KeyTyper.KeyPress(0x2A)); // wake the input channel
            await Task.Delay(90);
            if (_store.Data.Settings.ForceUsKeyboard && KeyTyper.CanType(password, out _))
            {
                var keys = new List<(int sc, bool up)>();
                KeyTyper.AppendSelectAll(keys);
                KeyTyper.AppendText(keys, password);
                KeyTyper.AppendKey(keys, KeyTyper.Enter);
                ok &= SendKeysRobust(keys);
            }
            else
            {
                ok &= await PasteField(password);
                await Task.Delay(100);
                SendKeysRobust(KeyTyper.KeyPress(KeyTyper.Enter));
            }
            await Task.Delay(300);
        }
        catch (Exception ex)
        {
            ok = false;
            Diag.Log($"[{Machine.Name}] FILL password error: {ex.Message}");
        }
        finally
        {
            ClearClipboard();
            _typing = false;
        }
        if (!ok) Notify?.Invoke(this, "The password may not have been typed — press Ctrl+Alt+K and pick again.");
    }

    /// <summary>Ctrl+Alt+K: look at the screen first — a password-only screen gets just the password.</summary>
    public async void FillSmart(string login, string password)
    {
        if (_rdp == null || !IsConnected) return;
        var screen = ScreenReader.Screen.Unknown;
        if (ScreenReader.Available)
        {
            using var bmp = PromptDetector.CaptureSession(_rdp);
            if (bmp != null)
            {
                try { (screen, _) = await ScreenReader.ClassifyAsync(bmp); } catch { /* fill both fields */ }
            }
        }
        if (screen == ScreenReader.Screen.WindowsPassword) FillPassword(password);
        else FillLogin(login, password);
    }

    /// <summary>The login list was shown by Remterm over the tab: wait until the session is back on screen and in front.</summary>
    public async void FillSmartWhenShown(string login, string password)
    {
        for (int i = 0; i < 25 && !(IsOnScreen() && Win.IsForeground(this)); i++) await Task.Delay(100);
        await Task.Delay(150); // the first frames after showing again
        FillSmart(login, password);
    }

    private async Task<bool> PasteField(string text)
    {
        if (!SetClipboard(text)) { Diag.Log($"[{Machine.Name}] clipboard set failed"); return false; }
        await Task.Delay(300); // let the clipboard sync to the remote session
        bool a = SendKeysRobust(KeyTyper.SelectAll());
        await Task.Delay(70);
        bool v = SendKeysRobust(KeyTyper.Paste());
        await Task.Delay(90);
        return a && v;
    }

    private static bool SetClipboard(string text)
    {
        for (int i = 0; i < 3; i++)
        {
            try { Clipboard.SetText(text); return true; }
            catch { Thread.Sleep(80); }
        }
        return false;
    }

    private static void ClearClipboard()
    {
        try { Clipboard.Clear(); } catch { /* ignore */ }
    }

    private async Task TypeTargetAsync()
    {
        var cred = _store.ResolveCredential(Machine);
        if (cred == null) { Notify?.Invoke(this, "No step-2 login saved (🔑) for this machine."); return; }
        await TypeAsync(cred.Username, cred.Password, _store.Data.Settings.AutoTypeSequence);
    }

    private async Task TypeAsync(string login, string password, string sequence)
    {
        if (_typing || _rdp == null || !IsConnected) return;
        if (!KeyTyper.CanType(login + password, out _))
        {
            Notify?.Invoke(this, "The login or password contains a character that is not on the US keyboard, so it can't be auto-typed.");
            return;
        }

        Diag.Log($"[{Machine.Name}] TYPING login=\"{login}\" (password {password.Length} chars) seq=\"{sequence}\"");
        _typing = true;
        bool anyFailed = false;
        try
        {
            if (!FocusSession())
            {
                Notify?.Invoke(this, "Click inside the session once, then press Ctrl+Alt+K again.");
                return;
            }
            await Task.Delay(350);

            // The RDP session swallows the first keystrokes right after focus lands, which left the
            // login field empty. Send a harmless Shift tap first to "wake" the input path, so the real
            // username is not the batch that gets dropped.
            const int shift = 0x2A;
            try { KeyTyper.SendInputKeys(new List<(int sc, bool up)> { (shift, false), (shift, true) }); } catch { /* ignore */ }
            await Task.Delay(200);

            foreach (var step in KeyTyper.Parse(sequence))
            {
                if (step.Kind == KeyTyper.StepKind.Delay) { await Task.Delay(step.Value); continue; }

                var keys = new List<(int sc, bool up)>();
                switch (step.Kind)
                {
                    case KeyTyper.StepKind.Login: KeyTyper.AppendSelectAll(keys); KeyTyper.AppendText(keys, login); break;
                    case KeyTyper.StepKind.Password: KeyTyper.AppendSelectAll(keys); KeyTyper.AppendText(keys, password); break;
                    case KeyTyper.StepKind.Key: KeyTyper.AppendKey(keys, step.Value); break;
                    case KeyTyper.StepKind.Text: KeyTyper.AppendText(keys, step.Text); break;
                }
                if (_rdp == null || !IsConnected) return;
                if (!SendKeysRobust(keys)) anyFailed = true;
                await Task.Delay(140);
            }
        }
        catch (Exception ex)
        {
            Diag.Log($"[{Machine.Name}] TYPING unexpected error: {ex.Message}");
            anyFailed = true;
        }
        finally
        {
            _typing = false;
        }
        if (anyFailed) Notify?.Invoke(this, "Some keystrokes didn't go through — if the login is incomplete, press Ctrl+Alt+K again.");
    }

    /// <summary>Brings our window to the front and puts keyboard focus on the RDP session.</summary>
    private bool FocusSession()
    {
        var root = Win.Root(this);
        if (root == IntPtr.Zero || _rdp == null) return false;
        try
        {
            if (Win.GetForegroundWindow() != root) Win.SetForegroundWindow(root);
            FindForm()?.Activate(); // our own pop-out window; embedded sessions have none
            _rdp.Focus();
            try { _rdp.Ocx.Focus(); } catch { /* not all versions expose it */ }
            return Win.GetForegroundWindow() == root;
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Types the keys with SendInput (real keyboard injection, which the RDP session reliably receives),
    /// re-focusing and retrying on failure. Falls back to the control's COM SendKeys as a last resort.
    /// </summary>
    private bool SendKeysRobust(List<(int sc, bool up)> keys)
    {
        for (int attempt = 0; attempt < 3; attempt++)
        {
            if (_rdp == null || !IsConnected) return false;
            try
            {
                if (!FocusSession()) { Thread.Sleep(120); continue; }
                KeyTyper.SendInputKeys(keys);
                return true;
            }
            catch (Exception ex)
            {
                Diag.Log($"[{Machine.Name}] SendInput attempt {attempt + 1} failed: {ex.Message}");
                Thread.Sleep(120);
            }
        }
        // Last resort: the control's own method.
        try { KeyTyper.SendCom(_rdp!.NonScriptable, keys); return true; }
        catch (Exception ex) { Diag.Log($"[{Machine.Name}] SendCom fallback failed: {ex.Message}"); return false; }
    }


    // ---------------------------------------------------------------- overlay / status

    private void SetStatus(TabStatus s)
    {
        Status = s;
        StatusChanged?.Invoke(this, EventArgs.Empty);
    }

    private void ShowOverlay(string title, string text, bool reconnect, bool trustKey = false)
    {
        _overlayTitle.Text = title;
        _overlayText.Text = text;
        _btnReconnect.Visible = reconnect;
        _btnTrustKey.Visible = trustKey;
        _btnClose.Visible = true;
        _btnClose.Text = reconnect ? "Close tab" : "Cancel";
        _overlay.Visible = true;
        _overlay.BringToFront();
        StatusChanged?.Invoke(this, EventArgs.Empty); // the status text changed too
    }

    private void ShowError(string title, string text)
    {
        IsConnected = false;
        SetStatus(TabStatus.Disconnected);
        ShowOverlay(title, text, reconnect: true);
    }

    private void HideOverlay() => _overlay.Visible = false;

    protected override void Dispose(bool disposing)
    {
        if (disposing)
        {
            _resizeTimer.Dispose();
            _autoTypeTimer.Dispose();
            _closeTimeout?.Dispose();
            DestroyRdp();
        }
        base.Dispose(disposing);
    }
}
