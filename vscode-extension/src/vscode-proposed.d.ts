// The editorInsets proposal is not part of @types/vscode. This is the piece of
// vscode.proposed.editorInsets.d.ts (microsoft/vscode, src/vscode-dts) that the
// extension calls. The call throws unless the editor was told to let this
// extension use the proposal; see the README on `enable-proposed-api`.
import 'vscode';

declare module 'vscode' {
  export interface WebviewEditorInset {
    readonly editor: TextEditor;
    readonly line: number;
    readonly height: number;
    readonly webview: Webview;
    readonly onDidDispose: Event<void>;
    dispose(): void;
  }

  export namespace window {
    /** `line` is 0-based and the inset follows it; -1 puts the inset above the first line. `height` counts editor lines. */
    export function createWebviewTextEditorInset(editor: TextEditor, line: number, height: number, options?: WebviewOptions): WebviewEditorInset;
  }
}
