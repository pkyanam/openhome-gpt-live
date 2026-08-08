const apiKey = process.env.OPENHOME_API_KEY?.trim();
const command = process.argv[2]?.trim();

if (!apiKey) throw new Error("OPENHOME_API_KEY is required.");
if (!command) throw new Error("Usage: bun scripts/devkit-command.ts '<read-only command>'");

const socket = new WebSocket(
  `wss://app.openhome.com/ws/devkit/${encodeURIComponent(apiKey)}/`,
);
let commandSent = false;
let settled = false;

const timeout = setTimeout(() => finish(2, "DevKit command timed out."), 20_000);

socket.addEventListener("open", () => socket.send("frontend"));
socket.addEventListener("error", () => finish(3, "DevKit diagnostic connection failed."));
socket.addEventListener("message", (event) => {
  let message: Record<string, unknown>;
  try {
    message = JSON.parse(String(event.data)) as Record<string, unknown>;
  } catch {
    return;
  }

  if (message["device_status"] === "connected" && !commandSent) {
    commandSent = true;
    socket.send(JSON.stringify({ command: "exec_command", cmd: command }));
    return;
  }
  if (message["response"] !== "exec_command") return;

  const data = message["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) return;
  const frame = data as Record<string, unknown>;
  if (frame["type"] === "output" && typeof frame["result"] === "string") {
    process.stdout.write(frame["result"]);
    if (!frame["result"].endsWith("\n")) process.stdout.write("\n");
  } else if (frame["type"] === "completed") {
    finish(0);
  }
});

function finish(code: number, error?: string): void {
  if (settled) return;
  settled = true;
  clearTimeout(timeout);
  if (error) process.stderr.write(`${error}\n`);
  socket.close();
  setTimeout(() => process.exit(code), 50);
}
