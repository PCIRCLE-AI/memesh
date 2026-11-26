// Diagnostic preload for the Windows entry-point gate. It keeps gate assertions and timeouts unchanged.
import childProcess from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncBuiltinESMExports } from 'node:module';
import { buildIsolatedSuiteEnv } from './lib/isolated-env.mjs';

const self = import.meta.url;
const here = path.dirname(fileURLToPath(self));
const selfFile = fileURLToPath(self);
const gate = path.join(here, 'check-entry-points-start.mjs');
const messages = path.join(here, 'hooks', 'messages.js');
const childFlag = 'MEMESH_WINDOWS_MESSAGES_ENTRY_DIAG';
const prefix = 'MEMESH_WINDOWS_MESSAGES_PHASE ';
const phases = new Set(['stdin-read-begin', 'stdin-read-end', 'stdin-read-error', 'powershell-begin', 'powershell-end', 'powershell-error', 'powershell-instrumentation-missing', 'ps-entry', 'ps-stdin-open', 'ps-stdin-reader', 'ps-stdin-read', 'ps-stdin-read-done', 'ps-decode', 'ps-decode-done', 'ps-identity', 'ps-identity-done', 'ps-acl-get', 'ps-acl-get-done', 'ps-acl-protect-set', 'ps-acl-protect-set-done', 'ps-acl-protect-read', 'ps-acl-protect-read-done', 'ps-acl-set', 'ps-acl-set-done', 'ps-acl-readback', 'ps-acl-readback-done', 'ps-probe', 'ps-probe-done', 'ps-done', 'ps-error', 'ps-acl-shape', 'ps-reason-missing-stdin-frame', 'ps-reason-path-changed', 'ps-reason-foreign-owner', 'ps-reason-null-dacl', 'ps-reason-unsupported-ace', 'ps-reason-acl-changed', 'ps-reason-public-allow-remains', 'ps-reason-rights-changed', 'ps-reason-native-exception', 'register-begin', 'register-end', 'register-error', 'hook-batch-begin', 'hook-batch-end', 'hook-batch-error', 'close-begin', 'close-end', 'close-error']);
const same = (value, expected) => typeof value === 'string' && path.resolve(value) === expected;
const emit = (phase, started) => process.stderr.write(`${prefix}${JSON.stringify({ phase, elapsedMs: Date.now() - started })}\n`);
export const traceScript = (encoded) => {
  if (typeof encoded !== 'string') return null;
  let script;
  try { script = Buffer.from(encoded, 'base64').toString('utf16le'); } catch { return null; }
  const anchors = ["$ErrorActionPreference = 'Stop'", '$frame = $reader.ReadLine()', "$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($frame)) | ConvertFrom-Json", '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()', 'foreach ($file in $request.paths) {', '$acl = Read-Acl $file', 'if ($changed) {', '$actual = Read-Acl $file', 'if ($request.writableDirectory) {', "[Console]::Out.Write('{\"ok\":true}')"];
  if (!anchors.every(anchor => script.includes(anchor))) return null;
  const trace = String.raw`$script:TraceClock = [Diagnostics.Stopwatch]::StartNew()
function Trace-Phase($phase) { try { if ($env:MEMESH_WINDOWS_MESSAGES_PHASE_FILE) { [IO.File]::AppendAllText($env:MEMESH_WINDOWS_MESSAGES_PHASE_FILE, $phase + ' ' + $script:TraceClock.ElapsedMilliseconds + [Environment]::NewLine, [Text.Encoding]::ASCII) } } catch {} }
function Trace-Reason($reason) { Trace-Phase ('ps-reason-' + $reason) }
function Trace-AclShape($side, $keys) {
  try {
    $total = 0; $parts = [Collections.Generic.List[string]]::new()
    foreach ($key in @($keys -split ';')) {
      $rule = $key -split '\|', 5
      if ($rule.Count -ne 5) { continue }
      $total++
      if ($parts.Count -lt 16) {
        $sid = $rule[0]
        $class = if ($sid -eq $self) { 'self' } elseif ($sid -eq 'S-1-5-18') { 'system' } elseif ($sid -eq 'S-1-5-32-544') { 'admin' } elseif ($sid -eq 'S-1-3-0') { 'creator-owner' } elseif ($sid -eq 'S-1-3-4') { 'owner-rights' } else { 'other' }
        $type = if ($rule[1] -eq 'Allow') { 'allow' } elseif ($rule[1] -eq 'Deny') { 'deny' } else { continue }
        $parts.Add(($class + ',' + $type + ',' + $rule[2] + ',' + $rule[3] + ',' + $rule[4]))
      }
    }
    if ($env:MEMESH_WINDOWS_MESSAGES_PHASE_FILE) { [IO.File]::AppendAllText($env:MEMESH_WINDOWS_MESSAGES_PHASE_FILE, ('shape ' + $script:TraceClock.ElapsedMilliseconds + ' ' + $side + ',' + $total + ',' + ($parts -join '|') + [Environment]::NewLine), [Text.Encoding]::ASCII) }
  } catch {}
}
`;
  script = trace + script.replace('try {', "try {\n  Trace-Phase 'ps-entry'")
    .replace('$reader = [IO.StreamReader]::new', "Trace-Phase 'ps-stdin-open'\n  $reader = [IO.StreamReader]::new")
    .replace('$frame = $reader.ReadLine()', "Trace-Phase 'ps-stdin-reader'\n  Trace-Phase 'ps-stdin-read'\n  $frame = $reader.ReadLine()\n  Trace-Phase 'ps-stdin-read-done'")
    .replace('$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($frame)) | ConvertFrom-Json', "Trace-Phase 'ps-decode'\n  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($frame)) | ConvertFrom-Json\n  Trace-Phase 'ps-decode-done'")
    .replace('$identity = [Security.Principal.WindowsIdentity]::GetCurrent()', "Trace-Phase 'ps-identity'\n  $identity = [Security.Principal.WindowsIdentity]::GetCurrent()\n  Trace-Phase 'ps-identity-done'")
    .replace('$acl = Read-Acl $file', "Trace-Phase 'ps-acl-get'\n    $acl = Read-Acl $file\n    Trace-Phase 'ps-acl-get-done'")
    .replace("$originalKeys = (@($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { Rule-Key $_ } | Sort-Object) -join ';')\n      $acl.SetAccessRuleProtection($true, $true)", "$originalKeys = (@($acl.GetAccessRules($true, $true, $sidType) | ForEach-Object { Rule-Key $_ } | Sort-Object) -join ';')\n      Trace-Phase 'ps-acl-protect-set'\n      $acl.SetAccessRuleProtection($true, $true)")
    .replace('else { [IO.File]::SetAccessControl($file, $acl) }\n      $acl = Read-Acl $file', "else { [IO.File]::SetAccessControl($file, $acl) }\n      Trace-Phase 'ps-acl-protect-set-done'\n      Trace-Phase 'ps-acl-protect-read'\n      $acl = Read-Acl $file\n      Trace-Phase 'ps-acl-protect-read-done'")
    .replace("if ($protectedKeys -ne $originalKeys) { throw 'rights changed' }", "if ($protectedKeys -ne $originalKeys) { Trace-AclShape 'expected' $originalKeys; Trace-AclShape 'actual' $protectedKeys; throw 'rights changed' }")
    .replace('if ($changed) {\n      if ([IO.Directory]::Exists($file))', "if ($changed) {\n      Trace-Phase 'ps-acl-set'\n      if ([IO.Directory]::Exists($file))")
    .replace("else { [IO.File]::SetAccessControl($file, $acl) }\n    }", "else { [IO.File]::SetAccessControl($file, $acl) }\n      Trace-Phase 'ps-acl-set-done'\n    }")
    .replace('$actual = Read-Acl $file', "Trace-Phase 'ps-acl-readback'\n    $actual = Read-Acl $file\n    Trace-Phase 'ps-acl-readback-done'")
    .replace('$probe = [IO.Path]::Combine', "Trace-Phase 'ps-probe'\n    $probe = [IO.Path]::Combine")
    .replace("} finally { if ($null -ne $stream) { $stream.Dispose() } }\n  }\n  [Console]", "} finally { if ($null -ne $stream) { $stream.Dispose() } }\n    Trace-Phase 'ps-probe-done'\n  }\n  Trace-Phase 'ps-done'\n  [Console]")
    .replace("if ($keys -ne $expected) { throw 'rights changed' }", "if ($keys -ne $expected) { Trace-AclShape 'expected' $expected; Trace-AclShape 'actual' $keys; throw 'rights changed' }")
    .replace("} catch {\n  [Console]", "} catch {\n  $message = $_.Exception.Message\n  Trace-Phase 'ps-error'\n  $reason = switch ($message) { 'missing stdin frame' { 'missing-stdin-frame'; break } 'path changed' { 'path-changed'; break } 'foreign owner' { 'foreign-owner'; break } 'null DACL' { 'null-dacl'; break } 'unsupported ACE' { 'unsupported-ace'; break } 'ACL changed' { 'acl-changed'; break } 'public allow remains' { 'public-allow-remains'; break } 'rights changed' { 'rights-changed'; break } default { 'native-exception' } }\n  Trace-Reason $reason\n  [Console]");
  return Buffer.from(script, 'utf16le').toString('base64');
};

