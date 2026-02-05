import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.PIPEDRIVE_NOTES_BLOCK_BASE_WINDOW_MINUTES = process.env.PIPEDRIVE_NOTES_BLOCK_BASE_WINDOW_MINUTES || '15';
process.env.PIPEDRIVE_NOTES_BLOCK_MIN_WINDOW_MINUTES = process.env.PIPEDRIVE_NOTES_BLOCK_MIN_WINDOW_MINUTES || '5';
process.env.PIPEDRIVE_NOTES_BLOCK_MAX_WINDOW_MINUTES = process.env.PIPEDRIVE_NOTES_BLOCK_MAX_WINDOW_MINUTES || '60';

const {
  buildNoteAppendHtml,
  computeAdaptiveWindowMinutes,
  estimateHtmlBytes,
  shouldStartNewBlockByWindow,
} = await import('../src/services/pipedrive/notesEngine.js');

test('computeAdaptiveWindowMinutes escolhe janela curta em alta cadência', () => {
  const startedAtIso = new Date(Date.now() - 10 * 60_000).toISOString();
  const windowMinutes = computeAdaptiveWindowMinutes({ startedAtIso, messageCount: 120, bytes: 10_000 });
  assert.equal(windowMinutes, 5);
});

test('computeAdaptiveWindowMinutes escolhe janela média em cadência média', () => {
  const startedAtIso = new Date(Date.now() - 10 * 60_000).toISOString();
  const windowMinutes = computeAdaptiveWindowMinutes({ startedAtIso, messageCount: 30, bytes: 10_000 });
  assert.equal(windowMinutes, 10);
});

test('computeAdaptiveWindowMinutes escolhe janela maior em baixa cadência', () => {
  const startedAtIso = new Date(Date.now() - 30 * 60_000).toISOString();
  const windowMinutes = computeAdaptiveWindowMinutes({ startedAtIso, messageCount: 0, bytes: 100 });
  assert.equal(windowMinutes, 30);
});

test('estimateHtmlBytes inclui overhead de HTML', () => {
  const html = '<p>Olá</p>\n<hr/>\n<p>fim</p>';
  assert.ok(estimateHtmlBytes(html) > 0);
});

test('buildNoteAppendHtml inclui marcadores mid e faz escape HTML', () => {
  const html = buildNoteAppendHtml([
    { message_id: 'm1', ts_ms: 1, direction: 'inbound', text: '<b>oi</b>' },
  ]);
  assert.match(html, /<!--mid:m1-->/);
  assert.match(html, /&lt;b&gt;oi&lt;\/b&gt;/);
});

test('shouldStartNewBlockByWindow retorna true quando passou da janela', () => {
  const startedAtIso = new Date(Date.now() - 16 * 60_000).toISOString();
  assert.equal(shouldStartNewBlockByWindow({ startedAtIso, windowMinutes: 15 }), true);
});
