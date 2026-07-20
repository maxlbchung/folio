// Finds the user's installed Claude Code, Codex, and OpenCode CLIs. The broker
// never installs anything: if a CLI is missing, the backend reports itself
// unavailable and the panel says so.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const WINDOWS = process.platform === "win32";

/** @typedef {{ command: string, prefixArgs: string[] }} CliLaunch */

const fromPath = (name) => {
  const probe = spawnSync(WINDOWS ? "where" : "which", [name], { encoding: "utf8", windowsHide: true });
  if (probe.status !== 0 || !probe.stdout) return [];
  return probe.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
};

/** Resolves an npm shim (claude.cmd / codex) to the real JS entry beside it,
 * so we can spawn `node entry.js` directly instead of shell-quoting a .cmd. */
const npmEntry = (shimPath, packagePath) => {
  const entry = join(dirname(shimPath), "node_modules", ...packagePath);
  return existsSync(entry) ? entry : null;
};

/** @returns {CliLaunch | null} */
const resolveCandidate = (candidate, packagePath, vendoredRelative) => {
  if (!existsSync(candidate)) return null;
  const base = (candidate.split(/[\\/]/).pop() ?? "").toLowerCase();
  const isWindowsShim = base.endsWith(".cmd") || base.endsWith(".bat") || base.endsWith(".ps1");
  if (isWindowsShim || !base.includes(".")) {
    // npm shims: prefer the package's real entry (vendored binary when it has
    // one, otherwise its JS entry under node) — never shell-quote a .cmd.
    const entry = npmEntry(candidate, packagePath);
    if (entry) {
      if (vendoredRelative) {
        const vendored = join(dirname(entry), ...vendoredRelative);
        if (existsSync(vendored)) return { command: vendored, prefixArgs: [] };
      }
      return { command: process.execPath, prefixArgs: [entry] };
    }
    // Extension-less on POSIX is a normal executable (native binary or shebang script).
    if (!WINDOWS && !isWindowsShim) return { command: candidate, prefixArgs: [] };
    return null;
  }
  return { command: candidate, prefixArgs: [] };
};

const findCli = (name, envOverride, extraCandidates, packagePath, vendoredRelative) => {
  const override = process.env[envOverride];
  const candidates = [
    ...(override ? [override] : []),
    ...fromPath(name),
    ...extraCandidates
  ];
  for (const candidate of candidates) {
    const resolved = resolveCandidate(candidate, packagePath, vendoredRelative);
    if (resolved) return resolved;
  }
  return null;
};

const home = homedir();

/** @returns {CliLaunch | null} */
export const findClaudeCli = () =>
  findCli(
    "claude",
    "INKTILE_CLAUDE_PATH",
    [
      join(home, ".local", "bin", WINDOWS ? "claude.exe" : "claude"),
      join(home, "AppData", "Roaming", "npm", "claude.cmd"),
      "/usr/local/bin/claude",
      "/opt/homebrew/bin/claude"
    ],
    ["@anthropic-ai", "claude-code", "cli.js"],
    null
  );

const CODEX_VENDOR_TRIPLES = {
  win32: ["..", "node_modules", "@openai", "codex-win32-x64", "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"],
  darwin: ["..", "node_modules", "@openai", process.arch === "arm64" ? "codex-darwin-arm64" : "codex-darwin-x64", "vendor", process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin", "bin", "codex"],
  linux: ["..", "node_modules", "@openai", process.arch === "arm64" ? "codex-linux-arm64" : "codex-linux-x64", "vendor", process.arch === "arm64" ? "aarch64-unknown-linux-musl" : "x86_64-unknown-linux-musl", "bin", "codex"]
};

/** @returns {CliLaunch | null} */
export const findCodexCli = () =>
  findCli(
    "codex",
    "INKTILE_CODEX_PATH",
    [
      join(home, "AppData", "Roaming", "npm", "codex.cmd"),
      join(home, ".local", "bin", WINDOWS ? "codex.exe" : "codex"),
      "/usr/local/bin/codex",
      "/opt/homebrew/bin/codex"
    ],
    ["@openai", "codex", "bin", "codex.js"],
    CODEX_VENDOR_TRIPLES[process.platform] ?? null
  );

/** npm installs (`opencode-ai`) hoist the platform binary as a sibling package
 * of the launcher script: node_modules/opencode-<os>-<arch>/bin/opencode. */
const OPENCODE_VENDOR_PACKAGE = {
  win32: "opencode-windows-x64",
  darwin: process.arch === "arm64" ? "opencode-darwin-arm64" : "opencode-darwin-x64",
  linux: process.arch === "arm64" ? "opencode-linux-arm64" : "opencode-linux-x64"
}[process.platform];

/** @returns {CliLaunch | null} */
export const findOpencodeCli = () =>
  findCli(
    "opencode",
    "INKTILE_OPENCODE_PATH",
    [
      // The official install script drops the binary in ~/.opencode/bin.
      join(home, ".opencode", "bin", WINDOWS ? "opencode.exe" : "opencode"),
      join(home, "AppData", "Roaming", "npm", "opencode.cmd"),
      join(home, ".local", "bin", WINDOWS ? "opencode.exe" : "opencode"),
      "/usr/local/bin/opencode",
      "/opt/homebrew/bin/opencode"
    ],
    ["opencode-ai", "bin", "opencode"],
    OPENCODE_VENDOR_PACKAGE
      ? ["..", "..", OPENCODE_VENDOR_PACKAGE, "bin", WINDOWS ? "opencode.exe" : "opencode"]
      : null
  );

export const claudeAvailability = () => {
  const cli = findClaudeCli();
  if (!cli) return { available: false, detail: "The claude CLI was not found. Install Claude Code and log in once." };
  const loggedIn = existsSync(join(home, ".claude", ".credentials.json")) || existsSync(join(home, ".claude.json")) || Boolean(process.env.ANTHROPIC_API_KEY);
  if (!loggedIn) return { available: false, detail: "The claude CLI is installed but no login was found — run claude once and log in." };
  return { available: true, detail: "Using your existing Claude Code login." };
};

export const codexAvailability = () => {
  const cli = findCodexCli();
  if (!cli) return { available: false, detail: "The codex CLI was not found. Install Codex and run codex login once." };
  const loggedIn = existsSync(join(home, ".codex", "auth.json")) || Boolean(process.env.OPENAI_API_KEY);
  if (!loggedIn) return { available: false, detail: "The codex CLI is installed but no login was found — run codex login once." };
  return { available: true, detail: "Using your existing Codex login." };
};

export const opencodeAvailability = () => {
  const cli = findOpencodeCli();
  if (!cli) return { available: false, detail: "The opencode CLI was not found. Install OpenCode and run opencode auth login once." };
  // opencode stores provider credentials under its data dir on every platform;
  // provider API keys in the environment work without a stored login.
  const dataHome = process.env.XDG_DATA_HOME || join(home, ".local", "share");
  const loggedIn = existsSync(join(dataHome, "opencode", "auth.json"))
    || Boolean(process.env.ANTHROPIC_API_KEY || process.env.OPENAI_API_KEY || process.env.OPENROUTER_API_KEY);
  if (!loggedIn) return { available: false, detail: "The opencode CLI is installed but no login was found — run opencode auth login once." };
  return { available: true, detail: "Using your existing OpenCode login." };
};
