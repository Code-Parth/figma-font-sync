import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import type { FontKey, Prefs } from "../../shared/messages";
import type { Library, Status } from "../api/types.gen";
import { ROLE_LABEL } from "../library";
import type { PluginState, ReloadReason } from "../state";
import { FileTab } from "../tabs/FileTab";
import { LibraryTab } from "../tabs/LibraryTab";
import { SettingsTab } from "../tabs/SettingsTab";

const TABS = [
  { id: "file", label: "This file" },
  { id: "library", label: "Library" },
  { id: "settings", label: "Settings" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const RELOAD_TEXT: Record<ReloadReason, string> = {
  installed:
    "Fonts installed. Reload this tab so Figma picks them up: right-click the file tab > Reload tab, then scan again.",
  uninstalled:
    "Fonts uninstalled. Reload this tab so Figma notices: right-click the file tab > Reload tab, then scan again.",
};

type MainProps = {
  status: Status;
  library: NonNullable<Library>;
  version: string | undefined;
  state: PluginState;
  onScan: () => void;
  onPrefs: (prefs: Prefs) => void;
  onSelect: (font: FontKey) => void;
  onReload: (reason: ReloadReason) => void;
  onChangeLibrary: () => void;
  onUnpaired: () => void;
};

export function Main(props: MainProps) {
  const { status, library, state, onScan } = props;
  const [tab, setTab] = useState<TabId>("file");
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());

  // Scan once on arrival so the user sees their fonts without an extra click.
  const autoScanned = useRef(false);
  useEffect(() => {
    if (autoScanned.current) return;
    autoScanned.current = true;
    if (state.report === null && state.scan.phase === "idle") onScan();
  }, [state.report, state.scan.phase, onScan]);

  const onTabKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = TABS.findIndex((candidate) => candidate.id === tab);
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % TABS.length;
    else if (event.key === "ArrowLeft") next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = TABS.length - 1;
    else return;
    event.preventDefault();
    const target = TABS[next];
    if (target === undefined) return;
    setTab(target.id);
    tabRefs.current.get(target.id)?.focus();
  };

  return (
    <div className="main">
      <header className="header">
        <span className="header-account" title={status.account?.email ?? undefined}>
          {status.account?.email ?? "Signed in"}
        </span>
        <span className="header-library">
          <span className="header-library-name" title={library.name}>
            {library.name}
          </span>
          <span className={`badge role-${library.role}`}>{ROLE_LABEL[library.role]}</span>
        </span>
      </header>

      {state.reload !== null ? <p className="banner banner-sticky">{RELOAD_TEXT[state.reload]}</p> : null}

      <div className="tabs" role="tablist" aria-label="Font Sync" onKeyDown={onTabKey}>
        {TABS.map(({ id, label }) => (
          <button
            key={id}
            ref={(element) => {
              if (element) tabRefs.current.set(id, element);
              else tabRefs.current.delete(id);
            }}
            type="button"
            role="tab"
            id={`tab-${id}`}
            className="tab"
            aria-selected={tab === id}
            aria-controls={`panel-${id}`}
            tabIndex={tab === id ? 0 : -1}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>

      {/* Panels stay mounted so search text, upload results and scroll survive a tab switch. */}
      <div className="panel" role="tabpanel" id="panel-file" aria-labelledby="tab-file" hidden={tab !== "file"}>
        <FileTab
          state={state}
          libraryId={library.id}
          canUpload={library.canUpload}
          onScan={onScan}
          onPrefs={props.onPrefs}
          onSelect={props.onSelect}
          onReload={props.onReload}
        />
      </div>
      <div className="panel" role="tabpanel" id="panel-library" aria-labelledby="tab-library" hidden={tab !== "library"}>
        <LibraryTab library={library} onReload={props.onReload} />
      </div>
      <div
        className="panel"
        role="tabpanel"
        id="panel-settings"
        aria-labelledby="tab-settings"
        hidden={tab !== "settings"}
      >
        <SettingsTab
          status={status}
          library={library}
          version={props.version}
          onChangeLibrary={props.onChangeLibrary}
          onUnpaired={props.onUnpaired}
        />
      </div>
    </div>
  );
}
