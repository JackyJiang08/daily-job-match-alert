// Turns the redacted envelope a nightly run leaves in state/logs/claude-envelope-last.json into the
// recorded Claude usage fixture (tests/fixtures/usage/claude-result.json). The capture already holds only
// bookkeeping fields (usage, modelUsage, durations, stop reason); this script refuses a capture without a
// readable modelUsage and never copies answers or identifiers. Usage: npm run fixture:envelope
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { redactEnvelope } from '../src/engines/claude.mjs';
import { claudeUsageFromEnvelope } from '../src/engines/usage.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const capturePath = path.join(root, 'state', 'logs', 'claude-envelope-last.json');
const synthetic = path.join(root, 'tests', 'fixtures', 'usage', 'claude-result.synthetic.json');
const target = path.join(root, 'tests', 'fixtures', 'usage', 'claude-result.json');

let capture;
try {
  capture = JSON.parse(await fs.readFile(capturePath, 'utf8'));
} catch {
  console.error(`No capture at ${path.relative(root, capturePath)} yet; it is written by the next nightly run that scores with Claude.`);
  process.exit(1);
}
const envelope = redactEnvelope(capture.envelope || {});
const usage = claudeUsageFromEnvelope(envelope);
if (usage.parseEmpty) {
  console.error('The capture has no readable modelUsage; keep the synthetic fixture.');
  process.exit(1);
}
const previous = JSON.parse(await fs.readFile(synthetic, 'utf8').catch(() => '{}'));
const fixture = {
  note: `Recorded from a nightly run on ${capture.capturedAt} (state/logs/claude-envelope-last.json, Claude Code print mode, --output-format json). The capture keeps only bookkeeping fields; the model's answer and every session identifier were never written.`,
  envelope,
  ...(previous.errorEnvelope ? { errorEnvelope: previous.errorEnvelope } : {}),
};
await fs.writeFile(target, `${JSON.stringify(fixture, null, 2)}\n`);
console.log(`Wrote ${path.relative(root, target)}: models ${usage.models.map(item => item.model).join(', ')}`);
