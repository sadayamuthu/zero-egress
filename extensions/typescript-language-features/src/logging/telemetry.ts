/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface TelemetryProperties {
	readonly [prop: string]: string | number | boolean | undefined;
}

export interface TelemetryReporter {
	logTelemetry(eventName: string, properties?: TelemetryProperties): void;
}

/**
 * ZeroEgress: this extension sends no telemetry and runs no experiments (the upstream reporter posted
 * through @vscode/extension-telemetry with the extension's aiKey, and fetched experiments from
 * default.exp-tas.com). Events are dropped here.
 */
export class NoopTelemetryReporter implements TelemetryReporter {
	public logTelemetry(_eventName: string, _properties?: TelemetryProperties): void { }
}
