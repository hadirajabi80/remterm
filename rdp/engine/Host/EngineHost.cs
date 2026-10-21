using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using RemoteHub.Rdp;
using RemoteHub.Security;
using RemoteHub.UI;

namespace RemoteHub.Host;

/// <summary>
/// The engine process: owns the encrypted RDP vault and the RDP sessions, and serves Remterm over a named
/// pipe with one JSON message per line.
///   Remterm → engine   {"id":1,"method":"open","params":{…}}
///   engine → Remterm   {"id":1,"result":…} | {"id":1,"error":"…"} | {"event":"session","data":{…}}
/// </summary>
internal sealed class EngineHost : ApplicationContext
{
    internal static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web)
    {
        Converters = { new JsonStringEnumConverter(JsonNamingPolicy.CamelCase) },
    };

    private readonly Pump _ui;
    private readonly NamedPipeClientStream _pipe;
    private readonly StreamWriter _out;
    private readonly object _writeLock = new();
    private readonly Dictionary<string, RdpSession> _sessions = new();
    private readonly System.Windows.Forms.Timer _focusTimer = new() { Interval = 150 };
    private readonly System.Windows.Forms.Timer _idleTimer = new() { Interval = 15000 };
    private readonly ToolTip _tt = new();
    private Store? _store;
    private bool _locked;
    private bool _hotkeysOn;
    private RdpSession? _hotSession;
    private bool _shuttingDown;

    public IntPtr Parent { get; }
    public bool Locked => _locked || _store == null;
    internal ToolTip ToolTips => _tt;
    internal bool ConfirmCloseConnected => _store?.Data.Settings.ConfirmCloseConnected ?? true;

    public EngineHost(string pipeName, string token, IntPtr parent)
    {
        Parent = parent;
        _ui = new Pump(this);
        _ = _ui.Handle; // create the window now: it marshals pipe messages onto this (UI) thread

        _pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        _pipe.Connect(10000);
        _out = new StreamWriter(_pipe, new UTF8Encoding(false)) { AutoFlush = true, NewLine = "\n" };

        OpenStoreIfPossible();
        Send(new { @event = "hello", data = new { token, pid = Environment.ProcessId, version = Application.ProductVersion.Split('+')[0], ocr = ScreenReader.Available } });

        new Thread(ReadLoop) { IsBackground = true, Name = "pipe-reader" }.Start();
        _focusTimer.Tick += (_, _) => FocusTick();
        _focusTimer.Start();
        _idleTimer.Tick += (_, _) => IdleTick();
        _idleTimer.Start();
    }

    // ============================================================================================ pipe

    private void ReadLoop()
    {
        try
        {
            using var reader = new StreamReader(_pipe, new UTF8Encoding(false), false, 1 << 16, leaveOpen: true);
            string? line;
            while ((line = reader.ReadLine()) != null)
            {
                var msg = line;
                _ui.BeginInvoke(() => Handle(msg));
            }
        }
        catch (Exception ex)
        {
            Diag.Log("pipe read: " + ex.Message);
        }
        // Remterm closed (or crashed): end our sessions and exit.
        try { _ui.BeginInvoke(Shutdown); } catch { Environment.Exit(0); }
    }

    private void Handle(string line)
    {
        long id = 0;
        try
        {
            using var doc = JsonDocument.Parse(line);
            var root = doc.RootElement;
            id = root.GetProperty("id").GetInt64();
            var method = root.GetProperty("method").GetString() ?? "";
            var p = root.TryGetProperty("params", out var pe) && pe.ValueKind == JsonValueKind.Object ? pe : default;
            var result = Dispatch(method, p);
            Send(new { id, result });
        }
        catch (Exception ex)
        {
            Diag.Log("request failed: " + ex.Message);
            Send(new { id, error = ex.Message });
        }
    }

    private void Send(object message)
    {
        if (_shuttingDown) return;
        try
        {
            var text = JsonSerializer.Serialize(message, Json);
            lock (_writeLock) _out.WriteLine(text);
        }
        catch (Exception ex)
        {
            Diag.Log("pipe write: " + ex.Message);
        }
    }

    public void Emit(string name, object? data = null) => Send(new { @event = name, data });

    // ============================================================================================ dispatch

    private object? Dispatch(string method, JsonElement p)
    {
        switch (method)
        {
            case "status": return Status();
            case "unlock": return Unlock(Str(p, "password"));
            case "lock": return Lock();

            // ---- vault data
            case "data": return Data();
            case "saveMachine": return SaveMachine(Get<Machine>(p, "machine"));
            case "deleteMachines": DeleteMachines(Get<string[]>(p, "ids")); return null;
            case "renameGroup": RenameGroup(Str(p, "from"), Str(p, "to")); return null;
            case "saveCredential": return SaveCredential(Get<CredentialDto>(p, "credential"), OptStr(p, "password"));
            case "deleteCredential": DeleteCredential(Str(p, "id")); return null;
            case "setDefaultCredential": S.Data.Settings.DefaultCredentialId = Str(p, "id"); S.Save(); return null;
            case "saveBastion": SaveBastion(Get<BastionDto>(p, "bastion"), OptStr(p, "password")); return null;
            case "saveSettings": SaveSettings(Get<AppSettings>(p, "settings")); return null;
            case "importPreview": return ImportPreview(Str(p, "text"));
            case "import": return Import(Str(p, "text"), OptStr(p, "group"), OptStr(p, "credentialId"));
            case "setMasterPassword": SetMasterPassword(OptStr(p, "current"), OptStr(p, "password")); return Status();
            case "openDiag": Diag.Open(); return null;

            // ---- sessions
            case "open": return Open(p);
            case "bounds":
                Session(p).SetBounds(new Rectangle(Int(p, "x"), Int(p, "y"), Int(p, "w"), Int(p, "h")), Bool(p, "visible"));
                return null;
            case "close": Session(p).Close(); return null;
            case "reconnect": Session(p).View.Connect(); return null;
            case "disconnect": Session(p).View.Disconnect(); return null;
            case "focus": Session(p).Focus(); return null;
            case "refresh": Session(p).Refresh(); return null;
            case "fill": ShowFillPicker(Session(p)); return null;
            case "fillWith": FillWith(Session(p), Str(p, "key")); return null;
            case "fullscreen": Session(p).ToggleFullscreen(); return null;
            case "popout":
                Session(p).PopOut(p.TryGetProperty("x", out _) ? new Point(Int(p, "x"), Int(p, "y")) : null, Bool(p, "follow"));
                return null;
            case "clip": Session(p).SetClip(Get<ClipRect[]>(p, "rects").Select(r => new Rectangle(r.X, r.Y, r.W, r.H)).ToArray()); return null;
            case "dock": Session(p).Dock(); return null;
            case "snapshot": return Session(p).Snapshot();
            case "thumb": return Session(p).Thumb();
            case "connectedCount": return _sessions.Values.Count(s => s.View.IsConnected);
            default: throw new InvalidOperationException("unknown method " + method);
        }
    }

    private Store S => _store != null && !_locked ? _store : throw new InvalidOperationException("LOCKED: unlock Remote Desktop first.");

    private RdpSession Session(JsonElement p) =>
        _sessions.TryGetValue(Str(p, "id"), out var s) ? s : throw new InvalidOperationException("That session is already closed.");

    private static string Str(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() ?? "" : "";

    private static string? OptStr(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static int Int(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.Number ? (int)Math.Round(v.GetDouble()) : 0;

    private static bool Bool(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.ValueKind == JsonValueKind.True;

    private static T Get<T>(JsonElement p, string name) =>
        p.ValueKind == JsonValueKind.Object && p.TryGetProperty(name, out var v) && v.Deserialize<T>(Json) is { } t
            ? t
            : throw new InvalidOperationException($"missing {name}");

    // ============================================================================================ vault & lock

    private void OpenStoreIfPossible()
    {
        try
        {
            if (!Vault.Exists) { var (v, d) = Vault.CreateNew(); Attach(new Store(v, d)); }
            else if (!Vault.FileNeedsMasterPassword()) { var (v, d) = Vault.Open(null); Attach(new Store(v, d)); }
            // else: wait for "unlock" with the master password
        }
        catch (Exception ex)
        {
            Diag.Log("open vault: " + ex.Message);
        }
    }

    private void Attach(Store store)
    {
        _store = store;
        Diag.Enabled = Diag.Enabled || store.Data.Settings.DiagEnabled;
        store.Changed += (_, _) => Emit("changed");
    }

    private object Status() => new
    {
        ready = _store != null,
        locked = Locked,
        needsPassword = _store == null,
        hasMaster = _store?.Vault.HasMasterPassword ?? Vault.Exists,
        vaultPath = Vault.FilePath,
        autoLockMinutes = _store?.Data.Settings.AutoLockMinutes ?? 0,
    };

    private object Unlock(string password)
    {
        if (_store == null)
        {
            try { var (v, d) = Vault.Open(password); Attach(new Store(v, d)); }
            catch (CryptographicException) { throw new InvalidOperationException("Wrong master password."); }
        }
        else if (!_store.Vault.VerifyMasterPassword(password))
        {
            throw new InvalidOperationException("Wrong master password.");
        }
        _locked = false;
        foreach (var s in _sessions.Values) s.ApplyLock(false);
        Emit("changed");
        return Status();
    }

    private object Lock()
    {
        if (_store == null) return Status();
        if (!_store.Vault.HasMasterPassword)
            throw new InvalidOperationException("Set a master password first (Remote Desktop settings → Security).");
        LockNow();
        return Status();
    }

    private void LockNow()
    {
        if (_locked) return;
        _locked = true;
        foreach (var s in _sessions.Values) s.ApplyLock(true);
        Emit("locked");
    }

    private void IdleTick()
    {
        var st = _store;
        if (st == null || _locked || !st.Vault.HasMasterPassword) return;
        int minutes = st.Data.Settings.AutoLockMinutes;
        if (minutes > 0 && Win.IdleMs() > minutes * 60_000L) LockNow();
    }

    private void SetMasterPassword(string? current, string? password)
    {
        var st = S;
        if (st.Vault.HasMasterPassword && !st.Vault.VerifyMasterPassword(current ?? ""))
            throw new InvalidOperationException("The current master password is wrong.");
        if (!string.IsNullOrEmpty(password) && password.Length < 6)
            throw new InvalidOperationException("Use at least 6 characters.");
        st.Vault.SetMasterPassword(string.IsNullOrEmpty(password) ? null : password, st.Data);
    }

    // ============================================================================================ data

    internal sealed record ClipRect(int X, int Y, int W, int H);

    internal sealed record CredentialDto(string Id, string Name, string Username, bool HasPassword);

    internal sealed class BastionDto
    {
        public string Host { get; set; } = "";
        public int Port { get; set; } = 3389;
        public string PrimaryUser { get; set; } = "";
        public bool HasPassword { get; set; }
        public string Authorization { get; set; } = "";
        public string LoginTemplate { get; set; } = "";
        public bool UseNla { get; set; } = true;
        public bool InteractiveLoginUsesTarget { get; set; }
        public int AuthLevel { get; set; }
    }

    private object Data()
    {
        var st = S;
        var b = st.Data.Bastion;
        return new
        {
            machines = st.Data.Machines,
            credentials = st.Data.Credentials.Select(c => new CredentialDto(c.Id, c.Name, c.Username, c.Password.Length > 0)),
            defaultCredentialId = st.Data.Credentials.Any(c => c.Id == st.Data.Settings.DefaultCredentialId)
                ? st.Data.Settings.DefaultCredentialId
                : st.Data.Credentials.FirstOrDefault()?.Id,
            bastion = new BastionDto
            {
                Host = b.Host, Port = b.Port, PrimaryUser = b.PrimaryUser, HasPassword = b.PrimaryPassword.Length > 0,
                Authorization = b.Authorization, LoginTemplate = b.LoginTemplate, UseNla = b.UseNla,
                InteractiveLoginUsesTarget = b.InteractiveLoginUsesTarget, AuthLevel = b.AuthLevel,
            },
            settings = st.Data.Settings,
            hasMaster = st.Vault.HasMasterPassword,
            vaultPath = Vault.FilePath,
            diagEnabled = Diag.Enabled,
            ocr = ScreenReader.Available,
        };
    }

    private Machine SaveMachine(Machine m)
    {
        var st = S;
        m.Name = m.Name.Trim();
        m.Ip = m.Ip.Trim();
        m.Target = m.Target.Trim();
        m.Group = m.Group.Trim();
        if (m.Name.Length == 0) throw new InvalidOperationException("Please enter a name.");
        if (m.Mode == ConnectionMode.Direct && m.Ip.Length == 0) throw new InvalidOperationException("Direct RDP needs an IP or host name.");
        if (m.CredentialId == "") m.CredentialId = null;
        m.Quality = RdpQuality.Normalize(m.Quality, "");

        var existing = st.Data.Machines.FirstOrDefault(x => x.Id == m.Id);
        if (existing == null)
        {
            if (string.IsNullOrEmpty(m.Id)) m.Id = Guid.NewGuid().ToString("N");
            m.LastUsed = null;
            st.Data.Machines.Add(m);
            existing = m;
        }
        else
        {
            existing.Name = m.Name; existing.Ip = m.Ip; existing.Target = m.Target; existing.Group = m.Group;
            existing.Mode = m.Mode; existing.CredentialId = m.CredentialId; existing.AutoType = m.AutoType;
            existing.Favorite = m.Favorite; existing.Notes = m.Notes ?? ""; existing.KeepAlive = m.KeepAlive;
            existing.Quality = m.Quality;
            foreach (var s in _sessions.Values.Where(s => s.View.Machine == existing)) { s.View.Title = existing.Name; s.Report(); }
        }
        st.Save();
        return existing;
    }

    private void DeleteMachines(string[] ids)
    {
        var st = S;
        st.Data.Machines.RemoveAll(m => ids.Contains(m.Id));
        st.Save();
    }

    private void RenameGroup(string from, string to)
    {
        var st = S;
        string Key(Machine m) => string.IsNullOrWhiteSpace(m.Group) ? "Ungrouped" : m.Group;
        to = to.Trim();
        foreach (var m in st.Data.Machines.Where(m => string.Equals(Key(m), from, StringComparison.OrdinalIgnoreCase)))
            m.Group = to == "Ungrouped" ? "" : to;
        st.Save();
    }

    private CredentialDto SaveCredential(CredentialDto dto, string? password)
    {
        var st = S;
        var c = st.Data.Credentials.FirstOrDefault(x => x.Id == dto.Id);
        if (c == null)
        {
            c = new CredentialProfile();
            st.Data.Credentials.Add(c);
        }
        c.Username = dto.Username.Trim();
        c.Name = string.IsNullOrWhiteSpace(dto.Name) ? c.Username : dto.Name.Trim();
        if (c.Name.Length == 0) throw new InvalidOperationException("Enter a name or a login.");
        if (password != null) c.Password = password;
        if (!st.Data.Credentials.Any(x => x.Id == st.Data.Settings.DefaultCredentialId))
            st.Data.Settings.DefaultCredentialId = c.Id;
        st.Save();
        return new CredentialDto(c.Id, c.Name, c.Username, c.Password.Length > 0);
    }

    private void DeleteCredential(string id)
    {
        var st = S;
        st.Data.Credentials.RemoveAll(c => c.Id == id);
        foreach (var m in st.Data.Machines.Where(m => m.CredentialId == id)) m.CredentialId = null;
        if (st.Data.Settings.DefaultCredentialId == id) st.Data.Settings.DefaultCredentialId = st.Data.Credentials.FirstOrDefault()?.Id;
        st.Save();
    }

    private void SaveBastion(BastionDto dto, string? password)
    {
        var st = S;
        var b = st.Data.Bastion;
        b.Host = dto.Host.Trim();
        b.Port = dto.Port is > 0 and <= 65535 ? dto.Port : 3389;
        b.PrimaryUser = dto.PrimaryUser.Trim();
        b.Authorization = dto.Authorization.Trim();
        b.LoginTemplate = string.IsNullOrWhiteSpace(dto.LoginTemplate) ? "{target}:{auth}:{user}" : dto.LoginTemplate.Trim();
        b.UseNla = dto.UseNla;
        b.InteractiveLoginUsesTarget = dto.InteractiveLoginUsesTarget;
        b.AuthLevel = Math.Clamp(dto.AuthLevel, 0, 2);
        if (password != null) b.PrimaryPassword = password;
        st.Save();
    }

    private void SaveSettings(AppSettings s)
    {
        var st = S;
        s.DefaultCredentialId = st.Data.Settings.DefaultCredentialId;
        s.SidebarWidth = st.Data.Settings.SidebarWidth;
        if (string.IsNullOrWhiteSpace(s.AutoTypeSequence)) s.AutoTypeSequence = "{login}{TAB}{password}{ENTER}";
        s.AutoTypeDelayMs = Math.Clamp(s.AutoTypeDelayMs, 0, 30000);
        s.AutoLockMinutes = Math.Clamp(s.AutoLockMinutes, 0, 600);
        s.ColorDepth = s.ColorDepth is 15 or 16 or 24 ? s.ColorDepth : 32;
        s.Quality = RdpQuality.Normalize(s.Quality);
        st.Data.Settings = s;
        Diag.Enabled = s.DiagEnabled;
        st.Save();
    }

    private object ImportPreview(string text)
    {
        var r = Importer.Parse(text, S.Data.Machines);
        return new { count = r.Machines.Count, duplicates = r.Duplicates, skipped = r.SkippedProtocols, sample = r.Machines.Take(6).Select(m => m.Name) };
    }

    private object Import(string text, string? group, string? credentialId)
    {
        var st = S;
        var r = Importer.Parse(text, st.Data.Machines);
        foreach (var m in r.Machines)
        {
            if (!string.IsNullOrWhiteSpace(group)) m.Group = group.Trim();
            m.CredentialId = string.IsNullOrEmpty(credentialId) ? null : credentialId;
            st.Data.Machines.Add(m);
        }
        if (r.Machines.Count > 0) st.Save();
        return new { imported = r.Machines.Count };
    }

    // ============================================================================================ sessions

    private object Open(JsonElement p)
    {
        var st = S;
        var id = Str(p, "id");
        if (id.Length == 0 || _sessions.ContainsKey(id)) throw new InvalidOperationException("bad session id");

        Machine machine;
        if (Bool(p, "selector"))
        {
            machine = new Machine { Name = "WALLIX list", Target = "", AutoType = AutoTypeMode.Always, Mode = ConnectionMode.Bastion, IsAdHoc = true };
        }
        else if (OptStr(p, "machineId") is { Length: > 0 } mid)
        {
            machine = st.Data.Machines.FirstOrDefault(m => m.Id == mid) ?? throw new InvalidOperationException("That machine was deleted.");
        }
        else
        {
            machine = Get<Machine>(p, "machine");
            machine.IsAdHoc = true;
            if (string.IsNullOrWhiteSpace(machine.Name)) machine.Name = machine.Ip;
        }

        if (machine.Mode == ConnectionMode.Bastion && string.IsNullOrWhiteSpace(st.Data.Bastion.Host))
            throw new InvalidOperationException("BASTION: Enter the WALLIX bastion address first (Remote Desktop settings).");

        var view = new SessionView(st, machine);
        int dupes = _sessions.Values.Count(s => s.View.Machine.Name == machine.Name);
        if (dupes > 0) view.Title = $"{machine.Name} {dupes + 1}";

        var session = new RdpSession(id, this, view);
        _sessions[id] = session;
        return new { title = view.Title, tooltip = view.ToolTip, machineId = machine.IsAdHoc ? "" : machine.Id };
    }

    internal void OnSessionClosed(RdpSession s)
    {
        _sessions.Remove(s.Id);
        if (_hotSession == s) _hotSession = null;
        Emit("closed", new { id = s.Id });
    }

    /// <summary>The saved-login list: pick one and it is typed into whatever the session shows.</summary>
    internal void ShowFillPicker(RdpSession? s)
    {
        if (s == null || Locked) return;
        if (!s.View.IsConnected) { Emit("notify", new { text = "Connect first, then pick a login to fill." }); return; }
        var entries = FillEntries();
        if (entries.Count == 0)
        {
            Emit("notify", new { text = "No logins saved yet — add them under Remote Desktop → Logins." });
            return;
        }

        // In its tab: Remterm shows the list itself (no window of ours over its window: focus stays simple
        // and clicking anywhere outside closes it). Only names go out; the engine types the picked one.
        if (s.Mode == "docked")
        {
            Emit("fillPicker", new { id = s.Id, entries = entries.Select(e => new { key = e.Key, label = e.Label, sub = e.Sub, bastion = e.IsBastion }) });
            return;
        }

        if (_picker != null) { _picker.Activate(); return; }
        var root = Win.Root(s.View);
        var picker = new CredentialPicker(entries);
        var area = Win.ClientScreenRect(root);
        picker.Location = new Point(area.X + (area.Width - picker.Width) / 2, area.Y + Theme.S(70));
        picker.FormClosed += (_, _) =>
        {
            _picker = null;
            if (picker.DialogResult == DialogResult.OK && picker.Result is { } f) s.View.FillSmart(f.Login, f.Password);
        };
        _picker = picker;
        // Not modal: a modal dialog disables Remterm's window, and WebView2 fails (Wails exits) when that
        // disabled window gets the focus back. Owned and modeless, it closes as soon as anything else is clicked.
        picker.Show(new Win.Owner(root));
    }

    private CredentialPicker? _picker;

    private List<FillEntry> FillEntries()
    {
        var st = S;
        var entries = new List<FillEntry>();
        var b = st.Data.Bastion;
        if (!string.IsNullOrWhiteSpace(b.PrimaryUser) && !string.IsNullOrEmpty(b.PrimaryPassword))
            entries.Add(new FillEntry("bastion", b.PrimaryUser, "bastion / step 1", b.PrimaryUser, b.PrimaryPassword, IsBastion: true));
        foreach (var c in st.Data.Credentials)
            entries.Add(new FillEntry(c.Id, string.IsNullOrWhiteSpace(c.Name) ? c.Username : c.Name, c.Username, c.Username, c.Password));
        return entries;
    }

    /// <summary>A login picked in Remterm's list: typed once the session is back on screen.</summary>
    private void FillWith(RdpSession s, string key)
    {
        var f = FillEntries().FirstOrDefault(e => e.Key == key) ?? throw new InvalidOperationException("That login was deleted.");
        s.View.FillSmartWhenShown(f.Login, f.Password);
    }

    // ============================================================================================ hotkeys

    private enum Hk { Fullscreen = 1, Quick, NextTab, PrevTab, Fill, CloseTab, Sidebar, Lock, Reconnect, Tab1 = 11, Tab9 = 19 }

    /// <summary>
    /// Ctrl+Alt shortcuts are registered only while a session has the keyboard (the RDP control eats every
    /// key otherwise); in the rest of Remterm the web UI handles its own shortcuts.
    /// </summary>
    private void FocusTick()
    {
        RdpSession? active = null;
        if (!Locked)
        {
            var focus = Win.FocusedWindow();
            var fg = Win.GetForegroundWindow();
            active = _sessions.Values.FirstOrDefault(s => s.HasFocus(focus, fg));
        }
        _hotSession = active;
        bool want = active != null;
        if (want == _hotkeysOn) return;
        _hotkeysOn = want;
        const uint MOD_ALT = 0x1, MOD_CONTROL = 0x2, MOD_NOREPEAT = 0x4000;
        var map = new (Hk id, Keys key)[]
        {
            (Hk.Fullscreen, Keys.Enter), (Hk.Quick, Keys.P), (Hk.NextTab, Keys.PageDown), (Hk.PrevTab, Keys.PageUp),
            (Hk.Fill, Keys.K), (Hk.CloseTab, Keys.W), (Hk.Sidebar, Keys.B), (Hk.Lock, Keys.L), (Hk.Reconnect, Keys.R),
        };
        foreach (var (id, key) in map)
        {
            if (want) Win.RegisterHotKey(_ui.Handle, (int)id, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, (uint)key);
            else Win.UnregisterHotKey(_ui.Handle, (int)id);
        }
        for (int i = 0; i < 9; i++)
        {
            if (want) Win.RegisterHotKey(_ui.Handle, (int)Hk.Tab1 + i, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, (uint)(Keys.D1 + i));
            else Win.UnregisterHotKey(_ui.Handle, (int)Hk.Tab1 + i);
        }
    }

    internal void OnHotkey(int raw)
    {
        var s = _hotSession;
        if (s == null || Locked) return;
        var id = (Hk)raw;
        switch (id)
        {
            case Hk.Fill: ShowFillPicker(s); break;
            case Hk.Reconnect: s.View.Connect(); break;
            case Hk.Fullscreen: s.ToggleFullscreen(); break;
            case >= Hk.Tab1 and <= Hk.Tab9: Emit("hotkey", new { key = $"tab{id - Hk.Tab1 + 1}", id = s.Id }); break;
            default:
                var key = id switch
                {
                    Hk.Quick => "quick", Hk.NextTab => "next", Hk.PrevTab => "prev", Hk.CloseTab => "close",
                    Hk.Sidebar => "sidebar", Hk.Lock => "lock", _ => "",
                };
                if (key.Length > 0) Emit("hotkey", new { key, id = s.Id });
                break;
        }
    }

    // ============================================================================================ shutdown

    private void Shutdown()
    {
        if (_shuttingDown) return;
        _shuttingDown = true;
        _focusTimer.Stop();
        _idleTimer.Stop();
        foreach (var s in _sessions.Values.ToList())
        {
            try { s.View.Disconnect(); } catch { /* exiting anyway */ }
        }
        ExitThread();
    }

    protected override void ExitThreadCore()
    {
        _shuttingDown = true;
        base.ExitThreadCore();
        Environment.Exit(0); // RDP controls may hold COM references that would keep the process alive
    }

    /// <summary>Never-shown window: owns the UI thread's message queue for BeginInvoke and WM_HOTKEY.</summary>
    private sealed class Pump(EngineHost host) : Form
    {
        protected override void SetVisibleCore(bool value) => base.SetVisibleCore(false);

        protected override void WndProc(ref Message m)
        {
            if (m.Msg == 0x0312) { host.OnHotkey((int)m.WParam); return; } // WM_HOTKEY
            base.WndProc(ref m);
        }
    }
}
