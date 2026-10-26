#!/usr/bin/env node
// Logging HTTP/CONNECT proxy. Records one JSON line {host, port, time} per
// attempt to --log <file> and NEVER forwards anything (always 403 / closes).
// Usage: egress-proxy.mjs --log <file> [--port 18080]
import http from 'node:http';
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = n => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const logFile = opt('--log');
const port = Number(opt('--port') ?? 18080);
if (!logFile) { console.error('usage: egress-proxy.mjs --log <file> [--port N]'); process.exit(2); }

function record(host, p) {
	appendFileSync(logFile, JSON.stringify({ host, port: p, time: new Date().toISOString() }) + '\n');
}
function splitHostPort(s, def) {
	const m = /^(?:\[([^\]]+)\]|([^:]+))(?::(\d+))?$/.exec(s);
	return m ? { host: m[1] ?? m[2], port: m[3] ? Number(m[3]) : def } : { host: s, port: def };
}

const server = http.createServer((req, res) => {
	let host = '?', p = 80;
	try { const u = new URL(req.url); host = u.hostname.replace(/^\[|\]$/g, ''); p = Number(u.port) || (u.protocol === 'https:' ? 443 : 80); }
	catch { const h = splitHostPort(req.headers.host ?? '?', 80); host = h.host; p = h.port; }
	record(host, p);
	res.writeHead(403, { 'content-type': 'text/plain' });
	res.end('blocked by egress-proxy\n');
});
server.on('connect', (req, socket) => {
	const h = splitHostPort(req.url, 443);
	record(h.host, h.port);
	socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
});
server.on('clientError', (_e, s) => s.destroy());
server.listen(port, '127.0.0.1', () => console.log(`egress-proxy listening on 127.0.0.1:${port}, logging to ${logFile}`));
