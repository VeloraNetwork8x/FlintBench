import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { httpError } from './paths.js';

/**
 * Native "choose a folder / file" dialogs, opened on the machine running FlintBench (the owner's
 * desktop). Windows uses the Explorer-style IFileOpenDialog through PowerShell, macOS AppleScript,
 * Linux zenity. One dialog at a time; cancelling resolves to null.
 */

// IFileOpenDialog via COM, compiled once per call by Add-Type. A hidden topmost window owns the
// dialog so it opens in front of the browser even though FlintBench runs in the background.
const PS_SCRIPT = String.raw`
param([string]$Kind, [string]$Title, [string]$Initial, [string]$FilterName, [string]$FilterSpec)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FlintBenchPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialogRCW {}
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct FilterSpec { [MarshalAs(UnmanagedType.LPWStr)] public string Name; [MarshalAs(UnmanagedType.LPWStr)] public string Spec; }
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
    void GetParent(out IShellItem ppsi);
    void GetDisplayName(uint sigdn, out IntPtr ppszName);
    void GetAttributes(uint mask, out uint attribs);
    void Compare(IShellItem psi, uint hint, out int order);
  }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileOpenDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(uint count, [MarshalAs(UnmanagedType.LPArray)] FilterSpec[] specs);
    void SetFileTypeIndex(uint index);
    void GetFileTypeIndex(out uint index);
    void Advise(IntPtr events, out uint cookie);
    void Unadvise(uint cookie);
    void SetOptions(uint options);
    void GetOptions(out uint options);
    void SetDefaultFolder(IShellItem item);
    void SetFolder(IShellItem item);
    void GetFolder(out IShellItem item);
    void GetCurrentSelection(out IShellItem item);
    void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string name);
    void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string name);
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string label);
    void GetResult(out IShellItem item);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, ref Guid riid, out IShellItem item);

  public static string Pick(IntPtr owner, bool folder, string title, string initial, string filterName, string filterSpec) {
    var dialog = (IFileOpenDialog)new FileOpenDialogRCW();
    uint options;
    dialog.GetOptions(out options);
    // FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST, plus FOS_PICKFOLDERS or FOS_FILEMUSTEXIST
    options |= 0x40 | 0x800 | (folder ? 0x20u : 0x1000u);
    dialog.SetOptions(options);
    if (!string.IsNullOrEmpty(title)) dialog.SetTitle(title);
    if (!folder && !string.IsNullOrEmpty(filterSpec))
      dialog.SetFileTypes(2, new[] { new FilterSpec { Name = filterName, Spec = filterSpec }, new FilterSpec { Name = "All files", Spec = "*.*" } });
    if (!string.IsNullOrEmpty(initial)) {
      try {
        var iid = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
        IShellItem start;
        SHCreateItemFromParsingName(initial, IntPtr.Zero, ref iid, out start);
        dialog.SetFolder(start);
      } catch { }
    }
    if (dialog.Show(owner) != 0) return null; // cancelled
    IShellItem result;
    dialog.GetResult(out result);
    IntPtr name;
    result.GetDisplayName(0x80058000, out name); // SIGDN_FILESYSPATH
    var path = Marshal.PtrToStringUni(name);
    Marshal.FreeCoTaskMem(name);
    return path;
  }
}
'@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.FormBorderStyle = 'None'
$owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'
$owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show()
$owner.Activate()
try {
  $picked = [FlintBenchPicker]::Pick($owner.Handle, $Kind -eq 'folder', $Title, $Initial, $FilterName, $FilterSpec)
} finally {
  $owner.Close()
}
if ($picked) { [Console]::Out.Write($picked) }
`;

let scriptFile = null;
let busy = false;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, maxBuffer: 1024 * 1024, timeout: 30 * 60_000 }, (error, stdout, stderr) => {
      // zenity / osascript exit non-zero on cancel: that is "no choice", not a failure
      if (error && !stdout.trim()) {
        if (error.code === 1 || /User canceled|-128/.test(stderr)) return resolve('');
        return reject(Object.assign(new Error(stderr.trim() || error.message), { code: error.code }));
      }
      resolve(stdout.trim());
    });
  });
}

async function pickWindows({ kind, title, initial, filterName, filterSpec }) {
  if (!scriptFile) {
    scriptFile = path.join(os.tmpdir(), `flintbench-picker-${process.pid}.ps1`);
    await fs.writeFile(scriptFile, `﻿${PS_SCRIPT}`, 'utf8');
  }
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptFile,
    '-Kind', kind, '-Title', title ?? '', '-Initial', initial ?? '', '-FilterName', filterName ?? '', '-FilterSpec', filterSpec ?? '']);
}

async function pickMac({ kind, title, initial }) {
  const prompt = JSON.stringify(title ?? 'Choose');
  const where = initial ? ` default location (POSIX file ${JSON.stringify(initial)})` : '';
  const what = kind === 'folder' ? 'choose folder' : 'choose file';
  return run('osascript', ['-e', `POSIX path of (${what} with prompt ${prompt}${where})`]);
}

async function pickLinux({ kind, title, initial }) {
  const args = ['--file-selection', `--title=${title ?? 'Choose'}`];
  if (kind === 'folder') args.push('--directory');
  if (initial) args.push(`--filename=${initial.endsWith('/') ? initial : `${initial}/`}`);
  return run('zenity', args);
}

/** Opens the dialog and resolves to the chosen absolute path, or null when cancelled. */
export async function pick({ kind = 'folder', title, initial, filterName, filterSpec } = {}) {
  if (kind !== 'folder' && kind !== 'file') throw httpError(400, 'kind must be folder or file');
  if (busy) throw httpError(409, 'A file dialog is already open on this computer');
  busy = true;
  try {
    const opts = { kind, title: String(title ?? '').slice(0, 120), initial: initial ? String(initial) : '', filterName, filterSpec };
    const picker = process.platform === 'win32' ? pickWindows : process.platform === 'darwin' ? pickMac : pickLinux;
    const result = await picker(opts).catch((error) => {
      if (error.code === 'ENOENT') throw httpError(501, 'No native file dialog is available on this system');
      throw error;
    });
    return result ? result.replace(/[\\/]+$/, (m) => (/^[A-Za-z]:[\\/]$/.test(result) || result === '/' ? m : '')) : null;
  } finally {
    busy = false;
  }
}
