// Regenerates every ZeroEgress brand raster (and the derived SVGs) from the two
// masters: resources/zero-egress/logo.svg and resources/zero-egress/wordmark.svg.
//
//   node scripts/zero-egress/gen-icons.mjs
//
// Dev-only. REQUIRES `rsvg-convert` (librsvg) on PATH: `brew install librsvg`
// (macOS) or `apt install librsvg2-bin` (Debian/Ubuntu).
// Everything else (PNG decode, ICO/ICNS/BMP/XPM encode) is plain Node, so there is
// no npm dependency. Text renders with the machine's system sans-serif font.
// Verify afterwards with: node scripts/zero-egress/test/check-icons.mjs
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rel = p => join(root, p);

const BG = '#111827';
const MINT = '#34d399';
const TEXT_DARK_BG = '#e6edf3';
const MUTED_DARK_BG = '#9ca3af';
const TAGLINE = 'Offline AI code editor. Nothing leaves.';

try {
	execFileSync('rsvg-convert', ['--version'], { stdio: 'ignore' });
} catch {
	console.error('gen-icons: `rsvg-convert` not found on PATH. Install librsvg first:\n  macOS: brew install librsvg\n  Debian/Ubuntu: apt install librsvg2-bin');
	process.exit(1);
}

// ---------------------------------------------------------------- masters ---
const logoSvg = readFileSync(rel('resources/zero-egress/logo.svg'), 'utf8');
const wordmarkSvg = readFileSync(rel('resources/zero-egress/wordmark.svg'), 'utf8');

const grab = (svg, re, what) => {
	const m = svg.match(re);
	if (!m) { throw new Error(`gen-icons: cannot find ${what}`); }
	return m[0];
};
const TILE_RECT = grab(logoSvg, /<rect id="tile"[^>]*\/>/, 'logo.svg #tile');
const MARK = grab(logoSvg, /<g id="mark">[\s\S]*?<\/g>/, 'logo.svg #mark');
const WORD_TEXT = grab(wordmarkSvg, /<text id="wordmark-text"[\s\S]*?<\/text>/, 'wordmark.svg #wordmark-text');
const FONT_FAMILY = WORD_TEXT.match(/font-family="([^"]+)"/)[1];
const norm = s => s.replace(/\s+/g, ' ').trim();
if (norm(grab(wordmarkSvg, /<g id="mark">[\s\S]*?<\/g>/, 'wordmark.svg #mark')) !== norm(MARK)
	|| norm(grab(wordmarkSvg, /<rect id="tile"[^>]*\/>/, 'wordmark.svg #tile')) !== norm(TILE_RECT)) {
	throw new Error('gen-icons: the tile in wordmark.svg has drifted from logo.svg; copy it over');
}
const WORD_VB = wordmarkSvg.match(/viewBox="([^"]+)"/)[1].split(/\s+/).map(Number);

// Mark bounding box inside the 96-unit tile (outer arc caps .. zero's bottom).
const CROP = { x: 12, y: 22, w: 72, h: 64 };

// Pixel-fit for tiles rendered at <= 32 px: heavier strokes, slightly larger
// zero, stronger arcs. Same geometry and idea, just legible at 16/32 px.
function smallMark(mark) {
	return mark
		.replace(/stroke-width="([\d.]+)"/g, (_, w) => `stroke-width="${+(w * 1.3).toFixed(2)}"`)
		.replace(/opacity="\.3"/g, 'opacity=".45"')
		.replace(/rx="9" ry="12"/, 'rx="10" ry="13"');
}
const recolor = (s, color) => s.replaceAll(MINT, color);

// --------------------------------------------------------------- builders ---
const f = n => +n.toFixed(3);
const doc = (w, h, body, extra = '') =>
	`<svg viewBox="0 0 ${f(w)} ${f(h)}" xmlns="http://www.w3.org/2000/svg"${extra}>\n${body}\n</svg>\n`;

/** App tile (rounded square + mark) at x,y with the given edge length. */
const tile = (x, y, size, { small = false } = {}) =>
	`<g transform="translate(${f(x)},${f(y)}) scale(${f(size / 96)})">${TILE_RECT}${small ? smallMark(MARK) : MARK}</g>`;

/** Bare mark (no tile), its crop box placed at x,y with height h. */
const glyph = (x, y, h, { color = MINT, opacity = 1 } = {}) => {
	const k = h / CROP.h;
	const op = opacity === 1 ? '' : ` opacity="${opacity}"`;
	return `<g${op} transform="translate(${f(x - CROP.x * k)},${f(y - CROP.y * k)}) scale(${f(k)})">${recolor(MARK, color)}</g>`;
};
const glyphW = h => h * CROP.w / CROP.h;

