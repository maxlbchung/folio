// Small child-process helpers shared by both CLI backends.

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

/** Async iterator over a stream's lines. */
export const lineReader = (stream) => createInterface({ input: stream, crlfDelay: Infinity });

/** Collects the last ~4KB of a stream; returns a reader for it. */
export const tail = (stream) => {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffer = (buffer + chunk).slice(-4096);
  });
  return () => buffer;
};

/** Resolves with the child's exit code, safe against the event having already fired. */
export const waitForExit = (child) =>
  new Promise((resolve) => {
    if (child.exitCode !== null) resolve(child.exitCode);
    else child.on("close", resolve);
  });

/** Kills a CLI child and everything it spawned (the CLIs fork workers). */
export const killTree = (child) => {
  if (child.exitCode !== null || child.signalCode) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    child.kill("SIGTERM");
  }
};
