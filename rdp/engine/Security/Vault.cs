using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace RemoteHub.Security;

/// <summary>
/// Encrypted store for everything the app knows (machines + credentials).
/// Layout: a random 256-bit data key encrypts the JSON with AES-GCM. The data key is protected with
/// Windows DPAPI (bound to this Windows user) and, when a master password is set, additionally wrapped
/// with AES-GCM under a PBKDF2-SHA256 key derived from that password.
/// </summary>
public sealed class Vault
{
    private const int Iterations = 600_000;
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };

    public static string Folder { get; } =
        Environment.GetEnvironmentVariable("REMOTEHUB_HOME") is { Length: > 0 } custom
            ? custom
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "RemoteHub");
    public static string FilePath { get; } = Path.Combine(Folder, "vault.dat");

    private byte[] _dataKey;
    private byte[]? _masterSalt;
    private byte[]? _masterHash; // PBKDF2 output, used to verify unlock attempts while running

    public bool HasMasterPassword => _masterSalt != null;

    private Vault(byte[] dataKey, byte[]? salt, byte[]? masterHash)
    {
        _dataKey = dataKey;
        _masterSalt = salt;
        _masterHash = masterHash;
    }

    public static bool Exists => File.Exists(FilePath);

    public static bool FileNeedsMasterPassword()
    {
        if (!Exists) return false;
        var env = JsonSerializer.Deserialize<Envelope>(File.ReadAllText(FilePath))!;
        return env.Master;
    }

    public static (Vault vault, AppData data) CreateNew()
    {
        var v = new Vault(RandomNumberGenerator.GetBytes(32), null, null);
        var data = new AppData();
        v.Save(data);
        return (v, data);
    }

    /// <exception cref="CryptographicException">Wrong master password or corrupted file.</exception>
    public static (Vault vault, AppData data) Open(string? masterPassword)
    {
        var env = JsonSerializer.Deserialize<Envelope>(File.ReadAllText(FilePath))
                  ?? throw new CryptographicException("Vault file is empty.");

        byte[] wrapped = Dpapi.Unprotect(Convert.FromBase64String(env.WrappedKey));
        byte[] dataKey;
        byte[]? salt = null, hash = null;
        if (env.Master)
        {
            if (string.IsNullOrEmpty(masterPassword)) throw new CryptographicException("Master password required.");
            salt = Convert.FromBase64String(env.Salt!);
            hash = Derive(masterPassword, salt, env.Iterations);
            dataKey = AesOpen(hash, wrapped);
        }
        else
        {
            dataKey = wrapped;
        }

        var plain = AesOpen(dataKey, Convert.FromBase64String(env.Data));
        var data = JsonSerializer.Deserialize<AppData>(plain) ?? new AppData();
        CryptographicOperations.ZeroMemory(plain);
        return (new Vault(dataKey, salt, hash), data);
    }

    public bool VerifyMasterPassword(string password)
    {
        if (_masterSalt == null || _masterHash == null) return true;
        var h = Derive(password, _masterSalt, Iterations);
        return CryptographicOperations.FixedTimeEquals(h, _masterHash);
    }

    /// <summary>Set, change (non-empty) or remove (null/empty) the master password.</summary>
    public void SetMasterPassword(string? password, AppData data)
    {
        if (string.IsNullOrEmpty(password))
        {
            _masterSalt = null;
            _masterHash = null;
        }
        else
        {
            _masterSalt = RandomNumberGenerator.GetBytes(16);
            _masterHash = Derive(password, _masterSalt, Iterations);
        }
        Save(data);
    }

    public void Save(AppData data)
    {
        Directory.CreateDirectory(Folder);
        var plain = JsonSerializer.SerializeToUtf8Bytes(data, Json);
        var sealedData = AesSeal(_dataKey, plain);
        CryptographicOperations.ZeroMemory(plain);

        byte[] keyBlob = _masterHash != null ? AesSeal(_masterHash, _dataKey) : _dataKey;
        var env = new Envelope
        {
            V = 1,
            Master = _masterHash != null,
            Salt = _masterSalt != null ? Convert.ToBase64String(_masterSalt) : null,
            Iterations = Iterations,
            WrappedKey = Convert.ToBase64String(Dpapi.Protect(keyBlob)),
            Data = Convert.ToBase64String(sealedData),
        };

        // Atomic replace so a crash mid-write never corrupts the vault.
        var tmp = FilePath + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(env, Json));
        if (File.Exists(FilePath)) File.Replace(tmp, FilePath, FilePath + ".bak", true);
        else File.Move(tmp, FilePath);
    }

    private static byte[] Derive(string password, byte[] salt, int iterations) =>
        Rfc2898DeriveBytes.Pbkdf2(Encoding.UTF8.GetBytes(password), salt, iterations, HashAlgorithmName.SHA256, 32);

    // nonce(12) | tag(16) | ciphertext
    private static byte[] AesSeal(byte[] key, byte[] plain)
    {
        var output = new byte[12 + 16 + plain.Length];
        var nonce = output.AsSpan(0, 12);
        RandomNumberGenerator.Fill(nonce);
        using var aes = new AesGcm(key, 16);
        aes.Encrypt(nonce, plain, output.AsSpan(28), output.AsSpan(12, 16));
        return output;
    }

    private static byte[] AesOpen(byte[] key, byte[] blob)
    {
        if (blob.Length < 28) throw new CryptographicException("Invalid encrypted blob.");
        var plain = new byte[blob.Length - 28];
        using var aes = new AesGcm(key, 16);
        aes.Decrypt(blob.AsSpan(0, 12), blob.AsSpan(28), blob.AsSpan(12, 16), plain);
        return plain;
    }

    private sealed class Envelope
    {
        public int V { get; set; }
        public bool Master { get; set; }
        public string? Salt { get; set; }
        public int Iterations { get; set; }
        public string WrappedKey { get; set; } = "";
        public string Data { get; set; } = "";
    }
}

