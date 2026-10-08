# Loaded once into FlintBench's long-lived PowerShell session (Windows). It never compiles anything:
# win-procs-build.ps1 builds FlintBenchProcs into a DLL on its own, and this loads it when it is there.
#   FbList          "<pid>`t<ppid>`t<started ms>`t<name>`t<command line>" per process
#   FbCwds '1,2'    "<pid>`t<current directory>" per readable pid
# With the DLL: native calls only (a Toolhelp snapshot, NtQueryInformationProcess, the process's own
# PEB), no WMI. WMI choked while agents started and ended processes by the hundred, and every other
# WMI user on the machine waited with it. Without it yet: the WMI scan, and no working folders.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$global:FbDll = Join-Path $env:TEMP 'flintbench-procs-v2.dll'

function global:FbReady {
  if ('FlintBenchProcs' -as [type]) { return $true }
  if (-not (Test-Path $global:FbDll)) { return $false }
  try { Add-Type -Path $global:FbDll -ErrorAction Stop; return $true } catch { return $false }
}

function global:FbList {
  if (FbReady) { [FlintBenchProcs]::List() }
  else {
    Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name,CommandLine,CreationDate | ForEach-Object {
      $c = if ($_.CommandLine) { $_.CommandLine -replace "[	
]", " " } else { "" }
      $t = if ($_.CreationDate) { ([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }
      "$($_.ProcessId)`t$($_.ParentProcessId)`t$t`t$($_.Name)`t$c"
    }
  }
}

function global:FbCwds([string]$pids) {
  if (FbReady) { [FlintBenchProcs]::Cwds($pids) }
}
