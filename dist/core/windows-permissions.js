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
  function Ace-Key($ace) {
    return '{0}|Allow|{1}|{2}|{3}' -f $ace.SecurityIdentifier.Value, [int]$ace.AccessMask,
      [int]$ace.InheritanceFlags, [int]$ace.PropagationFlags
  }
  function Rule-Keys($acl, $isContainer) {
    $raw = [Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
    $allows = [Security.AccessControl.RawAcl]::new($raw.DiscretionaryAcl.Revision, 0)
    foreach ($ace in $raw.DiscretionaryAcl) {
      if ($ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed) { continue }
      $copy = $ace.Copy()
      $copy.AceFlags = [Security.AccessControl.AceFlags](([int]$copy.AceFlags) -band (-bnot [int][Security.AccessControl.AceFlags]::Inherited))
      $allows.InsertAce($allows.Count, $copy)
    }
    $canonical = [Security.AccessControl.DiscretionaryAcl]::new($isContainer, $false, $allows)
    if (-not $canonical.IsCanonical) { throw 'rights changed' }
    $allowKeys = (@($canonical | ForEach-Object { Ace-Key $_ } | Sort-Object) -join ';')
    $denyKeys = (@($acl.GetAccessRules($true, $true, $sidType) | Where-Object { $_.AccessControlType -ne $allow } | ForEach-Object { Rule-Key $_ } | Sort-Object) -join ';')
    return (@($allowKeys, $denyKeys) | Where-Object { $_ -ne '' }) -join ';'
  }
  foreach ($file in $request.paths) {
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
//# sourceMappingURL=windows-permissions.js.map