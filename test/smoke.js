#!/usr/bin/env node
// Smoke test: builds a synthetic transcript, runs the CLI against it, asserts the numbers.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const assert = require('assert');

const CLI = path.join(__dirname, '..', 'bin', 'claude-wrapped.js');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccw-test-'));
const projDir = path.join(tmp, '-Users-test-myproject');
fs.mkdirSync(projDir, { recursive: true });

const ts = h => `2026-03-0${1 + Math.floor(h / 24)}T${String(h % 24).padStart(2, '0')}:00:00.000Z`;
const lines = [
  // real user prompt
  { type: 'user', message: { role: 'user', content: 'hola' }, timestamp: ts(10), sessionId: 's1' },
  // assistant with usage + tool_use (Bash and Edit)
  { type: 'assistant', timestamp: ts(10), sessionId: 's1', message: { role: 'assistant', model: 'claude-sonnet-4-6', usage: { input_tokens: 1000, output_tokens: 500, cache_creation_input_tokens: 200, cache_read_input_tokens: 8000 }, content: [
    { type: 'tool_use', name: 'Bash', input: { command: 'git status' } },
    { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/app.py' } },
  ] } },
  // tool result (should count as toolResult, one error)
  { type: 'user', timestamp: ts(11), sessionId: 's1', message: { role: 'user', content: [{ type: 'tool_result', is_error: true }] } },
  // second assistant, fable model
  { type: 'assistant', timestamp: ts(11), sessionId: 's1', message: { role: 'assistant', model: 'claude-fable-5', usage: { input_tokens: 2000, output_tokens: 1500, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }, content: [
    { type: 'tool_use', name: 'Agent', input: {} },
  ] } },
  // noise entries that must be ignored
  { type: 'queue-operation', operation: 'enqueue', timestamp: ts(11) },
  { type: 'ai-title', timestamp: ts(11) },
  'not-even-json{{{',
];
fs.writeFileSync(path.join(projDir, 's1.jsonl'), lines.map(l => typeof l === 'string' ? l : JSON.stringify(l)).join('\n'));

const out = execFileSync('node', [CLI, '--dir', tmp, '--json'], { encoding: 'utf8' });
const s = JSON.parse(out);

assert.equal(s.sessions, 1, 'sessions');
assert.equal(s.userPrompts, 1, 'userPrompts');
assert.equal(s.assistantMsgs, 2, 'assistantMsgs');
assert.equal(s.toolResults, 1, 'toolResults');
assert.equal(s.toolErrors, 1, 'toolErrors');
assert.equal(s.tokens.input, 3000, 'input tokens');
assert.equal(s.tokens.output, 2000, 'output tokens');
assert.equal(s.tokens.cacheRead, 8000, 'cacheRead tokens');
assert.equal(s.tools.Bash, 1, 'bash tool count');
assert.equal(s.tools.Edit, 1, 'edit tool count');
assert.equal(s.agentSpawns, 1, 'agent spawns');
assert.equal(s.files['app.py'], 1, 'edited file tracked');
assert.equal(s.bashCmds.git, 1, 'bash command tracked');
assert.ok(s.models['Sonnet'] && s.models['Fable 5'], 'model split');
// cost: sonnet 1000*3 + 500*15 + 200*3*1.25 + 8000*0.3 → μ$; fable 2000*20 + 1500*100
const expected = (1000*3 + 500*15 + 200*3.75 + 8000*0.3 + 2000*20 + 1500*100) / 1e6;
assert.ok(Math.abs(s.cost - expected) < 1e-9, `cost ${s.cost} ≈ ${expected}`);
assert.equal(s.derived.daysActive, 1, 'days active');
assert.ok(s.derived.topTools.length >= 3, 'top tools present');

// HTML generation works and embeds data
const html = path.join(tmp, 'r.html');
execFileSync('node', [CLI, '--dir', tmp, '--out', html, '--no-open'], { encoding: 'utf8' });
const doc = fs.readFileSync(html, 'utf8');
assert.ok(doc.includes('Claude Code Wrapped'), 'html title');
assert.ok(doc.includes('"sessions":1'), 'html embeds stats');

// demo mode works
execFileSync('node', [CLI, '--demo', '--out', path.join(tmp, 'demo.html'), '--no-open']);

fs.rmSync(tmp, { recursive: true, force: true });
console.log('✓ all smoke tests passed');
