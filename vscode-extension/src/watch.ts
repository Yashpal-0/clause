import { watch, type FSWatcher } from 'node:fs';

export interface DirectoryWatch {
  close(): void;
}

/**
 * Reports changes in a directory by the name of what changed, relative to the
 * directory. `null` means "something changed, look at everything": the platform
 * did not say what, or the watch failed and has been closed.
 *
 * Only the directory's own entries are reported, not what happens inside a
 * subdirectory: watch that directory itself. Node's recursive watch is no
 * substitute on Linux, where it follows each file by inode and goes quiet about
 * a file once it has been replaced by a rename.
 *
 * @returns undefined when the directory cannot be watched (it does not exist,
 * or the system is out of watches); the caller has to look again at moments
 * of its own.
 */
export function watchDirectory(dir: string, onChange: (name: string | null) => void): DirectoryWatch | undefined {
  let watcher: FSWatcher;
  try {
    watcher = watch(dir, { persistent: false }, (_event, name) => onChange(name));
  } catch {
    return undefined;
  }
  // Windows reports a removed directory as an error event, and one nobody
  // handles is thrown inside the extension host.
  watcher.on('error', () => {
    watcher.close();
    onChange(null);
  });
  return { close: () => watcher.close() };
}