// Text measurement: render once, read the alpha bounding box.
const MEASURE_SCALE = 8;
const measureCache = new Map();
function measure(textEl, vbW, vbH) {
	const key = textEl;
	if (!measureCache.has(key)) {
		const img = decodePng(render(doc(vbW, vbH, textEl), vbW * MEASURE_SCALE, vbH * MEASURE_SCALE));
		const bb = alphaBox(img);
		measureCache.set(key, { x: bb.x / MEASURE_SCALE, y: bb.y / MEASURE_SCALE, w: bb.w / MEASURE_SCALE, h: bb.h / MEASURE_SCALE });
	}
	return measureCache.get(key);
}

const WORD_BOX = measure(WORD_TEXT, WORD_VB[2], WORD_VB[3]);
/** "ZeroEgress" text whose ink box starts at x,y and is h tall. */
function word(x, y, h, fill) {
	const k = h / WORD_BOX.h;
	return `<g transform="translate(${f(x - WORD_BOX.x * k)},${f(y - WORD_BOX.y * k)}) scale(${f(k)})">${WORD_TEXT.replace(/fill="[^"]+"/, `fill="${fill}"`)}</g>`;
}
const wordW = h => WORD_BOX.w * h / WORD_BOX.h;

const TAG_TEXT = `<text x="0" y="40" font-family="${FONT_FAMILY}" font-size="40" font-weight="400" fill="#000">${TAGLINE}</text>`;
const TAG_BOX = measure(TAG_TEXT, 1000, 60);
function tagline(x, y, h, fill) {
	const k = h / TAG_BOX.h;
	return `<g transform="translate(${f(x - TAG_BOX.x * k)},${f(y - TAG_BOX.y * k)}) scale(${f(k)})">${TAG_TEXT.replace('fill="#000"', `fill="${fill}"`)}</g>`;
}
const tagW = h => TAG_BOX.w * h / TAG_BOX.h;

// ----------------------------------------------------------- compositions ---
/** Tile (or bare glyph on dark) + text in a row, centred in w x h. */
function horizontal(w, h, { textColor, mutedColor, withTagline = false, bare = false, bg = null, fill = 0.8 }) {
	const markH = h * fill;
	const markW = bare ? glyphW(markH) : markH;
	const textH = markH * (bare ? 0.5 : 0.42);
	const tagH = textH * 0.42;
	const gap = markH * 0.24;
	const textBlockW = Math.max(wordW(textH), withTagline ? tagW(tagH) : 0);
	let total = markW + gap + textBlockW;
	let s = 1;
	const maxW = w * 0.9;
	if (total > maxW) { s = maxW / total; total = maxW; }
	const x0 = (w - total) / 2;
	const mH = markH * s, mW = markW * s, tH = textH * s, gH = tagH * s, g = gap * s;
	const my = (h - mH) / 2;
	const tx = x0 + mW + g;
	const blockH = withTagline ? tH + gH * 1.4 + gH : tH;
	const ty = (h - blockH) / 2;
	const parts = [];
	if (bg) { parts.push(`<rect width="${w}" height="${h}" fill="${bg}"/>`); }
	parts.push(bare ? glyph(x0, my, mH) : tile(x0, my, mH));
	parts.push(word(tx, ty, tH, textColor));
	if (withTagline) { parts.push(tagline(tx, ty + tH + gH * 1.4, gH, mutedColor)); }
	return doc(w, h, parts.join('\n'));
}

/** Mark above centred text (and optional tagline). */
function stacked(w, h, { textColor, mutedColor, withTagline = false, bare = false, bg = null, panel = false }) {
	const parts = [];
	if (bg) { parts.push(`<rect width="${w}" height="${h}"${panel ? ` rx="${f(h * 0.06)}"` : ''} fill="${bg}"/>`); }
	let markH = h * (withTagline ? 0.36 : 0.46);
	let textH = markH * (bare ? 0.36 : 0.3);
	let tagH = textH * 0.34;
	const gap1 = markH * 0.22, gap2 = tagH * 1.5;
	let s = 1;
	const widest = Math.max(wordW(textH), withTagline ? tagW(tagH) : 0, markH);
	if (widest > w * 0.84) { s = w * 0.84 / widest; }
	markH *= s; textH *= s; tagH *= s;
	const totalH = markH + gap1 * s + textH + (withTagline ? gap2 * s + tagH : 0);
	let y = (h - totalH) / 2;
	const mW = bare ? glyphW(markH) : markH;
	parts.push(bare ? glyph((w - mW) / 2, y, markH) : tile((w - mW) / 2, y, markH));
	y += markH + gap1 * s;
	parts.push(word((w - wordW(textH)) / 2, y, textH, textColor));
	y += textH + gap2 * s;
	if (withTagline) { parts.push(tagline((w - tagW(tagH)) / 2, y, tagH, mutedColor)); }
	return doc(w, h, parts.join('\n'));
}

