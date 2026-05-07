const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const requiredFiles = [
  "index.html",
  "styles.css",
  "app.js",
  "library-import.js",
  "server.js",
  "package.json",
  "manifest.webmanifest",
  "sw.js",
  "icon.svg",
  "apple-touch-icon.png",
  "icon-512.png",
  "render.yaml",
  "railway.json",
  "Dockerfile",
  ".env.example",
  ".gitignore",
  ".dockerignore",
  "README.md",
  "DEPLOYMENT.md",
];

const missing = requiredFiles.filter((file) => !fs.existsSync(path.join(root, file)));
if (missing.length) {
  console.error(`Missing required files: ${missing.join(", ")}`);
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.webmanifest"), "utf8"));
if (!manifest.name || !manifest.start_url || !manifest.icons?.length) {
  console.error("manifest.webmanifest is missing name, start_url, or icons.");
  process.exit(1);
}

const manifestIconSources = manifest.icons.map((icon) => icon.src).join("\n");
if (!manifestIconSources.includes("apple-touch-icon.png") || !manifestIconSources.includes("icon-512.png")) {
  console.error("manifest.webmanifest should include PNG icons for iOS and install prompts.");
  process.exit(1);
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
if (!packageJson.scripts?.start || !packageJson.engines?.node) {
  console.error("package.json needs scripts.start and engines.node for deployment.");
  process.exit(1);
}

const gitignore = fs.readFileSync(path.join(root, ".gitignore"), "utf8");
if (!gitignore.includes(".env") || !gitignore.includes("server.log")) {
  console.error(".gitignore should ignore .env and server.log.");
  process.exit(1);
}

const envExample = fs.readFileSync(path.join(root, ".env.example"), "utf8");
if (!envExample.includes("AMAP_KEY") || !envExample.includes("OPENAI_API_KEY") || !envExample.includes("PORT")) {
  console.error(".env.example should document AMAP_KEY, OPENAI_API_KEY, and PORT.");
  process.exit(1);
}

const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
if (!indexHtml.includes("importLibraryBtn") || !indexHtml.includes("library-import.js") || !indexHtml.includes("library-backup-2")) {
  console.error("index.html should expose the JSON import control and current asset version.");
  process.exit(1);
}

if (!indexHtml.includes("apple-mobile-web-app-capable") || !indexHtml.includes("apple-touch-icon.png")) {
  console.error("index.html should include iOS home-screen metadata.");
  process.exit(1);
}

if (indexHtml.includes("2026-05-01")) {
  console.error("index.html should not hard-code an expired trip date.");
  process.exit(1);
}

console.log("Preflight ok: deployment files are present.");
