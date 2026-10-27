#!/usr/bin/env node
// Launch smoke and runtime egress check for a packaged ZeroEgress build (Method B of egress-test.md,
// automated). Used by the release workflow on every platform; runnable by hand.
//
// Usage: smoke.mjs --app <path to the executable> --out <empty work dir> [--timeout <seconds>]
//
// 1. Starts egress-proxy.mjs (logs every attempt, forwards nothing).
// 2. Starts the app with a fresh user data and extensions dir and HOME, Chromium pointed at the proxy
//    (loopback included, so the positive control reaches it), and a CDP port.
// 3. Over CDP: waits for the workbench, then from the renderer
//      - fetches an unconfigured private address, which the guard must refuse, and
//      - fetches https://127.0.0.1:19999/ (loopback, allowed): the positive control the proxy must log.
// 4. Checks main.log for the guard's block line for the unconfigured address (the line the
//    "ZeroEgress: Network" channel shows), closes the app, and runs egress-verdict.mjs with --expect.
// Exit 0 only if every step passed. Needs Node 22 (global WebSocket) or Node 20 with --experimental-websocket.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const app = opt('--app');
const out = opt('--out');
const timeoutMs = Number(opt('--timeout') ?? 240) * 1000;
if (!app || !out) { console.error('usage: smoke.mjs --app <executable> --out <dir> [--timeout seconds]'); process.exit(2); }
if (typeof WebSocket !== 'function') { console.error('smoke.mjs needs a global WebSocket (Node 22, or Node 20 with --experimental-websocket)'); process.exit(2); }
if (!existsSync(app)) { console.error(`app not found: ${app}`); process.exit(2); }

