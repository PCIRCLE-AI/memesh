// ============================================================================
// AUTO-GENERATED from src/core/windows-permissions.ts — DO NOT EDIT BY HAND.
// Regenerate with: npm run build  (scripts/generate-hook-core.mjs)
//
// Claude Code hooks import this committed copy instead of dist/, so the
// always-on capture path survives a missing or stale dist/ while staying
// byte-locked to core — eliminating the hand-mirror drift behind the P0 FTS bug.
// ============================================================================
import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
const SCRIPT = String.raw `
$ErrorActionPreference = 'Stop'
try {
  $null = Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop
  $reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::ASCII, $false, 1024, $false)
  $frame = $reader.ReadLine()
  if ([string]::IsNullOrWhiteSpace($frame)) { throw 'missing stdin frame' }
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($frame)) | ConvertFrom-Json
  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  $self = $identity.User.Value
  $admin = ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
  $sidType = [Security.Principal.SecurityIdentifier]
  $allow = [Security.AccessControl.AccessControlType]::Allow
  function Read-Acl($file) {
    $attributes = [IO.File]::GetAttributes($file)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'path changed' }
    if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) { return [IO.Directory]::GetAccessControl($file) }
    return [IO.File]::GetAccessControl($file)
  }
  function Check-Acl($acl) {
    $owner = $acl.GetOwner($sidType).Value
    if ($owner -ne $self -and -not ($admin -and $owner -eq 'S-1-5-32-544')) { throw 'foreign owner' }
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    if ($null -eq $raw.DiscretionaryAcl) { throw 'null DACL' }
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or
          ($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -and
           $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessDenied)) { throw 'unsupported ACE' }
    }
  }
  function Trusted-Allow($rule) {
    $sid = $rule.IdentityReference.Value
    return $sid -in @($self, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-4') -or
      ($sid -eq 'S-1-3-0' -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0)
  }
  function Rule-Key($rule) {
    return '{0}|{1}|{2}|{3}|{4}' -f $rule.IdentityReference.Value, $rule.AccessControlType,
      [int]$rule.FileSystemRights, [int]$rule.InheritanceFlags, [int]$rule.PropagationFlags
  }
  foreach ($file in $request.paths) {
    $acl = Read-Acl $file
    Check-Acl $acl
    $owner = $acl.GetOwner($sidType).Value
    $needsProtection = -not $acl.AreAccessRulesProtected
    if ($needsProtection) {
      $originalKeys = (@($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { Rule-Key $_ } | Sort-Object) -join ';')
      $acl.SetAccessRuleProtection($true, $true)
      if ([IO.Directory]::Exists($file)) { [IO.Directory]::SetAccessControl($file, $acl) }
      else { [IO.File]::SetAccessControl($file, $acl) }
      $acl = Read-Acl $file
      Check-Acl $acl
      if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner($sidType).Value -ne $owner) { throw 'ACL changed' }
      $protectedKeys = (@($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { Rule-Key $_ } | Sort-Object) -join ';')
      if ($protectedKeys -ne $originalKeys) { throw 'rights changed' }
    }
    $changed = $false
    foreach ($rule in @($acl.GetAccessRules($true, $true, $sidType))) {
      if ($rule.AccessControlType -eq $allow -and -not (Trusted-Allow $rule)) {
        $acl.RemoveAccessRuleSpecific($rule)
        $changed = $true
      }
    }
    $expected = (@($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { Rule-Key $_ } | Sort-Object) -join ';')
    if ($changed) {
      if ([IO.Directory]::Exists($file)) { [IO.Directory]::SetAccessControl($file, $acl) }
      else { [IO.File]::SetAccessControl($file, $acl) }
    }
    $actual = Read-Acl $file
    Check-Acl $actual
    if (-not $actual.AreAccessRulesProtected -or $actual.GetOwner($sidType).Value -ne $owner) { throw 'ACL changed' }
    foreach ($rule in $actual.GetAccessRules($true, $true, $sidType)) {
      if ($rule.AccessControlType -eq $allow -and -not (Trusted-Allow $rule)) { throw 'public allow remains' }
    }
    $keys = (@($actual.GetAccessRules($true, $true, $sidType) | ForEach-Object { Rule-Key $_ } | Sort-Object) -join ';')
    if ($keys -ne $expected) { throw 'rights changed' }
  }
  if ($request.writableDirectory) {
    $probe = [IO.Path]::Combine($request.writableDirectory, '.memesh-write-' + [Guid]::NewGuid().ToString('N'))
    $stream = $null
    try {
      $stream = [IO.FileStream]::new($probe, [IO.FileMode]::CreateNew, [IO.FileAccess]::ReadWrite,
        ([IO.FileShare]::ReadWrite -bor [IO.FileShare]::Delete), 4096, [IO.FileOptions]::DeleteOnClose)
      $stream.WriteByte(0)
    } finally { if ($null -ne $stream) { $stream.Dispose() } }
  }
  [Console]::Out.Write('{"ok":true}')
} catch {
  [Console]::Out.Write('{"ok":false}')
  exit 1
}
`;
export function makeWindowsPathsPrivate(targets, writableDirectory) {
    const paths = [];
    for (const target of targets) {
        if (fs.statSync(target, { throwIfNoEntry: false }) !== undefined)
            paths.push(fs.realpathSync(target));
    }
    if (paths.length === 0 && writableDirectory === undefined)
        return;
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    try {
        if (!systemRoot || !path.win32.isAbsolute(systemRoot))
            throw new Error('Windows system directory unavailable');
        const output = childProcess.execFileSync(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')], {
            input: Buffer.from(JSON.stringify({ paths: [...new Set(paths)], writableDirectory })).toString('base64') + '\n',
            encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
            timeout: 15_000, maxBuffer: 4096,
        });
        if (JSON.parse(output.trim()).ok !== true)
            throw new Error('ACL verification failed');
    }
    catch (cause) {
        throw Object.assign(new Error('Cannot verify private Windows permissions; use a writable folder owned by your Windows account.', { cause }), { code: 'MEMESH_PRIVATE_PATH' });
    }
}
