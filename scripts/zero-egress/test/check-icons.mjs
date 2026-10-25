// Asserts every brand target exists, keeps the pixel size of the file it
// replaced, and no longer matches that file byte-for-byte.
// Sizes and sha256 values were recorded from the files at the import commit
// (d65dfb5), before the ZeroEgress mark was generated. Run from anywhere:
//   node scripts/zero-egress/test/check-icons.mjs
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// [path, width, height, sha256 of the replaced file (null = new file)]
const RASTERS = [
	['resources/darwin/code.icns', 1024, 1024, '580cfda654e58bf2b2e860fa981851c89a10352f840f648c0329855bd872882b'],
	['resources/linux/rpm/code.xpm', 872, 970, '155b04770c4c09a719bde1031e877dbb40766b2d72bf245e361a5b13133be4e4'],
	['resources/linux/code.png', 512, 512, 'a7394d82fe4c961ca3e417a83dcbca379183df481a0b67f42ddfe8a195d952c2'],
	['resources/win32/code.ico', 256, 256, 'd3acc05fc170c9057ffcb21f385ae77a367e0733b3ad81bfef105852920c1029'],
	['resources/win32/code_70x70.png', 70, 70, 'f6f04fb82772e92a0437a4e03baddac64c4979352cbd2b869d2d7fca1e118f66'],
	['resources/win32/code_150x150.png', 150, 150, '7c2b1019e027a10b1db3e0eb5c04cfcfa98eb3da202e92284c5dbb6ab0618d22'],
	['resources/win32/logo_cube_noshadow.png', 970, 970, 'e406557b92efa06e8c24ba3b6cda58914648ad3bf6d2f7ac1ddbccbd0925b97c'],
	['resources/win32/inno-big-100.bmp', 164, 314, '96dc1d1ac701a4bf504c5afb4f4624d33c51cb351fa28fa0888d86f655077981'],
	['resources/win32/inno-big-125.bmp', 192, 386, 'a2fc87b44a19490bc331c8f6b6fd535da77cfaab619a03b1487fc99d12a68b04'],
	['resources/win32/inno-big-150.bmp', 246, 459, '7758e076ec90420bd5f8e0fab8394793151936df80c11171af274bd90e3b04dc'],
	['resources/win32/inno-big-175.bmp', 273, 556, 'b471996e8ee7d0d4f6adc359ceb5ebd9113887a2edfc73e010d7892585986f9b'],
	['resources/win32/inno-big-200.bmp', 328, 604, '8b4d8ad19a00f600085d2dca36e5d885f3f02897285c82fe44683449976f35c0'],
	['resources/win32/inno-big-225.bmp', 355, 700, 'baf3db1916ebe870cbc6bf1ad722c3211a93c592f7cd2e4c4201e8e2fd13ad88'],
	['resources/win32/inno-big-250.bmp', 410, 797, '3074d90966f6cbfaa7bffe20c55b63ec641333c2e1870c5974c284af41638007'],
	['resources/win32/inno-small-100.bmp', 55, 55, 'e17f6ac6c3c867f6a1a43753064e21635b891869a64740c1391da5b6eba1976e'],
	['resources/win32/inno-small-125.bmp', 64, 68, 'db040c3fff0c7a27f8221bdadc8e9d7e3feef88c03b37d7ce30b15514dca8851'],
	['resources/win32/inno-small-150.bmp', 83, 80, '2341e4e08602255937af5c2f17a9a55a46a9a644a504a6a82fdb5f36d761fd58'],
	['resources/win32/inno-small-175.bmp', 92, 97, 'b9d33fed1e723fb3bd191b7d605b0250064a03e138b60416132ae896c904901b'],
	['resources/win32/inno-small-200.bmp', 110, 106, '7d8526f3ff7c5c3f9a85b02128f7df6e063b5d52279a20085a38efba22b10a80'],
	['resources/win32/inno-small-225.bmp', 119, 123, '67afd13e47df84ab8c386d6b2f7380bada1c6012d35baeb9ea5dc0c6ab38ac87'],
	['resources/win32/inno-small-250.bmp', 138, 140, '10c5e1024610ea4cf1cc819c4ecd8c293191573fc90b5997defc91fd116d4225'],
	['resources/win32/inno-zero-egress.bmp', 1200, 1200, 'f101e39c4800800cc4865fe9b63bcc7204b15069f7adcfc55e9430f8970ea055'],
	['resources/server/favicon.ico', 256, 256, 'd3acc05fc170c9057ffcb21f385ae77a367e0733b3ad81bfef105852920c1029'],
	['resources/server/code-192.png', 192, 192, 'dd49d5fe9cd4cd4aee4bc93fcc2ec6830c57d29cdda7bcf5930662aed1ca8efd'],
	['resources/server/code-512.png', 512, 512, 'a7394d82fe4c961ca3e417a83dcbca379183df481a0b67f42ddfe8a195d952c2'],
	['resources/zero-egress/zero-egress-banner.png', 1536, 1024, 'e023fa34bf353cc780ebb17b3a287f90a149964588fcdc9fe352dd3b349d20e7'],
	['scripts/appimage/zero-egress.png', 872, 970, '5b02865504861e6119c377261cd45cea02de8c508d2b629a3485b11498b47872'],
	['src/vs/workbench/browser/media/zero-egress-icon-sm.png', 872, 970, '5b02865504861e6119c377261cd45cea02de8c508d2b629a3485b11498b47872'],
	['src/vs/workbench/browser/parts/editor/media/zero-egress-slice.png', 1200, 1200, '3819860ad08bcab98aaccafaeb3359d5bab24cc5d90a325de6e264bb88bd7bb5'],
	['src/vs/workbench/browser/parts/editor/media/zero-egress-watermark.png', 1283, 970, '75b6812b05ac34109e95de3a8df90f1fc3bd5a3a895e5f02418e359d410508f4'],
	['.github/social-preview.png', 1280, 640, null],
];

