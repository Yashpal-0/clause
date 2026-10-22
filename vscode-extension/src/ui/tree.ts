import { basename } from 'node:path';
import * as vscode from 'vscode';
import { anchorLine, blockLabel } from '../nav.ts';
import type { PendingFile, PendingModel } from '../pending.ts';
import { lineStats, statsText } from '../present.ts';
import type { BlockTarget, FileTarget, GroupTarget } from '../targets.ts';
import { partition, whereIs } from './scope.ts';

export type TreeNode = FileTarget | BlockTarget | GroupTarget;

const OUTSIDE: GroupTarget = { kind: 'group' };

const BLOCK_ICONS = { added: 'diff-added', removed: 'diff-removed', changed: 'diff-modified' } as const;

/** The Clause view: files, and under each the blocks that can be kept or discarded on their own. */
export class PendingTree implements vscode.TreeDataProvider<TreeNode>, vscode.Disposable {
  readonly #model: PendingModel;
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #subscription: vscode.Disposable;

  constructor(model: PendingModel) {
    this.#model = model;
    this.#subscription = model.onDidChange(() => this.#changed.fire());
  }

  getChildren(node?: TreeNode): TreeNode[] {
    if (node === undefined) {
      const { here, outside } = partition(this.#model.files());
      return [...here.map(fileNode), ...(outside.length > 0 ? [OUTSIDE] : [])];
    }
    if (node.kind === 'group') return partition(this.#model.files()).outside.map(fileNode);
    if (node.kind === 'block') return [];

    const file = this.#model.fileById(node.id);
    if (file === undefined || !hasBlocks(file)) return [];
    return file.state.blocks.map((block) => ({ kind: 'block', id: file.id, block }));
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node.kind === 'group') return this.#groupItem();
    const file = this.#model.fileById(node.id);
    if (file === undefined) return new vscode.TreeItem('(already decided)');
    return node.kind === 'file' ? fileItem(file, node) : blockItem(file, node);
  }

  dispose(): void {
    this.#subscription.dispose();
    this.#changed.dispose();
  }

  #groupItem(): vscode.TreeItem {
    const count = partition(this.#model.files()).outside.length;
    const item = new vscode.TreeItem('Outside this folder', vscode.TreeItemCollapsibleState.Expanded);
    item.id = 'group:outside';
    item.description = `${count} ${count === 1 ? 'file' : 'files'}`;
    item.tooltip = 'Files outside this folder that Claude sessions started in this folder changed';
    item.iconPath = new vscode.ThemeIcon('folder');
    item.contextValue = 'group';
    return item;
  }
}

function fileNode(file: PendingFile): FileTarget {
  return { kind: 'file', id: file.id };
}

/** Whether the file's blocks can be listed one by one. */
function hasBlocks(file: PendingFile): boolean {
  return file.state.situation === 'edited' && file.state.granularity === 'blocks';
}

function fileItem(file: PendingFile, node: FileTarget): vscode.TreeItem {
  const item = new vscode.TreeItem(basename(file.path), hasBlocks(file) ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None);
  item.id = `file:${file.id}`;
  item.resourceUri = file.uri;
  const stats = lineStats(file.state);
  item.description = [whereIs(file).directory, SITUATION_NOTE[file.state.situation], stats === undefined ? '' : statsText(stats)]
    .filter((part) => part !== '')
    .join(' · ');
  item.tooltip = file.path;
  item.contextValue = 'file';
  item.command = { command: 'claudePending.reveal', title: 'Show', arguments: [node] };
  return item;
}

const SITUATION_NOTE = { edited: '', created: 'new', deleted: 'deleted' } as const;

function blockItem(file: PendingFile, node: BlockTarget): vscode.TreeItem {
  const { block } = node;
  const item = new vscode.TreeItem(blockLabel(block), vscode.TreeItemCollapsibleState.None);
  item.id = `block:${file.id}:${block.baseStart}-${block.baseEnd}:${block.curStart}-${block.curEnd}`;
  item.description = `line ${anchorLine(block, file.state.cur?.lines.length ?? 1) + 1}`;
  item.iconPath = new vscode.ThemeIcon(BLOCK_ICONS[block.kind]);
  item.contextValue = 'block';
  item.command = { command: 'claudePending.reveal', title: 'Show', arguments: [node] };
  return item;
}
