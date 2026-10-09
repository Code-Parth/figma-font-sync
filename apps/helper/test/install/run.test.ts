import { describe, expect, it } from "bun:test";
import { runCommand } from "../../src/install/run";

describe.skipIf(process.platform === "win32")("runCommand", () => {
  it("feeds stdin and captures stdout and the exit code", async () => {
    expect(await runCommand(["cat"], { stdin: "hello\n" })).toEqual({ code: 0, stdout: "hello\n", stderr: "" });
  });

  it("adds env to the inherited environment", async () => {
    const result = await runCommand(["sh", "-c", 'printf "%s|%s" "$FS_VALUE" "${PATH:+inherited}"; exit 3'], {
      env: { FS_VALUE: "a 'quoted' $value" },
    });
    expect(result).toEqual({ code: 3, stdout: "a 'quoted' $value|inherited", stderr: "" });
  });

  it("rejects when the executable does not exist", async () => {
    await expect(runCommand(["font-sync-no-such-command"])).rejects.toThrow();
  });
});
