// Checks the Linux package sources under resources/linux and the gulp task
// that fills them in.
//
// 1. The package scripts must not register a package repository or a signing
//    key. Upstream's .deb postinst wrote /etc/apt/sources.list.d/vscode.list
//    (packages.microsoft.com) and piped a key into gpg; that both points apt at
//    a vendor server and fails the install when gpg is missing. The debconf
//    question that served it (debian/templates.template) must stay deleted.
// 2. The package metadata (deb control, rpm spec, AppStream, .desktop, snap)
//    must name ZeroEgress, not Microsoft or Visual Studio Code, and must not
//    carry a remote URL other than the project's GitHub repository: software
//    centers fetch AppStream screenshot URLs, which would be a request to a
//    third party caused by metadata ZeroEgress ships.
// 3. The package version must be product.json's zeroEgressVersion.
//
// Comment lines are ignored (upstream copyright headers, a commented-out yum
// block in the rpm spec).
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const linux = join(root, 'resources/linux');
const HOMEPAGE = 'https://github.com/sadayamuthu/zero-egress';
const MAINTAINER = 'ZeroEgress <4604648+sadayamuthu@users.noreply.github.com>';

let failures = 0;
const fail = msg => { console.error(`FAIL: ${msg}`); failures++; };
const read = rel => readFileSync(join(root, rel), 'utf8');
const isComment = line => /^\s*#/.test(line);
const lines = rel => read(rel).split('\n').map((text, i) => ({ text, n: i + 1 })).filter(l => !isComment(l.text));

function walk(dir) {
	return readdirSync(dir).flatMap(f => {
		const p = join(dir, f);
		return statSync(p).isDirectory() ? walk(p) : [relative(root, p)];
	});
}

// 1. No repository or key handling in the package scripts.
const scripts = [
	...readdirSync(join(linux, 'debian')).map(f => join('resources/linux/debian', f)),
	'resources/linux/rpm/code.spec.template',
];
const forbiddenInScripts = [
	/packages\.microsoft\.com/,
	/sources\.list/,
	/trusted\.gpg|trustedparts/,
	/yum\.repos\.d|zypp\/repos\.d/,
	/\bgpg\b/,
	/rpm\s+--import/,
	/add-microsoft-repo/,
	/debconf/,
];
for (const rel of scripts) {
	for (const { text, n } of lines(rel)) {
		for (const re of forbiddenInScripts) {
			if (re.test(text)) { fail(`${rel}:${n} matches ${re}: ${text.trim()}`); }
		}
	}
}
if (existsSync(join(linux, 'debian/templates.template'))) {
	fail('resources/linux/debian/templates.template exists again (the debconf repo question)');
}

// 2. Metadata names ZeroEgress and links only to the project.
const metadata = [
	'resources/linux/debian/control.template',
	'resources/linux/rpm/code.spec.template',
	'resources/linux/code.appdata.xml',
	'resources/linux/code.desktop',
	'resources/linux/code-url-handler.desktop',
	'resources/linux/code-workspace.xml',
	'resources/linux/snap/snapcraft.yaml',
];
const forbiddenInMetadata = [
	/microsoft/i,
	/visual\s*studio/i,
	/vscode/i,
	/<screenshots?\b/,
	/Code editing\. Redefined/i,
];
for (const rel of metadata) {
	for (const { text, n } of lines(rel)) {
		for (const re of forbiddenInMetadata) {
			if (re.test(text)) { fail(`${rel}:${n} matches ${re}: ${text.trim()}`); }
		}
		for (const url of text.match(/https?:\/\/[^\s"<>)]+/g) ?? []) {
			// The freedesktop MIME namespace is an XML identifier, not fetched.
			if (url === 'http://www.freedesktop.org/standards/shared-mime-info') { continue; }
			if (!url.startsWith(HOMEPAGE)) { fail(`${rel}:${n} links to ${url} (only ${HOMEPAGE} is allowed)`); }
		}
	}
}
// No file under resources/linux may point at Microsoft's or VS Code's sites.
for (const rel of walk(linux)) {
	if (/\.(png|xpm)$/.test(rel)) { continue; }
	for (const { text, n } of lines(rel)) {
		if (/microsoft\.com|visualstudio\.com/i.test(text)) { fail(`${rel}:${n} mentions a Microsoft host: ${text.trim()}`); }
	}
}
const control = read('resources/linux/debian/control.template');
if (!control.includes(`Maintainer: ${MAINTAINER}\n`)) { fail('debian control: Maintainer is not ZeroEgress'); }
if (!control.includes(`Homepage: ${HOMEPAGE}\n`)) { fail('debian control: Homepage is not the GitHub repository'); }
const spec = read('resources/linux/rpm/code.spec.template');
if (!/^Vendor:\s+ZeroEgress </m.test(spec)) { fail('rpm spec: Vendor is not ZeroEgress'); }
if (!/^Packager:\s+ZeroEgress </m.test(spec)) { fail('rpm spec: Packager is not ZeroEgress'); }
if (!new RegExp(`^URL:\\s+${HOMEPAGE.replace(/[.]/g, '\\.')}$`, 'm').test(spec)) { fail('rpm spec: URL is not the GitHub repository'); }
if (!read('resources/linux/code.appdata.xml').includes(`<url type="homepage">${HOMEPAGE}</url>`)) {
	fail('appdata: homepage is not the GitHub repository');
}

// 3. The gulp task stamps zeroEgressVersion, not package.json's VS Code version.
const gulpfile = read('build/gulpfile.vscode.linux.js');
const versionReplacements = gulpfile.split('\n').filter(l => l.includes("'@@VERSION@@'"));
for (const l of versionReplacements) {
	if (/packageJson\.version/.test(l)) { fail(`gulpfile.vscode.linux.js stamps package.json's version: ${l.trim()}`); }
}
if (!versionReplacements.some(l => l.includes('product.zeroEgressVersion'))) {
	fail('gulpfile.vscode.linux.js does not stamp product.zeroEgressVersion');
}

if (failures) { process.exit(1); }
console.log(`PASS linux-packaging (${scripts.length} scripts, ${metadata.length} metadata files)`);
