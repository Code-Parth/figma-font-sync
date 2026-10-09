import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { CommandResult } from "../../src/install/run";
import { createAutostartWith, launchAgentPlist, systemdUnitFile, windowsArg } from "../../src/service/autostart";
import { fakeRunner, ok, type RecordedCall } from "../install/support";

let home: string;

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), "font-sync-autostart-"));
});

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

const fail = (stderr = "failed"): CommandResult => ({ code: 1, stdout: "", stderr });

function deps(respond?: (call: RecordedCall) => CommandResult) {
  const runner = fakeRunner(respond);
  const sleeps: number[] = [];
  return {
    runner,
    sleeps,
    deps: {
      run: runner.run,
      uid: () => 501,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
    },
  };
}

async function exists(file: string): Promise<boolean> {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

describe("darwin LaunchAgent", () => {
  const plistPath = () => path.join(home, "Library", "LaunchAgents", "com.apexialabs.font-sync.plist");

  it("writes the plist, boots out the old job and bootstraps the new one", async () => {
    const { runner, deps: d } = deps((call) => (call.argv[1] === "bootout" ? fail("not loaded") : ok()));
    const autostart = createAutostartWith("darwin", home, {}, d);
    await autostart.enable(["/Applications/Font Sync/font-sync", "serve"]);

    const plist = await readFile(plistPath(), "utf8");
    expect(plist).toContain("<string>com.apexialabs.font-sync</string>");
    expect(plist).toContain("<string>/Applications/Font Sync/font-sync</string>\n    <string>serve</string>");
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    const log = path.join(home, "Library", "Logs", "font-sync.log");
    expect(plist).toContain(`<key>StandardOutPath</key>\n  <string>${log}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n  <string>${log}</string>`);
    expect(await exists(path.join(home, "Library", "Logs"))).toBe(true);

    expect(runner.calls.map((call) => call.argv)).toEqual([
      ["launchctl", "bootout", "gui/501/com.apexialabs.font-sync"],
      ["launchctl", "bootstrap", "gui/501", plistPath()],
    ]);
    expect(await autostart.status()).toEqual({ enabled: true, detail: `LaunchAgent ${plistPath()}` });
  });

  it("never boots out the whole gui domain", async () => {
    const { runner, deps: d } = deps();
    const autostart = createAutostartWith("darwin", home, {}, d);
    await autostart.enable(["/bin/font-sync", "serve"]);
    await autostart.disable();
    for (const call of runner.calls.filter((c) => c.argv[1] === "bootout")) {
      expect(call.argv[2]).toBe("gui/501/com.apexialabs.font-sync");
    }
  });

  it("retries bootstrap while launchd is still removing the old job", async () => {
    let bootstraps = 0;
    const { runner, sleeps, deps: d } = deps((call) => {
      if (call.argv[1] !== "bootstrap") return ok();
      bootstraps += 1;
      return bootstraps < 3 ? fail("Bootstrap failed: 5: Input/output error") : ok();
    });
    await createAutostartWith("darwin", home, {}, d).enable(["/bin/font-sync", "serve"]);
    expect(bootstraps).toBe(3);
    expect(sleeps).toEqual([500, 500]);
    expect(runner.calls).toHaveLength(4);
  });

  it("reports a bootstrap that keeps failing", async () => {
    const { deps: d } = deps((call) => (call.argv[1] === "bootstrap" ? fail("Bootstrap failed: 5") : ok()));
    await expect(createAutostartWith("darwin", home, {}, d).enable(["/bin/font-sync"])).rejects.toThrow(
      "Bootstrap failed: 5",
    );
  });

  it("disables by booting out and deleting the plist", async () => {
    const { runner, deps: d } = deps();
    const autostart = createAutostartWith("darwin", home, {}, d);
    await autostart.enable(["/bin/font-sync", "serve"]);
    runner.calls.length = 0;
    await autostart.disable();
    expect(runner.calls.map((call) => call.argv)).toEqual([
      ["launchctl", "bootout", "gui/501/com.apexialabs.font-sync"],
    ]);
    expect(await exists(plistPath())).toBe(false);
    expect((await autostart.status()).enabled).toBe(false);
  });

  it.skipIf(process.platform === "win32")("makes a plist left by an older enable owner-only", async () => {
    await mkdir(path.dirname(plistPath()), { recursive: true });
    await writeFile(plistPath(), "old", { mode: 0o644 });
    await createAutostartWith("darwin", home, {}, deps().deps).enable(["/bin/font-sync", "serve"], {
      FONT_SYNC_GOOGLE_CLIENT_SECRET: "secret",
    });
    expect((await stat(plistPath())).mode & 0o777).toBe(0o600);
  });

  it("escapes XML in arguments and paths", () => {
    const plist = launchAgentPlist(["/Users/a&b/<bin>/font-sync", `say "hi" it's`], "/Users/a&b/log");
    expect(plist).toContain("<string>/Users/a&amp;b/&lt;bin&gt;/font-sync</string>");
    expect(plist).toContain("<string>say &quot;hi&quot; it&apos;s</string>");
    expect(plist).toContain("<string>/Users/a&amp;b/log</string>");
    expect(plist).not.toContain("a&b");
  });

  it("sets the given environment, escaped, and leaves the key out without one", () => {
    const plist = launchAgentPlist(["/bin/font-sync"], "/log", { FONT_SYNC_GOOGLE_CLIENT_ID: "id<1>", FONT_SYNC_GOOGLE_CLIENT_SECRET: "s&t" });
    expect(plist).toContain(
      "<key>EnvironmentVariables</key>\n  <dict>\n    <key>FONT_SYNC_GOOGLE_CLIENT_ID</key>\n    <string>id&lt;1&gt;</string>\n    <key>FONT_SYNC_GOOGLE_CLIENT_SECRET</key>\n    <string>s&amp;t</string>\n  </dict>",
    );
    expect(launchAgentPlist(["/bin/font-sync"], "/log")).not.toContain("EnvironmentVariables");
  });
});

describe("win32 Run key", () => {
  const key = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

  it("adds a quoted command line with reg.exe argv", async () => {
    const { runner, deps: d } = deps();
    await createAutostartWith("win32", home, {}, d).enable([
      "C:\\Users\\ana\\AppData\\Local\\Font Sync\\font-sync.exe",
      "serve",
    ]);
    expect(runner.calls.map((call) => call.argv)).toEqual([
      [
        "reg.exe",
        "add",
        key,
        "/v",
        "FontSync",
        "/t",
        "REG_SZ",
        "/d",
        '"C:\\Users\\ana\\AppData\\Local\\Font Sync\\font-sync.exe" "serve"',
        "/f",
      ],
    ]);
  });

  it("throws when reg.exe add fails", async () => {
    const { deps: d } = deps(() => fail("ERROR: Access is denied."));
    await expect(createAutostartWith("win32", home, {}, d).enable(["x.exe"])).rejects.toThrow("Access is denied");
  });

  it("deletes the value only when it exists", async () => {
    const present = deps();
    await createAutostartWith("win32", home, {}, present.deps).disable();
    expect(present.runner.calls.map((call) => call.argv)).toEqual([
      ["reg.exe", "query", key, "/v", "FontSync"],
      ["reg.exe", "delete", key, "/v", "FontSync", "/f"],
    ]);

    const absent = deps(() => fail("ERROR: The system was unable to find the specified registry key or value."));
    await createAutostartWith("win32", home, {}, absent.deps).disable();
    expect(absent.runner.calls).toHaveLength(1);
  });

  it("reports the registered command line", async () => {
    const stdout = [
      "",
      "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Run",
      '    FontSync    REG_SZ    "C:\\fs\\font-sync.exe" "serve"',
      "",
      "",
    ].join("\r\n");
    const { deps: d } = deps(() => ok(stdout));
    expect(await createAutostartWith("win32", home, {}, d).status()).toEqual({
      enabled: true,
      detail: 'FontSync: "C:\\fs\\font-sync.exe" "serve"',
    });

    const missing = deps(() => fail());
    expect((await createAutostartWith("win32", home, {}, missing.deps).status()).enabled).toBe(false);
  });

  it("quotes arguments the way CommandLineToArgvW reads them", () => {
    expect(windowsArg("plain")).toBe('"plain"');
    expect(windowsArg("with space")).toBe('"with space"');
    expect(windowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(windowsArg("C:\\dir\\")).toBe('"C:\\dir\\\\"');
    expect(windowsArg('a\\"b')).toBe('"a\\\\\\"b"');
    expect(windowsArg("C:\\a\\b")).toBe('"C:\\a\\b"');
  });
});

describe("linux systemd --user unit", () => {
  // XDG_CONFIG_HOME only counts when it is a POSIX absolute path, which a Windows temp dir is not.
  it.skipIf(process.platform === "win32")("writes the unit under XDG_CONFIG_HOME, reloads and enables it", async () => {
    const configHome = path.join(home, "xdg-config");
    const unitFile = path.join(configHome, "systemd", "user", "font-sync.service");
    const { runner, deps: d } = deps();
    await createAutostartWith("linux", home, { XDG_CONFIG_HOME: configHome }, d).enable([
      "/opt/font sync/font-sync",
      "serve",
    ]);

    expect(await readFile(unitFile, "utf8")).toBe(`[Unit]
Description=Font Sync helper

[Service]
Type=simple
ExecStart="/opt/font sync/font-sync" "serve"
Restart=on-failure

[Install]
WantedBy=default.target
`);
    expect(runner.calls.map((call) => call.argv)).toEqual([
      ["systemctl", "--user", "daemon-reload"],
      ["systemctl", "--user", "enable", "--now", "font-sync.service"],
    ]);
  });

  it.skipIf(process.platform === "win32")("makes a unit left by an older enable owner-only", async () => {
    const unit = path.join(home, ".config", "systemd", "user", "font-sync.service");
    await mkdir(path.dirname(unit), { recursive: true });
    await writeFile(unit, "old", { mode: 0o644 });
    await createAutostartWith("linux", home, {}, deps().deps).enable(["/bin/font-sync", "serve"], {
      FONT_SYNC_GOOGLE_CLIENT_SECRET: "secret",
    });
    expect((await stat(unit)).mode & 0o777).toBe(0o600);
  });

  it("defaults to ~/.config", async () => {
    const { deps: d } = deps();
    await createAutostartWith("linux", home, {}, d).enable(["/usr/bin/font-sync", "serve"]);
    expect(await exists(path.join(home, ".config", "systemd", "user", "font-sync.service"))).toBe(true);
  });

  it("throws when systemctl enable fails", async () => {
    const { deps: d } = deps((call) => (call.argv[2] === "enable" ? fail("Failed to connect to bus") : ok()));
    await expect(createAutostartWith("linux", home, {}, d).enable(["/usr/bin/font-sync"])).rejects.toThrow(
      "Failed to connect to bus",
    );
  });

  it("disables, deletes the unit and reloads", async () => {
    const { runner, deps: d } = deps();
    const autostart = createAutostartWith("linux", home, {}, d);
    await autostart.enable(["/usr/bin/font-sync", "serve"]);
    runner.calls.length = 0;
    await autostart.disable();
    expect(runner.calls.map((call) => call.argv)).toEqual([
      ["systemctl", "--user", "disable", "--now", "font-sync.service"],
      ["systemctl", "--user", "daemon-reload"],
    ]);
    expect(await exists(path.join(home, ".config", "systemd", "user", "font-sync.service"))).toBe(false);
  });

  it("reports is-enabled", async () => {
    const enabled = deps(() => ok("enabled\n"));
    expect(await createAutostartWith("linux", home, {}, enabled.deps).status()).toEqual({
      enabled: true,
      detail: "font-sync.service: enabled",
    });
    expect(enabled.runner.calls[0]?.argv).toEqual(["systemctl", "--user", "is-enabled", "font-sync.service"]);

    const disabled = deps(() => ({ code: 1, stdout: "disabled\n", stderr: "" }));
    expect((await createAutostartWith("linux", home, {}, disabled.deps).status()).enabled).toBe(false);

    const missing = deps(() => {
      throw new Error("spawn systemctl ENOENT");
    });
    expect(await createAutostartWith("linux", home, {}, missing.deps).status()).toEqual({
      enabled: false,
      detail: "systemctl is not available",
    });
  });

  it("escapes quotes, backslashes, specifiers and variables in ExecStart", () => {
    const unit = systemdUnitFile(["/home/a/bin/font-sync", 'x"y\\z', "100%", "$HOME", "a\nb"]);
    expect(unit).toContain('ExecStart="/home/a/bin/font-sync" "x\\"y\\\\z" "100%%" "$$HOME" "a\\nb"\n');
  });

  it("sets the given environment with Environment= lines, where $ stays literal", () => {
    const unit = systemdUnitFile(["/bin/font-sync"], { FONT_SYNC_GOOGLE_CLIENT_ID: "id", FONT_SYNC_GOOGLE_CLIENT_SECRET: 'a"b\\c%d$e' });
    expect(unit).toContain(
      'Environment="FONT_SYNC_GOOGLE_CLIENT_ID=id"\nEnvironment="FONT_SYNC_GOOGLE_CLIENT_SECRET=a\\"b\\\\c%%d$e"\nExecStart=',
    );
    expect(systemdUnitFile(["/bin/font-sync"])).not.toContain("Environment=");
  });
});

describe("darwin service control", () => {
  const plistPath = () => path.join(home, "Library", "LaunchAgents", "com.apexialabs.font-sync.plist");
  const registered = async () => {
    await mkdir(path.dirname(plistPath()), { recursive: true });
    await writeFile(plistPath(), launchAgentPlist(["/bin/font-sync", "serve"], "/log"));
  };

  it("does nothing without the LaunchAgent", async () => {
    const { runner, deps: d } = deps();
    const autostart = createAutostartWith("darwin", home, {}, d);
    expect(await autostart.isRegistered()).toBe(false);
    expect(await autostart.startService()).toBe(false);
    expect(await autostart.stopService()).toBe(false);
    expect(runner.calls).toEqual([]);
  });

  it("names the LaunchAgent's log", () => {
    expect(createAutostartWith("darwin", home, {}, deps().deps).logFile).toBe(
      path.join(home, "Library", "Logs", "font-sync.log"),
    );
  });

  it("starts with kickstart -k on the service target", async () => {
    await registered();
    const { runner, deps: d } = deps();
    const autostart = createAutostartWith("darwin", home, {}, d);
    expect(await autostart.isRegistered()).toBe(true);
    expect(await autostart.startService()).toBe(true);
    expect(runner.calls.map((call) => call.argv)).toEqual([
      ["launchctl", "kickstart", "-k", "gui/501/com.apexialabs.font-sync"],
    ]);
  });

  it("bootstraps the plist when a stop booted the job out", async () => {
    await registered();
    const { runner, deps: d } = deps((call) =>
      call.argv[1] === "kickstart"
        ? { code: 113, stdout: "", stderr: 'Could not find service "com.apexialabs.font-sync" in domain for user gui: 501' }
        : ok(),
    );
    expect(await createAutostartWith("darwin", home, {}, d).startService()).toBe(true);
    expect(runner.calls.map((call) => call.argv)).toEqual([
      ["launchctl", "kickstart", "-k", "gui/501/com.apexialabs.font-sync"],
      ["launchctl", "bootstrap", "gui/501", plistPath()],
    ]);
  });

  it("reports any other kickstart failure", async () => {
    await registered();
    const { runner, deps: d } = deps(() => ({ code: 1, stdout: "", stderr: "Operation not permitted" }));
    await expect(createAutostartWith("darwin", home, {}, d).startService()).rejects.toThrow("Operation not permitted");
    expect(runner.calls).toHaveLength(1);
  });

  it("stops with bootout, so KeepAlive cannot respawn it, and keeps the plist", async () => {
    await registered();
    const { runner, deps: d } = deps();
    expect(await createAutostartWith("darwin", home, {}, d).stopService()).toBe(true);
    expect(runner.calls.map((call) => call.argv)).toEqual([["launchctl", "bootout", "gui/501/com.apexialabs.font-sync"]]);
    expect(await exists(plistPath())).toBe(true);
  });

  it("treats a job that is not loaded as stopped, and reports other bootout failures", async () => {
    await registered();
    const notLoaded = deps(() => ({ code: 3, stdout: "", stderr: "Boot-out failed: 3: No such process" }));
    expect(await createAutostartWith("darwin", home, {}, notLoaded.deps).stopService()).toBe(true);
    const failing = deps(() => fail("Boot-out failed: 1: Operation not permitted"));
    await expect(createAutostartWith("darwin", home, {}, failing.deps).stopService()).rejects.toThrow(
      "Operation not permitted",
    );
  });
});

describe("win32 service control", () => {
  it("is registered when the Run value exists, and never starts or stops anything itself", async () => {
    const present = deps();
    const autostart = createAutostartWith("win32", home, {}, present.deps);
    expect(await autostart.isRegistered()).toBe(true);
    expect(present.runner.calls.map((call) => call.argv)).toEqual([
      ["reg.exe", "query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "FontSync"],
    ]);
    present.runner.calls.length = 0;
    expect(await autostart.startService()).toBe(false);
    expect(await autostart.stopService()).toBe(false);
    expect(present.runner.calls).toEqual([]);
    expect(autostart.logFile).toBeUndefined();

    const absent = deps(() => fail());
    expect(await createAutostartWith("win32", home, {}, absent.deps).isRegistered()).toBe(false);
  });
});

describe("linux service control", () => {
  const enabledUnit = (call: RecordedCall) => (call.argv[2] === "is-enabled" ? ok("enabled\n") : ok());

  it("restarts and stops the enabled unit", async () => {
    const { runner, deps: d } = deps(enabledUnit);
    const autostart = createAutostartWith("linux", home, {}, d);
    expect(await autostart.isRegistered()).toBe(true);
    expect(await autostart.startService()).toBe(true);
    expect(await autostart.stopService()).toBe(true);
    expect(runner.calls.map((call) => call.argv.slice(2))).toEqual([
      ["is-enabled", "font-sync.service"],
      ["is-enabled", "font-sync.service"],
      ["restart", "font-sync.service"],
      ["is-enabled", "font-sync.service"],
      ["stop", "font-sync.service"],
    ]);
  });

  it("leaves a disabled unit alone", async () => {
    const { runner, deps: d } = deps(() => ({ code: 1, stdout: "disabled\n", stderr: "" }));
    const autostart = createAutostartWith("linux", home, {}, d);
    expect(await autostart.isRegistered()).toBe(false);
    expect(await autostart.startService()).toBe(false);
    expect(await autostart.stopService()).toBe(false);
    expect(runner.calls.every((call) => call.argv[2] === "is-enabled")).toBe(true);
  });

  it("reports a failed restart", async () => {
    const { deps: d } = deps((call) => (call.argv[2] === "restart" ? fail("Unit font-sync.service failed") : enabledUnit(call)));
    await expect(createAutostartWith("linux", home, {}, d).startService()).rejects.toThrow("Unit font-sync.service failed");
  });
});
