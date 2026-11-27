import fs from 'fs';
import childProcess from 'node:child_process';
import path from 'node:path';
import { expect } from 'vitest';

type WindowsAcl = { self: string; admin: boolean; owner: string; nullDacl: boolean; protected: boolean; rules: { sid: string; type: string; rights: number; inherit: number; propagation: number }[] };

const WINDOWS_ACL_FIXTURE = String.raw`
$ErrorActionPreference = 'Stop'
$null = Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::ASCII, $false, 1024, $false)
$frame = $reader.ReadLine()
if ([string]::IsNullOrWhiteSpace($frame)) { throw 'missing stdin frame' }
$r = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($frame)) | ConvertFrom-Json
$self = [Security.Principal.WindowsIdentity]::GetCurrent().User
$admin = ([Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$acl = if ([IO.Directory]::Exists($r.file)) { [IO.Directory]::GetAccessControl($r.file) } else { [IO.File]::GetAccessControl($r.file) }
switch ($r.action) {
  'public' {
    $acl.SetAccessRuleProtection($true, $true)
    $everyone = [Security.Principal.SecurityIdentifier]::new('S-1-1-0')
    if ([IO.Directory]::Exists($r.file)) {
      $acl.AddAccessRule(([Security.AccessControl.FileSystemAccessRule]::new($everyone, [Security.AccessControl.FileSystemRights]::Read,
        ([Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit),
        [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)))
    } else {
      $acl.AddAccessRule(([Security.AccessControl.FileSystemAccessRule]::new($everyone, [Security.AccessControl.FileSystemRights]::Read, [Security.AccessControl.AccessControlType]::Allow)))
    }
  }
  'deny' { $acl.AddAccessRule(([Security.AccessControl.FileSystemAccessRule]::new($self, [Security.AccessControl.FileSystemRights]::Write, [Security.AccessControl.AccessControlType]::Deny))) }
  'restore' {
    foreach ($rule in @($acl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {
      if ($rule.IdentityReference.Value -eq $self.Value -and $rule.AccessControlType -eq [Security.AccessControl.AccessControlType]::Deny) { $acl.RemoveAccessRuleSpecific($rule) }
    }
  }
}
if ($r.action -in @('deny-read', 'restore-read')) {
  $directory = [IO.Directory]::Exists($r.file)
  $rights = if ($directory) { [Security.AccessControl.FileSystemRights]::ListDirectory -bor [Security.AccessControl.FileSystemRights]::Traverse } else { [Security.AccessControl.FileSystemRights]::ReadData }
  $inherit = if ($directory) { [Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [Security.AccessControl.InheritanceFlags]::ObjectInherit } else { [Security.AccessControl.InheritanceFlags]::None }
  $rule = [Security.AccessControl.FileSystemAccessRule]::new($self, $rights, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Deny)
  if ($r.action -eq 'deny-read') { $acl.AddAccessRule($rule) }
  else { $acl.RemoveAccessRuleSpecific($rule) }
}
if ($r.action -ne 'read') {
  if ([IO.Directory]::Exists($r.file)) { [IO.Directory]::SetAccessControl($r.file, $acl) }
  else { [IO.File]::SetAccessControl($r.file, $acl) }
  $acl = if ([IO.Directory]::Exists($r.file)) { [IO.Directory]::GetAccessControl($r.file) } else { [IO.File]::GetAccessControl($r.file) }
}
$raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
@{ self = $self.Value; admin = $admin; owner = $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value; nullDacl = $null -eq $raw.DiscretionaryAcl; protected = $acl.AreAccessRulesProtected; rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]) | ForEach-Object {
  @{ sid = $_.IdentityReference.Value; type = $_.AccessControlType.ToString(); rights = [int]$_.FileSystemRights; inherit = [int]$_.InheritanceFlags; propagation = [int]$_.PropagationFlags }
}) } | ConvertTo-Json -Depth 3 -Compress
`;

export function windowsAclFixture(file: string, action: 'public' | 'deny' | 'restore' | 'read' | 'deny-read' | 'restore-read'): WindowsAcl {
  return JSON.parse(childProcess.execFileSync(path.win32.join(process.env.SystemRoot ?? process.env.SYSTEMROOT!, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WINDOWS_ACL_FIXTURE, 'utf16le').toString('base64')],
    { input: Buffer.from(JSON.stringify({ file, action })).toString('base64') + '\n', encoding: 'utf8', windowsHide: true, timeout: 15_000 }));
}

export function readWindowsAcl(file: string): WindowsAcl {
  return windowsAclFixture(file, 'read');
}

export function makeWindowsAclPublic(file: string): WindowsAcl {
  return windowsAclFixture(file, 'public');
}

function expectWindowsPrivate(file: string): void {
  const acl = readWindowsAcl(file);
  const trusted = (rule: WindowsAcl['rules'][number]) => rule.sid === acl.self || rule.sid === 'S-1-5-18' || rule.sid === 'S-1-5-32-544'
    || rule.sid === 'S-1-3-4' || (rule.sid === 'S-1-3-0' && (rule.propagation & 2) !== 0);
  expect(acl.nullDacl).toBe(false);
  expect(acl.owner === acl.self || (acl.admin && acl.owner === 'S-1-5-32-544')).toBe(true);
  for (const rule of acl.rules) if (rule.type === 'Allow') expect(trusted(rule)).toBe(true);
}

export function expectPrivateDir(dirPath: string): void {
  const stats = fs.statSync(dirPath);
  expect(stats.isDirectory()).toBe(true);

  if (process.platform === 'win32') {
    expectWindowsPrivate(dirPath);
    return;
  }

  expect(stats.mode & 0o777).toBe(0o700);
}

export function expectPrivateFile(filePath: string): void {
  const stats = fs.statSync(filePath);
  expect(stats.isFile()).toBe(true);

  if (process.platform === 'win32') {
    expectWindowsPrivate(filePath);
    return;
  }

  expect(stats.mode & 0o777).toBe(0o600);
}

/**
 * Whether this environment can actually make a path unreadable.
 *
 * A test that needs a real EACCES has to ask, because two common environments
 * cannot produce one however the mode bits are set: root ignores them, and
 * Windows does not model POSIX read or traversal permission at all — a
 * `chmod` there leaves the directory readable, so the code under test takes
 * its success path and the assertion fails on a platform difference rather
 * than on the behaviour it was written to pin.
 *
 * Measured: `tests/hooks/stop-notes.test.ts` guarded only the root half, and
 * both windows-latest legs of the #333 matrix failed with `expected 'wrote'
 * to be 'error'` — the hook had read the directory the test believed it had
 * locked. Every other leg passed.
 *
 * Skip on this rather than weaken the assertion: the branch stays genuinely
 * covered where an EACCES is real, instead of everywhere and vacuously.
 */
export const canDenyReads = process.platform !== 'win32' && (process.getuid?.() ?? 0) !== 0;