// [path, sha256 of the replaced file (null = new file)]
const VECTORS = [
	['src/vs/workbench/browser/media/code-icon.svg', '6229c970c27444e78bcc07878fbeaf8e3b64ac4ee4d46e54a9bdf958fad36c91'],
	['src/vs/workbench/browser/parts/editor/media/letterpress-light.svg', 'd222a7154b5cf4923b7d56c8fe23f32425b12ea124ae2a2e058bd35c684869b8'],
	['src/vs/workbench/browser/parts/editor/media/letterpress-dark.svg', 'a73ee973150d5e2918ad7fd9ee46a0838b46e05b6877cd853b858058f830e653'],
	['src/vs/workbench/browser/parts/editor/media/letterpress-hcLight.svg', '0ec3b26e624ebcf8f1971c8bf7ae99c60a88db628db4d6a032f2a3b6a59be963'],
	['src/vs/workbench/browser/parts/editor/media/letterpress-hcDark.svg', '9069d176dd2cbbd2cbedb7d607a5376cc2952ceaed35e41c7c6371d44ba12739'],
	['src/vs/workbench/contrib/zeroEgress/browser/media/zero-egress-wordmark-dark.svg', 'ac1f184b86848f08c8284b4b834c191f0b55314817585bcfd9e61b5cb47e1670'],
	['resources/zero-egress/logo.svg', null],
	['resources/zero-egress/wordmark.svg', null],
	['.github/social-preview.svg', null],
];

// Every .ico keeps these entry sizes (all three old files had the same set).
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];

function pngSize(b, off = 0) {
	if (b.readUInt32BE(off) !== 0x89504e47 || b.toString('latin1', off + 12, off + 16) !== 'IHDR') { return null; }
	return [b.readUInt32BE(off + 16), b.readUInt32BE(off + 20)];
}

function icoSizes(b) {
	const n = b.readUInt16LE(4);
	const out = [];
	for (let i = 0; i < n; i++) {
		const o = 6 + 16 * i;
		out.push([b[o] || 256, b[o + 1] || 256]);
	}
	return out;
}

