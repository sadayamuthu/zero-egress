// Fails if the egress guard is unwired from any process entry point.
//
// The unit tests exercise EgressGuard and installEgressNodeHooks in isolation, so an upstream merge that
// rewrites app.ts, proxyResolver.ts or sharedProcessMain.ts and drops a call would leave them green while
// shipping an unguarded process. This checks the call sites themselves, in source (comments stripped),
// and that each one is in the place that makes it effective (for example: before the extension host hands
// modules to extensions). The release smoke jobs check the packaged app at runtime.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
let failures = 0;

/** Source with line and block comments removed (good enough for these files: no '//' inside strings we match). */
function code(rel) {
	return readFileSync(join(root, rel), 'utf8')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n').map(l => l.replace(/(^|[^:'"`])\/\/.*$/, '$1')).join('\n');
}

function expect(rel, what, re) {
	const src = code(rel);
	const m = re.exec(src);
	if (!m) { console.error(`FAIL: ${rel}: ${what} (${re})`); failures++; return -1; }
	return m.index;
}

function expectBefore(rel, what, first, second) {
	const a = expect(rel, `${what}: first part`, first);
	const b = expect(rel, `${what}: second part`, second);
	if (a >= 0 && b >= 0 && a > b) { console.error(`FAIL: ${rel}: ${what} (order)`); failures++; }
}

// Main process: the guard exists, its Node hooks are installed in the constructor, and the session filter
// (renderer, webviews, Electron net) consults it.
const app = 'src/vs/code/electron-main/app.ts';
expectBefore(app, 'EgressGuard is created and its Node hooks installed in the CodeApplication constructor',
	/this\.egressGuard\s*=\s*this\._register\(new EgressGuard\(\)\);\s*this\._register\(this\.egressGuard\.installNodeHooks\(\)\);/,
	/session\.defaultSession\.webRequest\.onBeforeRequest/);
expect(app, 'the webRequest filter cancels what the guard refuses',
	/webRequest\.onBeforeRequest\(\(details, callback\) => \{\s*if \(!this\.egressGuard\.check\(details\.url,[^)]*\)\)\s*\{\s*return callback\(\{ cancel: true \}\);/);
expect(app, 'the audit collector is set as the audit target', /this\.egressGuard\.setTargets\('audit',/);
expect(app, 'the MCP channel gets the guard', /new MCPChannel\(this\.egressGuard\)/);
expect(app, 'the model-request channel gets the guard', /new LLMMessageChannel\([^;]*this\.egressGuard\)/);
expect(app, 'the egress channel is registered for windows', /registerChannel\(EGRESS_GUARD_CHANNEL, new EgressGuardChannel\(this\.egressGuard, \{ canSetSettings: true/);
expect(app, 'the egress channel is registered for the shared process', /registerChannel\(EGRESS_GUARD_CHANNEL, new EgressGuardChannel\(this\.egressGuard, \{ canSetSettings: false/);
expect(app, 'a closed window drops its settings targets', /onDidRemoveConnection\(connection => this\.egressGuard\.removeSettingsClient\(connection\.ctx\)\)/);

const guard = 'src/vs/workbench/contrib/zeroEgress/electron-main/egressGuard.ts';
expect(guard, 'installNodeHooks hooks http, https, net, dgram and dns',
	/installNodeHooks\(\): IDisposable \{\s*return installEgressNodeHooks\(url => this\.check\(url, 'main'\), \{\s*global: globalThis,\s*http: require\('http'\),\s*https: require\('https'\),\s*net: require\('net'\),\s*dgram: require\('dgram'\),\s*dns: require\('dns'\),\s*\}\);/);

const mcp = 'src/vs/workbench/contrib/zeroEgress/electron-main/mcpChannel.ts';
expect(mcp, 'the MCP config sets the mcp target', /this\.egressGuard\.setTargets\('mcp',/);

// Extension host: hooks installed on the modules extensions get, after proxy-agent's patches and before
// configureModuleLoading hands modules to extensions.
const proxy = 'src/vs/workbench/api/node/proxyResolver.ts';
expect(proxy, 'the extension host guard is registered for RPC', /extHostRpc\.set\(ExtHostEgressGuardContext, egressGuard\);/);
expectBefore(proxy, 'extension host hooks installed after the proxy patches',
	/const lookup = createPatchedModules\(/,
	/disposables\.add\(installEgressNodeHooks\(egressGuard\.check, /);
expectBefore(proxy, 'extension host hooks installed before modules reach extensions',
	/disposables\.add\(installEgressNodeHooks\(egressGuard\.check, \{ global: globalThis, http, https, net, dgram, dns, electronNet: loadElectronNet\(extHostLogService\) \}\)\);/,
	/return configureModuleLoading\(extensionService, lookup\);/);
expect(proxy, 'the dgram and dns modules are the real ones', /const dgram = require\('dgram'\);\s*const dns = require\('dns'\);/);
expect('src/vs/workbench/api/browser/extensionHost.contribution.ts', 'the main-thread side of the extension host guard is loaded', /import '\.\/mainThreadEgressGuard\.js';/);

// Shared process: loopback only, before any service is created.
const shared = 'src/vs/code/electron-utility/sharedProcess/sharedProcessMain.ts';
expectBefore(shared, 'shared process installs loopback-only hooks right after the main-process connection',
	/this\._register\(installLoopbackOnlyEgressHooks\(/,
	/\/\/ Policies|const policyService|services\.set\(IPolicyService/);
const hooks = 'src/vs/workbench/contrib/zeroEgress/node/egressNodeHooks.ts';
expect(hooks, 'the loopback-only hooks cover http, https, net, dgram and dns',
	/installLoopbackOnlyEgressHooks[\s\S]*return installEgressNodeHooks\(check, \{ global: globalThis, http: require\('http'\), https: require\('https'\), net: require\('net'\), dgram: require\('dgram'\), dns: require\('dns'\), electronNet \}\);/);
expect(hooks, 'installEgressNodeHooks patches dgram and dns when given', /if \(t\.dgram\) \{ patchDgram\(t\.dgram, check, patch\); \}\s*if \(t\.dns\) \{ patchDns\(t\.dns, check, patch\); \}/);
expect(hooks, 'Socket#connect is the TCP choke point', /patch\(t\.net\.Socket\.prototype, 'connect',/);

// Renderer: the contribution that sends each window's model endpoints and writes the Network log is loaded.
expect('src/vs/workbench/contrib/zeroEgress/browser/egressTargetsContribution.ts', 'the egress targets contribution is registered at startup',
	/registerWorkbenchContribution2\(EgressTargetsContribution\.ID, EgressTargetsContribution, WorkbenchPhase\.BlockStartup\);/);
expect('src/vs/workbench/contrib/zeroEgress/browser/zeroEgress.contribution.ts', 'the egress targets contribution is imported', /import '\.\/egressTargetsContribution\.js'/);
expect('src/vs/workbench/workbench.common.main.ts', 'the ZeroEgress contribution is part of the workbench', /import '\.\/contrib\/zeroEgress\/browser\/zeroEgress\.contribution\.js';/);

if (failures) { console.error(`${failures} wiring check(s) failed`); process.exit(1); }
console.log('PASS guard-wiring');
