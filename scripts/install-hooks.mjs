import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dryRun = process.argv.includes("--dry-run");
const hook = resolve(root, ".githooks", "pre-commit");

if (!existsSync(hook)) {
  console.error("Missing .githooks/pre-commit.");
  process.exit(1);
}

if (dryRun) {
  console.log("Hook installer dry run passed; would set core.hooksPath to .githooks.");
  process.exit(0);
}

const repository = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
if (repository.status !== 0) {
  console.error("This checkout is not a usable Git repository. Run again from a complete clone.");
  process.exit(1);
}

const result = spawnSync("git", ["-C", root, "config", "core.hooksPath", ".githooks"], { stdio: "inherit" });
if (result.status !== 0) process.exit(result.status ?? 1);

console.log("Installed tracked Git hooks from .githooks.");
