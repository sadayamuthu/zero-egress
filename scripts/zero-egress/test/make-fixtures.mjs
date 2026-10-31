// Generates fixtures/good.json and fixtures/good.pdf from the compiled out/ modules (run `npm run compile` first).
// Usage: node scripts/zero-egress/test/make-fixtures.mjs
// The signing key is a throwaway one in a temp dir; the PDF is a stand-in (any bytes) whose sha256 goes into the body.

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const out = join(root, 'out', 'vs', 'workbench', 'contrib', 'zeroEgress');
const load = p => import(pathToFileURL(join(out, p)).href);

export async function loadTs() {
	const [proof, audit, keyMod] = await Promise.all([
		load('common/egressProof.js'), load('common/auditTypes.js'), load('electron-main/egressLedger/egressProofKey.js'),
	]);
	return { proof, audit, keyMod };
}

async function main() {
	const { proof, audit, keyMod } = await loadTs();
	const bodies = [
		{ type: 'session_start', time: '2026-10-01T08:00:00.000Z', version: '1.0.0', commit: 'abc1234' },
		{ type: 'heartbeat', hour: '2026-10-01T08:00:00.000Z' },
		{ type: 'allowed', hour: '2026-10-01T08:00:00.000Z', dest: '127.0.0.1:11434', kind: 'this machine', reason: 'this machine', origin: 'main', count: 12 },
		{ type: 'allowed', hour: '2026-10-01T08:00:00.000Z', dest: '192.168.1.20:8080', kind: 'local network', reason: 'model server (set in Settings)', origin: 'renderer', count: 3 },
		{ type: 'blocked', minute: '2026-10-01T08:05:00.000Z', dest: 'telemetry.example.com:443', origin: 'extensionHost', count: 4 },
		{ type: 'blocked_lookup', minute: '2026-10-01T08:06:00.000Z', host: 'tracker.example.net', origin: 'sharedProcess', count: 2 },
		{ type: 'heartbeat', hour: '2026-10-01T09:00:00.000Z' },
		{ type: 'allowed', hour: '2026-10-01T09:00:00.000Z', dest: '127.0.0.1:11434', kind: 'this machine', reason: 'this machine', origin: 'main', count: 5 },
		{ type: 'blocked', minute: '2026-10-01T09:10:00.000Z', dest: 'telemetry.example.com:443', origin: 'renderer', count: 1 },
		// crash: no session_end before the next start
		{ type: 'session_start', time: '2026-10-01T11:30:00.000Z', version: '1.0.0', commit: 'abc1234' },
		{ type: 'heartbeat', hour: '2026-10-01T11:00:00.000Z' },
		{ type: 'session_end', time: '2026-10-01T12:00:00.000Z' },
	];
	const records = [];
	let prev = audit.GENESIS_HASH;
	bodies.forEach((body, i) => {
		const seq = i + 1;
		records.push({ seq, prevHash: prev, body });
		prev = audit.chainHash(prev, { seq, body: JSON.parse(JSON.stringify(body)) });
	});

	const dir = mkdtempSync(join(tmpdir(), 'egress-fixture-key-'));
	try {
		const key = keyMod.EgressProofKey.load(dir, { isEncryptionAvailable: () => false, encryptString: () => { throw new Error('unused'); }, decryptString: () => { throw new Error('unused'); } });
		const body = proof.buildEgressProof(records, {
			createdAt: '2026-10-01T13:00:00.000Z',
			period: { from: '2026-10-01T00:00:00.000Z', to: '2026-10-02T00:00:00.000Z' },
			identity: { machineId: 'fixture-machine', user: 'fixture-user', version: '1.0.0', commit: 'abc1234', os: 'fixture-os', networkSettings: [] },
			modelUsage: null,
			recordingSince: '2026-10-01T08:00:00.000Z',
			key: { publicKey: key.publicKey, fingerprint: key.fingerprint, storage: key.storage },
		});
		const pdf = Buffer.from('%PDF-1.4\n% stand-in PDF for the verify script fixtures\n%%EOF\n');
		body.pdfSha256 = createHash('sha256').update(pdf).digest('hex');
		const signature = key.sign(proof.canonicalProof(body));
		const fixtures = join(here, 'fixtures');
		mkdirSync(fixtures, { recursive: true });
		writeFileSync(join(fixtures, 'good.json'), JSON.stringify({ ...body, signature }, undefined, '\t'));
		writeFileSync(join(fixtures, 'good.pdf'), pdf);
		console.log('wrote good.json and good.pdf');
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) { await main(); }
