/**
 * Copyright 2017 Google Inc. All rights reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import {assert} from './assert';
import {debug} from './Debug';
const debugProtocolSend = debug('puppeteer:protocol:SEND ►');
const debugProtocolReceive = debug('puppeteer:protocol:RECV ◀');

import {Protocol} from 'devtools-protocol';
import {ProtocolMapping} from 'devtools-protocol/types/protocol-mapping';
import {ConnectionTransport} from './ConnectionTransport';
import {ProtocolError} from './Errors';
import {EventEmitter} from './EventEmitter';

/**
 * @public
 */
interface ConnectionCallback {
	resolve: Function;
	reject: Function;
	error: ProtocolError;
	method: string;
}

/**
 * Internal events that the Connection class emits.
 *
 * @internal
 */
const ConnectionEmittedEvents = {
	Disconnected: Symbol('Connection.Disconnected'),
} as const;

/**
 * @public
 */
export class Connection extends EventEmitter {
	#url: string;
	#transport: ConnectionTransport;
	#lastId = 0;
	#sessions: Map<string, CDPSession> = new Map();
	#closed = false;
	#callbacks: Map<number, ConnectionCallback> = new Map();

	constructor(url: string, transport: ConnectionTransport) {
		super();
		this.#url = url;

		this.#transport = transport;
		this.#transport.onmessage = this.#onMessage.bind(this);
		this.#transport.onclose = this.#onClose.bind(this);
	}

	static fromSession(session: CDPSession): Connection | undefined {
		return session.connection();
	}

	get _closed(): boolean {
		return this.#closed;
	}

	/**
	 * @param sessionId - The session id
	 * @returns The current CDP session if it exists
	 */
	session(sessionId: string): CDPSession | null {
		return this.#sessions.get(sessionId) || null;
	}

	url(): string {
		return this.#url;
	}

	send<T extends keyof ProtocolMapping.Commands>(
		method: T,
		...paramArgs: ProtocolMapping.Commands[T]['paramsType']
	): Promise<ProtocolMapping.Commands[T]['returnType']> {
		// There is only ever 1 param arg passed, but the Protocol defines it as an
		// array of 0 or 1 items See this comment:
		// https://github.com/ChromeDevTools/devtools-protocol/pull/113#issuecomment-412603285
		// which explains why the protocol defines the params this way for better
		// type-inference.
		// So now we check if there are any params or not and deal with them accordingly.
		const params = paramArgs.length ? paramArgs[0] : undefined;
		const id = this._rawSend({method, params});
		return new Promise((resolve, reject) => {
			this.#callbacks.set(id, {
				resolve,
				reject,
				error: new ProtocolError(),
				method,
			});
		});
	}

	_rawSend(message: Record<string, unknown>): number {
		const id = ++this.#lastId;
		const stringifiedMessage = JSON.stringify({...message, id});
		debugProtocolSend(stringifiedMessage);
		this.#transport.send(stringifiedMessage);
		return id;
	}

	async #onMessage(message: string): Promise<void> {
		debugProtocolReceive(message);
		const object = JSON.parse(message);
		if (object.method === 'Target.attachedToTarget') {
			const {sessionId} = object.params;
			const session = new CDPSession(
				this,
				object.params.targetInfo.type,
				sessionId
			);
			this.#sessions.set(sessionId, session);
			this.emit('sessionattached', session);
			const parentSession = this.#sessions.get(object.sessionId);
			if (parentSession) {
				parentSession.emit('sessionattached', session);
			}
		} else if (object.method === 'Target.detachedFromTarget') {
			const session = this.#sessions.get(object.params.sessionId);
			if (session) {
				session._onClosed();
				this.#sessions.delete(object.params.sessionId);
				this.emit('sessiondetached', session);
				const parentSession = this.#sessions.get(object.sessionId);
				if (parentSession) {
					parentSession.emit('sessiondetached', session);
				}
			}
		}

		if (object.sessionId) {
			const session = this.#sessions.get(object.sessionId);
			if (session) {
				session._onMessage(object);
			}
		} else if (object.id) {
			const callback = this.#callbacks.get(object.id);
			// Callbacks could be all rejected if someone has called `.dispose()`.
			if (callback) {
				this.#callbacks.delete(object.id);
				if (object.error) {
					callback.reject(
						createProtocolError(callback.error, callback.method, object)
					);
				} else {
					callback.resolve(object.result);
				}
			}
		} else {
			this.emit(object.method, object.params);
		}
	}

	#onClose(): void {
		if (this.#closed) {
			return;
		}

		this.#closed = true;
		this.#transport.onmessage = undefined;
		this.#transport.onclose = undefined;
		for (const callback of this.#callbacks.values()) {
			callback.reject(
				rewriteError(
					callback.error,
					`Protocol error (${callback.method}): Target closed.`
				)
			);
		}

		this.#callbacks.clear();
		for (const session of this.#sessions.values()) {
			session._onClosed();
		}

		this.#sessions.clear();
		this.emit(ConnectionEmittedEvents.Disconnected);
	}

	dispose(): void {
		this.#onClose();
		this.#transport.close();
	}

	/**
	 * @param targetInfo - The target info
	 * @returns The CDP session that is created
	 */
	async createSession(
		targetInfo: Protocol.Target.TargetInfo
	): Promise<CDPSession> {
		const {sessionId} = await this.send('Target.attachToTarget', {
			targetId: targetInfo.targetId,
			flatten: true,
		});
		const session = this.#sessions.get(sessionId);
		if (!session) {
			throw new Error('CDPSession creation failed.');
		}

		return session;
	}
}