function icnsSize(b) {
	// Largest PNG-backed entry.
	let best = null;
	for (let o = 8; o + 8 <= b.length;) {
		const len = b.readUInt32BE(o + 4);
		if (len < 8) { break; }
		const s = o + 8 + 8 <= b.length && b.readUInt32BE(o + 8) === 0x89504e47 ? pngSize(b, o + 8) : null;
		if (s && (!best || s[0] > best[0])) { best = s; }
		o += len;
	}
	return best;
}

function imageSize(path, b) {
	if (path.endsWith('.png')) { return pngSize(b); }
	if (path.endsWith('.bmp')) { return b.toString('latin1', 0, 2) === 'BM' ? [b.readInt32LE(18), Math.abs(b.readInt32LE(22))] : null; }
	if (path.endsWith('.ico')) { return icoSizes(b).reduce((a, s) => (!a || s[0] > a[0] ? s : a), null); }
	if (path.endsWith('.icns')) { return icnsSize(b); }
	if (path.endsWith('.xpm')) {
		const m = b.toString('latin1', 0, 4096).match(/"\s*(\d+)\s+(\d+)\s+\d+\s+\d+/);
		return m ? [+m[1], +m[2]] : null;
	}
	return null;
}

const sha = b => createHash('sha256').update(b).digest('hex');
const failures = [];
const fail = (p, msg) => failures.push(`${p}: ${msg}`);

for (const [p, w, h, oldSha] of RASTERS) {
	const abs = join(root, p);
	if (!existsSync(abs)) { fail(p, 'missing'); continue; }
	const b = readFileSync(abs);
	const s = imageSize(p, b);
	if (!s) { fail(p, 'unreadable image header'); continue; }
	if (s[0] !== w || s[1] !== h) { fail(p, `size ${s[0]}x${s[1]}, expected ${w}x${h}`); }
	if (oldSha && sha(b) === oldSha) { fail(p, 'unchanged since the import commit (old brand art)'); }
	if (p.endsWith('.ico')) {
		const got = icoSizes(b).map(x => x[0]).sort((a, c) => a - c).join(',');
		if (got !== ICO_SIZES.join(',')) { fail(p, `ico entries ${got}, expected ${ICO_SIZES.join(',')}`); }
	}
	if (p.endsWith('.bmp') && b.readUInt16LE(28) !== 24) { fail(p, `bmp is ${b.readUInt16LE(28)}-bit, expected 24-bit (Inno Setup)`); }
}

for (const [p, oldSha] of VECTORS) {
	const abs = join(root, p);
	if (!existsSync(abs)) { fail(p, 'missing'); continue; }
	const b = readFileSync(abs);
	if (oldSha && sha(b) === oldSha) { fail(p, 'unchanged since the import commit (old brand art)'); }
}

// Title-bar icon: square viewBox, no fixed size (CSS sizes it), labelled.
const iconPath = 'src/vs/workbench/browser/media/code-icon.svg';
if (existsSync(join(root, iconPath))) {
	const svg = readFileSync(join(root, iconPath), 'utf8');
	const tag = (svg.match(/<svg\b[^>]*>/) || [''])[0];
	const vb = (tag.match(/viewBox="([^"]+)"/) || [])[1]?.trim().split(/[\s,]+/).map(Number);
	if (!vb || vb.length !== 4 || vb[2] !== vb[3]) { fail(iconPath, 'viewBox must be square'); }
	if (/\s(width|height)=/.test(tag)) { fail(iconPath, 'must not set width/height on <svg>'); }
	if (!tag.includes('aria-label="ZeroEgress app icon"')) { fail(iconPath, 'missing aria-label="ZeroEgress app icon"'); }
}

// Web manifest names.
for (const m of ['resources/server/manifest.json']) {
	const j = JSON.parse(readFileSync(join(root, m), 'utf8'));
	if (j.name !== 'ZeroEgress' || j.short_name !== 'ZeroEgress') { fail(m, 'name/short_name must be ZeroEgress'); }
}

if (failures.length) {
	for (const f of failures) { console.error(`FAIL ${f}`); }
	console.error(`ICON CHECK FAILED (${failures.length})`);
	process.exit(1);
}
console.log(`ICON CHECK PASSED (${RASTERS.length} rasters, ${VECTORS.length} vectors)`);
