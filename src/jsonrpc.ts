/**
 * @file JSON RPC 2.0 middleware for Koa.
 * @author Johan Nordberg <johan@steemit.com>
 * Implemented according to http://www.jsonrpc.org/specification
 */

import * as assert from 'assert'
import * as bunyan from 'bunyan'
import * as Koa from 'koa'
import {VError} from 'verror'

import {getParamNames, readJson, resolveParams} from './utils'

/**
 * RPC specific error codes, application errors should not use these.
 */
export enum JsonRpcErrorCode {
    ParseError     = -32700,
    InvalidRequest = -32600,
    MethodNotFound = -32601,
    InvalidParams  = -32602,
    InternalError  = -32603,
}

export type JsonRpcId = string | number | null

function isValidId(id: JsonRpcId) {
    return id === null || id === undefined || typeof id === 'string' || (
        typeof id === 'number' && Number.isSafeInteger(id)
    )
}

function isValidResponse(response: JsonRpcResponse) {
    return (response.id !== null && response.id !== undefined) || response.error !== undefined
}

export class JsonRpcError extends VError {

    public readonly name = 'RPCError'
    public readonly code: number

    constructor(code: number, ...params) {
        // workaround for https://github.com/DefinitelyTyped/DefinitelyTyped/pull/19479
        super(params[0], ...(params.slice(1)))
        this.code = code
    }

    public toJSON() {
        const code = this.code
        const data = JsonRpcError.info(this) as any
        const message = this.message
        if (Object.keys(data).length > 0) {
            return {code, data, message}
        } else {
            return {code, message}
        }

    }

}

export interface JsonRpcResponseOptions {
    error?: JsonRpcError
    request?: JsonRpcRequest
    result?: any
    time?: number
}

export class JsonRpcResponse {

    public readonly jsonrpc: string = '2.0'
    public readonly id: JsonRpcId
    public readonly error?: JsonRpcError
    public readonly request?: JsonRpcRequest
    public readonly result?: any
    public readonly time?: number

    constructor({error, request, result, time}: JsonRpcResponseOptions) {
        assert(!result || !error, 'must specify either result or error')
        assert(!(result && error), 'result and error are mutually exclusive')
        this.id = request ? request.id : null
        this.error = error
        this.request = request
        this.result = result === undefined ? null : result
        this.time = time
    }

    public toJSON() {
        const {jsonrpc, id, error, result} = this
        if (error) {
            return {jsonrpc, id, error}
        } else {
            return {jsonrpc, id, result}
        }
    }

}

export class JsonRpcRequest {

    public static from(data: any) {
        const {jsonrpc, method, params, id} = data
        return new JsonRpcRequest(jsonrpc, id, method, params)
    }

    constructor(
        public readonly jsonrpc: string,
        public readonly id: JsonRpcId,
        public readonly method: string,
        public readonly params?: any,
    ) {
        assert(jsonrpc === '2.0', 'invalid rpc version')
        assert(isValidId(id), 'invalid id')
        assert(typeof method === 'string', 'invalid method')
    }

}

export function rpcAssert(value: any, message?: string) {
    if (!value) {
        throw new JsonRpcError(400, message || 'Assertion failed')
    }
}

export function rpcAssertEqual(actual: any, expected: any, message?: string) {
    // tslint:disable-next-line:triple-equals
    if (actual != expected) {
        const info = {actual, expected}
        throw new JsonRpcError(400, {info}, message || 'Assertion failed')
    }
}

export interface JsonRpcMethodContext {
    ctx: Koa.Context,
    log: bunyan,
    request: JsonRpcRequest,
    assert: typeof rpcAssert
    assertEqual: typeof rpcAssertEqual
}

export type JsonRpcMethod = (this: JsonRpcMethodContext, ...params) => any

export class JsonRpc {

    public readonly methods: {
        [name: string]: {method: JsonRpcMethod, params: string[]},
    } = {}

    /**
     * @param namespace  Optional namespace to add to all methods.
     */
    constructor(public namespace?: string) {}

    /**
     * Register a rpc method.
     * @param name    Method name.
     * @param method  Method implementation.
     */
    public register(name: string, method: JsonRpcMethod) {
        const n = this.namespace ? `${ this.namespace }.${ name }` : name
        assert(!this.methods[n], 'method already exists')
        const params = getParamNames(method)
        this.methods[n] = {method, params}
    }

    public middleware = async (ctx: Koa.Context, next: () => Promise<any>) => {
        if (ctx.method !== 'POST') {
            const error = new JsonRpcError(JsonRpcErrorCode.InvalidRequest, 'Method Not Allowed')
            ctx.status = 405
            ctx.body = new JsonRpcResponse({error})
            return next()
        }

        let data: any
        try {
            data = await readJson(ctx.req)
        } catch (cause) {
            const error = new JsonRpcError(JsonRpcErrorCode.ParseError, {cause}, 'Parse error')
            ctx.status = 400
            ctx.body = new JsonRpcResponse({error})
            return next()
        }

        // spec says an empty batch request is invalid
        if (Array.isArray(data) && data.length === 0) {
            const error = new JsonRpcError(JsonRpcErrorCode.InvalidRequest, 'Invalid Request')
            ctx.status = 400
            ctx.body = new JsonRpcResponse({error})
            return next()
        }

        ctx.status = 200
        if (Array.isArray(data)) {
            const rp = data.map((d) => this.handleRequest(d, ctx))
            const responses = (await Promise.all(rp)).filter(isValidResponse)
            ctx.body = (responses.length > 0) ? responses : ''
            ctx['rpc_responses'] = responses
        } else {
            const response = await this.handleRequest(data, ctx)
            ctx.body = isValidResponse(response) ? response : ''
            ctx['rpc_responses'] = [response]
        }

        return next()
    }

    private handleRequest = async (data: any, ctx: Koa.Context) => {
        let request: JsonRpcRequest
        try {
            request = JsonRpcRequest.from(data)
        } catch (cause) {
            const error = new JsonRpcError(JsonRpcErrorCode.InvalidRequest, {cause}, 'Invalid Request')
            return new JsonRpcResponse({error})
        }

        const handler = this.methods[request.method]
        if (!handler) {
            const error = new JsonRpcError(JsonRpcErrorCode.MethodNotFound, 'Method not found')
            return new JsonRpcResponse({request, error})
        }

        let params: any[]
        try {
            if (request.params !== undefined) {
                params = resolveParams(request.params, handler.params)
            } else {
                params = []
            }
        } catch (cause) {
            const error = new JsonRpcError(JsonRpcErrorCode.InvalidParams, {cause}, 'Invalid params')
            return new JsonRpcResponse({request, error})
        }

        let result: any
        let log: any
        if (ctx['log']) {
            log = ctx['log'].child({rpc_req: request})
        }
        const start = process.hrtime()
        try {
            const bind: JsonRpcMethodContext = {
                assert: rpcAssert,
                assertEqual: rpcAssertEqual,
                ctx, log, request,
            }
            result = await handler.method.apply(bind, params)
        } catch (error) {
            if (!(error instanceof JsonRpcError)) {
                error = new JsonRpcError(JsonRpcErrorCode.InternalError, {cause: error}, 'Internal error')
            }
            return new JsonRpcResponse({request, error})
        }
        const delta = process.hrtime(start)
        const time = delta[0] * 1e3 + delta[1] / 1e6
        return new JsonRpcResponse({request, result, time})
    }
}
