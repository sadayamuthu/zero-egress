// Verifies offline-by-default settings and that removed extensions are gone.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const REMOVED = ['github', 'github-authentication', 'microsoft-authentication', 'tunnel-forwarding', 'open-remote-ssh', 'open-remote-wsl'];

const EXPECTED = [
	{ extension: 'typescript-language-features', setting: 'typescript.disableAutomaticTypeAcquisition', expected: true },
	{ extension: 'json-language-features', setting: 'json.schemaDownload.enable', expected: false },
	{ extension: 'typescript-language-features', setting: 'typescript.tsserver.web.typeAcquisition.enabled', expected: false },
	{ extension: 'npm', setting: 'npm.fetchOnlinePackageInfo', expected: false },
	{ extension: 'git', setting: 'git.autofetch', expected: false },
];

const problems = [];
for (const { extension, setting, expected } of EXPECTED) {
	let got;
	try {
		const pkg = JSON.parse(readFileSync(join(root, 'extensions', extension, 'package.json'), 'utf8'));
		const configs = [].concat(pkg.contributes?.configuration ?? []);
		for (const c of configs) {
			if (c.properties && setting in c.properties) { got = c.properties[setting].default; }
		}
	} catch (e) { got = `<${e.code ?? e.message}>`; }
	if (got !== expected) { problems.push(`${extension} ${setting} expected ${JSON.stringify(expected)} got ${JSON.stringify(got)}`); }
}
for (const ext of REMOVED) {
	if (existsSync(join(root, 'extensions', ext))) { problems.push(`${ext} expected removed got present`); }
}

if (problems.length) {
	console.error(problems.join('\n'));
	process.exit(1);
}
console.log('DEFAULTS OK');
