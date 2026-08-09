const installModes = {
  guided: {
    number: "PATH 01",
    title: "Interactive, recommended",
    description: "Detect what is already configured, choose from four HTTPS modes, and hand off only the account and dashboard steps.",
    code: "curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | bash",
    points: ["Interactive prompts", "Idempotent updates", "Guided pairing"],
  },
  cloudflare: {
    number: "PATH 02",
    title: "Persistent Cloudflare Tunnel",
    description: "Create or reuse a named tunnel linked to your Cloudflare account, route your DNS hostname, validate ingress, and install a user service.",
    code: "curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | bash -s -- \\\n  --tunnel cloudflare --hostname voice.example.com",
    points: ["Account linked", "Starts on boot", "Safe to rerun"],
  },
  existing: {
    number: "PATH 03",
    title: "Bring your own HTTPS",
    description: "Keep an existing reverse proxy or tunnel. The bridge continues to listen only on loopback while your stable origin handles TLS.",
    code: "curl -fsSL https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/install.sh | bash -s -- \\\n  --tunnel existing --public-url https://voice.example.com",
    points: ["Proxy agnostic", "Loopback origin", "Production stable"],
  },
  agent: {
    number: "PATH 04",
    title: "Hand it to a local agent",
    description: "A concise repository skill teaches Codex or another local agent the guarded end-to-end workflow and its human-only handoffs.",
    code: "Read and follow https://raw.githubusercontent.com/pkyanam/openhome-gpt-live/main/skills/openhome-gpt-live/SKILL.md.\nSet up OpenHome GPT Live on this computer; do safe machine steps and pause only for the skill's human-only handoffs.",
    points: ["Codex plugin-ready", "Deterministic helpers", "Short prompt"],
  },
};

const tabs = document.querySelectorAll(".mode-tab");
const modeNumber = document.querySelector("#mode-number");
const modeTitle = document.querySelector("#mode-title");
const modeDescription = document.querySelector("#mode-description");
const installCode = document.querySelector("#install-code");
const modePoints = document.querySelector("#mode-points");

tabs.forEach((tab) => tab.addEventListener("click", () => {
  const mode = installModes[tab.dataset.mode];
  tabs.forEach((item) => {
    const selected = item === tab;
    item.classList.toggle("active", selected);
    item.setAttribute("aria-selected", String(selected));
  });
  modeNumber.textContent = mode.number;
  modeTitle.textContent = mode.title;
  modeDescription.textContent = mode.description;
  installCode.textContent = mode.code;
  modePoints.replaceChildren(...mode.points.map((point) => {
    const item = document.createElement("span");
    item.textContent = point;
    return item;
  }));
}));

const toast = document.querySelector(".toast");
let toastTimer;
document.querySelectorAll("[data-copy]").forEach((button) => {
  button.addEventListener("click", async () => {
    const group = button.closest("[data-copy-group]");
    const source = group?.querySelector("code")?.textContent?.trim() ?? "";
    if (!source) return;
    await navigator.clipboard.writeText(source);
    button.textContent = "Copied";
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.classList.remove("show");
      button.textContent = "Copy";
    }, 1600);
  });
});

const voiceLines = {
  Arbor: "Grounded and composed",
  Breeze: "Light and open",
  Cove: "Calm and centered",
  Ember: "Bright and energetic",
  Juniper: "Crisp and familiar",
  Maple: "Friendly and rounded",
  Sol: "Clear and optimistic",
  Spruce: "Steady and thoughtful",
  Vale: "Warm and direct",
};

const wakeNameInput = document.querySelector("#wake-name");

function renderVoiceLine() {
  const voice = document.querySelector("#selected-voice").textContent;
  const wakeName = wakeNameInput.value.trim() || "Juniper";
  document.querySelector("#voice-line").textContent = `${voiceLines[voice]}, ready when you say “${wakeName}.”`;
}

document.querySelectorAll("[data-voice]").forEach((button) => button.addEventListener("click", () => {
  document.querySelectorAll("[data-voice]").forEach((item) => item.classList.toggle("active", item === button));
  const voice = button.dataset.voice;
  document.querySelector("#selected-voice").textContent = voice;
  renderVoiceLine();
}));

wakeNameInput.addEventListener("input", renderVoiceLine);

const revealItems = document.querySelectorAll(".reveal");
if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  revealItems.forEach((item) => item.classList.add("visible"));
} else {
  const observer = new IntersectionObserver((entries) => entries.forEach((entry) => {
    if (entry.isIntersecting) {
      entry.target.classList.add("visible");
      observer.unobserve(entry.target);
    }
  }), { threshold: .12 });
  revealItems.forEach((item) => observer.observe(item));
}
