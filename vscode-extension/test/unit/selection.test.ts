import test from 'node:test';
import assert from 'node:assert/strict';
import { extractSelectionPayload } from '../../src/nav.ts';

test('extractSelectionPayload returns null for empty selection', () => {
  const result = extractSelectionPayload(
    {
      isEmpty: true,
      start: { line: 5, character: 0 },
      end: { line: 5, character: 0 },
    },
    '/path/to/file.ts',
    '',
  );
  assert.equal(result, null);
});

test('extractSelectionPayload calculates lines and extracts text correctly', () => {
  const result = extractSelectionPayload(
    {
      isEmpty: false,
      start: { line: 2, character: 4 },
      end: { line: 4, character: 10 },
    },
    '/path/to/file.ts',
    'line1\nline2\nline3',
  );
  assert.ok(result !== null);
  assert.equal(result.startLine, 3);
  assert.equal(result.endLine, 5);
  assert.equal(result.lineCount, 3);
  assert.equal(result.text, 'line1\nline2\nline3');
  assert.equal(result.filePath, '/path/to/file.ts');
});

test('extractSelectionPayload handles selection ending at character 0 of next line', () => {
  const result = extractSelectionPayload(
    {
      isEmpty: false,
      start: { line: 2, character: 0 },
      end: { line: 4, character: 0 },
    },
    '/path/to/file.ts',
    'line1\nline2\n',
  );
  assert.ok(result !== null);
  assert.equal(result.startLine, 3);
  assert.equal(result.endLine, 4);
  assert.equal(result.lineCount, 2);
  assert.equal(result.text, 'line1\nline2\n');
});

test('extractSelectionPayload caps text and lines to limits', () => {
  const longText = 'a'.repeat(200_000);
  const result = extractSelectionPayload(
    {
      isEmpty: false,
      start: { line: 0, character: 0 },
      end: { line: 3000, character: 10 },
    },
    '/path/to/file.ts',
    longText,
  );
  assert.ok(result !== null);
  assert.equal(result.lineCount, 2000);
  assert.equal(result.endLine, 2000);
  assert.equal(result.text.length, 128 * 1024);
});
