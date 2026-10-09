import { HELPER_URL } from "../connection";
import { detectPlatform, isFigmaDesktop, type Platform } from "../platform";
import { Command, Screen } from "../ui";

const RUN_IN: Record<Platform, string> = {
  mac: "Open Terminal and run:",
  windows: "Open Command Prompt and run:",
  other: "Open a terminal and run:",
};

/**
 * `paired`: a pairing token is stored, so the helper was installed here before and only needs starting.
 * Without one this is most likely the first run on this computer. Figma can't launch programs for a
 * plugin, so both variants hand the user a command and wait for /health to answer.
 */
export function Unreachable({
  paired,
  checking,
  onCheck,
  userAgent = navigator.userAgent,
}: {
  paired: boolean;
  checking: boolean;
  onCheck: () => void;
  userAgent?: string;
}) {
  if (!isFigmaDesktop(userAgent)) {
    return (
      <Screen title="Use the Figma desktop app">
        <p>
          Font Sync installs fonts through a helper program on your computer, and Figma in a browser can't reach it.
          Open this file in the Figma desktop app and run the plugin there.
        </p>
      </Screen>
    );
  }
  const platform = detectPlatform(userAgent);
  return paired ? (
    <StartHelper platform={platform} checking={checking} onCheck={onCheck} />
  ) : (
    <InstallHelper platform={platform} checking={checking} onCheck={onCheck} />
  );
}

type VariantProps = { platform: Platform; checking: boolean; onCheck: () => void };

function StartHelper({ platform, checking, onCheck }: VariantProps) {
  return (
    <Screen title="Start the Font Sync helper">
      <p>
        Font Sync installs fonts through a small helper program on this computer. It isn't answering at{" "}
        <span className="mono">{HELPER_URL}</span>.
      </p>
      <p>{RUN_IN[platform]}</p>
      {platform === "windows" ? (
        <>
          <Command copy>figma-font-sync start</Command>
          <p className="text-secondary">PowerShell blocks npm's command scripts by default, so in PowerShell run:</p>
          <Command copy>figma-font-sync.cmd start</Command>
          <p className="text-secondary">
            To start it every time you log in (in PowerShell, <span className="mono">figma-font-sync.cmd</span>):
          </p>
          <Command copy>figma-font-sync autostart enable</Command>
        </>
      ) : (
        <>
          {/* launchd and systemd start the helper as soon as start at login is turned on, so that comes first
              and needs no start after it; a start run first leaves a helper running outside the service
              manager. The Windows Run key starts nothing until the next login, so there start comes first. */}
          <Command copy>figma-font-sync autostart enable</Command>
          <p className="text-secondary">
            That starts it now and every time you log in. To start it only this once instead:
          </p>
          <Command copy>figma-font-sync start</Command>
        </>
      )}
      <CheckNow checking={checking} onCheck={onCheck} />
    </Screen>
  );
}

function InstallHelper({ platform, checking, onCheck }: VariantProps) {
  return (
    <Screen title="Install Font Sync">
      <p>
        Font Sync installs fonts through a small helper program on this computer. Install it once, then set it up.
      </p>
      <p>{RUN_IN[platform]}</p>
      <Command copy>npm i -g figma-font-sync</Command>
      <p>Then:</p>
      <Command copy>figma-font-sync setup</Command>
      {platform === "mac" ? (
        <>
          {/* install.sh runs setup itself, so it replaces both lines above. */}
          <p className="text-secondary">No Node.js? This one line does both:</p>
          <Command copy>curl -fsSL https://unpkg.com/figma-font-sync/install.sh | sh</Command>
        </>
      ) : null}
      {platform === "windows" ? (
        <p className="text-secondary">
          PowerShell blocks npm's command scripts by default, so in PowerShell add .cmd to both names:{" "}
          <span className="mono">npm.cmd</span> and <span className="mono">figma-font-sync.cmd</span>.
        </p>
      ) : null}
      <CheckNow checking={checking} onCheck={onCheck} />
    </Screen>
  );
}

function CheckNow({ checking, onCheck }: { checking: boolean; onCheck: () => void }) {
  return (
    <div className="actions">
      {/* Never disabled: the poll makes `checking` flip every 2 seconds, and disabling would drop keyboard focus. */}
      <button type="button" className="button secondary" onClick={onCheck}>
        {checking ? "Checking..." : "Check now"}
      </button>
      <span className="text-tertiary">This screen moves on by itself as soon as the helper answers.</span>
    </div>
  );
}
