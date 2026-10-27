// The Linux package scripts must not register a package repository or a signing key.
// Upstream's .deb postinst wrote /etc/apt/sources.list.d/vscode.list (packages.microsoft.com)
// and piped a key into gpg; that both points apt at a vendor server and fails the install
// when gpg is missing. Comment lines are ignored (the rpm spec keeps a commented-out block).
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const files = [
	...readdirSync(join(root, 'resources/linux/debian')).map(f => join('resources/linux/debian', f)),
	'resources/linux/rpm/code.spec.template',
];
const forbidden = [
	/packages\.microsoft\.com/,
	/sources\.list/,
	/trusted\.gpg|trustedparts/,
	/yum\.repos\.d|zypp\/repos\.d/,
	/\bgpg\b/,
	/rpm\s+--import/,
	/add-microsoft-repo/,
];

let failures = 0;
for (const rel of files) {
	readFileSync(join(root, rel), 'utf8').split('\n').forEach((line, i) => {
		if (/^\s*#/.test(line)) { return; }
		for (const re of forbidden) {
			if (re.test(line)) { console.error(`FAIL: ${rel}:${i + 1} matches ${re}: ${line.trim()}`); failures++; }
		}
	});
}
if (failures) { process.exit(1); }
console.log(`PASS linux-packaging (${files.length} files)`);
