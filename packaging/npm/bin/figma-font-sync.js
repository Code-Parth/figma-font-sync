#!/usr/bin/env node
// Runs the native figma-font-sync binary from the @figma-font-sync/<os>-<arch> package npm installed as an
// optional dependency. CommonJS and dependency-free so it runs on any Node npm still supports.
"use strict";

const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { constants } = require("node:os");
const path = require("node:path");

const MAIN = "figma-font-sync";
const SCOPE = "@figma-font-sync";

/** process.platform/process.arch to the platform package suffix and the binary's file name. */
const PLATFORMS = {
  "darwin/arm64": { suffix: "darwin-arm64", exe: "figma-font-sync" },
  "darwin/x64": { suffix: "darwin-x64", exe: "figma-font-sync" },
  "win32/x64": { suffix: "windows-x64", exe: "figma-font-sync.exe" },
  "linux/x64": { suffix: "linux-x64", exe: "figma-font-sync" },
};

const SUPPORTED = "macOS arm64, macOS x64, Windows x64 and Linux x64 (glibc)";

function fail(lines) {
  process.stderr.write(`${MAIN}: ${lines.join("\n")}\n`);
  process.exit(1);
}

function ownVersion() {
  return require(path.join(__dirname, "..", "package.json")).version;
}

/** Bun builds only against glibc; Node reports glibcVersionRuntime only when it runs on glibc. */
function isMusl() {
  if (!process.report || typeof process.report.getReport !== "function") return false;
  let report = process.report.getReport();
  if (typeof report === "string") report = JSON.parse(report);
  return !(report && report.header && report.header.glibcVersionRuntime);
}

function platformBinary(version) {
  const platform = PLATFORMS[`${process.platform}/${process.arch}`];
  if (!platform) {
    fail([
      `there is no build for ${process.platform} ${process.arch}.`,
      `Supported: ${SUPPORTED}.`,
    ]);
  }
  if (process.platform === "linux" && isMusl()) {
    fail([
      "this Linux uses musl libc (Alpine and similar). Only glibc builds exist.",
      `Supported: ${SUPPORTED}.`,
    ]);
  }

  const pkg = `${SCOPE}/${platform.suffix}`;
  let manifest;
  try {
    manifest = require.resolve(`${pkg}/package.json`);
  } catch {
    fail([
      `the package ${pkg} is missing. It holds the binary for this platform and is an optional dependency`,
      `of ${MAIN}, so npm skips it with --omit=optional, --no-optional or omit=optional in .npmrc.`,
      "Reinstall without that option:",
      `  npm i -g ${MAIN}@${version}`,
    ]);
  }

  const platformVersion = require(manifest).version;
  if (platformVersion !== version) {
    fail([
      `${pkg} is ${platformVersion} but ${MAIN} is ${version}. Reinstall so they match:`,
      `  npm i -g ${MAIN}@${version}`,
    ]);
  }

  const binary = path.join(path.dirname(manifest), "bin", platform.exe);
  if (!existsSync(binary)) {
    fail([`${binary} is missing. Reinstall:`, `  npm i -g ${MAIN}@${version}`]);
  }
  return binary;
}

function main() {
  const override = process.env.FIGMA_FONT_SYNC_BINARY;
  const binary = override || platformBinary(ownVersion());

  const child = spawn(binary, process.argv.slice(2), { stdio: "inherit" });
  child.on("error", (error) => {
    fail([`could not run ${binary}: ${error.message}`]);
  });

  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, () => {
      // Windows sends Ctrl+C to every process on the console, the child included, and child.kill there is
      // TerminateProcess, which would skip the helper's shutdown. Staying alive until it exits is enough.
      if (process.platform === "win32") return;
      // A terminal Ctrl+C reaches the whole process group; kill or a supervisor signals only this pid.
      child.kill(signal);
    });
  }

  child.on("exit", (code, signal) => {
    if (signal) {
      process.removeAllListeners(signal);
      // An ignored signal (Node ignores SIGPIPE) does not end this process, so leave the shell's exit code too.
      process.exitCode = 128 + (constants.signals[signal] || 0);
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code === null ? 1 : code);
  });
}

main();
