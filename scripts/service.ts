import { execFileSync, spawnSync } from "node:child_process";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, platform, userInfo } from "node:os";
import { resolve } from "node:path";

const action = process.argv[2] ?? "status";
const projectRoot = resolve(import.meta.dir, "..");
const bun = process.execPath;
const serviceName = "openhome-gpt-live";

if (!['install', 'status', 'uninstall'].includes(action)) {
  console.error("Usage: bun scripts/service.ts <install|status|uninstall>");
  process.exit(1);
}

if (platform() === "darwin") {
  await macService(action);
} else if (platform() === "linux") {
  await linuxService(action);
} else {
  throw new Error("Automatic service installation currently supports macOS and Linux.");
}

async function macService(requested: string): Promise<void> {
  const label = "com.openhome.gpt-live";
  const launchAgents = resolve(homedir(), "Library", "LaunchAgents");
  const plist = resolve(launchAgents, `${label}.plist`);
  const domain = `gui/${userInfo().uid}`;

  if (requested === "install") {
    await mkdir(launchAgents, { recursive: true });
    await mkdir(resolve(projectRoot, "data"), { recursive: true });
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${escapeXml(bun)}</string><string>src/server.ts</string></array>
  <key>WorkingDirectory</key><string>${escapeXml(projectRoot)}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${escapeXml(resolve(projectRoot, "data", "server.log"))}</string>
  <key>StandardErrorPath</key><string>${escapeXml(resolve(projectRoot, "data", "server-error.log"))}</string>
</dict>
</plist>
`;
    await writeFile(plist, xml, { encoding: "utf8", mode: 0o600 });
    await chmod(plist, 0o600);
    spawnSync("launchctl", ["bootout", domain, plist], { stdio: "ignore" });
    execFileSync("launchctl", ["bootstrap", domain, plist], { stdio: "inherit" });
    execFileSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "inherit" });
    console.log(`Installed and started ${label}.`);
    return;
  }
  if (requested === "uninstall") {
    spawnSync("launchctl", ["bootout", domain, plist], { stdio: "ignore" });
    await rm(plist, { force: true });
    console.log(`Removed ${label}. Project data was kept.`);
    return;
  }
  const status = spawnSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" });
  console.log(status.status === 0 ? `${label} is loaded.` : `${label} is not loaded.`);
  if (status.status !== 0) process.exitCode = 1;
}

async function linuxService(requested: string): Promise<void> {
  const unitDirectory = resolve(homedir(), ".config", "systemd", "user");
  const unit = resolve(unitDirectory, `${serviceName}.service`);
  if (requested === "install") {
    await mkdir(unitDirectory, { recursive: true });
    await mkdir(resolve(projectRoot, "data"), { recursive: true });
    const source = `[Unit]
Description=OpenHome GPT Live bridge
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=${systemdPath(projectRoot)}
ExecStart=${systemdPath(bun)} src/server.ts
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
`;
    await writeFile(unit, source, { encoding: "utf8", mode: 0o600 });
    await chmod(unit, 0o600);
    execFileSync("systemctl", ["--user", "daemon-reload"], { stdio: "inherit" });
    execFileSync("systemctl", ["--user", "enable", "--now", `${serviceName}.service`], { stdio: "inherit" });
    console.log(`Installed and started ${serviceName}.service.`);
    return;
  }
  if (requested === "uninstall") {
    spawnSync("systemctl", ["--user", "disable", "--now", `${serviceName}.service`], { stdio: "ignore" });
    await rm(unit, { force: true });
    spawnSync("systemctl", ["--user", "daemon-reload"], { stdio: "ignore" });
    console.log(`Removed ${serviceName}.service. Project data was kept.`);
    return;
  }
  const status = spawnSync("systemctl", ["--user", "is-active", "--quiet", `${serviceName}.service`]);
  console.log(status.status === 0 ? `${serviceName}.service is active.` : `${serviceName}.service is not active.`);
  if (status.status !== 0) process.exitCode = 1;
}

function escapeXml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function systemdPath(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll(" ", "\\x20");
}
