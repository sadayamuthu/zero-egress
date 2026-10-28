#!/usr/bin/env node
/**
 * Patch-bump product.json zeroEgressVersion and increment zeroEgressRelease.
 *
 * Usage:
 *   node scripts/zero-egress/bump-version.mjs           # write product.json, print new version
 *   node scripts/zero-egress/bump-version.mjs --dry-run # print next version only
 *
 * zeroEgressVersion: 0.1.0 → 0.1.1 (patch)
 * zeroEgressRelease: 0001 → 0002 (monotonic counter, zero-padded to 4)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const productPath = path.join(root, 'product.json');
const dryRun = process.argv.includes('--dry-run');

const raw = fs.readFileSync(productPath, 'utf8');
const product = JSON.parse(raw);

const version = String(product.zeroEgressVersion || '');
const parts = version.split('.').map((p) => Number(p));
if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
	console.error(`Invalid zeroEgressVersion: ${JSON.stringify(version)}`);
	process.exit(1);
}
parts[2] += 1;
const nextVersion = parts.join('.');

const releaseNum = Number.parseInt(String(product.zeroEgressRelease || '0'), 10);
if (!Number.isInteger(releaseNum) || releaseNum < 0) {
	console.error(`Invalid zeroEgressRelease: ${JSON.stringify(product.zeroEgressRelease)}`);
	process.exit(1);
}
const nextRelease = String(releaseNum + 1).padStart(4, '0');

if (dryRun) {
	process.stdout.write(`${nextVersion}\n`);
	process.exit(0);
}

product.zeroEgressVersion = nextVersion;
product.zeroEgressRelease = nextRelease;
// Match existing product.json style (tabs + trailing newline).
fs.writeFileSync(productPath, `${JSON.stringify(product, null, '\t')}\n`);
process.stdout.write(`${nextVersion}\n`);