/** Tile centred in w x h at `fill` of the short side. Optional opaque bg. */
function centredTile(w, h, { fill = 1, bg = null, small } = {}) {
	const size = Math.min(w, h) * fill;
	const isSmall = small ?? size <= 32;
	return doc(w, h, (bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>\n` : '') + tile((w - size) / 2, (h - size) / 2, size, { small: isSmall }));
}

/** macOS: Big Sur grid, 824/1024 tile with 100/1024 margin. */
const macTile = px => doc(1024, 1024, tile(100, 100, 824, { small: px * 824 / 1024 <= 32 }));

/** Bare glyph centred in w x h at height h*fill. */
const centredGlyph = (w, h, { fill = 1, color = MINT, opacity = 1, bg = null } = {}) => {
	const gh = h * fill;
	const gw = glyphW(gh);
	return doc(w, h, (bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>\n` : '') + glyph((w - gw) / 2, (h - gh) / 2, gh, { color, opacity }));
};

// -------------------------------------------------------------- rendering ---
function render(svg, w, h) {
	return execFileSync('rsvg-convert', ['--width', String(w), '--height', String(h), '--format', 'png'], { input: svg, maxBuffer: 1 << 28 });
}

function decodePng(buf) {
	if (buf.readUInt32BE(0) !== 0x89504e47) { throw new Error('not a PNG'); }
	let o = 8, w = 0, h = 0, bpp = 4;
	const idat = [];
	while (o < buf.length) {
		const len = buf.readUInt32BE(o), type = buf.toString('latin1', o + 4, o + 8);
		const data = buf.subarray(o + 8, o + 8 + len);
		if (type === 'IHDR') {
			w = data.readUInt32BE(0); h = data.readUInt32BE(4);
			if (data[8] !== 8 || (data[9] !== 6 && data[9] !== 2) || data[12] !== 0) { throw new Error('expected 8-bit RGB(A) non-interlaced PNG'); }
			bpp = data[9] === 6 ? 4 : 3;
		} else if (type === 'IDAT') { idat.push(data); } else if (type === 'IEND') { break; }
		o += 12 + len;
	}
	const raw = inflateSync(Buffer.concat(idat));
	const stride = w * bpp, line = Buffer.alloc(stride * h);
	for (let y = 0; y < h; y++) {
		const ft = raw[y * (stride + 1)], src = y * (stride + 1) + 1, dst = y * stride;
		for (let i = 0; i < stride; i++) {
			const a = i >= bpp ? line[dst + i - bpp] : 0;
			const b = y ? line[dst - stride + i] : 0;
			const c = y && i >= bpp ? line[dst - stride + i - bpp] : 0;
			let v = raw[src + i];
			if (ft === 1) { v += a; } else if (ft === 2) { v += b; } else if (ft === 3) { v += (a + b) >> 1; } else if (ft === 4) {
				const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
				v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
			}
			line[dst + i] = v & 255;
		}
	}
	if (bpp === 4) { return { w, h, px: line }; }
	const px = Buffer.alloc(w * h * 4, 255);
	for (let i = 0; i < w * h; i++) { line.copy(px, i * 4, i * 3, i * 3 + 3); }
	return { w, h, px };
}

