# Compiles FlintBenchProcs (see win-procs.ps1) into flintbench-procs-v2.dll in %TEMP%, once. Run on its own
# by FlintBench at normal priority and with no time limit: compiling starts csc.exe, which can take a
# minute on a busy machine. Written under a temporary name and renamed when complete and loadable, so
# a compile cut short never leaves a broken DLL behind.
$ErrorActionPreference = 'Stop'
$dll = Join-Path $env:TEMP 'flintbench-procs-v2.dll'
if (Test-Path $dll) {
  try { Add-Type -Path $dll; exit 0 } catch { Remove-Item $dll -Force }
}
$tmp = Join-Path $env:TEMP ('flintbench-procs-' + [guid]::NewGuid().ToString('N') + '.dll')
Add-Type -OutputAssembly $tmp -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class FlintBenchProcs {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct PROCESSENTRY32W {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID;
    public uint th32ModuleID; public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase;
    public uint dwFlags; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct PBI { public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2a; public IntPtr Reserved2b; public IntPtr UniqueProcessId; public IntPtr Reserved3; }
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32FirstW(IntPtr snap, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool Process32NextW(IntPtr snap, ref PROCESSENTRY32W entry);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, IntPtr info, int len, out int ret);
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);

  const int QUERY_LIMITED = 0x1000, QUERY = 0x0400, VM_READ = 0x0010;

  // ProcessCommandLineInformation (60): a UNICODE_STRING followed by its text; Windows 8.1 and later
  static string CommandLine(IntPtr h) {
    int size = 4096;
    for (int attempt = 0; attempt < 2; attempt++) {
      IntPtr buf = Marshal.AllocHGlobal(size);
      try {
        int ret;
        int status = NtQueryInformationProcess(h, 60, buf, size, out ret);
        if (status == 0) {
          int length = Marshal.ReadInt16(buf) & 0xFFFF;
          IntPtr text = Marshal.ReadIntPtr(buf, IntPtr.Size);
          return length == 0 || text == IntPtr.Zero ? "" : Marshal.PtrToStringUni(text, length / 2);
        }
        if (ret <= size) return "";
        size = ret;
      } finally { Marshal.FreeHGlobal(buf); }
    }
    return "";
  }

  public static string List() {
    var sb = new StringBuilder();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0); // TH32CS_SNAPPROCESS
    if (snap == IntPtr.Zero || snap == (IntPtr)(-1)) return "";
    try {
      var e = new PROCESSENTRY32W(); e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32W));
      if (!Process32FirstW(snap, ref e)) return "";
      do {
        int pid = (int)e.th32ProcessID;
        if (pid == 0) continue;
        long started = 0; string cmd = "";
        IntPtr h = OpenProcess(QUERY_LIMITED, false, pid);
        if (h != IntPtr.Zero) {
          try {
            long c, x, k, u;
            if (GetProcessTimes(h, out c, out x, out k, out u) && c > 0) started = (DateTime.FromFileTimeUtc(c) - new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)).Ticks / 10000;
            cmd = CommandLine(h).Replace('\t', ' ').Replace('\r', ' ').Replace('\n', ' ');
          } finally { CloseHandle(h); }
        }
        sb.Append(pid).Append('\t').Append(e.th32ParentProcessID).Append('\t').Append(started).Append('\t').Append(e.szExeFile).Append('\t').Append(cmd).Append('\n');
      } while (Process32NextW(snap, ref e));
    } finally { CloseHandle(snap); }
    return sb.ToString();
  }

  static byte[] Read(IntPtr h, IntPtr addr, int size) {
    var buf = new byte[size]; IntPtr got;
    return ReadProcessMemory(h, addr, buf, (IntPtr)size, out got) && (long)got == size ? buf : null;
  }

  // RTL_USER_PROCESS_PARAMETERS.CurrentDirectory, read from the process's PEB (64-bit processes)
  static string Cwd(int pid) {
    IntPtr h = OpenProcess(QUERY | VM_READ, false, pid);
    if (h == IntPtr.Zero) return null;
    try {
      bool wow; if (IsWow64Process(h, out wow) && wow) return null;
      var pbi = new PBI(); int ret;
      if (NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(pbi), out ret) != 0) return null;
      var peb = Read(h, pbi.PebBaseAddress + 0x20, 8); if (peb == null) return null;
      var parameters = (IntPtr)BitConverter.ToInt64(peb, 0);
      var cur = Read(h, parameters + 0x38, 16); if (cur == null) return null;
      int length = BitConverter.ToUInt16(cur, 0);
      var buffer = (IntPtr)BitConverter.ToInt64(cur, 8);
      if (length == 0 || length > 4096) return null;
      var text = Read(h, buffer, length); if (text == null) return null;
      return Encoding.Unicode.GetString(text).TrimEnd('\\');
    } finally { CloseHandle(h); }
  }

  public static string Cwds(string pids) {
    var sb = new StringBuilder();
    foreach (var part in (pids ?? "").Split(',')) {
      int pid; if (!int.TryParse(part, out pid)) continue;
      var cwd = Cwd(pid);
      if (cwd != null) sb.Append(pid).Append('\t').Append(cwd).Append('\n');
    }
    return sb.ToString();
  }
}
'@
Add-Type -Path $tmp
Move-Item $tmp $dll -Force