interface CDPSessionOnMessageObject {
	id?: number;
	method: string;
	params: Record<string, unknown>;
	error: {message: string; data: any; code: number};
	result?: any;
}

export const CDPSessionEmittedEvents = {
	Disconnected: Symbol('CDPSession.Disconnected'),
} as const;

export class CDPSession extends EventEmitter {
	#sessionId: string;
	#targetType: string;
	#callbacks: Map<number, ConnectionCallback> = new Map();
	#connection?: Connection;

	constructor(connection: Connection, targetType: string, sessionId: string) {
		super();
		this.#connection = connection;
		this.#targetType = targetType;
		this.#sessionId = sessionId;
	}

	connection(): Connection | undefined {
		return this.#connection;
	}

	send<T extends keyof ProtocolMapping.Commands>(
		method: T,
		...paramArgs: ProtocolMapping.Commands[T]['paramsType']
	): Promise<ProtocolMapping.Commands[T]['returnType']> {
		if (!this.#connection) {
			return Promise.reject(
				new Error(
					`Protocol error (${method}): Session closed. Most likely the ${
						this.#targetType
					} has been closed.`
				)
			);
		}

		// See the comment in Connection#send explaining why we do this.
		const params = paramArgs.length ? paramArgs[0] : undefined;

		const id = this.#connection._rawSend({
			sessionId: this.#sessionId,
			method,
			params,
		});

		return new Promise((resolve, reject) => {
			this.#callbacks.set(id, {
				resolve,
				reject,
				error: new ProtocolError(),
				method,
			});
		});
	}

	_onMessage(object: CDPSessionOnMessageObject): void {
		const callback = object.id ? this.#callbacks.get(object.id) : undefined;
		if (object.id && callback) {
			this.#callbacks.delete(object.id);
			if (object.error) {
				callback.reject(
					createProtocolError(callback.error, callback.method, object)
				);
			} else {
				callback.resolve(object.result);
			}
		} else {
			assert(!object.id);
			this.emit(object.method, object.params);
		}
	}

	async detach(): Promise<void> {
		if (!this.#connection) {
			throw new Error(
				`Session already detached. Most likely the ${
					this.#targetType
				} has been closed.`
			);
		}

		await this.#connection.send('Target.detachFromTarget', {
			sessionId: this.#sessionId,
		});
	}

	_onClosed(): void {
		for (const callback of this.#callbacks.values()) {
			callback.reject(
				rewriteError(
					callback.error,
					`Protocol error (${callback.method}): Target closed.`
				)
			);
		}

		this.#callbacks.clear();
		this.#connection = undefined;
		this.emit(CDPSessionEmittedEvents.Disconnected);
	}

	id(): string {
		return this.#sessionId;
	}
}

function createProtocolError(
	error: ProtocolError,
	method: string,
	object: {error: {message: string; data: any; code: number}}
): Error {
	let message = `Protocol error (${method}): ${object.error.message}`;
	if ('data' in object.error) {
		message += ` ${object.error.data}`;
	}

	return rewriteError(error, message, object.error.message);
}

function rewriteError(
	error: ProtocolError,
	message: string,
	originalMessage?: string
): Error {
	error.message = message;
	error.originalMessage = originalMessage ?? error.originalMessage;
	return error;
}
