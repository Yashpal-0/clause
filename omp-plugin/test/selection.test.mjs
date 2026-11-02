import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../../claude-plugin/store.mjs';
import clause, { formatSelectionContext, formatSelectionStatus } from '../index.mjs';

test('formatSelectionContext formats XML block correctly', () => {
  const xml = formatSelectionContext({
    filePath: '/tmp/test.ts',
    startLine: 10,
    endLine: 15,
    text: 'console.log("hi");',
  });
  assert.equal(xml, '<ide_selection file="/tmp/test.ts" lines="10-15">\nconsole.log("hi");\n</ide_selection>');
});

test('formatSelectionStatus formats singular and plural line counts', () => {
  assert.equal(formatSelectionStatus({ lineCount: 1 }), '• 1 line selected');
  assert.equal(formatSelectionStatus({ lineCount: 12 }), '• 12 lines selected');
});

test('before_agent_start injects ide_selection context when selection is present', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clause-omp-test-'));
  const store = openStore(root);
  const workspace = join(root, 'workspace');
  store.writeSelection(workspace, {
    filePath: join(workspace, 'a.ts'),
    startLine: 1,
    endLine: 3,
    lineCount: 3,
    text: 'const x = 1;\n',
  });

  try {
    const handlers = new Map();
    const fakePi = {
      on(event, handler) {
        handlers.set(event, handler);
      },
    };
    clause(fakePi, { storeRoot: root });

    const beforeStart = handlers.get('before_agent_start');
    assert.ok(beforeStart !== undefined);

    const result = await beforeStart({ reason: 'prompt' }, { cwd: workspace });
    assert.ok(result?.message !== undefined);
    assert.equal(result.message.customType, 'clause-selection');
    assert.match(result.message.content, /<ide_selection file=".*a\.ts" lines="1-3">/);
    assert.match(result.message.content, /const x = 1;/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('selection polling updates and clears ctx.ui.setStatus', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clause-omp-test-'));
  const store = openStore(root);
  const workspace = join(root, 'workspace');

  try {
    const statuses = [];
    const fakeCtx = {
      cwd: workspace,
      ui: {
        setStatus(key, text) {
          statuses.push({ key, text });
        },
      },
    };
    const handlers = new Map();
    const fakePi = {
      on(event, handler) {
        handlers.set(event, handler);
      },
    };
    clause(fakePi, { storeRoot: root, pollIntervalMs: 50 });

    const sessionStart = handlers.get('session_start');
    assert.ok(sessionStart !== undefined);
    await sessionStart({}, fakeCtx);

    // Initially no selection
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(statuses.length, 0);

    // Write selection
    store.writeSelection(workspace, {
      filePath: join(workspace, 'b.ts'),
      startLine: 5,
      endLine: 10,
      lineCount: 6,
      text: 'hello\n',
    });

    await new Promise((resolve) => setTimeout(resolve, 120));
    const active = statuses.find((s) => s.key === 'clause-selection' && s.text !== undefined);
    assert.ok(active !== undefined);
    assert.equal(active.text, '• 6 lines selected');

    // Clear selection
    store.clearSelection(workspace);
    await new Promise((resolve) => setTimeout(resolve, 120));
    const cleared = statuses[statuses.length - 1];
    assert.equal(cleared.key, 'clause-selection');
    assert.equal(cleared.text, undefined);

    // Shutdown stops timer
    const sessionShutdown = handlers.get('session_shutdown');
    assert.ok(sessionShutdown !== undefined);
    await sessionShutdown({}, fakeCtx);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
