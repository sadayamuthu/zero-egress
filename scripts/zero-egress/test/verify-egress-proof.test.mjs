import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, '..', 'verify-egress-proof.mjs');
const GOOD_JSON = join(here, 'fixtures', 'good.json');
const GOOD_PDF = join(here, 'fixtures', 'good.pdf');
const tmp = mkdtempSync(join(tmpdir(), 'verify-egress-proof-'));

const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });

function tampered() {
	const report = JSON.parse(readFileSync(GOOD_JSON, 'utf8'));
	report.allowed.find(r => r.dest === '127.0.0.1:11434').count -= 1;
	const p = join(tmp, 'tampered.json');
	writeFileSync(p, JSON.stringify(report, undefined, '\t'));
	return p;
}

test('good report passes', () => {
	const r = run(GOOD_JSON, GOOD_PDF);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /✓ Signature valid/);
	assert.match(r.stdout, /✓ PDF matches JSON/);
	assert.match(r.stdout, /Key fingerprint: \w{4}-\w{4}-\w{4}-\w{4}/);
	assert.match(r.stdout, /does not prove the machine itself wasn't tampered with\./);
});

test('tampered report exits 1', () => {
	const r = run(tampered());
	assert.equal(r.status, 1);
	assert.match(r.stdout, /✗ Signature valid/);
	assert.match(r.stdout, /✗ Every row recomputes from the records - Row for 127\.0\.0\.1:11434 /);
});

test('pdf mismatch exits 1', () => {
	const other = join(tmp, 'other.pdf');
	writeFileSync(other, 'not the pdf');
	const r = run(GOOD_JSON, other);
	assert.equal(r.status, 1);
	assert.match(r.stdout, /✗ PDF matches JSON/);
});

test('usage exits 2', () => {
	assert.equal(run().status, 2);
	assert.equal(run('a', 'b', 'c').status, 2);
});

test('script and the in-repo TS checker agree on every check', async (t) => {
	let ts;
	try {
		ts = await (await import('./make-fixtures.mjs')).loadTs();
		const probe = await import(pathToFileURL(join(here, '..', '..', '..', 'out', 'vs', 'workbench', 'contrib', 'zeroEgress', 'electron-main', 'egressLedger', 'egressProofReport.js')).href);
		ts.verifyReportText = probe.verifyReportText;
	} catch (e) {
		t.skip(`compiled out/ not available: ${e.message}`);
		return;
	}
	const { verifyReportText } = ts;
	const { verifyReportText: portText } = await import(pathToFileURL(script).href);
	for (const file of [GOOD_JSON, tampered()]) {
		const text = readFileSync(file, 'utf8');
		const pdf = readFileSync(GOOD_PDF);
		const expected = (await verifyReportText(text, pdf, undefined)).map(c => [c.name, c.ok, c.detail]);
		const actual = portText(text, pdf).checks.map(c => [c.name, c.ok, c.detail]);
		assert.deepEqual(actual, expected);
	}
});
