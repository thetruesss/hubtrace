import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SRC = path.join(ROOT, "VC");
const DIST = path.join(ROOT, "dist");

const TARGETS = {
  chrome: { out: "chrome-mv3", manifest: forChrome },
  firefox: { out: "firefox-mv3", manifest: forFirefox }
};

function forChrome(manifest) {
  const next = { ...manifest };
  delete next.key;
  delete next.browser_specific_settings;
  return next;
}

function forFirefox(manifest) {
  const next = { ...manifest };
  delete next.key;
  next.background = { scripts: [manifest.background.service_worker] };
  return next;
}

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.name === "manifest.json") continue;
    if (entry.isDirectory()) copyTree(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

function build(name) {
  const target = TARGETS[name];
  if (!target) throw new Error(`Неизвестная цель сборки: ${name}`);

  const out = path.join(DIST, target.out);
  fs.rmSync(out, { recursive: true, force: true });
  copyTree(SRC, out);

  const manifest = JSON.parse(fs.readFileSync(path.join(SRC, "manifest.json"), "utf8"));
  const built = target.manifest(manifest);
  if ("key" in built) throw new Error("В собранном манифесте остался key");
  fs.writeFileSync(path.join(out, "manifest.json"), `${JSON.stringify(built, null, 2)}\n`, "utf8");

  console.log(`${name}: ${path.relative(ROOT, out)} (v${built.version})`);
}

build(process.argv[2] || "chrome");
