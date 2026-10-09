import { HelperError } from "../errors";
import type { InstalledFont, InstallInput, Registration } from "./index";
import type { CommandResult, CommandRunner } from "./run";

export const POWERSHELL = [
  "powershell.exe",
  "-NoProfile",
  "-NonInteractive",
  "-ExecutionPolicy",
  "Bypass",
  "-Command",
  "-",
];

/*
 * The scripts are constants. Font paths and names reach them only through FS_FONT_PATH and FS_REG_NAME,
 * because names come from shared Drive files and must never be parsed as PowerShell.
 *
 * `-Command -` reads stdin line by line, so each script is a single `& { }` statement ended by a blank line.
 * Its exit code is not a reliable signal, so success is a marker line on stdout. The marker is concatenated
 * at runtime so that an echoed script can never contain it.
 */
const OK = "font-sync-ok";
const ERROR_PREFIX = "font-sync-error: ";

const NATIVE = String.raw`Add-Type -ErrorAction Stop -Namespace FontSync -Name Native -MemberDefinition (@(
      '[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern int AddFontResourceW(string file);',
      '[DllImport("gdi32.dll", CharSet = CharSet.Unicode)] public static extern bool RemoveFontResourceW(string file);',
      '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeoutW(',
      'IntPtr hWnd, uint msg, UIntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);'
    ) -join ' ')`;

// WM_FONTCHANGE to HWND_BROADCAST with SMTO_ABORTIFHUNG, so one hung window cannot block the helper.
const BROADCAST = String.raw`$result = [UIntPtr]::Zero
    [void][FontSync.Native]::SendMessageTimeoutW([IntPtr]0xFFFF, 0x1D, [UIntPtr]::Zero, [IntPtr]::Zero, 2, 1000, [ref]$result)`;

const KEY = String.raw`'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\Fonts'`;

export const INSTALL_SCRIPT = String.raw`& {
  $ErrorActionPreference = 'Stop'
  $path = $env:FS_FONT_PATH
  $name = $env:FS_REG_NAME
  $key = ${KEY}
  try {
    if (-not (Test-Path -LiteralPath $key)) { New-Item -Path $key -Force | Out-Null }
    New-ItemProperty -LiteralPath $key -Name $name -PropertyType String -Value $path -Force | Out-Null
  } catch {
    Write-Output ('${ERROR_PREFIX}' + $_.Exception.Message)
    exit 1
  }
  Write-Output ('font-sync-' + 'ok')
  try {
    ${NATIVE}
    [void][FontSync.Native]::AddFontResourceW($path)
    ${BROADCAST}
  } catch {
    # Constrained Language Mode blocks Add-Type. The registry value still loads the font at the next sign-in.
  }
}

`;

export const UNINSTALL_SCRIPT = String.raw`& {
  $path = $env:FS_FONT_PATH
  $name = $env:FS_REG_NAME
  $key = ${KEY}
  $native = $false
  try {
    ${NATIVE}
    $native = $true
  } catch {
  }
  if ($native -and $path) {
    # AddFontResourceW is reference counted; the cap guards against a call that never reports zero.
    for ($i = 0; $i -lt 100 -and [FontSync.Native]::RemoveFontResourceW($path); $i++) { }
  }
  if ($name) {
    Remove-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue
    if ($null -ne (Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue)) {
      Write-Output ('${ERROR_PREFIX}' + 'the registry value could not be removed')
      exit 1
    }
  }
  if ($native) {
    ${BROADCAST}
  }
  Write-Output ('font-sync-' + 'ok')
}

`;

/**
 * The HKCU Fonts value name, after the HKLM convention: "<full name> (TrueType)", collection faces joined
 * with " & ". The md5 suffix keeps it unique per file, so two versions of a font never share a value.
 */
export function registryValueName(input: Pick<InstallInput, "faces" | "format" | "md5" | "sourceName">): string {
  const names = [...new Set(input.faces.map((face) => face.fullName || `${face.family} ${face.style}`))];
  const label = names.length > 0 ? names.join(" & ") : input.sourceName;
  const kind = input.format === "otf" ? "OpenType" : "TrueType";
  // Control characters cannot travel in an environment variable, and Remove-ItemProperty -Name treats
  // [ ] * ? and the backtick as wildcard syntax, which could match other values.
  return `${label} (${kind}) #${input.md5.toLowerCase().slice(0, 8)}`.replace(/[\p{Cc}[\]*?`]/gu, "_");
}

export function windowsRegistration(run: CommandRunner): Registration {
  return {
    async register(file, input) {
      const name = registryValueName(input);
      const env = { FS_FONT_PATH: file, FS_REG_NAME: name };
      await runScript(run, INSTALL_SCRIPT, env, "Windows did not register the font");
      return [name];
    },

    async unregister(installed: InstalledFont) {
      const count = Math.max(installed.paths.length, installed.registryValues.length);
      for (let i = 0; i < count; i++) {
        const env = { FS_FONT_PATH: installed.paths[i] ?? "", FS_REG_NAME: installed.registryValues[i] ?? "" };
        await runScript(run, UNINSTALL_SCRIPT, env, "Windows did not unregister the font");
      }
    },

    deleted: async () => {},
  };
}

async function runScript(run: CommandRunner, script: string, env: Record<string, string>, failure: string) {
  let result: CommandResult;
  try {
    result = await run(POWERSHELL, { env, stdin: script });
  } catch {
    throw new HelperError("install-failed", `${failure}: PowerShell could not be started`);
  }
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim());
  if (lines.includes(OK)) return;
  const reported = lines.find((line) => line.startsWith(ERROR_PREFIX))?.slice(ERROR_PREFIX.length);
  const detail = reported || result.stderr.trim() || `exit code ${result.code}`;
  throw new HelperError("install-failed", `${failure}: ${detail}`);
}