export function parseTraceLine(line) {
  const phase = /^([a-z-]+) ([0-9]{1,8})$/.exec(line);
  if (phase && phases.has(phase[1])) return { phase: phase[1], elapsedMs: Number(phase[2]) };
  const shape = /^shape ([0-9]{1,8}) (expected|actual),([0-9]{1,4}),(.*)$/.exec(line);
  if (!shape) return null;
  const rules = shape[4] === '' ? [] : shape[4].split('|').map(rule => {
    const match = /^(self|system|admin|creator-owner|owner-rights|other),(allow|deny),(-?(?:0|[1-9][0-9]{0,9})),([0-3]),([0-3])$/.exec(rule);
    return match && { subject: match[1], type: match[2], rights: Number(match[3]), inherit: Number(match[4]), propagation: Number(match[5]) };
  });
  if (rules.length !== Math.min(Number(shape[3]), 16) || rules.some(rule => !rule || rule.rights < -2147483648 || rule.rights > 2147483647)) return null;
  return { phase: 'ps-acl-shape', elapsedMs: Number(shape[1]), side: shape[2], total: Number(shape[3]), rules };
}

function controlScript(kind) {
  const open = "$reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::ASCII, $false, 1024, $false)\n  $frame = $reader.ReadLine()";
  const decode = "$json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($frame))";
  const parsed = "$request = $json | ConvertFrom-Json";
  let body;
  if (kind === 'literal') body = "$request = ConvertFrom-Json -InputObject '{\"value\":\"a\"}'";
  else if (kind === 'decode') body = `${open}\n  ${decode}\n  if ($json -ne '{"value":"a"}') { throw 'unexpected data' }\n  $request = [PSCustomObject]@{ value = 'a' }`;
  else if (kind === 'core') body = "$request = [PSCustomObject]@{ value = (Write-Output 'a') }";
  else if (kind === 'explicit-import') body = "$null = Import-Module -Name ([IO.Path]::Combine($PSHOME, 'Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1')) -ErrorAction Stop\n  $request = ConvertFrom-Json -InputObject '{\"value\":\"a\"}'";
  else body = `${open}\n  ${decode}\n  ${parsed}`;
  return `$ErrorActionPreference = 'Stop'\ntry {\n  ${body}\n  if ($request.value -ne 'a') { throw 'unexpected value' }\n  [Console]::Out.Write('OK')\n} catch {\n  [Console]::Out.Write('ERR:' + $_.Exception.GetType().Name)\n  exit 1\n}`;
}

