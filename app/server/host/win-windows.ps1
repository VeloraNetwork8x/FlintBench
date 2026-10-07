# Top-level windows of other processes (Windows only). The native helper is compiled once and cached.
#   -Mode names -Names Code,WindowsTerminal   "<pid>`t<title>" of visible windows owned by those process names
#   -Mode pids  -Pids 12,34                   "<pid>`t<title>" of visible windows owned by those pids
#   -Mode focus -Pids 12 [-Title part]        restores and brings to the front the first matching window
#   -Mode explorer -Path C:\dir [-Item C:\dir\f.txt]
#                                             shows the folder in File Explorer (reusing an open window of it),
#                                             selects the item and brings the window to the front
# VS Code titles end with "<folder> - Visual Studio Code"; terminals own the windows of the shells in them.
param([string]$Mode = 'names', [string]$Names = '', [string]$Pids = '', [string]$Title = '', [string]$Path = '', [string]$Item = '')
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$dll = Join-Path $env:TEMP 'flintbench-windows-v2.dll'
if (-not (Test-Path $dll)) {
  Add-Type -OutputAssembly $dll -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class FlintBenchWindows {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int max);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  public static List<KeyValuePair<IntPtr, string>> All() {
    var found = new List<KeyValuePair<IntPtr, string>>();
    EnumWindows((h, l) => {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(512);
      if (GetWindowText(h, sb, 512) == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      found.Add(new KeyValuePair<IntPtr, string>(h, pid + "\t" + sb.ToString()));
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static bool Focus(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
    // Windows only lets the foreground app hand focus over: a synthetic Alt press lifts that lock
    keybd_event(0x12, 0, 0, UIntPtr.Zero);
    keybd_event(0x12, 0, 2, UIntPtr.Zero);
    return SetForegroundWindow(h);
  }
}
'@
}
Add-Type -Path $dll
$pidSet = @{}
foreach ($p in ($Pids -split ',')) { if ($p -match '^\d+$') { $pidSet[[int]$p] = $true } }
if ($Mode -eq 'names') {
  foreach ($n in ($Names -split ',')) { if ($n) { Get-Process -Name $n | ForEach-Object { $pidSet[[int]$_.Id] = $true } } }
}
if ($Mode -eq 'explorer') {
  $shell = New-Object -ComObject Shell.Application
  $target = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  function Find-Window {
    foreach ($w in @($shell.Windows())) {
      try { if ($w.FullName -like '*explorer.exe' -and $w.Document.Folder.Self.Path.TrimEnd('\') -ieq $target) { return $w } } catch {}
    }
    return $null
  }
  $win = Find-Window
  if (-not $win) {
    Start-Process explorer.exe -ArgumentList ('"' + $target + '"')
    for ($i = 0; $i -lt 50 -and -not $win; $i++) { Start-Sleep -Milliseconds 120; $win = Find-Window }
  }
  if (-not $win) { 'missing'; exit }
  if ($Item) {
    # a new window fills its view a moment after it appears: retry the selection briefly
    for ($i = 0; $i -lt 15; $i++) {
      try {
        $fi = $win.Document.Folder.ParseName([IO.Path]::GetFileName($Item))
        if ($fi) { $win.Document.SelectItem($fi, 29); break } # select + deselect others + scroll into view + focus
      } catch {}
      Start-Sleep -Milliseconds 120
    }
  }
  if ([FlintBenchWindows]::Focus([IntPtr][long]$win.HWND)) { 'focused' } else { 'denied' }
  exit
}
$windows = [FlintBenchWindows]::All()
if ($Mode -eq 'focus') {
  foreach ($w in $windows) {
    $parts = $w.Value.Split("`t", 2)
    if ($pidSet.ContainsKey([int]$parts[0]) -and (-not $Title -or $parts[1].Contains($Title))) {
      if ([FlintBenchWindows]::Focus($w.Key)) { "focused`t$($w.Value)" } else { "denied`t$($w.Value)" }
      break
    }
  }
} else {
  foreach ($w in $windows) {
    $ownerPid = [int]($w.Value.Split("`t")[0])
    if ($pidSet.ContainsKey($ownerPid)) { $w.Value }
  }
}