const BLOCKED = { host: '10.255.255.2', port: 1234 };
const CONTROL = { host: '127.0.0.1', port: 19999 };
const results = [];
const step = (name, ok, detail = '') => { results.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` (${detail})` : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((res, rej) => { const s = createServer(); s.once('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });

mkdirSync(out, { recursive: true });
const workDir = resolve(out);
const userData = join(workDir, 'user-data');
const extensions = join(workDir, 'extensions');
const proxyLog = join(workDir, 'egress.jsonl');
const proxyPort = await freePort();
const cdpPort = await freePort();

const proxy = spawn(process.execPath, [join(here, 'egress-proxy.mjs'), '--log', proxyLog, '--port', String(proxyPort)], { stdio: 'inherit' });
await sleep(500);

const proxyUrl = `http://127.0.0.1:${proxyPort}`;
const args = [
	`--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
	`--remote-debugging-port=${cdpPort}`,
	`--proxy-server=${proxyUrl}`, '--proxy-bypass-list=<-loopback>',
	'--skip-welcome', '--skip-release-notes', '--disable-workspace-trust', '--disable-gpu',
	...(process.platform === 'linux' ? ['--no-sandbox'] : []),
];
console.log(`launching ${app} ${args.join(' ')}`);
// A throwaway HOME too (not on Windows, where the profile is USERPROFILE/APPDATA): the app also writes
// ~/<dataFolderName>/argv.json, which must not be the user's real one.
const home = join(workDir, 'home');
mkdirSync(home, { recursive: true });
// No HTTP(S)_PROXY/NO_PROXY: when they are set, each window replaces the --proxy-server rules with them
// and bypasses loopback (windowImpl.ts), and the positive control could not reach the proxy. The extension
// host resolves its proxy through the same Chromium session, so --proxy-server covers it too.
const env = { ...process.env, ...(process.platform === 'win32' ? {} : { HOME: home }) };
for (const k of ['VSCODE_CLI', 'ELECTRON_RUN_AS_NODE', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) { delete env[k]; }
const child = spawn(app, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
let exited = false;
child.on('exit', (code, signal) => { exited = true; console.log(`app exited: code ${code} signal ${signal}`); });
child.stdout.on('data', d => process.stdout.write(`[app] ${d}`));
child.stderr.on('data', d => process.stdout.write(`[app] ${d}`));

const deadline = Date.now() + timeoutMs;
let ws;
try {
	// The workbench page target.
	let target;
	while (!target && Date.now() < deadline && !exited) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
			target = list.find(t => t.type === 'page' && /workbench/.test(t.url));
		} catch { /* not up yet */ }
		if (!target) { await sleep(1000); }
	}
	step('the app starts and exposes the workbench page over CDP', !!target, target?.url);
	if (!target) { throw new Error('no workbench'); }

	ws = new WebSocket(target.webSocketDebuggerUrl);
	await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('CDP connect failed')); });
	let nextId = 1;
	const pending = new Map();
	ws.onmessage = m => { const msg = JSON.parse(m.data); pending.get(msg.id)?.(msg); pending.delete(msg.id); };
	const evaluate = expression => new Promise((res, rej) => {
		const id = nextId++;
		pending.set(id, msg => msg.error || msg.result?.exceptionDetails ? rej(new Error(JSON.stringify(msg.error ?? msg.result.exceptionDetails))) : res(msg.result.result.value));
		ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
	});

	let ready = false;
	while (!ready && Date.now() < deadline) {
		ready = await evaluate(`!!document.querySelector('.monaco-workbench .part.statusbar') && !!document.querySelector('.monaco-workbench .part.editor')`).catch(() => false);
		if (!ready) { await sleep(1000); }
	}
	step('the workbench renders (editor and status bar)', ready);
	if (!ready) { throw new Error('workbench did not render'); }
	const title = await evaluate('document.title').catch(() => '');
	console.log(`window title: ${title}`);

	const blocked = await evaluate(`fetch('https://${BLOCKED.host}:${BLOCKED.port}/').then(() => 'reached', e => 'rejected: ' + e.message)`);
	step('an unconfigured address is refused in the renderer', blocked.startsWith('rejected'), blocked);
	const control = await evaluate(`fetch('https://${CONTROL.host}:${CONTROL.port}/').then(() => 'reached', e => 'rejected: ' + e.message)`);
	console.log(`positive control fetch: ${control}`);

	// The guard's log line (main.log; the same event feeds the "ZeroEgress: Network" channel).
	const line = `[ZeroEgress] blocked connection to ${BLOCKED.host}:${BLOCKED.port} from renderer`;
	const findLine = () => {
		const logs = join(userData, 'logs');
		if (!existsSync(logs)) { return false; }
		return readdirSync(logs).some(d => {
			const f = join(logs, d, 'main.log');
			return existsSync(f) && statSync(f).isFile() && readFileSync(f, 'utf8').includes(line);
		});
	};
	let logged = false;
	for (let i = 0; i < 10 && !logged; i++) { logged = findLine(); if (!logged) { await sleep(500); } }
	step('the block is logged by the guard', logged, line);
} catch (e) {
	step('the smoke session ran to the end', false, e.message);
} finally {
	// Close the app: CDP Browser.close, then kill if it lingers.
	try {
		const version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json();
		const b = new WebSocket(version.webSocketDebuggerUrl);
		await new Promise(res => { b.onopen = res; b.onerror = res; });
		b.send(JSON.stringify({ id: 1, method: 'Browser.close' }));
	} catch { /* already gone */ }
	ws?.close();
	for (let i = 0; i < 30 && !exited; i++) { await sleep(500); }
	if (!exited) { child.kill('SIGKILL'); console.log('app killed after Browser.close timed out'); }
	await sleep(500);
	proxy.kill();
}

const verdict = spawnSync(process.execPath, [join(here, 'egress-verdict.mjs'), proxyLog, '--expect', `${CONTROL.host}:${CONTROL.port}`], { encoding: 'utf8' });
process.stdout.write(verdict.stdout + verdict.stderr);
if (existsSync(proxyLog)) { console.log(`proxy log:\n${readFileSync(proxyLog, 'utf8')}`); }
step('egress verdict (nothing but loopback reached the proxy, and the positive control did)', verdict.status === 0);

const failed = results.filter(r => !r.ok);
console.log(failed.length ? `SMOKE FAILED (${failed.length} of ${results.length} checks)` : `SMOKE PASSED (${results.length} checks)`);
process.exit(failed.length ? 1 : 0);