function runControls() {
  if (process.platform !== 'win32') return;
  const cases = [
    ['A-literal-input-object', 'literal'], ['B-framed-dotnet-decode', 'decode'], ['C-framed-pipeline', 'pipeline'],
    ['I-core-write-output', 'core'], ['J-literal-private-analysis-cache', 'literal'], ['K-literal-explicit-utility-import', 'explicit-import'],
  ];
  for (const [name, kind] of cases) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'memesh-ps-control-'));
    try {
      try { fs.chmodSync(home, 0o700); } catch {}
      const env = buildIsolatedSuiteEnv(process.env, { runtimeHome: home });
      const systemRoot = env.SystemRoot ?? env.SYSTEMROOT;
      if (!systemRoot) {
        process.stdout.write(`${JSON.stringify({ case: name, exit: null, timeout: false, ms: 0, result: 'exception:SystemRootUnavailable' })}\n`);
        continue;
      }
      if (name.startsWith('J-')) env.PSModuleAnalysisCachePath = path.join(home, 'ModuleAnalysisCache');
      const script = controlScript(kind);
      const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
      const input = ['literal', 'core', 'explicit-import'].includes(kind) ? undefined : `${Buffer.from(JSON.stringify({ value: 'a' })).toString('base64')}\n`;
      const started = Date.now();
      const result = childProcess.spawnSync(path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args, { env, input, encoding: 'utf8', timeout: 2500, windowsHide: true });
      const timeout = result.error?.code === 'ETIMEDOUT';
      const output = typeof result.stdout === 'string' ? result.stdout.trim() : '';
      const ok = !timeout && result.status === 0 && output === 'OK';
      const exception = /^ERR:([A-Za-z][A-Za-z0-9]{0,79})$/.exec(output)?.[1] ?? 'Unknown';
      const detail = ok ? 'ok' : timeout ? 'timeout' : `exception:${exception}`;
      process.stdout.write(`${JSON.stringify({ case: name, exit: result.status ?? null, timeout, ms: Date.now() - started, result: detail })}\n`);
    } finally {
      try { fs.rmSync(home, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); } catch {}
    }
  }
}