/// <summary>Windows DPAPI (CurrentUser scope) without the extra NuGet package.</summary>
internal static class Dpapi
{
    private static readonly byte[] Entropy = Encoding.UTF8.GetBytes("RemoteHub.v1.vault");

    public static byte[] Protect(byte[] data) => Run(data, protect: true);
    public static byte[] Unprotect(byte[] data) => Run(data, protect: false);

    private static byte[] Run(byte[] data, bool protect)
    {
        var input = new DATA_BLOB();
        var entropy = new DATA_BLOB();
        var output = new DATA_BLOB();
        var hIn = GCHandle.Alloc(data, GCHandleType.Pinned);
        var hEnt = GCHandle.Alloc(Entropy, GCHandleType.Pinned);
        try
        {
            input.cbData = data.Length; input.pbData = hIn.AddrOfPinnedObject();
            entropy.cbData = Entropy.Length; entropy.pbData = hEnt.AddrOfPinnedObject();
            bool ok = protect
                ? CryptProtectData(ref input, "RemoteHub", ref entropy, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref output)
                : CryptUnprotectData(ref input, IntPtr.Zero, ref entropy, IntPtr.Zero, IntPtr.Zero, CRYPTPROTECT_UI_FORBIDDEN, ref output);
            if (!ok) throw new CryptographicException("DPAPI failed", new Win32Exception(Marshal.GetLastWin32Error()));
            var result = new byte[output.cbData];
            Marshal.Copy(output.pbData, result, 0, output.cbData);
            return result;
        }
        finally
        {
            hIn.Free(); hEnt.Free();
            if (output.pbData != IntPtr.Zero) LocalFree(output.pbData);
        }
    }

    private const int CRYPTPROTECT_UI_FORBIDDEN = 0x1;

    [StructLayout(LayoutKind.Sequential)]
    private struct DATA_BLOB { public int cbData; public IntPtr pbData; }

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptProtectData(ref DATA_BLOB pDataIn, string szDataDescr, ref DATA_BLOB pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

    [DllImport("crypt32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    private static extern bool CryptUnprotectData(ref DATA_BLOB pDataIn, IntPtr ppszDataDescr, ref DATA_BLOB pOptionalEntropy,
        IntPtr pvReserved, IntPtr pPromptStruct, int dwFlags, ref DATA_BLOB pDataOut);

    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr hMem);
}
