import * as vscode from 'vscode';
import { changedMarks, folderMarks, MARKER_BADGE, markerTooltip } from '../marks.ts';
import type { PendingModel } from '../pending.ts';
import { NewestRegistration } from '../registration.ts';

const markerColour = () => new vscode.ThemeColor('claudePending.explorerForeground');

/**
 * Marks the files that have changes waiting for Keep or Discard, and the
 * folders above them, in the file tree and on their tabs, so that you can see
 * where to look. Git decorates the same files, and VS Code merges the two into
 * one label: see `MARKER_BADGE`, `folderMarks` and `registerMarks`.
 */
export class ExplorerMarks implements vscode.FileDecorationProvider, vscode.Disposable {
  readonly #model: PendingModel;
  readonly #changed = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.#changed.event;
  readonly #subscription: vscode.Disposable;
  /** How many changes each file had waiting, and how many such files each folder above them holds, when the file tree was last told. Starts empty, so the first report from the model names every pending file. */
  #announced: ReadonlyMap<string, number> = new Map();
  /** The folders among `#announced`: the ones that get a colour. */
  #folders: ReadonlyMap<string, number> = new Map();

  constructor(model: PendingModel) {
    this.#model = model;
    this.#subscription = model.onDidChange(() => this.#announce());
  }

  dispose(): void {
    this.#subscription.dispose();
    this.#changed.dispose();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    const file = this.#model.fileForUri(uri);
    if (file !== undefined) {
      const decoration = new vscode.FileDecoration(MARKER_BADGE, markerTooltip(file.state.pending), markerColour());
      // The folders above it show a dot for this file, so that a collapsed folder says where to look.
      decoration.propagate = true;
      return decoration;
    }

    // The folder's own colour comes first when VS Code merges the labels, and the dot takes its colour from the same place: see `folderMarks`.
    // Colour only: the badge and the tooltip belong to the files, and the folder's dot comes from them.
    if (uri.scheme === 'file' && this.#folders.has(uri.fsPath)) return new vscode.FileDecoration(undefined, undefined, markerColour());
    return undefined;
  }

  /**
   * Names every mark again. A decoration registration made just now has
   * nothing cached, so what was announced before it never reached it.
   */
  announceAll(): void {
    this.#fire(changedMarks(new Map(), this.#announced));
  }

  /** Tells the file tree which files and folders to ask about again. The model reports on every keystroke too, and the tree is only worth waking when a count changed. */
  #announce(): void {
    const counts = new Map(this.#model.files().map((file) => [file.path, file.state.pending] as const));
    // shortcut: the workspace folders are read now, so one added while the window is open is marked from the model's next report on.
    const roots = vscode.workspace.workspaceFolders?.map((folder) => folder.uri.fsPath) ?? [];
    const folders = folderMarks(counts.keys(), roots);
    const now = new Map([...counts, ...folders]);

    const changed = changedMarks(this.#announced, now);
    this.#announced = now;
    this.#folders = folders;
    this.#fire(changed);
  }

  #fire(paths: string[] | undefined): void {
    if (paths?.length === 0) return;
    // shortcut: the model names files by their real path and the file tree asks under the spelling of the workspace folder, so a
    // workspace opened through a symlink may get its marks late or not at all, and no folder is marked there (a drive letter spelled
    // in another case on Windows does the same). Upgrade by also announcing the folder's spelling.
    this.#changed.fire(paths?.map((path) => vscode.Uri.file(path)));
  }
}

/** The part of the git extension's API that is used here. */
interface GitExtension {
  getAPI(version: 1): { readonly onDidOpenRepository: vscode.Event<unknown> };
}

/**
 * Registers `marks` and keeps it the newest file decoration provider. VS Code
 * takes a label's colour from the first provider that has one, newest first,
 * and git registers its providers after ours: one for each repository when it
 * opens the repository, and again for all of them when `git.decorations.enabled`
 * is switched on. Each time, ours is registered again, and then the file tree
 * is told to ask it about everything, because a new registration has nothing
 * cached.
 */
export function registerMarks(marks: ExplorerMarks, log: (message: string) => void): vscode.Disposable {
  const registration = new NewestRegistration(
    () => {
      const registered = vscode.window.registerFileDecorationProvider(marks);
      marks.announceAll();
      return registered;
    },
    (error) => log(`could not register the file tree marks again: ${describe(error)}`),
  );
  const renew = () => registration.renew();

  const gitSetting = vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('git.decorations.enabled')) renew();
  });

  let watchingGit: vscode.Disposable | undefined;
  let disposed = false;
  void onGitOpensRepository(renew, log).then((subscription) => {
    if (subscription === undefined) return;
    if (disposed) {
      subscription.dispose();
      return;
    }
    watchingGit = subscription;
    // Git may have opened repositories before this point, and registered their providers without telling us.
    renew();
  });

  return new vscode.Disposable(() => {
    disposed = true;
    watchingGit?.dispose();
    gitSetting.dispose();
    registration.dispose();
  });
}

/**
 * Calls `onOpened` whenever git opens a repository, which is when it registers
 * the decoration provider for it.
 *
 * shortcut: a git that is switched on after this window starts is not watched, and only the setting renews the registration then.
 */
async function onGitOpensRepository(onOpened: () => void, log: (message: string) => void): Promise<vscode.Disposable | undefined> {
  try {
    const extension = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (extension === undefined) return undefined;
    const git = extension.isActive ? extension.exports : await extension.activate();
    return git.getAPI(1).onDidOpenRepository(onOpened);
  } catch (error) {
    log(`not watching git for new repositories, so the colour of the file tree marks can lose to git's: ${describe(error)}`);
    return undefined;
  }
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));