function runDirectController() {
  const result = childProcess.spawnSync(process.execPath, ['--import', self, gate], { encoding: 'utf8', timeout: 90000 });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  runControls();
  process.exitCode = result.status ?? 1;
}

if (same(process.argv[1], selfFile)) {
  runDirectController();
} else if (process.env[childFlag] === 'child' && same(process.argv[1], messages)) {
  const started = Date.now();
  const read = fs.readFileSync;
  fs.readFileSync = function tracedRead(file, ...args) {
    if (file !== 0) return read.call(this, file, ...args);
    emit('stdin-read-begin', started);
    try { const result = read.call(this, file, ...args); emit('stdin-read-end', started); return result; }
    catch (error) { emit('stdin-read-error', started); throw error; }
  };
  const exec = childProcess.execFileSync;
  childProcess.execFileSync = function tracedExec(command, ...args) {
    if (path.win32.basename(String(command)).toLowerCase() !== 'powershell.exe') return exec.call(this, command, ...args);
    emit('powershell-begin', started);
    const [argv, ...rest] = args;
    const index = Array.isArray(argv) ? argv.indexOf('-EncodedCommand') : -1;
    const traced = index >= 0 ? traceScript(argv[index + 1]) : null;
    if (!traced) emit('powershell-instrumentation-missing', started);
    try { const result = exec.call(this, command, ...(traced ? [[...argv.slice(0, index + 1), traced, ...argv.slice(index + 2)], ...rest] : args)); emit('powershell-end', started); return result; }
    catch (error) { emit('powershell-error', started); throw error; }
  };
  syncBuiltinESMExports();
  const { ConversationMessages } = await import(new URL('./hooks/_generated/conversation-messages.js', import.meta.url));
  for (const [method, label] of [['register', 'register'], ['hookBatch', 'hook-batch'], ['close', 'close']]) {
    const original = ConversationMessages.prototype[method];
    ConversationMessages.prototype[method] = function tracedMethod(...args) {
      emit(`${label}-begin`, started);
      try { const result = original.apply(this, args); emit(`${label}-end`, started); return result; }
      catch (error) { emit(`${label}-error`, started); throw error; }
    };
  }
} else if (same(process.argv[1], gate)) {
  const spawn = childProcess.spawn;
  childProcess.spawn = function tracedSpawn(command, args, options) {
    if (command !== process.execPath || !Array.isArray(args) || !same(args[0], messages)) return spawn.call(this, command, args, options);
    const baseEnv = options?.env ?? process.env;
    let traceFile;
    try {
      const candidatePath = path.join(baseEnv.HOME, `.memesh-windows-phase-${process.pid}-${Date.now()}`);
      fs.writeFileSync(candidatePath, '', { mode: 0o600, flag: 'wx' });
      traceFile = candidatePath;
    } catch { /* trace must not change the gate */ }
    const env = { ...baseEnv, [childFlag]: 'child', ...(traceFile ? { MEMESH_WINDOWS_MESSAGES_PHASE_FILE: traceFile } : {}), NODE_OPTIONS: `${baseEnv.NODE_OPTIONS ?? ''} --import=${self}`.trim() };
    let child;
    try { child = spawn.call(this, command, args, { ...options, env }); } catch (error) { if (traceFile) try { fs.rmSync(traceFile, { force: true }); } catch {} throw error; }
    let pending = '';
    const forward = (line) => {
      if (!line.startsWith(prefix)) return;
      try {
        const value = JSON.parse(line.slice(prefix.length));
        if (Object.keys(value).every(key => key === 'phase' || key === 'elapsedMs') && phases.has(value.phase) && Number.isInteger(value.elapsedMs) && value.elapsedMs >= 0) process.stderr.write(`${prefix}${JSON.stringify(value)}\n`);
      } catch { /* diagnostic data is untrusted child stderr */ }
    };
    child.stderr?.on('data', chunk => { pending += chunk; let newline; while ((newline = pending.indexOf('\n')) >= 0) { forward(pending.slice(0, newline)); pending = pending.slice(newline + 1); } });
    child.stderr?.once('end', () => forward(pending));
    child.once('exit', () => {
      try {
        for (const line of fs.readFileSync(traceFile, 'utf8').split(/\r?\n/)) {
          const value = parseTraceLine(line);
          if (value) process.stderr.write(`${prefix}${JSON.stringify(value)}\n`);
        }
      } catch { /* trace must not change the gate */ }
      finally { if (traceFile) try { fs.rmSync(traceFile, { force: true }); } catch {} }
    });
    return child;
  };
  syncBuiltinESMExports();
}
