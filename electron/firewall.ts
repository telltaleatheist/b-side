/**
 * firewall — whether Windows lets other devices reach the hub, and the one act
 * that lets them.
 *
 * Sharing binds the hub to every address, and Windows Defender Firewall decides
 * what reaches it: the first bind raises Windows' own "allow access" prompt,
 * which ticks Private networks only, and a Cancel there writes a Block rule.
 * Either way a phone cannot connect and nothing in B-Sides said why. So the
 * settings page reads the rules for this program and the category of each
 * network this computer is on, and offers one button that (after Windows asks
 * for permission) removes this program's inbound Block rules and adds an Allow
 * rule for the hub's port on Private and Domain networks. Public networks stay
 * closed on purpose: a hub with no key there is open to everyone on that wifi.
 *
 * The rule is per program path; a per-user uninstall cannot remove it (no
 * administrator), and a rule for a program that is gone matches nothing.
 */
import { spawn } from 'node:child_process';

import { Refusal } from './refusal';
import type { FirewallView } from '../shared/api';

const RULE_NAME = 'B-Sides hub';
const READ_MS = 20_000;

/** Run a PowerShell script (UTF-16 base64, so nothing in it needs quoting); its stdout, or a refusal. */
function powershell(script: string, deadlineMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
      { windowsHide: true },
    );
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Refusal('firewall_unread', 'Windows took too long to say what its firewall allows. Try again.'));
    }, deadlineMs);
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Refusal('firewall_unread', `PowerShell could not start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(out).toString('utf8').trim());
      else reject(new Refusal('firewall_unread', Buffer.concat(err).toString('utf8').trim() || `PowerShell exited with ${code}.`));
    });
  });
}

/** A PowerShell single-quoted string. */
function quoted(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** What the firewall does with the hub's port, for this program; null off Windows. */
export async function firewallView(port: number): Promise<FirewallView | null> {
  if (process.platform !== 'win32') return null;
  const script = `
$ErrorActionPreference = 'Stop'
$program = ${quoted(process.execPath)}
$rules = @(Get-NetFirewallApplicationFilter -Program $program -ErrorAction SilentlyContinue |
  Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' } |
  ForEach-Object { @{ action = [string]$_.Action; profile = [string]$_.Profile } })
$networks = @(Get-NetConnectionProfile | ForEach-Object { @{ name = [string]$_.Name; category = [string]$_.NetworkCategory } })
@{ rules = $rules; networks = $networks } | ConvertTo-Json -Depth 4 -Compress
`;
  const read = JSON.parse(await powershell(script, READ_MS)) as {
    rules: Array<{ action: string; profile: string }> | null;
    networks: Array<{ name: string; category: string }> | null;
  };
  const rules = read.rules ?? [];
  const covers = (profile: string, kind: string): boolean => profile === 'Any' || profile.split(/,\s*/).includes(kind);
  const networks = (read.networks ?? []).map((network) => ({
    name: network.name,
    // Windows calls a domain network "DomainAuthenticated"; the rule profile calls it "Domain".
    kind: network.category === 'DomainAuthenticated' ? 'Domain' : network.category,
  }));
  // A Block rule wins over an Allow one. Windows' own prompt writes Block rules for the
  // network kinds left unticked, so only a Block that covers Private counts against it.
  const onPrivate = (action: string): boolean => rules.some((rule) => rule.action === action && covers(rule.profile, 'Private'));
  return {
    port,
    reachableOnPrivate: onPrivate('Allow') && !onPrivate('Block'),
    publicNetworks: networks.filter((network) => network.kind === 'Public').map((network) => network.name),
  };
}

/** Ask Windows (one permission prompt) to let other devices reach the hub's port on Private and Domain networks. */
export async function allowThroughFirewall(port: number): Promise<FirewallView | null> {
  if (process.platform !== 'win32') return null;
  const elevated = `
$ErrorActionPreference = 'Stop'
$program = ${quoted(process.execPath)}
Get-NetFirewallApplicationFilter -Program $program -ErrorAction SilentlyContinue | Get-NetFirewallRule |
  Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule
Get-NetFirewallRule -DisplayName ${quoted(RULE_NAME)} -ErrorAction SilentlyContinue | Remove-NetFirewallRule
New-NetFirewallRule -DisplayName ${quoted(RULE_NAME)} -Direction Inbound -Action Allow -Program $program -Protocol TCP -LocalPort ${port} -Profile Private,Domain | Out-Null
`;
  const encoded = Buffer.from(elevated, 'utf16le').toString('base64');
  // The elevated PowerShell is started by an ordinary one: Start-Process -Verb RunAs is what raises the prompt.
  const launcher = `
$ErrorActionPreference = 'Stop'
try {
  $run = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'
} catch {
  Write-Output 'declined'
  exit 0
}
Write-Output ("exit " + $run.ExitCode)
`;
  // No deadline worth having while a person reads the permission prompt; a long one so a hung prompt still ends.
  const said = await powershell(launcher, 10 * 60_000);
  if (said === 'declined') {
    throw new Refusal('firewall_declined', 'Windows did not get permission to change its firewall, so nothing changed.');
  }
  if (said !== 'exit 0') {
    throw new Refusal('firewall_unchanged', `Windows could not add the firewall rule (${said}).`);
  }
  // Success is what the firewall now says, not what the script returned.
  const view = await firewallView(port);
  if (view === null || !view.reachableOnPrivate) {
    throw new Refusal('firewall_unchanged', 'The firewall rule was added, but Windows still does not allow B-Sides on Private networks.');
  }
  return view;
}
