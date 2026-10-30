/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import * as fs from 'fs';
import * as path from 'path';
import { KeyObject, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from 'crypto';

const ENCRYPTED_FILE = 'zero-egress-proof-key';
const PLAIN_FILE = 'zero-egress-proof-key.pem';
// DER SubjectPublicKeyInfo prefix for an Ed25519 key; the raw 32-byte key follows it.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export interface SafeStorageLike {
	isEncryptionAvailable(): boolean;
	encryptString(s: string): Buffer;
	decryptString(b: Buffer): string;
}

function rawPublicKey(key: KeyObject): Buffer {
	return createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(ED25519_SPKI_PREFIX.length);
}

/** The device's Ed25519 signing key for Egress Proof reports. Created on first use; never leaves the machine. */
export class EgressProofKey {

	/**
	 * Loads the key from `dir`, creating it on first use. The private key is kept encrypted with `safe` when encryption
	 * is available, otherwise as an owner-only PEM file. An existing key is always reused, never silently replaced.
	 */
	static load(dir: string, safe: SafeStorageLike): EgressProofKey {
		const encryptedPath = path.join(dir, ENCRYPTED_FILE);
		const plainPath = path.join(dir, PLAIN_FILE);
		if (fs.existsSync(encryptedPath)) {
			if (!safe.isEncryptionAvailable()) {
				throw new Error('The Egress Proof signing key is encrypted, but OS encryption is not available right now.');
			}
			return new EgressProofKey(createPrivateKey(safe.decryptString(fs.readFileSync(encryptedPath))), 'safeStorage');
		}
		if (fs.existsSync(plainPath)) {
			if (process.platform !== 'win32') { fs.chmodSync(plainPath, 0o600); } // keep it owner-only even if it was loosened
			return new EgressProofKey(createPrivateKey(fs.readFileSync(plainPath, 'utf8')), 'file');
		}
		const { privateKey } = generateKeyPairSync('ed25519');
		const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
		fs.mkdirSync(dir, { recursive: true });
		if (safe.isEncryptionAvailable()) {
			fs.writeFileSync(encryptedPath, safe.encryptString(pem), { mode: 0o600, flag: 'wx' });
			return new EgressProofKey(privateKey, 'safeStorage');
		}
		fs.writeFileSync(plainPath, pem, { mode: 0o600, flag: 'wx' });
		fs.chmodSync(plainPath, 0o600); // the mode above is masked by the umask
		return new EgressProofKey(privateKey, 'file');
	}

	/** Raw 32-byte public key, base64. */
	readonly publicKey: string;
	/** First 16 hex chars of sha256(raw public key), as `xxxx-xxxx-xxxx-xxxx`. */
	readonly fingerprint: string;

	private constructor(private readonly privateKey: KeyObject, readonly storage: 'safeStorage' | 'file') {
		const raw = rawPublicKey(privateKey);
		this.publicKey = raw.toString('base64');
		this.fingerprint = EgressProofKey.fingerprintOf(raw);
	}

	static fingerprintOf(rawPublicKey: Buffer): string {
		return createHash('sha256').update(rawPublicKey).digest('hex').slice(0, 16).match(/.{4}/g)!.join('-');
	}

	/** Ed25519 signature of the UTF-8 bytes of `data`, base64. */
	sign(data: string): string {
		return sign(null, Buffer.from(data, 'utf8'), this.privateKey).toString('base64');
	}

	static verify(publicKey: string, data: string, signature: string): boolean {
		try {
			const raw = Buffer.from(publicKey, 'base64');
			if (raw.length !== 32) { return false; }
			const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, raw]), format: 'der', type: 'spki' });
			return verify(null, Buffer.from(data, 'utf8'), key, Buffer.from(signature, 'base64'));
		} catch {
			return false;
		}
	}
}
