import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, rmSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { AppLogger } from '../src/logger.js';

test('logs retain exactly the latest 50 entries and do not allow injected new lines', () => {
  const log = new AppLogger();
  for (let i = 0; i < 80; i++) log.info(`event-${String(i).padStart(3, '0')}`);
  const lines = log.recent();
  assert.equal(lines.length, 50);
  assert.match(lines[0]!, /event-030/);
  assert.match(lines.at(-1)!, /event-079/);
  log.info('one\nFORGED\rline');
  assert.ok(!log.recent().at(-1)!.includes('\n'));
  assert.equal(log.recent(999).length, 50);
});
test('tokens, authorization values, URL credentials and structured secrets are redacted', () => {
  const token = '123456789:abcdefghijklmnopqrstuvwxyz_12345';
  const log = new AppLogger({ secrets: [token] });
  log.error(
    `POST https://api.telegram.org/bot${token}/sendMessage Authorization: Bearer abc-secret`,
    {
      token,
      password: 'pass-secret',
      nested: { api_key: 'key-secret' },
      detail: 'https://user:secret@host.example/path',
      error: '{"api_key":"embedded-secret"}',
    },
  );
  const text = log.recent().join('\n');
  for (const secret of [
    token,
    'abc-secret',
    'pass-secret',
    'key-secret',
    'user:secret',
    'embedded-secret',
  ])
    assert.ok(!text.includes(secret));
  assert.ok(text.includes('[REDACTED]'));
  assert.ok(text.includes('host.example'));
});
test('file logs survive restart, are bounded and apply redaction again on reading', () => {
  const root = mkdtempSync(join(tmpdir(), 'dujiao-logs-'));
  try {
    const log = new AppLogger({ directory: root, maxBytes: 2048 });
    for (let i = 0; i < 120; i++) log.info(`event-${i} ${'detail'.repeat(12)}`);
    assert.ok(statSync(join(root, 'runtime.log')).size <= 2048);
    assert.ok(statSync(join(root, 'runtime.log.1')).size <= 2048);
    const reopened = new AppLogger({ directory: root, maxBytes: 2048 });
    assert.match(reopened.recent().at(-1)!, /event-119/);
    assert.ok(reopened.recent().length <= 50);
    log.info('token=private-value');
    assert.ok(!readFileSync(join(root, 'runtime.log'), 'utf8').includes('private-value'));
    appendFileSync(join(root, 'runtime.log'), 'old token=old-secret-value\n');
    assert.ok(!reopened.recent().join('\n').includes('old-secret-value'));
  } finally {
    assert.equal(dirname(resolve(root)), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('dujiao-logs-'));
    rmSync(root, { recursive: true, force: true });
  }
});
