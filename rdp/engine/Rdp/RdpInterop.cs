using System.Runtime.InteropServices;

namespace RemoteHub.Rdp;

/// <summary>
/// Hosts the Windows RDP ActiveX (mstscax.dll) without aximp-generated wrappers.
/// Properties are reached late-bound through <see cref="Ocx"/>; events come in through a dispinterface sink.
/// </summary>
internal sealed class RdpHost : AxHost
{
    // MsRdpClient9NotSafeForScripting: supports UpdateSessionDisplaySettings and ClearTextPassword.
    private const string Clsid = "8b918b82-7985-4c24-89df-c33ad2bbfbcd";

    private ConnectionPointCookie? _cookie;
    private readonly RdpEventSink _sink;

    public RdpHost() : base(Clsid)
    {
        _sink = new RdpEventSink(this);
    }

    public dynamic Ocx => GetOcx() ?? throw new InvalidOperationException("RDP control is not created yet.");

    public IMsRdpClientNonScriptable NonScriptable => (IMsRdpClientNonScriptable)GetOcx()!;

    public event EventHandler? Connecting;
    public event EventHandler? Connected;
    public event EventHandler? LoginComplete;
    public event EventHandler<int>? Disconnected;
    public event EventHandler<int>? FatalError;
    public event EventHandler<int>? LogonError;
    public event EventHandler? AutoReconnecting;
    public event EventHandler? AutoReconnected;

    /// <summary>Handler sets <c>Cancel = true</c> to refuse the logon.</summary>
    public event EventHandler<PublicKeyEventArgs>? ReceivedPublicKey;

    protected override void CreateSink()
    {
        try
        {
            _cookie = new ConnectionPointCookie(GetOcx()!, _sink, typeof(IMsTscAxEvents));
        }
        catch
        {
            _cookie = null;
        }
    }

    protected override void DetachSink()
    {
        try { _cookie?.Disconnect(); } catch { /* control already gone */ }
        _cookie = null;
    }

    internal void RaiseConnecting() => Connecting?.Invoke(this, EventArgs.Empty);
    internal void RaiseConnected() => Connected?.Invoke(this, EventArgs.Empty);
    internal void RaiseLoginComplete() => LoginComplete?.Invoke(this, EventArgs.Empty);
    internal void RaiseDisconnected(int reason) => Disconnected?.Invoke(this, reason);
    internal void RaiseFatalError(int code) => FatalError?.Invoke(this, code);
    internal void RaiseLogonError(int code) => LogonError?.Invoke(this, code);
    internal void RaiseAutoReconnecting() => AutoReconnecting?.Invoke(this, EventArgs.Empty);
    internal void RaiseAutoReconnected() => AutoReconnected?.Invoke(this, EventArgs.Empty);

    internal bool RaisePublicKey(string key)
    {
        var e = new PublicKeyEventArgs(key);
        ReceivedPublicKey?.Invoke(this, e);
        return !e.Cancel;
    }
}

internal sealed class PublicKeyEventArgs(string publicKey) : EventArgs
{
    public string PublicKey { get; } = publicKey;
    public bool Cancel { get; set; }
}

[ComImport]
[Guid("336D5562-EFA8-482E-8CB3-C5C0FC7A7DB6")]
[InterfaceType(ComInterfaceType.InterfaceIsIDispatch)]
public interface IMsTscAxEvents
{
    [DispId(1)] void OnConnecting();
    [DispId(2)] void OnConnected();
    [DispId(3)] void OnLoginComplete();
    [DispId(4)] void OnDisconnected(int discReason);
    [DispId(10)] void OnFatalError(int errorCode);
    [DispId(15)] void OnConfirmClose(ref bool pfAllowClose);
    [DispId(16)] void OnReceivedTSPublicKey([MarshalAs(UnmanagedType.BStr)] string publicKey, ref bool pfContinueLogon);
    [DispId(22)] void OnLogonError(int lError);
    [DispId(33)] void OnAutoReconnected();
    [DispId(34)] void OnAutoReconnecting2(int disconnectReason, bool networkAvailable, int attemptCount, int maxAttemptCount);
}

[ClassInterface(ClassInterfaceType.None)]
[ComVisible(true)]
internal sealed class RdpEventSink(RdpHost host) : IMsTscAxEvents
{
    public void OnConnecting() => host.RaiseConnecting();
    public void OnConnected() => host.RaiseConnected();
    public void OnLoginComplete() => host.RaiseLoginComplete();
    public void OnDisconnected(int discReason) => host.RaiseDisconnected(discReason);
    public void OnFatalError(int errorCode) => host.RaiseFatalError(errorCode);
    public void OnConfirmClose(ref bool pfAllowClose) => pfAllowClose = true;
    public void OnReceivedTSPublicKey(string publicKey, ref bool pfContinueLogon) => pfContinueLogon = host.RaisePublicKey(publicKey);
    public void OnLogonError(int lError) => host.RaiseLogonError(lError);
    public void OnAutoReconnected() => host.RaiseAutoReconnected();
    public void OnAutoReconnecting2(int disconnectReason, bool networkAvailable, int attemptCount, int maxAttemptCount) => host.RaiseAutoReconnecting();
}

/// <summary>
/// Vtable-exact declaration of IMsRdpClientNonScriptable (IUnknown-based), declared by hand so that
/// SendKeys can take real arrays (the tlbimp version marshals them as a single by-ref element).
/// </summary>
[ComImport]
[Guid("2F079C4C-87B2-4AFD-97AB-20CDB43038AE")]
[InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
public interface IMsRdpClientNonScriptable
{
    void set_ClearTextPassword([MarshalAs(UnmanagedType.BStr)] string value);
    void set_PortablePassword([MarshalAs(UnmanagedType.BStr)] string value);
    [return: MarshalAs(UnmanagedType.BStr)] string get_PortablePassword();
    void set_PortableSalt([MarshalAs(UnmanagedType.BStr)] string value);
    [return: MarshalAs(UnmanagedType.BStr)] string get_PortableSalt();
    void set_BinaryPassword([MarshalAs(UnmanagedType.BStr)] string value);
    [return: MarshalAs(UnmanagedType.BStr)] string get_BinaryPassword();
    void set_BinarySalt([MarshalAs(UnmanagedType.BStr)] string value);
    [return: MarshalAs(UnmanagedType.BStr)] string get_BinarySalt();
    void ResetPassword();
    void NotifyRedirectDeviceChange(nuint wParam, nint lParam);
    void SendKeys(int numKeys,
        [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] short[] pbArrayKeyUp,
        [In, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] int[] plKeyData);
}
