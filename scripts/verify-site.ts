import { access, readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..", "site");
const required = ["index.html", "styles.css", "script.js", "devkit-hero.png", "og.png", "robots.txt", "sitemap.xml"];
for (const file of required) await access(resolve(root, file));

const html = await readFile(resolve(root, "index.html"), "utf8");
const css = await readFile(resolve(root, "styles.css"), "utf8");
const script = await readFile(resolve(root, "script.js"), "utf8");
if (/TODO|PLACEHOLDER/i.test(`${html}\n${css}\n${script}`)) throw new Error("Site contains placeholder text.");
if (!html.includes("devkit-hero.png") || !html.includes("og.png")) throw new Error("Generated DevKit assets are not wired into the site.");
if (!html.includes("id=\"setup\"") || !html.includes("id=\"architecture\"") || !html.includes("id=\"faq\"")) throw new Error("Core documentation anchors are missing.");
if (!script.includes("installModes") || !script.includes("navigator.clipboard")) throw new Error("Interactive setup controls are missing.");

for (const image of ["devkit-hero.png", "og.png"]) {
  const details = await stat(resolve(root, image));
  if (details.size < 100_000 || details.size > 3_000_000) throw new Error(`${image} has an unexpected size.`);
}

console.log("GitHub Pages site assets and interactions are present.");
