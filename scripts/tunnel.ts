import { execFileSync, spawn, spawnSync } from "node:child_process";
import { chmod, mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { dirname, resolve } from "node:path";

type TunnelState = {
  mode: "cloudflare" | "quick";
  hostname: string;
  tunnelId?: string;
  tunnelName?: string;
  configPath?: string;
  pid?: number;
};

const projectRoot = resolve(import.meta.dir, "..");
const dataDirectory = resolve(projectRoot, "data");
const statePath = resolve(dataDirectory, "cloudflare-tunnel.json");
const configPath = resolve(dataDirectory, "cloudflared.yml");
const action = process.argv[2] ?? "help";
const args = parseArgs(process.argv.slice(3));

if (action === "help" || action === "--help" || action === "-h" || args.help) {
  printHelp();
  process.exit(0);
}
if (!commandPath("cloudflared")) {
  throw new Error("cloudflared is not installed. See https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/");
}

if (action === "setup") await setupNamedTunnel();
else if (action === "quick") await startQuickTunnel();
else if (action === "status") await showStatus();
else if (action === "uninstall") await uninstallService();
else throw new TypeError(`Unknown tunnel action: ${action}. Run bun run tunnel -- --help.`);

async function setupNamedTunnel(): Promise<void> {
  const hostname = normalizedHostname(args.hostname ?? "");
  const tunnelName = normalizedTunnelName(args.name ?? "openhome-gpt-live");
  const nonInteractive = args.nonInteractive;
  if (!hostname) throw new TypeError("--hostname is required for a persistent Cloudflare Tunnel.");

  let tunnels = listTunnels();
  if (!tunnels) {
    if (nonInteractive) {
      throw new Error("Cloudflare login is required. Run `cloudflared tunnel login` interactively, then retry.");
    }
    console.log("Cloudflare authorization is required. Your browser will open; choose the account and domain for this speaker.\n");
    run("cloudflared", ["tunnel", "login"], true);
    tunnels = listTunnels();
    if (!tunnels) throw new Error("Cloudflare login did not complete.");
  }

  let tunnel = tunnels.find((entry) => entry.name === tunnelName);
  if (!tunnel) {
    console.log(`Creating Cloudflare Tunnel ${tunnelName}…`);
    run("cloudflared", ["tunnel", "create", tunnelName], true);
    tunnel = listTunnels()?.find((entry) => entry.name === tunnelName);
  }
  if (!tunnel?.id) throw new Error(`Could not resolve Cloudflare Tunnel ${tunnelName}.`);

  const credentialPath = resolve(homedir(), ".cloudflared", `${tunnel.id}.json`);
  await requireFile(credentialPath, "tunnel credentials");
  const previous = await readState();
  if (!(previous?.mode === "cloudflare" && previous.tunnelId === tunnel.id && previous.hostname === hostname)) {
    console.log(`Routing ${hostname} to the tunnel…`);
    run("cloudflared", ["tunnel", "route", "dns", tunnel.id, hostname], true);
  }

  await mkdir(dataDirectory, { recursive: true });
  await writePrivate(configPath, [
    `tunnel: ${tunnel.id}`,
    `credentials-file: ${credentialPath}`,
    "no-autoupdate: true",
    "ingress:",
    `  - hostname: ${hostname}`,
    "    service: http://127.0.0.1:3000",
    "  - service: http_status:404",
    "",
  ].join("\n"));
  run("cloudflared", ["tunnel", "--config", configPath, "ingress", "validate"], true);
  await writeState({ mode: "cloudflare", hostname, tunnelId: tunnel.id, tunnelName, configPath });
  await installService(tunnel.id);
  console.log(`\nPersistent Cloudflare Tunnel ready: https://${hostname}`);
  console.log("It is linked to your Cloudflare account and managed by a user service.");
}

async function startQuickTunnel(): Promise<void> {
  const existing = await readState();
  if (existing?.mode === "quick" && existing.pid && processIsAlive(existing.pid) && existing.hostname) {
    console.log(JSON.stringify({ url: `https://${existing.hostname}`, reused: true }));
    return;
  }

  await mkdir(dataDirectory, { recursive: true });
  const logPath = resolve(dataDirectory, "quick-tunnel.log");
  const log = await open(logPath, "a", 0o600);
  const child = spawn(commandPath("cloudflared")!, ["tunnel", "--url", "http://127.0.0.1:3000", "--no-autoupdate"], {
    cwd: projectRoot,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
  });
  child.unref();
  await log.close();

  const deadline = Date.now() + 25_000;
  let hostname = "";
  while (Date.now() < deadline) {
    const source = await readFile(logPath, "utf8").catch(() => "");
    hostname = /https:\/\/([a-z0-9-]+\.trycloudflare\.com)/i.exec(source)?.[1] ?? "";
    if (hostname) break;
    await Bun.sleep(500);
  }
  if (!hostname) {
    if (child.pid) process.kill(child.pid, "SIGTERM");
    throw new Error(`Quick Tunnel did not return a URL. Inspect ${logPath}.`);
  }
  await writeState({ mode: "quick", hostname, pid: child.pid });
  console.log(JSON.stringify({ url: `https://${hostname}`, reused: false }));
}

async function showStatus(): Promise<void> {
  const state = await readState();
  if (!state) {
    console.log("No repository-managed Cloudflare tunnel is configured.");
    return;
  }
  if (state.mode === "quick") {
    console.log(`Quick Tunnel: ${state.hostname}`);
    console.log(`Process: ${state.pid && processIsAlive(state.pid) ? "running" : "stopped"}`);
    console.log("Quick Tunnel URLs are temporary and can change after restart.");
    return;
  }
  console.log(`Named Tunnel: ${state.tunnelName}`);
  console.log(`Public host: ${state.hostname}`);
  console.log(`Service: ${serviceIsActive() ? "active" : "inactive"}`);
  const info = spawnSync("cloudflared", ["tunnel", "info", state.tunnelId!], { encoding: "utf8" });
  console.log(`Cloudflare connector: ${info.status === 0 ? "reachable" : "not connected"}`);
}

async function installService(tunnelId: string): Promise<void> {
  const executable = commandPath("cloudflared")!;
  if (platform() === "darwin") {
    const label = "com.openhome.gpt-live-tunnel";
    const launchAgents = resolve(homedir(), "Library", "LaunchAgents");
    const plist = resolve(launchAgents, `${label}.plist`);
    const domain = `gui/${userInfo().uid}`;
    await mkdir(launchAgents, { recursive: true });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${escapeXml(executable)}</string><string>tunnel</string><string>--config</string><string>${escapeXml(configPath)}</string><string>run</string><string>${tunnelId}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>5</integer>
<key>StandardOutPath</key><string>${escapeXml(resolve(dataDirectory, "cloudflared.log"))}</string>
<key>StandardErrorPath</key><string>${escapeXml(resolve(dataDirectory, "cloudflared-error.log"))}</string>
</dict></plist>\n`;
    await writePrivate(plist, xml);
    spawnSync("launchctl", ["bootout", domain, plist], { stdio: "ignore" });
    execFileSync("launchctl", ["bootstrap", domain, plist], { stdio: "inherit" });
    execFileSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "inherit" });
    return;
  }
  if (platform() === "linux") {
    const unitDirectory = resolve(homedir(), ".config", "systemd", "user");
    const unit = resolve(unitDirectory, "openhome-gpt-live-tunnel.service");
    await mkdir(unitDirectory, { recursive: true });
    await writePrivate(unit, `[Unit]\nDescription=OpenHome GPT Live Cloudflare Tunnel\nAfter=network-online.target\nWants=network-online.target\n\n[Service]\nExecStart=${systemdPath(executable)} tunnel --config ${systemdPath(configPath)} run ${tunnelId}\nRestart=always\nRestartSec=5\n\n[Install]\nWantedBy=default.target\n`);
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", "openhome-gpt-live-tunnel.service"], { stdio: "inherit" });
    return;
  }
  throw new Error("Persistent tunnel services support macOS and Linux.");
}

async function uninstallService(): Promise<void> {
  if (platform() === "darwin") {
    const label = "com.openhome.gpt-live-tunnel";
    const plist = resolve(homedir(), "Library", "LaunchAgents", `${label}.plist`);
    spawnSync("launchctl", ["bootout", `gui/${userInfo().uid}`, plist], { stdio: "ignore" });
    console.log("Stopped the OpenHome tunnel launch agent. The Cloudflare tunnel and DNS record were preserved.");
    return;
  }
  if (platform() === "linux") {
    spawnSync("systemctl", ["--user", "disable", "--now", "openhome-gpt-live-tunnel.service"], { stdio: "ignore" });
    console.log("Stopped the OpenHome tunnel user service. The Cloudflare tunnel and DNS record were preserved.");
    return;
  }
}

function listTunnels(): Array<{ id: string; name: string }> | undefined {
  const result = spawnSync("cloudflared", ["tunnel", "list", "--output", "json"], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as Array<{ id?: string; name?: string }>;
    return parsed.filter((entry): entry is { id: string; name: string } => Boolean(entry.id && entry.name));
  } catch {
    return undefined;
  }
}

function run(command: string, commandArgs: string[], inherited = false): void {
  const result = spawnSync(command, commandArgs, { encoding: inherited ? undefined : "utf8", stdio: inherited ? "inherit" : "pipe" });
  if (result.status !== 0) throw new Error(`${command} ${commandArgs.join(" ")} failed.`);
}

function commandPath(name: string): string | undefined {
  const result = spawnSync("/usr/bin/env", ["which", name], { encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

function parseArgs(values: string[]): { hostname?: string; name?: string; nonInteractive: boolean; help: boolean } {
  const parsed = { nonInteractive: false, help: false } as { hostname?: string; name?: string; nonInteractive: boolean; help: boolean };
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index]!;
    if (value === "--non-interactive") parsed.nonInteractive = true;
    else if (value === "--help" || value === "-h") parsed.help = true;
    else if (value.startsWith("--hostname=")) parsed.hostname = value.slice(11);
    else if (value === "--hostname") parsed.hostname = values[++index];
    else if (value.startsWith("--name=")) parsed.name = value.slice(7);
    else if (value === "--name") parsed.name = values[++index];
    else throw new TypeError(`Unknown tunnel option: ${value}`);
  }
  return parsed;
}

function normalizedHostname(value: string): string {
  const hostname = value.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (!hostname || !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(hostname)) {
    throw new TypeError("Enter a DNS hostname such as voice.example.com.");
  }
  return hostname;
}

function normalizedTunnelName(value: string): string {
  const name = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(name)) throw new TypeError("Tunnel name must use letters, numbers, hyphens, or underscores.");
  return name;
}

async function requireFile(path: string, label: string): Promise<void> {
  try { await readFile(path); } catch { throw new Error(`Cloudflare ${label} were not found at ${path}.`); }
}

async function writePrivate(path: string, body: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, body, { encoding: "utf8", mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, path);
}

async function readState(): Promise<TunnelState | undefined> {
  try { return JSON.parse(await readFile(statePath, "utf8")) as TunnelState; } catch { return undefined; }
}

async function writeState(state: TunnelState): Promise<void> {
  await writePrivate(statePath, `${JSON.stringify(state, null, 2)}\n`);
}

function processIsAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function serviceIsActive(): boolean {
  if (platform() === "darwin") return spawnSync("launchctl", ["print", `gui/${userInfo().uid}/com.openhome.gpt-live-tunnel`]).status === 0;
  if (platform() === "linux") return spawnSync("systemctl", ["--user", "is-active", "--quiet", "openhome-gpt-live-tunnel.service"]).status === 0;
  return false;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function systemdPath(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}

function printHelp(): void {
  console.log(`OpenHome GPT Live tunnel helper

Usage:
  bun run tunnel -- setup --hostname voice.example.com [--name openhome-gpt-live]
  bun run tunnel -- quick
  bun run tunnel -- status
  bun run tunnel -- uninstall

setup       Create or reuse an account-linked named tunnel, route DNS, and
            install a persistent user service. Cloudflare login may open a browser.
quick       Start a temporary background Quick Tunnel and print its JSON URL.
status      Show redacted tunnel and service status.
uninstall   Stop only the repository-managed service; preserve tunnel and DNS.

Options:
  --hostname HOST       Public hostname for persistent setup
  --name NAME           Named tunnel to create or reuse (default: openhome-gpt-live)
  --non-interactive     Never open Cloudflare login; fail with the required action
  -h, --help            Show this help
`);
}
