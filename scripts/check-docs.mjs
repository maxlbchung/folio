import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "README.md",
  "AGENTS.md",
  "docs/ARCHITECTURE.md",
  "docs/FILE_FORMAT.md",
  "docs/PRODUCT_INVARIANTS.md",
  "docs/TESTING_AND_RELEASE.md",
  "skills/inktile-app/SKILL.md",
  "skills/inktile-app/agents/openai.yaml"
];

const failures = [];
for (const path of required) {
  if (!existsSync(join(root, path))) failures.push(`Missing required handoff file: ${path}`);
}

function markdownFiles(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? markdownFiles(path) : extname(path) === ".md" ? [path] : [];
  });
}

const files = [join(root, "README.md"), join(root, "AGENTS.md"), ...markdownFiles(join(root, "docs")), ...markdownFiles(join(root, "skills"))]
  .filter((path, index, items) => existsSync(path) && items.indexOf(path) === index);
const linkPattern = /\[[^\]]*\]\(([^)]+)\)/g;

for (const file of files) {
  const source = readFileSync(file, "utf8");
  for (const match of source.matchAll(linkPattern)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || /^(?:[a-z]+:|#)/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split("#", 1)[0]);
    if (!existsSync(resolve(dirname(file), target))) {
      failures.push(`${file.slice(root.length + 1)}: broken local link ${raw}`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}

console.log(`Documentation checks passed (${files.length} Markdown files).`);
