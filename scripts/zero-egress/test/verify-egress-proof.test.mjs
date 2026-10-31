import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { copyFileSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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

const stableStringify = v => v === null || typeof v !== 'object' ? JSON.stringify(v)
	: Array.isArray(v) ? '[' + v.map(stableStringify).join(',') + ']'
		: '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}';

/** The attack: a report signed with the attacker's own key that states the real device's fingerprint. Its signature is valid. */
function forgedFingerprint() {
	const report = JSON.parse(readFileSync(GOOD_JSON, 'utf8'));
	const { publicKey, privateKey } = generateKeyPairSync('ed25519');
	report.key = { ...report.key, publicKey: publicKey.export({ type: 'spki', format: 'der' }).subarray(12).toString('base64') }; // fingerprint kept: the victim's
	delete report.signature;
	report.signature = sign(null, Buffer.from(stableStringify(report), 'utf8'), privateKey).toString('base64');
	const p = join(tmp, 'forged-fingerprint.json');
	writeFileSync(p, JSON.stringify(report, undefined, '\t'));
	return p;
}

test('good report passes', () => {
	const r = run(GOOD_JSON, GOOD_PDF);
	assert.equal(r.status, 0, r.stdout + r.stderr);
	assert.match(r.stdout, /✓ Signature valid/);
	assert.match(r.stdout, /✓ PDF matches JSON/);
	assert.match(r.stdout, /✓ Fingerprint matches the public key/);
	assert.match(r.stdout, /Key fingerprint: [0-9a-f]{4}(-[0-9a-f]{4}){7}\n/);
	assert.doesNotMatch(r.stdout, /unverified/);
	assert.match(r.stdout, /does not prove the machine itself wasn't tampered with\./);
});

test('tampered report exits 1', () => {
	const r = run(tampered());
	assert.equal(r.status, 1);
	assert.match(r.stdout, /✗ Signature valid/);
	assert.match(r.stdout, /✗ Every row recomputes from the records - Row for 127\.0\.0\.1:11434 /);
});

test('valid signature with a forged fingerprint exits 1 and labels the key unverified', () => {
	const r = run(forgedFingerprint(), GOOD_PDF);
	assert.equal(r.status, 1, r.stdout);
	assert.match(r.stdout, /✓ Signature valid/);
	assert.match(r.stdout, /✗ Fingerprint matches the public key - The report states /);
	assert.match(r.stdout, /Key fingerprint: [0-9a-f-]+ \(unverified\)/);
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

// A downloaded copy run through a symlinked path (macOS /var, /tmp) must still run its checks.
test('runs when invoked through a symlinked path', () => {
	const real = mkdtempSync(join(tmpdir(), 'verify-egress-proof-real-'));
	copyFileSync(script, join(real, 'verify-egress-proof.mjs'));
	const link = join(tmp, 'linked');
	symlinkSync(real, link);
	const linked = join(link, 'verify-egress-proof.mjs');
	assert.equal(spawnSync(process.execPath, [linked], { encoding: 'utf8' }).status, 2);
	const good = spawnSync(process.execPath, [linked, GOOD_JSON, GOOD_PDF], { encoding: 'utf8' });
	assert.equal(good.status, 0);
	assert.match(good.stdout, /✓ Signature valid/);
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
	for (const file of [GOOD_JSON, tampered(), forgedFingerprint()]) {
		const text = readFileSync(file, 'utf8');
		const pdf = readFileSync(GOOD_PDF);
		const inRepo = await verifyReportText(text, pdf, undefined);
		const port = portText(text, pdf);
		assert.deepEqual(port.checks.map(c => [c.name, c.ok, c.detail]), inRepo.checks.map(c => [c.name, c.ok, c.detail]));
		assert.equal(port.fingerprint, inRepo.fingerprint);
		if (file !== GOOD_JSON) { assert.ok(inRepo.checks.some(c => !c.ok), `${file} must fail`); }
	}
	const forged = await verifyReportText(readFileSync(forgedFingerprint(), 'utf8'), undefined, undefined);
	assert.deepEqual(forged.checks.slice(0, 2).map(c => [c.name, c.ok]), [['Signature valid', true], ['Fingerprint matches the public key', false]]);
});
