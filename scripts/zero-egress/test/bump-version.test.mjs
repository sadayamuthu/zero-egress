#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '../bump-version.mjs');
const root = path.resolve(here, '../../..');

function fail(msg) {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
}

// Dry-run against the real product.json must print a valid next patch.
{
	const r = spawnSync(process.execPath, [script, '--dry-run'], { cwd: root, encoding: 'utf8' });
	if (r.status !== 0) fail(`dry-run exited ${r.status}: ${r.stderr}`);
	const next = r.stdout.trim();
	assert.match(next, /^\d+\.\d+\.\d+$/, `dry-run output not a semver: ${next}`);
	const cur = JSON.parse(fs.readFileSync(path.join(root, 'product.json'), 'utf8')).zeroEgressVersion;
	const [a, b, c] = cur.split('.').map(Number);
	assert.equal(next, `${a}.${b}.${c + 1}`);
}

// Write mode in a temp copy of product.json.
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ze-bump-'));
	const productPath = path.join(tmp, 'product.json');
	fs.writeFileSync(productPath, JSON.stringify({
		zeroEgressVersion: '1.2.3',
		zeroEgressRelease: '0007',
		nameShort: 'ZeroEgress',
	}, null, '\t') + '\n');

	// Run with ROOT overridden by placing a tiny wrapper: the script resolves
	// product.json relative to the repo. Copy the script logic via env isn't
	// supported, so invoke from a fake repo layout.
	const scriptsDir = path.join(tmp, 'scripts', 'zero-egress');
	fs.mkdirSync(scriptsDir, { recursive: true });
	fs.copyFileSync(script, path.join(scriptsDir, 'bump-version.mjs'));

	const r = spawnSync(process.execPath, [path.join(scriptsDir, 'bump-version.mjs')], {
		cwd: tmp,
		encoding: 'utf8',
	});
	if (r.status !== 0) fail(`write exited ${r.status}: ${r.stderr}`);
	assert.equal(r.stdout.trim(), '1.2.4');
	const updated = JSON.parse(fs.readFileSync(productPath, 'utf8'));
	assert.equal(updated.zeroEgressVersion, '1.2.4');
	assert.equal(updated.zeroEgressRelease, '0008');
	assert.equal(updated.nameShort, 'ZeroEgress');
}

// --latest: the newest release tag's product.json is ahead of main's; the bump starts from it.
{
	const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ze-bump-latest-'));
	const scriptsDir = path.join(tmp, 'scripts', 'zero-egress');
	fs.mkdirSync(scriptsDir, { recursive: true });
	fs.copyFileSync(script, path.join(scriptsDir, 'bump-version.mjs'));
	const write = (file, version, release) => fs.writeFileSync(file, JSON.stringify({ zeroEgressVersion: version, zeroEgressRelease: release }, null, '\t') + '\n');
	const productPath = path.join(tmp, 'product.json');
	const latestPath = path.join(tmp, 'latest.json');
	const run = (...args) => spawnSync(process.execPath, [path.join(scriptsDir, 'bump-version.mjs'), ...args], { cwd: tmp, encoding: 'utf8' });

	write(productPath, '0.1.0', '0001');
	write(latestPath, '0.1.9', '0010');
	let r = run('--latest', latestPath);
	if (r.status !== 0) fail(`--latest exited ${r.status}: ${r.stderr}`);
	assert.equal(r.stdout.trim(), '0.1.10');
	let updated = JSON.parse(fs.readFileSync(productPath, 'utf8'));
	assert.equal(updated.zeroEgressVersion, '0.1.10');
	assert.equal(updated.zeroEgressRelease, '0011');

	// main moved ahead of the tag (a manual minor bump): main wins; the counter still never goes back.
	write(productPath, '0.2.0', '0003');
	write(latestPath, '0.1.9', '0010');
	r = run('--latest', latestPath, '--dry-run');
	assert.equal(r.status, 0, r.stderr);
	assert.equal(r.stdout.trim(), '0.2.1');
	run('--latest', latestPath);
	updated = JSON.parse(fs.readFileSync(productPath, 'utf8'));
	assert.equal(updated.zeroEgressRelease, '0011');

	// numeric, not string, comparison: 0.1.10 is newer than 0.1.9
	write(productPath, '0.1.9', '0001');
	write(latestPath, '0.1.10', '0002');
	r = run('--latest', latestPath, '--dry-run');
	assert.equal(r.stdout.trim(), '0.1.11');

	r = run('--latest');
	assert.notEqual(r.status, 0, '--latest without a path must fail');
}

console.log('bump-version tests OK');
