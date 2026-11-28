import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';

// Paths are data on stdin, never PowerShell source. Keep inherited denies and
// the owner's existing rights; tightening a DACL must not grant write access.
const SCRIPT = String.raw`
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
  function Assert-Private($acl) {
    Check-Acl $acl
    foreach ($rule in $acl.GetAccessRules($true, $true, $sidType)) {
      if ($rule.AccessControlType -eq $allow -and -not (Trusted-Allow $rule)) { throw 'public allow remains' }
    }
  }
  function Rule-Key($rule) {
    return '{0}|{1}|{2}|{3}|{4}' -f $rule.IdentityReference.Value, $rule.AccessControlType,
      [int]$rule.FileSystemRights, [int]$rule.InheritanceFlags, [int]$rule.PropagationFlags
  }
  function Ace-Key($ace) {
    return '{0}|Allow|{1}|{2}|{3}' -f $ace.SecurityIdentifier.Value, [int]$ace.AccessMask,
      [int]$ace.InheritanceFlags, [int]$ace.PropagationFlags
  }
  function Rule-Keys($acl, $isContainer) {
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    $canonical = [Security.AccessControl.DiscretionaryAcl]::new($isContainer, $false, $raw.DiscretionaryAcl.Count)
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed) { continue }
      # AddAccess merges equivalent explicit ACEs across the entire ACL.
      $canonical.AddAccess($allow, $ace.SecurityIdentifier, $ace.AccessMask, $ace.InheritanceFlags, $ace.PropagationFlags)
    }
    $allowKeys = (@($canonical | ForEach-Object { Ace-Key $_ } | Sort-Object) -join ';')
    $denyKeys = (@($acl.GetAccessRules($true, $true, $sidType) | Where-Object { $_.AccessControlType -ne $allow } | ForEach-Object { Rule-Key $_ } | Sort-Object) -join ';')
    return (@($allowKeys, $denyKeys) | Where-Object { $_ -ne '' }) -join ';'
  }
  function Protect-Path($file) {
    $acl = Read-Acl $file
    Check-Acl $acl
    $owner = $acl.GetOwner($sidType).Value
    $isContainer = [IO.Directory]::Exists($file)
    $needsProtection = -not $acl.AreAccessRulesProtected
    if ($needsProtection) {
      $originalKeys = Rule-Keys $acl $isContainer
      $acl.SetAccessRuleProtection($true, $true)
      if ([IO.Directory]::Exists($file)) { [IO.Directory]::SetAccessControl($file, $acl) }
      else { [IO.File]::SetAccessControl($file, $acl) }
      $acl = Read-Acl $file
      Check-Acl $acl
      if (-not $acl.AreAccessRulesProtected -or $acl.GetOwner($sidType).Value -ne $owner) { throw 'ACL changed' }
      $protectedKeys = Rule-Keys $acl $isContainer
      if ($protectedKeys -ne $originalKeys) { throw 'rights changed' }
    }
    $changed = $false
    foreach ($rule in @($acl.GetAccessRules($true, $true, $sidType))) {
      if ($rule.AccessControlType -eq $allow -and -not (Trusted-Allow $rule)) {
        $acl.RemoveAccessRuleSpecific($rule)
        $changed = $true
      }
    }
    $expected = Rule-Keys $acl $isContainer
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
    $keys = Rule-Keys $actual $isContainer
    if ($keys -ne $expected) { throw 'rights changed' }
  }
  foreach ($file in $request.paths) {
    if ($request.readOnly) { Assert-Private (Read-Acl $file) }
    else { Protect-Path $file }
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
  if ($null -ne $request.messageDatabaseName) {
    # Discover the current files only after the directory has been protected.
    $name = $request.messageDatabaseName
    if ($name -eq '' -or $name -in @('.', '..') -or [IO.Path]::GetFileName($name) -cne $name) { throw 'invalid database name' }
    $files = @()
    foreach ($suffix in @('', '-wal', '-shm')) {
      $file = [IO.Path]::Combine($request.writableDirectory, $name + $suffix)
      try { $attributes = [IO.File]::GetAttributes($file) }
      catch {
        if ($_.Exception.GetBaseException() -is [IO.FileNotFoundException]) { continue }
        throw
      }
      # Leave every file untouched until Node can resolve these links using
      # the existing same-directory checks.
      if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        [Console]::Out.Write('{"ok":true,"requiresRealpath":true}')
        return
      }
      $files += $file
    }
    foreach ($file in $files) { Protect-Path $file }
    [Console]::Out.Write('{"ok":true,"requiresRealpath":false}')
    return
  }
  [Console]::Out.Write('{"ok":true}')
} catch {
  [Console]::Out.Write('{"ok":false}')
  exit 1
}
`;

/** Windows mode bits cannot establish privacy; verify the actual DACL. */
export function makeWindowsPathsPrivate(targets: string[], writableDirectory?: string, timeout?: number): void {
  runWindowsPermissionCheck(targets, writableDirectory, false, timeout);
}

/** Protect one message store; false means its files still need native realpath checks. */
export function makeWindowsMessageStorePrivate(file: string): boolean {
  const dir = path.dirname(file);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory, and messages must remain owner-private`);
  const directory = fs.realpathSync(dir);
  return !runWindowsPermissionScript({
    paths: [directory], writableDirectory: directory, readOnly: false, messageDatabaseName: path.basename(file),
  }).requiresRealpath;
}

/** Validate an existing Windows DACL without changing it or probing writes. */
export function verifyWindowsPathsPrivate(targets: string[], timeout?: number): void {
  runWindowsPermissionCheck(targets, undefined, true, timeout);
}

function runWindowsPermissionCheck(targets: string[], writableDirectory: string | undefined, readOnly: boolean, timeout?: number): void {
  const paths: string[] = [];
  for (const target of targets) {
    if (fs.statSync(target, { throwIfNoEntry: false }) !== undefined) paths.push(fs.realpathSync(target));
  }
  if (paths.length === 0 && writableDirectory === undefined) return;
  runWindowsPermissionScript({ paths: [...new Set(paths)], writableDirectory, readOnly }, timeout);
}

function runWindowsPermissionScript(
  request: { paths: string[]; writableDirectory?: string; readOnly: boolean; messageDatabaseName?: string }, timeout = 15_000,
): { requiresRealpath?: boolean } {
  const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
  try {
    if (!Number.isSafeInteger(timeout) || timeout <= 0) throw new Error('Invalid Windows permissions check timeout');
    if (!systemRoot || !path.win32.isAbsolute(systemRoot)) throw new Error('Windows system directory unavailable');
    const output = childProcess.execFileSync(
      path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SCRIPT, 'utf16le').toString('base64')],
      {
        input: Buffer.from(JSON.stringify(request)).toString('base64') + '\n',
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
        timeout, maxBuffer: 4096,
      },
    );
    const reply = JSON.parse(output.trim());
    if (reply?.ok !== true || (request.messageDatabaseName !== undefined && typeof reply.requiresRealpath !== 'boolean')) {
      throw new Error('ACL verification failed');
    }
    return reply;
  } catch (cause) {
    throw Object.assign(new Error('Cannot verify private Windows permissions; use a writable folder owned by your Windows account.', { cause }), { code: 'MEMESH_PRIVATE_PATH' });
  }
}
