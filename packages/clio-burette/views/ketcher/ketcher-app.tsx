// The Ketcher editor of the Burette desktop app, mounted for the MCP Apps view.
// The page bootstrap owns the bridge; this module renders Burette's own
// KetcherEditor and hands its API back once the editor is ready.
import { createRoot } from "react-dom/client";
import { ketcherProvider } from "ketcher-core";
import { KetcherEditor, type KetcherEditorApi } from "@/components/ketcher-editor";
import "./ketcher-view.css";

export function mount(root: HTMLElement, callbacks: {
  onReady: (api: KetcherEditorApi) => void;
  onStatus: (status: string) => void;
}) {
  const theme = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  createRoot(root).render(
    <div className="app-shell burette-clio-ketcher" data-theme="auto" data-effective-theme={theme}>
      <div className="ketcher-page">
        <div className="ketcher-page-body">
          <div className="ketcher-editor-shell">
            <KetcherEditor
              onReady={callbacks.onReady}
              onStatus={callbacks.onStatus}
              onOpenFile={() => callbacks.onStatus("Open files from the agent: ask it to open a file in Ketcher.")}
            />
          </div>
        </div>
      </div>
    </div>,
  );
  // The live Ketcher instance, for reading its struct (atom ids to MOL order).
  return { ketcher: () => ketcherProvider.getKetcher() };
}