function alphaBox({ w, h, px }) {
	let x0 = w, y0 = h, x1 = -1, y1 = -1;
	for (let y = 0; y < h; y++) {
		for (let x = 0; x < w; x++) {
			if (px[(y * w + x) * 4 + 3] > 8) { if (x < x0) { x0 = x; } if (x > x1) { x1 = x; } if (y < y0) { y0 = y; } if (y > y1) { y1 = y; } }
		}
	}
	if (x1 < 0) { throw new Error('gen-icons: measured text rendered empty (missing font?)'); }
	return { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 24-bit bottom-up BMP, composited over an opaque background. */
function encodeBmp({ w, h, px }, bg) {
	const [br, bgc, bb] = [1, 3, 5].map(i => parseInt(bg.slice(i, i + 2), 16));
	const rowLen = Math.ceil(w * 3 / 4) * 4, size = 54 + rowLen * h;
	const out = Buffer.alloc(size);
	out.write('BM', 0, 'latin1'); out.writeUInt32LE(size, 2); out.writeUInt32LE(54, 10);
	out.writeUInt32LE(40, 14); out.writeInt32LE(w, 18); out.writeInt32LE(h, 22);
	out.writeUInt16LE(1, 26); out.writeUInt16LE(24, 28); out.writeUInt32LE(rowLen * h, 34);
	out.writeInt32LE(3779, 38); out.writeInt32LE(3779, 42);
	for (let y = 0; y < h; y++) {
		const row = 54 + (h - 1 - y) * rowLen;
		for (let x = 0; x < w; x++) {
			const i = (y * w + x) * 4, a = px[i + 3] / 255;
			const mix = (c, b) => Math.round(c * a + b * (1 - a));
			out[row + x * 3] = mix(px[i + 2], bb);
			out[row + x * 3 + 1] = mix(px[i + 1], bgc);
			out[row + x * 3 + 2] = mix(px[i], br);
		}
	}
	return out;
}

function encodeIco(pngs) {
	const head = Buffer.alloc(6 + 16 * pngs.length);
	head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
	let off = head.length;
	pngs.forEach(([size, data], i) => {
		const o = 6 + 16 * i;
		head[o] = size >= 256 ? 0 : size; head[o + 1] = size >= 256 ? 0 : size;
		head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
		head.writeUInt32LE(data.length, o + 8); head.writeUInt32LE(off, o + 12);
		off += data.length;
	});
	return Buffer.concat([head, ...pngs.map(p => p[1])]);
}

function encodeIcns(entries) {
	const chunks = entries.map(([type, data]) => {
		const h = Buffer.alloc(8); h.write(type, 0, 'latin1'); h.writeUInt32BE(8 + data.length, 4);
		return Buffer.concat([h, data]);
	});
	const body = Buffer.concat(chunks), head = Buffer.alloc(8);
	head.write('icns', 0, 'latin1'); head.writeUInt32BE(8 + body.length, 4);
	return Buffer.concat([head, body]);
}

/** XPM (for the RPM package icon): 2 chars per pixel, alpha < 50% is None. */
function encodeXpm({ w, h, px }, name) {
	const chars = [];
	for (let c = 35; c < 127; c++) { if (c !== 34 && c !== 92) { chars.push(String.fromCharCode(c)); } }
	const codes = new Map([['None', '  ']]);
	const keyAt = i => {
		if (px[i + 3] < 128) { return 'None'; }
		// 5 bits per channel keeps the palette well under the 2-char limit.
		return '#' + [0, 1, 2].map(k => (px[i + k] & 0xf8 | px[i + k] >> 5).toString(16).padStart(2, '0')).join('');
	};
	const rows = [];
	for (let y = 0; y < h; y++) {
		let row = '';
		for (let x = 0; x < w; x++) {
			const key = keyAt((y * w + x) * 4);
			if (!codes.has(key)) {
				const n = codes.size - 1;
				if (n >= chars.length * chars.length) { throw new Error('gen-icons: too many XPM colours'); }
				codes.set(key, chars[Math.floor(n / chars.length)] + chars[n % chars.length]);
			}
			row += codes.get(key);
		}
		rows.push(row);
	}
	const colours = [...codes].map(([k, c]) => `"${c} c ${k}",`);
	return `/* XPM */\nstatic char *${name}[] = {\n/* columns rows colors chars-per-pixel */\n"${w} ${h} ${codes.size} 2 ",\n${colours.join('\n')}\n/* pixels */\n${rows.map(r => `"${r}"`).join(',\n')}\n};\n`;
}

// ---------------------------------------------------------------- outputs ---
const written = [];
function out(path, data) {
	mkdirSync(dirname(rel(path)), { recursive: true });
	writeFileSync(rel(path), data);
	written.push(path);
}
const png = (path, svg, w, h) => out(path, render(svg, w, h));
const tilePng = (path, size) => png(path, centredTile(size, size), size, size);
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const ico = path => out(path, encodeIco(ICO_SIZES.map(s => [s, render(centredTile(s, s), s, s)])));
const bmp = (path, svg, w, h, bg) => out(path, encodeBmp(decodePng(render(svg, w, h)), bg));

// Desktop
out('resources/darwin/code.icns', encodeIcns([
	['icp4', 16], ['icp5', 32], ['ic11', 32], ['ic12', 64], ['ic07', 128], ['ic13', 256],
	['ic08', 256], ['ic14', 512], ['ic09', 512], ['ic10', 1024],
].map(([t, s]) => [t, render(macTile(s), s, s)])));
tilePng('resources/linux/code.png', 512);
out('resources/linux/rpm/code.xpm', encodeXpm(decodePng(render(centredTile(872, 970), 872, 970)), 'zero_egress'));
ico('resources/win32/code.ico');
tilePng('resources/win32/code_70x70.png', 70);
tilePng('resources/win32/code_150x150.png', 150);
tilePng('resources/win32/logo_cube_noshadow.png', 970);
png('scripts/appimage/zero-egress.png', centredTile(872, 970), 872, 970);

// Windows installer wizard art (24-bit BMP, no alpha).
for (const [scale, w, h] of [[100, 164, 314], [125, 192, 386], [150, 246, 459], [175, 273, 556], [200, 328, 604], [225, 355, 700], [250, 410, 797]]) {
	const gh = w * 0.62 * CROP.h / CROP.w;
	const body = `<rect width="${w}" height="${h}" fill="${BG}"/>\n${glyph(w * 0.19, h * 0.36 - gh / 2, gh)}`;
	bmp(`resources/win32/inno-big-${scale}.bmp`, doc(w, h, body), w, h, BG);
}
for (const [scale, w, h] of [[100, 55, 55], [125, 64, 68], [150, 83, 80], [175, 92, 97], [200, 110, 106], [225, 119, 123], [250, 138, 140]]) {
	bmp(`resources/win32/inno-small-${scale}.bmp`, centredTile(w, h, { fill: 0.86 }), w, h, '#ffffff');
}
bmp('resources/win32/inno-zero-egress.bmp', centredTile(1200, 1200, { fill: 0.86 }), 1200, 1200, '#ffffff');

// Server / web app
ico('resources/server/favicon.ico');
tilePng('resources/server/code-192.png', 192);
tilePng('resources/server/code-512.png', 512);

// Workbench
const ICON_SVG = centredTile(96, 96, { small: true }).replace('<svg ', '<svg role="img" aria-label="ZeroEgress app icon" ');
out('src/vs/workbench/browser/media/code-icon.svg', ICON_SVG);
png('src/vs/workbench/browser/media/zero-egress-icon-sm.png', centredTile(872, 970), 872, 970);
png('src/vs/workbench/browser/parts/editor/media/zero-egress-slice.png', centredTile(1200, 1200), 1200, 1200);
// Empty-editor watermark: white mark, alpha; light themes invert it in CSS/JS.
png('src/vs/workbench/browser/parts/editor/media/zero-egress-watermark.png', centredGlyph(1283, 970, { color: '#ffffff' }), 1283, 970);
for (const [theme, color, opacity, note] of [
	['light', '#0F1115', 0.1, 'light backgrounds: dark ink, faint'],
	['dark', '#FFFFFF', 0.3, 'dark backgrounds: light ink, faint'],
	['hcLight', '#d9d9d9', 1, 'high-contrast light: solid light-gray ink'],
	['hcDark', '#3C3C3C', 1, 'high-contrast dark: solid dark-gray ink'],
]) {
	const svg = centredGlyph(CROP.w, CROP.h, { color, opacity })
		.replace('>\n', `>\n<!-- ZeroEgress mark, ${note}. Generated by scripts/zero-egress/gen-icons.mjs -->\n`);
	out(`src/vs/workbench/browser/parts/editor/media/letterpress-${theme}.svg`, svg);
}

// README banner (1536x1024, 3:2): dark panel so it reads on GitHub light and dark.
// (The in-app onboarding splash draws the mark inline; see ZeroEgressOnboarding.tsx.)
const BANNER = stacked(1536, 1024, { textColor: TEXT_DARK_BG, mutedColor: MUTED_DARK_BG, withTagline: true, bare: true, bg: BG, panel: true });
png('resources/zero-egress/zero-egress-banner.png', BANNER, 1536, 1024);
out('src/vs/workbench/contrib/zeroEgress/browser/media/zero-egress-wordmark-dark.svg', wordmarkSvg);

// GitHub social preview
const card = (w, h) => horizontal(w, h, { textColor: TEXT_DARK_BG, mutedColor: MUTED_DARK_BG, withTagline: true, bare: true, bg: BG, fill: 0.36 });
const SOCIAL = card(1280, 640);
out('.github/social-preview.svg', SOCIAL);
png('.github/social-preview.png', SOCIAL, 1280, 640);

console.log(`gen-icons: wrote ${written.length} files`);
