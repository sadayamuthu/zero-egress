#!/usr/bin/env node
/**
 * Patch-bump product.json zeroEgressVersion and increment zeroEgressRelease.
 *
 * Usage:
 *   node scripts/zero-egress/bump-version.mjs           # write product.json, print new version
 *   node scripts/zero-egress/bump-version.mjs --dry-run # print next version only
 *   node scripts/zero-egress/bump-version.mjs --latest <file>  # also consider this product.json
 *
 * zeroEgressVersion: 0.1.0 → 0.1.1 (patch)
 * zeroEgressRelease: 0001 → 0002 (monotonic counter, zero-padded to 4)
 *
 * Release commits live only on their tags (main is protected), so main's product.json falls behind.
 * --latest passes the product.json of the newest release tag; the bump starts from whichever of the two
 * is higher, version and counter separately.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const productPath = path.join(root, 'product.json');
const dryRun = process.argv.includes('--dry-run');
const latestIdx = process.argv.indexOf('--latest');
const latestPath = latestIdx >= 0 ? process.argv[latestIdx + 1] : undefined;
if (latestIdx >= 0 && !latestPath) {
	console.error('--latest needs a product.json path');
	process.exit(1);
}

const raw = fs.readFileSync(productPath, 'utf8');
const product = JSON.parse(raw);

function parseVersion(p, where) {
	const version = String(p.zeroEgressVersion || '');
	const parts = version.split('.').map((n) => Number(n));
	if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) {
		console.error(`Invalid zeroEgressVersion in ${where}: ${JSON.stringify(version)}`);
		process.exit(1);
	}
	return parts;
}

function parseRelease(p, where) {
	const n = Number.parseInt(String(p.zeroEgressRelease || '0'), 10);
	if (!Number.isInteger(n) || n < 0) {
		console.error(`Invalid zeroEgressRelease in ${where}: ${JSON.stringify(p.zeroEgressRelease)}`);
		process.exit(1);
	}
	return n;
}

const compare = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];

let parts = parseVersion(product, 'product.json');
let releaseNum = parseRelease(product, 'product.json');
if (latestPath) {
	const latest = JSON.parse(fs.readFileSync(latestPath, 'utf8'));
	const latestParts = parseVersion(latest, latestPath);
	if (compare(latestParts, parts) > 0) { parts = latestParts; }
	releaseNum = Math.max(releaseNum, parseRelease(latest, latestPath));
}
parts = [parts[0], parts[1], parts[2] + 1];
const nextVersion = parts.join('.');
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
