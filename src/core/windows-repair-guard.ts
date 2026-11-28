import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { createInterface } from 'node:readline';

const TIMEOUT = 15_000;

// Stock SQLite does not share DELETE. These handles prevent SQLite opens
// without invoking SQLite cleanup against the replacement's pathname.
const SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::ASCII, $false, 1024, $false)
function Read-Frame($line) {
  return [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line)) | ConvertFrom-Json
}
function Send-Frame($line) {
  [Console]::Out.WriteLine($line)
  [Console]::Out.Flush()
}
$handles = [Collections.Generic.List[IO.FileStream]]::new()
$stage = 'STARTUP'
try {
  $null = Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1'))
  Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class MemeshRepairFile {
  [StructLayout(LayoutKind.Sequential)]
  private struct IoStatusBlock {
    public IntPtr Status;
    public UIntPtr Information;
  }

  [DllImport("ntdll.dll", ExactSpelling = true)]
  private static extern int NtSetInformationFile(SafeFileHandle file, out IoStatusBlock status,
    byte[] information, uint length, int informationClass);

  public static FileStream OpenGuard(string file) {
    var attributes = File.GetAttributes(file);
    if ((attributes & (FileAttributes.ReparsePoint | FileAttributes.Directory)) != 0)
      throw new IOException("Repair requires regular files");
    return new FileStream(file, FileMode.Open, FileSystemRights.Read | FileSystemRights.Delete,
      FileShare.Read | FileShare.Delete, 4096, FileOptions.None);
  }

  public static int Replace(string from, string to) {
    if (!String.Equals(Path.GetDirectoryName(from), Path.GetDirectoryName(to), StringComparison.OrdinalIgnoreCase))
      throw new IOException("Repair requires a same-directory replacement");
    string name = Path.GetFullPath(to);
    string ntName = name.StartsWith(@"\\?\") ? @"\??\" + name.Substring(4) :
      name.StartsWith(@"\\") ? @"\??\UNC\" + name.Substring(2) : @"\??\" + name;
    byte[] nameBytes = Encoding.Unicode.GetBytes(ntName);
    int lengthOffset = 2 * IntPtr.Size;
    byte[] request = new byte[lengthOffset + sizeof(uint) + nameBytes.Length + sizeof(char)];
    // FILE_RENAME_INFORMATION_EX: flags, null RootDirectory, byte count, UTF-16 name.
    BitConverter.GetBytes(3u).CopyTo(request, 0); // REPLACE_IF_EXISTS | POSIX_SEMANTICS
    BitConverter.GetBytes((uint)nameBytes.Length).CopyTo(request, lengthOffset);
    nameBytes.CopyTo(request, lengthOffset + sizeof(uint));
    using (var source = new FileStream(from, FileMode.Open,
      FileSystemRights.Delete | FileSystemRights.Synchronize, FileShare.Read | FileShare.Delete, 4096, FileOptions.None)) {
      IoStatusBlock status;
      return NtSetInformationFile(source.SafeFileHandle, out status, request, (uint)request.Length, 65);
    }
  }
}
'@
  $request = Read-Frame ($reader.ReadLine())
  $stage = 'LOCK'
  foreach ($file in $request.paths) { $handles.Add([MemeshRepairFile]::OpenGuard($file)) }
  if ($null -ne $request.probe) {
    $stage = 'PREFLIGHT'
    $probe = [MemeshRepairFile]::OpenGuard($request.probe.to)
    try {
      $status = [MemeshRepairFile]::Replace($request.probe.from, $request.probe.to)
      if ($status -ne 0) {
        Send-Frame ('UNSUPPORTED ' + $status.ToString('X8'))
        exit 1
      }
      if ($probe.ReadByte() -ne 48) { throw 'old file did not survive probe' }
    } finally { $probe.Dispose() }
  }
  Send-Frame 'READY'
  while ($null -ne ($line = $reader.ReadLine())) {
    try {
      $operation = Read-Frame $line
      $status = [MemeshRepairFile]::Replace($operation.from, $operation.to)
      if ($status -eq 0) { Send-Frame 'REPLACED' }
      elseif ($status -lt 0) { Send-Frame ('FAILED ' + $status.ToString('X8')) }
      else { Send-Frame 'FAILED' }
    } catch { Send-Frame 'FAILED' }
  }
} catch {
  Send-Frame $stage
  exit 1
} finally {
  foreach ($handle in $handles) { $handle.Dispose() }
}
`;

interface WindowsRepairGuard {
  replace(from: string, to: string): Promise<void>;
  release(): Promise<void>;
}

export class WindowsReplacementUncertainError extends Error {}

export async function acquireWindowsRepairGuard(paths: string[], probe?: { from: string; to: string }): Promise<WindowsRepairGuard> {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('Windows system directory unavailable');
  const child = spawn(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
    { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
  child.stdin.on('error', () => {}); // A failed pipe also closes the child.
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once('close', (code, signal) => resolve({ code, signal })));
  child.on('error', () => {}); // Failed spawn is followed by close.
  const lines = createInterface({ input: child.stdout });

  async function exchange(value: object): Promise<string | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT);
    try {
      const reply = once(lines, 'line', { signal: controller.signal }).then(([line]) => String(line));
      child.stdin.write(Buffer.from(JSON.stringify(value), 'utf8').toString('base64') + '\n');
      return await Promise.race([reply, closed.then(() => undefined)]);
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  }

  async function release(verifyExit = true): Promise<void> {
    child.stdin.end(); // EOF also releases the handles when the parent dies.
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT);
    let deadline: NodeJS.Timeout | undefined;
    try {
      const exit = await Promise.race([closed, new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('Timed out releasing the Windows repair lock')), TIMEOUT * 2);
      })]);
      if (verifyExit && exit.code !== 0) throw new Error('Windows repair guard exited before confirming release');
    } finally {
      clearTimeout(timer);
      clearTimeout(deadline);
      lines.close();
      child.stdin.destroy();
      child.stdout.destroy();
      child.unref();
    }
  }

  try {
    const ready = await exchange({ paths, probe });
    const unsupported = /^UNSUPPORTED ([0-9A-F]{8})$/.exec(ready ?? '')?.[1];
    if (unsupported) throw new Error('This volume does not support guarded Windows database replacement (NTSTATUS 0x' + unsupported + ')');
    if (ready === 'PREFLIGHT') throw new Error('Guarded Windows replacement preflight failed');
    if (ready === 'LOCK') throw new Error('Cannot acquire the Windows repair lock; close other SQLite readers and writers');
    if (ready !== 'READY') throw new Error('Could not start the Windows repair guard');
  } catch (error) {
    await release(false);
    if ((error as NodeJS.ErrnoException).code === 'ABORT_ERR') throw new Error('Timed out acquiring the Windows repair lock', { cause: error });
    throw error;
  }
  return {
    async replace(from, to) {
      let reply: string | undefined;
      try { reply = await exchange({ from, to }); }
      catch (cause) { throw new WindowsReplacementUncertainError('Guarded Windows replacement could not be confirmed', { cause }); }
      if (reply === 'REPLACED') return;
      const status = /^FAILED ([0-9A-F]{8})$/.exec(reply ?? '')?.[1];
      if (status) throw new Error('Guarded Windows replacement failed (NTSTATUS 0x' + status + ')');
      throw new WindowsReplacementUncertainError('Guarded Windows replacement could not be confirmed');
    },
    release,
  };
}
