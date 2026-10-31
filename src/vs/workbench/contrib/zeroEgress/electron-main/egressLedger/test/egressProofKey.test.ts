/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fs from 'fs';
import { EgressProofKey, osEncryptionUsable } from '../egressProofKey.js';

suite('EgressProofKey', () => {
	let dir: string;

	setup(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zero-egress-proof-key-')); });
	teardown(() => { fs.rmSync(dir, { recursive: true, force: true }); });

	function fakeSafe(available: boolean, backend?: string) {
		const encrypted: string[] = [];
		return {
			encrypted,
			getSelectedStorageBackend: backend === undefined ? undefined : () => backend,
			isEncryptionAvailable: () => available,
			encryptString: (s: string) => { encrypted.push(s); return Buffer.from('enc:' + Buffer.from(s).toString('base64')); },
			decryptString: (b: Buffer) => Buffer.from(b.toString().slice(4), 'base64').toString(),
		};
	}

	test('creates once and reloads the same key', () => {
		const safe = fakeSafe(true);
		const a = EgressProofKey.load(dir, safe);
		const b = EgressProofKey.load(dir, safe);
		assert.strictEqual(b.publicKey, a.publicKey);
		assert.strictEqual(b.fingerprint, a.fingerprint);
		assert.strictEqual(Buffer.from(a.publicKey, 'base64').length, 32);
		assert.match(a.fingerprint, /^[0-9a-f]{4}(-[0-9a-f]{4}){7}$/, '128 bits, eight groups');
		assert.strictEqual(EgressProofKey.fingerprintOfBase64(a.publicKey), a.fingerprint);
		assert.strictEqual(EgressProofKey.fingerprintOfBase64('c2hvcnQ='), undefined);
		assert.strictEqual(EgressProofKey.fingerprintOfBase64(42), undefined);
		assert.strictEqual(safe.encrypted.length, 1, 'the key is created only once');
	});

	test('uses encryption when available', () => {
		const safe = fakeSafe(true);
		const key = EgressProofKey.load(dir, safe);
		assert.strictEqual(key.storage, 'safeStorage');
		assert.strictEqual(safe.encrypted.length, 1);
		assert.match(safe.encrypted[0], /BEGIN PRIVATE KEY/);
		assert.ok(fs.existsSync(path.join(dir, 'zero-egress-proof-key')));
		assert.ok(!fs.existsSync(path.join(dir, 'zero-egress-proof-key.pem')));
		assert.ok(!fs.readFileSync(path.join(dir, 'zero-egress-proof-key')).toString().includes('PRIVATE KEY'));
	});

	test('falls back to an owner-only file', () => {
		const safe = fakeSafe(false);
		const key = EgressProofKey.load(dir, safe);
		assert.strictEqual(key.storage, 'file');
		assert.strictEqual(safe.encrypted.length, 0);
		const file = path.join(dir, 'zero-egress-proof-key.pem');
		assert.match(fs.readFileSync(file, 'utf8'), /BEGIN PRIVATE KEY/);
		if (process.platform !== 'win32') {
			assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
		}
		assert.strictEqual(EgressProofKey.load(dir, safe).publicKey, key.publicKey);
		if (process.platform !== 'win32') {
			fs.chmodSync(file, 0o644);
			EgressProofKey.load(dir, safe);
			assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600, 'a reused key file is made owner-only again');
		}
	});

	test('on Linux, the basic_text or unknown backend is not OS encryption: owner-only file instead', () => {
		for (const backend of ['basic_text', 'unknown']) {
			const sub = fs.mkdtempSync(path.join(dir, 'k-'));
			const safe = fakeSafe(true, backend);
			const key = EgressProofKey.load(sub, safe, 'linux');
			assert.strictEqual(key.storage, 'file', backend);
			assert.strictEqual(safe.encrypted.length, 0);
			assert.ok(fs.existsSync(path.join(sub, 'zero-egress-proof-key.pem')));
		}
		assert.strictEqual(osEncryptionUsable(fakeSafe(true, 'gnome_libsecret'), 'linux'), true);
		assert.strictEqual(osEncryptionUsable(fakeSafe(true, 'basic_text'), 'darwin'), true, 'the backend only matters on Linux');
		assert.strictEqual(osEncryptionUsable(fakeSafe(false, 'gnome_libsecret'), 'linux'), false);
	});

	test('on Linux, a key encrypted under basic_text is reused but reported as a file', () => {
		const first = EgressProofKey.load(dir, fakeSafe(true, 'gnome_libsecret'), 'linux');
		assert.strictEqual(first.storage, 'safeStorage');
		const again = EgressProofKey.load(dir, fakeSafe(true, 'basic_text'), 'linux');
		assert.strictEqual(again.publicKey, first.publicKey);
		assert.strictEqual(again.storage, 'file');
	});

	test('sign and verify round trip; tampered data fails', () => {
		const key = EgressProofKey.load(dir, fakeSafe(true));
		const sig = key.sign('{"a":1}');
		assert.strictEqual(EgressProofKey.verify(key.publicKey, '{"a":1}', sig), true);
		assert.strictEqual(EgressProofKey.verify(key.publicKey, '{"a":2}', sig), false);
		assert.strictEqual(EgressProofKey.verify(key.publicKey, '{"a":1}', 'not a signature'), false);
		assert.strictEqual(EgressProofKey.verify('bad key', '{"a":1}', sig), false);
	});
});
