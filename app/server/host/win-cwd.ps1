# Prints "<pid>`t<current directory>" for each pid in a comma-separated -Pids list.
# Windows does not expose another process's working directory through any API, but it lives in
# the process's own PEB (RTL_USER_PROCESS_PARAMETERS.CurrentDirectory). Reading it needs only
# PROCESS_QUERY_INFORMATION + PROCESS_VM_READ, granted for the user's own processes. 64-bit only.
param([string]$Pids)
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FlintBenchCwd {
  [StructLayout(LayoutKind.Sequential)]
  struct PBI { public IntPtr Reserved1; public IntPtr PebBaseAddress; public IntPtr Reserved2a; public IntPtr Reserved2b; public IntPtr UniqueProcessId; public IntPtr Reserved3; }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int cls, ref PBI pbi, int len, out int ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr h, IntPtr addr, byte[] buf, IntPtr size, out IntPtr read);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr h, out bool wow);
  static byte[] Read(IntPtr h, IntPtr addr, int size) {
    var buf = new byte[size]; IntPtr got;
    return ReadProcessMemory(h, addr, buf, (IntPtr)size, out got) && (long)got == size ? buf : null;
  }
  public static string Get(int pid) {
    IntPtr h = OpenProcess(0x0400 | 0x0010, false, pid);
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
      return System.Text.Encoding.Unicode.GetString(text).TrimEnd('\\');
    } finally { CloseHandle(h); }
  }
}
'@
foreach ($p in ($Pids -split ',' | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ })) {
  $cwd = [FlintBenchCwd]::Get($p)
  if ($cwd) { "$p`t$cwd" }
}
