import { HELPER_URL } from "../connection";
import { Command, Screen } from "../ui";

export function Unreachable({ checking, onCheck }: { checking: boolean; onCheck: () => void }) {
  return (
    <Screen title="Start the Font Sync helper">
      <p>
        The plugin installs fonts through a small helper program on this computer. It isn't answering at{" "}
        <span className="mono">{HELPER_URL}</span>.
      </p>
      <p>Run it once in a terminal:</p>
      <Command>font-sync serve</Command>
      <p>Or start it automatically every time you log in:</p>
      <Command>font-sync autostart enable</Command>
      <p className="text-secondary">
        The plugin has to run in the Figma desktop app. Figma in a browser can't reach the helper.
      </p>
      <div className="actions">
        <button type="button" className="button secondary" onClick={onCheck} disabled={checking}>
          {checking ? "Checking..." : "Check now"}
        </button>
        <span className="text-tertiary">Checking again every 3 seconds.</span>
      </div>
    </Screen>
  );
}
