// Fails when minifying a compiled file leaves a character above \xFF in it.
// The release build's minify step (build/lib/optimize.ts) rejects those, but
// it only runs when a release is built. esbuild escapes such characters in
// strings, not in regular expression literals, so a regex like /[”]/ passes
// compile and test and then breaks the release. This runs the same esbuild
// minify on each file, so the problem shows up in CI on the pull request.
//
// Usage: node scripts/zero-egress/check-minified-ascii.mjs <dir> [<dir>...]
// Test folders are skipped: the release does not ship them.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');
const esbuild = createRequire(join(root, 'package.json'))('esbuild');

/** The same check optimize.ts runs on the minified output. */
const NON_ASCII = /[^\x00-\xFF]+/g;

function* jsFiles(dir) {
	for (const e of readdirSync(dir, { withFileTypes: true })) {
		const p = join(dir, e.name);
		if (e.isDirectory()) {
			if (e.name !== 'test' && e.name !== 'node_modules') { yield* jsFiles(p); }
		} else if (e.name.endsWith('.js')) {
			yield p;
		}
	}
}

const dirs = process.argv.slice(2);
if (!dirs.length) { console.error('usage: check-minified-ascii.mjs <dir> [<dir>...]'); process.exit(2); }

const problems = [];
let count = 0;
for (const dir of dirs) {
	for (const file of jsFiles(dir)) {
		count++;
		let code;
		try {
			// the options optimize.ts passes to esbuild
			code = esbuild.transformSync(readFileSync(file, 'utf8'), { minify: true, format: 'esm', platform: 'neutral', target: 'es2022', logLevel: 'silent' }).code;
		} catch {
			continue; // not something esbuild parses (the release would fail on it anyway, louder)
		}
		const found = code.match(NON_ASCII);
		if (found) { problems.push(`${relative(process.cwd(), file)}: ${[...new Set(found)].slice(0, 5).join(' ')}`); }
	}
}

if (problems.length) {
	console.error('MINIFIED ASCII CHECK FAILED: these files keep a non-ASCII character after minify,');
	console.error('which the release build rejects. Write it as a \\u escape (usually it is inside a regex):');
	for (const p of problems) { console.error(`  ${p}`); }
	process.exit(1);
}
console.log(`MINIFIED ASCII CHECK PASSED (${count} files)`);
