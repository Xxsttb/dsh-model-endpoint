/**
 * dsh-model-endpoint — Host half.
 *
 * Publishes the model this profile is currently using as an OpenAI-compatible
 * HTTP endpoint. The listener is created here with `node:http`, so the bind
 * address is fully configurable: `127.0.0.1` keeps it private to this machine,
 * `0.0.0.0` publishes it to the local network, and a router or NAT port forward
 * makes the very same endpoint reachable from the public internet. Nothing in
 * the request path depends on which of those three topologies you use.
 *
 * Completions are answered with `ctx.llm.stream()` — the same provider- and
 * model-neutral entry point the agent loop uses — so every model this profile
 * can already talk to is served without a second credential store.
 *
 * This file is AI-generated. See README.md.
 */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { admitOpenAiUserContent, assertUserImageInputSupported, ImageInputFailure } from './openai-content.js';
import { networkInterfaces } from 'node:os';
import z from '@deepseek-ai/schemastery';
import {
    BlockAssembler,
    ReasoningEffortId,
    createAssistantMessage,
    createToolResultMessage,
    createUserMessage,
} from '@deepseek-ai/dsh-llm';

/** Default TCP port. Well clear of the Harness web UI on 19387. */
const DEFAULT_PORT = 8787;
/** Largest accepted request body. Long conversations are big; this still bounds memory. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Anonymous `created` stamp for synthetic model objects (2024-01-01T00:00:00Z). */
const MODEL_CREATED = 1704067200;
/** Synthetic source tag for every message this endpoint constructs. */
const ENDPOINT_SOURCE = { kind: 'model-endpoint' };

/**
 * Persisted settings. Every field is `.volatile()` so the settings page can
 * write it live and the listener can rebind without a reload.
 */
export const Config = z.object({
    /** Whether the HTTP listener runs at all. */
    enabled: z.boolean().default(true).volatile(),
    /** Bind address. `127.0.0.1` = this machine only, `0.0.0.0` = every interface. */
    host: z.string().default('127.0.0.1').volatile(),
    /** TCP port to listen on. */
    port: z.number().step(1).min(1).max(65535).default(DEFAULT_PORT).volatile(),
    /**
     * Bearer token clients must present. Empty means "no authentication" —
     * reasonable while bound to loopback, and the settings page warns when the
     * bind address is not loopback.
     */
    apiKey: z.string().default('').volatile(),
    /** Follow the model picked in chat and on the Models settings page. */
    followSelection: z.boolean().default(true).volatile(),
    /** Provider used when `followSelection` is off, or as a fallback. */
    provider: z.string().default('').volatile(),
    /** Model used when `followSelection` is off, or as a fallback. */
    model: z.string().default('').volatile(),
    /** Reasoning effort override; empty keeps the selected model's own default. */
    reasoningEffort: z.string().default('').volatile(),
    /** Extra system prompt, applied only when a request carries no system message. */
    systemPrompt: z.string().default('').volatile(),
    /** `Access-Control-Allow-Origin` value, for browser-based clients. */
    corsOrigin: z.string().default('*').volatile(),
    /**
     * `max_tokens` used when a request omits it.
     *
     * `0` means "no ceiling of our own": the request goes upstream without a
     * `maxTokens` field, and whatever the provider considers its model's limit
     * is what applies. Anything else is a real cap.
     */
    defaultMaxTokens: z.number().step(1).min(0).max(200_000).default(8192).volatile(),
    /** Hard ceiling for one completion, including time spent streaming. */
    requestTimeoutMs: z.number().step(1).min(1_000).max(3_600_000).default(600_000).volatile(),
    /**
     * Master switch for handing this profile's tools to the calling model.
     *
     * The endpoint can lend the model the tools this Harness has registered, and
     * run them on its behalf. That is real capability, so it is off until asked
     * for, and even then only the individual tools switched on below are sent.
     */
    toolsEnabled: z.boolean().default(false).volatile(),
    /**
     * Which tools are lent out, by tool name. `true` exposes one; absent means
     * not exposed. Defaulting to "nothing exposed" keeps a fresh install from
     * handing out file, shell, or web access by accident.
     */
    toolSwitches: z.dict(z.boolean()).default({}).volatile(),
    /** How many model/tool round trips one request may take before it is cut off. */
    maxToolRounds: z.number().step(1).min(1).max(32).default(8).volatile(),
});

/** The only service this plugin needs before it can answer a request. */
export const inject = ['llm', 'attachments'];

/**
 * Read a config value that may be wrapped in a cosmokit volatile reference.
 * @param {unknown} value - raw field, possibly a `{ get() }` reference.
 * @returns {unknown} the current value.
 */
function unwrap(value) {
    if (value !== null && typeof value === 'object' && typeof value.get === 'function') {
        return value.get();
    }
    return value;
}

/**
 * Project the volatile Config into a plain, detached snapshot.
 * @param {object} config - the plugin Config.
 * @returns {object} plain settings, safe to capture for one request generation.
 */
function snapshot(config) {
    const read = (key, fallback) => {
        const value = unwrap(config?.[key]);
        return value === undefined || value === null ? fallback : value;
    };
    const port = Math.floor(Number(read('port', DEFAULT_PORT)));
    const maxTokens = Math.floor(Number(read('defaultMaxTokens', 8192)));
    const timeoutMs = Math.floor(Number(read('requestTimeoutMs', 600_000)));
    const maxRounds = Math.floor(Number(read('maxToolRounds', 8)));
    return {
        enabled: read('enabled', true) !== false,
        host: String(read('host', '127.0.0.1')).trim() || '127.0.0.1',
        port: Number.isFinite(port) && port >= 1 && port <= 65535 ? port : DEFAULT_PORT,
        apiKey: String(read('apiKey', '')).trim(),
        followSelection: read('followSelection', true) !== false,
        provider: String(read('provider', '')).trim(),
        model: String(read('model', '')).trim(),
        reasoningEffort: String(read('reasoningEffort', '')).trim(),
        systemPrompt: String(read('systemPrompt', '')),
        corsOrigin: String(read('corsOrigin', '*')),
        defaultMaxTokens: Number.isFinite(maxTokens) && maxTokens >= 0 ? maxTokens : 8192,
        requestTimeoutMs: Number.isFinite(timeoutMs) && timeoutMs >= 1000 ? timeoutMs : 600_000,
        toolsEnabled: read('toolsEnabled', false) === true,
        toolSwitches: readSwitchMap(config?.toolSwitches),
        maxToolRounds: Number.isFinite(maxRounds) && maxRounds >= 1 ? Math.min(maxRounds, 32) : 8,
    };
}

/**
 * Project the volatile per-tool switch dictionary into plain booleans.
 *
 * A dict field is itself a volatile reference, and reading it yields the live
 * value object; anything that is not a dictionary of booleans is discarded
 * rather than guessed at.
 * @param {unknown} value - the raw `toolSwitches` field.
 * @returns {Record<string, boolean>} only the names explicitly switched on or off.
 */
function readSwitchMap(value) {
    const raw = unwrap(value);
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const switches = {};
    for (const [name, entry] of Object.entries(raw)) {
        const flag = unwrap(entry);
        if (typeof flag === 'boolean') switches[name] = flag;
    }
    return switches;
}

/**
 * Whether a bind address is confined to this machine.
 * @param {string} host - configured bind address.
 * @returns {boolean} true for loopback-only binds.
 */
function isLoopbackHost(host) {
    return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

/**
 * Every non-internal IPv4 address of this machine, for display in settings.
 * @returns {string[]} a sorted, de-duplicated address list.
 */
function lanAddresses() {
    const found = new Set();
    for (const entries of Object.values(networkInterfaces())) {
        for (const entry of entries ?? []) {
            if (entry.family === 'IPv4' && !entry.internal) found.add(entry.address);
        }
    }
    return [...found].sort();
}

/**
 * Write one JSON response.
 * @param {import('node:http').ServerResponse} response - the response to fill.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serializable payload.
 * @param {Record<string, string>} [headers] - extra headers to merge in.
 * @returns {void}
 */
function sendJson(response, status, body, headers = {}) {
    if (response.writableEnded) return;
    const text = JSON.stringify(body);
    response.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'content-length': Buffer.byteLength(text),
        'cache-control': 'no-store',
        ...headers,
    });
    response.end(text);
}

/**
 * Write one OpenAI-shaped error.
 * @param {import('node:http').ServerResponse} response - the response to fill.
 * @param {number} status - HTTP status code.
 * @param {string} message - human-readable detail.
 * @param {string} [code] - machine-readable code.
 * @param {Record<string, string>} [headers] - extra headers to merge in.
 * @returns {void}
 */
function sendError(response, status, message, code = 'invalid_request_error', headers = {}) {
    sendJson(response, status, { error: { message, type: code, param: null, code } }, headers);
}

/**
 * An HTTP status paired with an OpenAI error code, thrown from inside the
 * request pipeline and rendered by {@link failRequest}.
 */
class ApiFailure extends Error {
    /**
     * @param {number} status - HTTP status code.
     * @param {string} code - machine-readable OpenAI error code.
     * @param {string} message - human-readable detail.
     */
    constructor(status, code, message) {
        super(message);
        this.name = 'ApiFailure';
        this.status = status;
        this.code = code;
    }
}

/**
 * Map a thrown value onto an HTTP response.
 * @param {import('node:http').ServerResponse} response - the response to fill.
 * @param {unknown} error - whatever the pipeline threw.
 * @param {Record<string, string>} headers - CORS headers to preserve.
 * @returns {void}
 */
function failRequest(response, error, headers) {
    if (error instanceof ApiFailure) {
        sendError(response, error.status, error.message, error.code, headers);
        return;
    }
    const code = typeof error?.code === 'string' ? error.code : '';
    const message = error instanceof Error ? error.message : String(error);
    const byCode = {
        MISSING_CREDENTIAL: [401, 'invalid_api_key'],
        INVALID_CREDENTIAL: [401, 'invalid_api_key'],
        AUTH: [401, 'invalid_api_key'],
        RATE_LIMIT: [429, 'rate_limit_exceeded'],
        QUOTA: [402, 'insufficient_quota'],
        ACCOUNT_QUOTA: [402, 'insufficient_quota'],
        CONTEXT_WINDOW_EXCEEDED: [400, 'context_length_exceeded'],
        UNSUPPORTED_CONTENT: [400, 'unsupported_content'],
        NO_ADAPTER: [503, 'model_unavailable'],
        UNSUPPORTED_REASONING_EFFORT: [400, 'invalid_request_error'],
        // This one is this endpoint's own code, not a Harness failure code: the
        // model looped on borrowed tools until the round limit stopped it. 409
        // rather than 5xx because nothing upstream broke — the request was
        // answered as far as this endpoint is willing to answer it, and the
        // caller's own retry policy, not the provider's, decides what next.
        TOOL_ROUND_LIMIT: [409, 'tool_round_limit'],
    };
    const [status, errorCode] = byCode[code] ?? [502, 'upstream_error'];
    sendError(response, status, message, errorCode, headers);
}

/**
 * Read a bounded JSON request body.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {Promise<object>} the parsed body object.
 * @throws {ApiFailure} on an oversized body, a malformed body, or a read error.
 */
async function readJsonBody(request) {
    const declared = Number(request.headers['content-length'] ?? 0);
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        throw new ApiFailure(413, 'request_too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    }
    const parts = [];
    let size = 0;
    for await (const part of request) {
        size += part.length;
        if (size > MAX_BODY_BYTES) {
            throw new ApiFailure(413, 'request_too_large', `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
        }
        parts.push(part);
    }
    if (size === 0) throw new ApiFailure(400, 'invalid_request_error', 'Request body is empty.');
    let parsed;
    try {
        parsed = JSON.parse(Buffer.concat(parts).toString('utf8'));
    } catch (error) {
        throw new ApiFailure(400, 'invalid_request_error', `Request body is not valid JSON: ${error.message}`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new ApiFailure(400, 'invalid_request_error', 'Request body must be a JSON object.');
    }
    return parsed;
}

/**
 * CORS headers for a configured origin.
 * @param {string} origin - the `corsOrigin` setting.
 * @returns {Record<string, string>} headers to attach to every response.
 */
function corsHeaders(origin) {
    return {
        'access-control-allow-origin': origin === '' ? '*' : origin,
        'access-control-allow-methods': 'GET, POST, OPTIONS',
        'access-control-allow-headers': 'authorization, content-type, x-api-key',
        'access-control-max-age': '600',
    };
}

/**
 * Length-checked comparison of a presented key against the configured one.
 * @param {string} expected - configured key.
 * @param {string} presented - key taken from the request.
 * @returns {boolean} whether the request may proceed.
 */
function keyMatches(expected, presented) {
    if (expected.length === 0) return true;
    if (presented.length !== expected.length) return false;
    let diff = 0;
    for (let index = 0; index < expected.length; index += 1) {
        diff |= expected.charCodeAt(index) ^ presented.charCodeAt(index);
    }
    return diff === 0;
}

/**
 * Extract the presented bearer token from either accepted header.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @returns {string} the presented key, or an empty string.
 */
function presentedKey(request) {
    const authorization = request.headers.authorization ?? '';
    if (typeof authorization === 'string' && authorization.toLowerCase().startsWith('bearer ')) {
        return authorization.slice(7).trim();
    }
    const header = request.headers['x-api-key'];
    return typeof header === 'string' ? header.trim() : '';
}

/**
 * Split an OpenAI model id into an explicit provider route and a model id.
 * @param {string} value - a `provider/model` or bare `model` identifier.
 * @returns {{ provider: string, model: string } | undefined} the split, when explicit.
 */
function splitModelId(value) {
    const at = value.indexOf('/');
    if (at <= 0 || at === value.length - 1) return undefined;
    return { provider: value.slice(0, at), model: value.slice(at + 1) };
}

/**
 * Read a message's `content` as plain text.
 * @param {unknown} content - a string, a content-part array, or undefined.
 * @returns {string} the concatenated text.
 */
function contentToText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
        .map((part) => (typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : ''))
        .filter((text) => text !== '')
        .join('\n');
}

function imageInputErrorToApiFailure(error) {
    return error instanceof ImageInputFailure
        ? new ApiFailure(error.status, error.code, error.message)
        : error;
}

/**
 * Convert and durably admit the content of a user message.
 * @param {unknown} content - OpenAI message content.
 * @param {number} index - message position.
 * @param {object | undefined} attachments - Harness attachment service.
 * @param {AbortSignal} signal - request cancellation signal.
 * @returns {Promise<object[]>} Harness-compatible message content.
 */
async function toContentBlocks(content, index, attachments, signal, imageBudget) {
    try {
        return await admitOpenAiUserContent(content, index, { attachments, signal, imageBudget });
    } catch (error) {
        throw imageInputErrorToApiFailure(error);
    }
}

/**
 * Convert one OpenAI chat message into a Harness request message.
 * @param {object} message - one entry of the request's `messages` array.
 * @param {number} index - its position, for error messages.
 * @returns {object} a frozen Harness message.
 * @throws {ApiFailure} for an unsupported role or malformed content.
 */
async function toHarnessMessage(message, index, attachments, signal, imageBudget) {
    const role = message?.role;
    if (role !== 'user' && Array.isArray(message?.content)
        && message.content.some((part) => part?.type === 'image_url')) {
        throw new ApiFailure(400, 'unsupported_content', 'Image content is supported only in user messages.');
    }
    if (role === 'system' || role === 'developer') {
        // The Harness folds a system message into the request's `system` field;
        // keeping it in the history would duplicate the prompt.
        return createUserMessage({ content: [{ type: 'text', text: contentToText(message.content) }], source: ENDPOINT_SOURCE });
    }
    if (role === 'user') {
        return createUserMessage({ content: await toContentBlocks(message.content, index, attachments, signal, imageBudget), source: ENDPOINT_SOURCE });
    }
    if (role === 'assistant') {
        const content = [];
        const text = contentToText(message.content);
        if (text !== '') content.push({ type: 'text', text });
        for (const call of message.tool_calls ?? []) {
            const name = call?.function?.name;
            if (typeof name !== 'string' || name === '') {
                throw new ApiFailure(400, 'invalid_request_error', `messages[${index}].tool_calls[].function.name is required.`);
            }
            content.push({
                type: 'tool-call',
                id: typeof call.id === 'string' && call.id !== '' ? call.id : `call_${randomUUID()}`,
                name,
                arguments: typeof call.function?.arguments === 'string' ? call.function.arguments : '{}',
            });
        }
        if (content.length === 0) content.push({ type: 'text', text: '' });
        return createAssistantMessage({ content, source: { provider: 'model-endpoint', model: 'client' } });
    }
    if (role === 'tool') {
        const callId = typeof message.tool_call_id === 'string' ? message.tool_call_id : '';
        if (callId === '') {
            throw new ApiFailure(400, 'invalid_request_error', `messages[${index}].tool_call_id is required for the tool role.`);
        }
        return createToolResultMessage({
            callId,
            content: [{ type: 'text', text: contentToText(message.content) }],
            isError: false,
        });
    }
    throw new ApiFailure(400, 'invalid_request_error', `messages[${index}].role "${String(role)}" is not supported.`);
}

/**
 * Convert OpenAI tool definitions into Harness tool schemas.
 * @param {unknown} tools - the request's `tools` array.
 * @returns {object[] | undefined} Harness schemas, or undefined when tools are absent.
 * @throws {ApiFailure} for a malformed tool definition.
 */
function toToolSchemas(tools) {
    if (tools === undefined || tools === null) return undefined;
    if (!Array.isArray(tools)) throw new ApiFailure(400, 'invalid_request_error', 'tools must be an array.');
    const schemas = [];
    for (const tool of tools) {
        const fn = tool?.type === 'function' ? tool.function : tool;
        const name = fn?.name;
        if (typeof name !== 'string' || name === '') {
            throw new ApiFailure(400, 'invalid_request_error', 'Every tool needs a function name.');
        }
        schemas.push({
            name,
            description: typeof fn.description === 'string' ? fn.description : '',
            parameters: typeof fn.parameters === 'object' && fn.parameters !== null ? fn.parameters : { type: 'object', properties: {} },
        });
    }
    return schemas;
}

/**
 * Read the tool schemas this profile has registered, as a model would see them.
 *
 * `schemas()` returns the global view — every tool any loaded plugin registered,
 * projected onto the model-facing fields. That projection is a fresh object, so
 * the `deferLoading` marker can be dropped here: the adapters in this
 * composition reject deferred loading, and by this point every schema is loaded
 * anyway.
 *
 * The Harness does not record which plugin registered a given tool, so these
 * rows carry a name and a description and nothing about their origin.
 * @param {object | undefined} tools - the `tools` service, if mounted.
 * @returns {{ name: string, description: string, parameters: object }[]} schemas sorted by name.
 */
function visibleTools(tools) {
    if (tools === undefined) return [];
    let rows;
    try {
        rows = tools.schemas();
    } catch {
        return [];
    }
    if (!Array.isArray(rows)) return [];
    const schemas = [];
    for (const row of rows) {
        const name = typeof row?.name === 'string' ? row.name : '';
        if (name === '') continue;
        schemas.push({
            name,
            description: typeof row.description === 'string' ? row.description : '',
            parameters: row.parameters !== null && typeof row.parameters === 'object' && !Array.isArray(row.parameters)
                ? row.parameters
                : { type: 'object', properties: {} },
        });
    }
    return schemas.sort((left, right) => left.name.localeCompare(right.name));
}

/**
 * Decide how a request's own tools and this endpoint's tools combine.
 *
 * They never combine. A request that defines its own functions keeps them and
 * the endpoint lends nothing, because a model that mixed the two would leave
 * the caller holding half a turn: the endpoint runs the tools it lends, and the
 * caller is the only party that can run the tools it defined itself.
 * @param {object | undefined} tools - the `tools` service, if mounted.
 * @param {object} settings - a settings snapshot.
 * @param {object[] | undefined} requested - schemas the caller defined itself.
 * @returns {{ lent: object[], maxRounds: number }} the tool plan for this request.
 */
function toolPlan(tools, settings, requested) {
    const none = { send: [], lent: new Set(), maxRounds: 1 };
    if (requested !== undefined && requested.length > 0) return { ...none, send: requested };
    if (!settings.toolsEnabled) return none;
    const switches = settings.toolSwitches;
    const lent = visibleTools(tools).filter((schema) => switches[schema.name] === true);
    if (lent.length === 0) return none;
    return {
        send: lent,
        lent: new Set(lent.map((schema) => schema.name)),
        maxRounds: Math.max(1, settings.maxToolRounds),
    };
}

/**
 * Flatten a tool result into the text a model reads back on the next round.
 * @param {object} result - a `ctx.tools.execute` result.
 * @returns {string} the textual content, or a placeholder when there is none.
 */
function toolResultText(result) {
    const content = Array.isArray(result?.content) ? result.content : [];
    const parts = [];
    for (const block of content) {
        if (typeof block === 'string') parts.push(block);
        else if (block?.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    }
    if (parts.length > 0) return parts.join('\n');
    return result?.isError === true ? 'The tool failed.' : 'The tool returned no content.';
}

/**
 * Run one model-requested tool call through this profile's own registry.
 *
 * This is the whole point of the tool switches: the call is executed by the
 * Harness, with whatever authority the tool already has, which is why each tool
 * has to be switched on deliberately.
 * @param {object} tools - the `tools` service.
 * @param {{ id: string, name: string, arguments: string }} call - the requested call.
 * @param {AbortSignal} signal - cancellation for this completion.
 * @returns {Promise<{ text: string, isError: boolean }>} what to feed back to the model.
 */
async function runToolCall(tools, call, signal) {
    const raw = typeof call.arguments === 'string' ? call.arguments.trim() : '';
    let args;
    try {
        args = raw === '' ? {} : JSON.parse(raw);
    } catch {
        return { text: `Error: the arguments for "${call.name}" are not valid JSON, so it was not run.`, isError: true };
    }
    try {
        const result = await tools.execute({ name: call.name, arguments: args, callId: call.id, signal });
        return { text: toolResultText(result), isError: result?.isError === true };
    } catch (error) {
        return { text: `Error: ${error instanceof Error ? error.message : String(error)}`, isError: true };
    }
}

/**
 * Add one round's token counts to the running total.
 * @param {object | undefined} total - the accumulated usage.
 * @param {object | undefined} next - this round's usage.
 * @returns {object | undefined} the new total.
 */
function mergeUsage(total, next) {
    if (next === undefined || next === null) return total;
    const base = total ?? {};
    const add = (key) => {
        const left = Number.isFinite(base[key]) ? base[key] : 0;
        const right = Number.isFinite(next[key]) ? next[key] : 0;
        return left + right;
    };
    return {
        inputTokens: add('inputTokens'),
        outputTokens: add('outputTokens'),
        cacheReadTokens: add('cacheReadTokens'),
        cacheWriteTokens: add('cacheWriteTokens'),
        reasoningTokens: add('reasoningTokens'),
    };
}

/**
 * Run a chat turn to its end, executing the tools this endpoint lends.
 *
 * Each round is one full model call. When the model asks only for tools this
 * endpoint lent, they run here and the conversation continues with their
 * results. Anything else ends the turn and comes back to the caller, which is
 * the only party that can act on it.
 * @param {object} ctx - the plugin context.
 * @param {object} deps - resolved services and settings.
 * @param {object} options - the base `ctx.llm.stream` options.
 * @param {{ send: object[], lent: Set<string>, maxRounds: number }} plan - the tool plan.
 * @param {object} sink - callbacks for incremental output: text, reasoning, toolCall.
 * @returns {Promise<object>} the turn outcome: text, toolCalls, finish, usage, failed.
 */
async function driveRounds(deps, options, plan, sink) {
    const messages = [...options.messages];
    let text = '';
    let usage;
    const roundOneOptions = plan.send.length === 0 ? { ...options, messages } : { ...options, messages, tools: plan.send };
    for (let round = 0; round < plan.maxRounds; round += 1) {
        const assembler = new BlockAssembler();
        const owned = new Set();
        const foreign = new Set();
        const announced = new Set();
        const held = new Map();
        const emitCall = (chunk) => {
            const first = !announced.has(chunk.index);
            announced.add(chunk.index);
            sink.toolCall?.({ index: chunk.index, id: chunk.id, name: chunk.name, argumentsDelta: chunk.argumentsDelta, first });
        };
        const flushHeld = (index, isOwned) => {
            const buffer = held.get(index);
            held.delete(index);
            if (isOwned || buffer === undefined) return;
            for (const item of buffer) emitCall(item);
        };
        let reason;
        let roundUsage;
        const roundOptions = round === 0
            ? roundOneOptions
            : plan.send.length === 0
                ? { ...options, messages }
                : { ...options, messages, tools: plan.send };
        for await (const chunk of deps.ctx.llm.stream(roundOptions)) {
            switch (chunk.type) {
                case 'text-delta':
                    assembler.push(chunk);
                    text += chunk.text;
                    sink.text?.(chunk.text);
                    break;
                case 'reasoning-delta':
                    assembler.push(chunk);
                    sink.reasoning?.(chunk.text);
                    break;
                case 'tool-call-delta': {
                    assembler.push(chunk);
                    const index = chunk.index;
                    if (owned.has(index)) break;
                    if (foreign.has(index)) {
                        emitCall(chunk);
                        break;
                    }
                    const named = typeof chunk.name === 'string' && chunk.name !== '';
                    if (named) {
                        const isOwned = plan.lent.has(chunk.name);
                        if (isOwned) owned.add(index);
                        else foreign.add(index);
                        flushHeld(index, isOwned);
                        if (!isOwned) emitCall(chunk);
                        break;
                    }
                    const buffer = held.get(index);
                    if (buffer === undefined) held.set(index, [chunk]);
                    else buffer.push(chunk);
                    break;
                }
                case 'usage':
                    assembler.push(chunk);
                    roundUsage = chunk.usage;
                    break;
                case 'finish':
                    assembler.push(chunk);
                    reason = chunk.reason;
                    break;
                default:
                    assembler.push(chunk);
                    break;
            }
        }
        // A call that never announced a name cannot be attributed to a lent
        // tool, so it belongs to the caller.
        for (const index of [...held.keys()]) {
            foreign.add(index);
            flushHeld(index, false);
        }
        usage = mergeUsage(usage, roundUsage ?? assembler.usage);
        if (reason?.kind === 'error' || reason?.kind === 'aborted') {
            return { text, toolCalls: [], finish: reason, usage, failed: reason.failure ?? { message: 'The model call failed.' } };
        }
        const blocks = assembler.blocks();
        const calls = blocks
            .filter((block) => block.type === 'tool-call')
            .map((block) => ({ id: block.id, name: block.name, arguments: block.arguments }));
        const lent = calls.filter((call) => plan.lent.has(call.name));
        const others = calls.filter((call) => !plan.lent.has(call.name));
        if (others.length > 0 || lent.length === 0) {
            return { text, toolCalls: others, finish: reason, usage, failed: undefined };
        }
        if (round + 1 >= plan.maxRounds) {
            return {
                text,
                toolCalls: [],
                finish: reason,
                usage,
                failed: { message: `The model kept calling tools past the ${plan.maxRounds}-round limit, so the turn was cut off.`, code: 'TOOL_ROUND_LIMIT' },
            };
        }
        messages.push(createAssistantMessage({
            content: blocks,
            source: { provider: options.provider, model: options.model },
        }));
        for (const call of lent) {
            const outcome = await runToolCall(deps.tools, call, options.signal);
            sink.toolResult?.(call, outcome);
            messages.push(createToolResultMessage({
                callId: call.id,
                content: [{ type: 'text', text: outcome.text }],
                isError: outcome.isError,
            }));
        }
    }
    return { text, toolCalls: [], finish: { kind: 'stop' }, usage, failed: undefined };
}

/**
 * Read the model the profile is currently using, from the service that both the
 * chat picker and the Models settings page write to.
 * @param {object | undefined} service - the `agentDefaultModel` service, if mounted.
 * @returns {{ provider: string, model: string, reasoningEffort?: string } | undefined} the selection.
 */
function selectedRoute(service) {
    if (service === undefined) return undefined;
    try {
        const selection = service.currentSelection();
        if (typeof selection?.provider === 'string' && typeof selection?.model === 'string' && selection.model !== '') {
            return {
                provider: selection.provider,
                model: selection.model,
                ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: String(selection.reasoningEffort) }),
            };
        }
    } catch {
        // A missing or misbehaving service must never break the endpoint.
    }
    return undefined;
}

/**
 * Enumerate every routable model.
 * @param {object} ctx - the plugin context.
 * @returns {Promise<{ provider: string, id: string, name: string }[]>} catalog rows.
 */
async function catalog(ctx) {
    const rows = [];
    for (const provider of ctx.llm.listProviders()) {
        try {
            for (const model of await ctx.llm.listModels(provider.id)) {
                rows.push({ provider: provider.id, id: model.id, name: model.name || model.id });
            }
        } catch {
            // A provider that cannot enumerate is simply absent from the catalog.
        }
    }
    return rows;
}

/**
 * List the reasoning efforts one model accepts.
 *
 * The settings page turns this into a dropdown, so a user never has to know
 * that effort ids are provider vocabulary: whatever the model declares is what
 * the dropdown offers, and nothing else can be selected.
 * @param {object} ctx - the plugin context.
 * @param {string} provider - the provider id to inspect.
 * @param {string} model - the model id to inspect.
 * @returns {Promise<object>} the declared efforts, or an empty list with a reason.
 */
async function effortsFor(ctx, provider, model) {
    if (provider === '' || model === '') {
        return { provider, model, efforts: [] };
    }
    try {
        const info = await ctx.llm.resolveModelInfo(provider, model);
        const efforts = (info?.reasoning?.efforts ?? [])
            .filter((effort) => typeof effort?.id === 'string' && effort.id !== '')
            .map((effort) => ({
                id: effort.id,
                name: typeof effort.name === 'string' && effort.name !== '' ? effort.name : effort.id,
            }));
        const defaultEffort = info?.reasoning?.defaultEffort;
        return {
            provider,
            model,
            efforts,
            ...(typeof defaultEffort === 'string' && defaultEffort !== '' ? { defaultEffort } : {}),
        };
    } catch (error) {
        // An unreachable model simply declares nothing; the dropdown then offers
        // only "model default", which is exactly right for a model that cannot
        // be asked.
        return {
            provider,
            model,
            efforts: [],
            reason: error instanceof Error ? error.message : String(error),
        };
    }
}

/**
 * Decide which provider and model a request should use.
 *
 * Precedence: an explicit `model` in the request, then the profile's current
 * selection (chat picker or Models page), then this endpoint's own settings.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - a settings snapshot.
 * @param {object | undefined} service - the `agentDefaultModel` service, if mounted.
 * @param {unknown} requested - the request's `model` field.
 * @param {AbortSignal} signal - cancellation for metadata lookups.
 * @returns {Promise<object>} the resolved route, with a `source` tag.
 * @throws {ApiFailure} when nothing routable can be found.
 */
async function resolveRoute(ctx, settings, service, requested, signal) {
    const wanted = typeof requested === 'string' ? requested.trim() : '';
    const explicit = wanted !== '' && wanted.toLowerCase() !== 'auto' && wanted.toLowerCase() !== 'default';
    const selection = selectedRoute(service);
    const candidates = [];
    if (explicit) {
        const split = splitModelId(wanted);
        if (split !== undefined) candidates.push({ ...split, source: 'request' });
        if (selection !== undefined && selection.model === wanted) {
            candidates.push({ provider: selection.provider, model: selection.model, source: 'request' });
        }
        for (const row of await catalog(ctx)) {
            if (row.id === wanted && !candidates.some((c) => c.provider === row.provider && c.model === row.id)) {
                candidates.push({ provider: row.provider, model: row.id, source: 'request' });
            }
        }
    } else {
        if (settings.followSelection && selection !== undefined) {
            candidates.push({ ...selection, source: 'selection' });
        }
        if (settings.provider !== '' && settings.model !== '') {
            candidates.push({ provider: settings.provider, model: settings.model, source: 'settings' });
        }
        if (selection !== undefined) candidates.push({ ...selection, source: 'selection' });
    }

    const failures = [];
    for (const candidate of candidates) {
        try {
            const modelInfo = await ctx.llm.resolveModelInfo(candidate.provider, candidate.model, signal);
            return {
                ...candidate,
                ...(Array.isArray(modelInfo?.inputModalities) ? { inputModalities: modelInfo.inputModalities } : {}),
            };
        } catch (error) {
            failures.push(`${candidate.provider}/${candidate.model}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    if (explicit) {
        throw new ApiFailure(404, 'model_not_found', `No routable model matches "${wanted}". Try GET /v1/models.`);
    }
    throw new ApiFailure(
        503,
        'model_unavailable',
        candidates.length === 0
            ? 'No model is selected in this profile and none is configured on the endpoint settings page.'
            : `No configured model is routable. ${failures.join(' | ')}`,
    );
}

/**
 * Pick the reasoning effort to send, honouring only efforts the model declares.
 * @param {object} ctx - the plugin context.
 * @param {object} route - the resolved route.
 * @param {unknown} requested - the request's `reasoning_effort`, if any.
 * @param {object} settings - a settings snapshot.
 * @param {AbortSignal} signal - cancellation for metadata lookups.
 * @returns {Promise<string | undefined>} an accepted effort id, or undefined.
 */
async function resolveEffort(ctx, route, requested, settings, signal) {
    const wanted = String(requested ?? route.reasoningEffort ?? settings.reasoningEffort ?? '').trim();
    if (wanted === '' || wanted === 'none') return undefined;
    try {
        const info = await ctx.llm.resolveModelInfo(route.provider, route.model, signal);
        const efforts = info?.reasoning?.efforts ?? [];
        if (efforts.some((effort) => effort.id === wanted)) return wanted;
    } catch {
        // An unresolvable metadata read simply drops the effort.
    }
    return undefined;
}

/**
 * Map a Harness finish reason onto an OpenAI `finish_reason`.
 * @param {object} reason - the finish reason from the chunk stream.
 * @returns {string} the OpenAI finish reason.
 */
function finishReason(reason) {
    switch (reason?.kind) {
        case 'tool-calls':
            return 'tool_calls';
        case 'max-tokens':
            return 'length';
        case 'stop':
        default:
            return 'stop';
    }
}

/**
 * Map a Harness token usage onto OpenAI's usage object.
 * @param {object | undefined} usage - the assembler's usage, if the adapter reported any.
 * @returns {object} an OpenAI usage object.
 */
function openAiUsage(usage) {
    const prompt = Number(usage?.inputTokens ?? 0);
    const completion = Number(usage?.outputTokens ?? 0);
    return {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: Number(usage?.totalTokens ?? prompt + completion),
    };
}

/**
 * Build the `ctx.llm.stream` options for one chat request.
 * @param {object} route - the resolved route.
 * @param {object} input - the parsed request body.
 * @param {object} settings - a settings snapshot.
 * @param {string | undefined} effort - the accepted reasoning effort.
 * @param {AbortSignal} signal - cancellation for this completion.
 * @param {object[]} send - the exact tool schemas to put on the wire.
 * @param {object | undefined} attachments - the Harness attachment service.
 * @returns {Promise<object>} options accepted by `ctx.llm.stream`.
 * @throws {ApiFailure} for malformed messages or content parts.
 */
async function streamOptions(route, input, settings, effort, signal, send, attachments) {
    const messages = [];
    const imageBudget = { imageCount: 0, imageBytes: 0 };
    for (let index = 0; index < input.messages.length; index += 1) {
        messages.push(await toHarnessMessage(input.messages[index], index, attachments, signal, imageBudget));
    }
    const hasSystem = input.messages.some((message) => message?.role === 'system' || message?.role === 'developer');
    const system = hasSystem ? '' : settings.systemPrompt;
    const requested = Number(input.max_tokens ?? input.max_completion_tokens);
    // A request's own 0 means the same thing as the setting's: no ceiling of
    // ours. Only a positive number is a cap, so maxTokens stays absent and the
    // provider's own model limit is what applies.
    const cap = Number.isFinite(requested) && requested >= 0 ? Math.floor(requested) : settings.defaultMaxTokens;
    const temperature = Number.isFinite(input.temperature) ? input.temperature : undefined;
    const stop = typeof input.stop === 'string' ? [input.stop] : Array.isArray(input.stop) ? input.stop.filter((value) => typeof value === 'string') : undefined;
    return {
        provider: route.provider,
        model: route.model,
        messages,
        signal,
        ...(cap >= 1 ? { maxTokens: cap } : {}),
        ...(system.trim() === '' ? {} : { system }),
        ...(send.length === 0 ? {} : { tools: send }),
        ...(temperature === undefined ? {} : { temperature }),
        ...(stop === undefined || stop.length === 0 ? {} : { stop }),
        ...(effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) }),
    };
}

/**
 * Answer one chat completion, streaming or not.
 * @param {object} deps - resolved services and settings.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @param {import('node:http').ServerResponse} response - the response to fill.
 * @param {Record<string, string>} headers - CORS headers.
 * @returns {Promise<void>} after the response is complete.
 */
async function handleChat(deps, request, response, headers) {
    const { ctx, settings, service } = deps;
    const input = await readJsonBody(request);
    if (!Array.isArray(input.messages) || input.messages.length === 0) {
        throw new ApiFailure(400, 'invalid_request_error', 'messages must be a non-empty array.');
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error(`no completion within ${settings.requestTimeoutMs} ms`)), settings.requestTimeoutMs);
    const onClose = () => {
        if (!response.writableEnded) controller.abort(new Error('client disconnected'));
    };
    request.on('close', onClose);
    try {
        const route = await resolveRoute(ctx, settings, service, input.model, controller.signal);
        try {
            assertUserImageInputSupported(input.messages, route.inputModalities);
        } catch (error) {
            throw imageInputErrorToApiFailure(error);
        }
        const effort = await resolveEffort(ctx, route, input.reasoning_effort, settings, controller.signal);
        const requestedTools = toToolSchemas(input.tools);
        const plan = toolPlan(deps.tools, settings, requestedTools);
        const options = await streamOptions(route, input, settings, effort, controller.signal, plan.send, deps.attachments);
        const modelLabel = `${route.provider}/${route.model}`;
        if (input.stream === true) {
            await streamChat(deps, options, modelLabel, plan, response, headers);
        } else {
            await completeChat(deps, options, modelLabel, plan, response, headers);
        }
    } finally {
        clearTimeout(timeout);
        request.off('close', onClose);
    }
}

/**
 * Run a completion to the end and answer with one JSON body.
 * @param {object} deps - resolved services and settings.
 * @param {object} options - `ctx.llm.stream` options.
 * @param {string} modelLabel - the `provider/model` label echoed to the client.
 * @param {{ send: object[], lent: Set<string>, maxRounds: number }} plan - the tool plan.
 * @param {import('node:http').ServerResponse} response - the response to fill.
 * @param {Record<string, string>} headers - CORS headers.
 * @returns {Promise<void>} after the response is complete.
 */
async function completeChat(deps, options, modelLabel, plan, response, headers) {
    const outcome = await driveRounds(deps, options, plan, {});
    if (outcome.failed !== undefined) {
        failRequest(response, Object.assign(new Error(outcome.failed.message ?? 'The model call failed.'), { code: outcome.failed.code }), headers);
        return;
    }
    const toolCalls = outcome.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: call.arguments },
    }));
    sendJson(
        response,
        200,
        {
            id: `chatcmpl-${randomUUID()}`,
            object: 'chat.completion',
            created: Math.floor(Date.now() / 1000),
            model: modelLabel,
            choices: [
                {
                    index: 0,
                    message: {
                        role: 'assistant',
                        content: outcome.text,
                        ...(toolCalls.length === 0 ? {} : { tool_calls: toolCalls }),
                    },
                    finish_reason: toolCalls.length === 0 ? finishReason(outcome.finish) : 'tool_calls',
                },
            ],
            usage: openAiUsage(outcome.usage),
        },
        headers,
    );
}

/**
 * Stream a completion as server-sent events.
 * @param {object} deps - resolved services and settings.
 * @param {object} options - `ctx.llm.stream` options.
 * @param {string} modelLabel - the `provider/model` label echoed to the client.
 * @param {{ send: object[], lent: Set<string>, maxRounds: number }} plan - the tool plan.
 * @param {import('node:http').ServerResponse} response - the response to fill.
 * @param {Record<string, string>} headers - CORS headers.
 * @returns {Promise<void>} after the stream is closed.
 */
async function streamChat(deps, options, modelLabel, plan, response, headers) {
    response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        ...headers,
    });
    const id = `chatcmpl-${randomUUID()}`;
    const created = Math.floor(Date.now() / 1000);
    const emit = (payload) => {
        if (response.writableEnded) return;
        response.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const envelope = (delta, finish, usage) => ({
        id,
        object: 'chat.completion.chunk',
        created,
        model: modelLabel,
        choices: [{ index: 0, delta, finish_reason: finish ?? null, ...(usage === undefined ? {} : { usage }) }],
    });
    emit(envelope({ role: 'assistant', content: '' }, null));
    let visible = 0;
    let failed;
    const sink = {
        text: (chunk) => {
            visible += chunk.length;
            emit(envelope({ content: chunk }, null));
        },
        reasoning: (chunk) => {
            emit(envelope({ reasoning_content: chunk }, null));
        },
        toolCall: (call) => {
            emit(
                envelope(
                    {
                        tool_calls: [
                            {
                                index: call.index,
                                ...(call.first ? { id: call.id, type: 'function' } : {}),
                                function: {
                                    ...(call.name === undefined || call.name === '' ? {} : { name: call.name }),
                                    arguments: call.argumentsDelta,
                                },
                            },
                        ],
                    },
                    null,
                ),
            );
        },
    };
    let outcome;
    try {
        outcome = await driveRounds(deps, options, plan, sink);
    } catch (error) {
        failed = { message: error instanceof Error ? error.message : String(error), code: error?.code };
    }
    if (outcome !== undefined) {
        if (outcome.failed !== undefined) failed = outcome.failed;
        else if (outcome.toolCalls.length > 0) emit(envelope({}, 'tool_calls', openAiUsage(outcome.usage)));
        else emit(envelope({}, finishReason(outcome.finish), openAiUsage(outcome.usage)));
    }
    if (failed !== undefined) {
        const detail = visible === 0 ? failed.message : `The stream ended early: ${failed.message}`;
        emit({ error: { message: detail, type: failed.code ?? 'upstream_error', code: failed.code ?? null, param: null } });
    }
    response.write('data: [DONE]\n\n');
    response.end();
}

/**
 * List every routable model, plus the one this endpoint currently defaults to.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - a settings snapshot.
 * @param {object | undefined} service - the `agentDefaultModel` service, if mounted.
 * @param {import('node:http').ServerResponse} response - the response to fill.
 * @param {Record<string, string>} headers - CORS headers.
 * @param {string | undefined} requestedId - a specific model id when serving `/v1/models/<id>`.
 * @returns {Promise<void>} after the response is complete.
 * @throws {ApiFailure} when a specifically requested model is not in the catalog.
 */
async function handleModels(ctx, settings, service, response, headers, requestedId) {
    const rows = await catalog(ctx);
    const selection = selectedRoute(service);
    const entries = [];
    const seen = new Set();
    const push = (id, owner) => {
        if (seen.has(id)) return;
        seen.add(id);
        entries.push({ id, object: 'model', created: MODEL_CREATED, owned_by: owner });
    };
    if (selection !== undefined && rows.some((row) => row.provider === selection.provider && row.id === selection.model)) {
        push(`${selection.provider}/${selection.model}`, selection.provider);
    }
    for (const row of rows) push(`${row.provider}/${row.id}`, row.provider);
    for (const row of rows) {
        if (!rows.some((other) => other.id === row.id && other.provider !== row.provider)) push(row.id, row.provider);
    }
    if (settings.provider !== '' && settings.model !== '') push(`${settings.provider}/${settings.model}`, settings.provider);
    const data = requestedId === undefined ? entries : entries.filter((entry) => entry.id === requestedId);
    if (requestedId !== undefined && data.length === 0) {
        throw new ApiFailure(404, 'model_not_found', `No model named "${requestedId}". Try GET /v1/models.`);
    }
    sendJson(response, 200, { object: 'list', data }, headers);
}

/**
 * Describe this endpoint for `/` and `/health`.
 * @param {object} ctx - the plugin context.
 * @param {object} settings - a settings snapshot.
 * @param {object | undefined} service - the `agentDefaultModel` service, if mounted.
 * @param {number | undefined} boundPort - the live port, when the listener is up.
 * @param {object | undefined} tools - the `tools` service, if mounted.
 * @returns {object} a status document.
 */
function healthDocument(ctx, settings, service, boundPort, tools) {
    const selection = selectedRoute(service);
    const port = boundPort ?? settings.port;
    const loopback = isLoopbackHost(settings.host);
    const address = lanAddresses()[0];
    const switched = Object.values(settings.toolSwitches).filter((flag) => flag === true).length;
    return {
        status: boundPort === undefined ? 'stopped' : 'ok',
        object: 'dsh.model_endpoint',
        model: selection === undefined
            ? settings.provider !== '' && settings.model !== ''
                ? { provider: settings.provider, model: settings.model, source: 'settings' }
                : null
            : { provider: selection.provider, model: selection.model, source: 'selection' },
        bind: { host: settings.host, port, baseUrl: `http://${settings.host}:${port}/v1` },
        reachableFrom: {
            thisMachine: `http://127.0.0.1:${port}/v1`,
            localNetwork: loopback || address === undefined ? null : `http://${address}:${port}/v1`,
            publicInternet: loopback ? null : 'this port, through your router or NAT forward',
        },
        authentication: settings.apiKey === '' ? 'none' : 'bearer',
        lanAddresses: lanAddresses(),
        providers: ctx.llm.listProviders().map((provider) => provider.id),
        tools: {
            available: tools === undefined ? 0 : visibleTools(tools).length,
            enabled: settings.toolsEnabled,
            switchedOn: switched,
            maxRounds: settings.maxToolRounds,
        },
        hint: 'POST /v1/chat/completions with any OpenAI-compatible client.',
    };
}

/**
 * Route one request.
 * @param {object} deps - resolved services and settings.
 * @param {import('node:http').IncomingMessage} request - the incoming request.
 * @param {import('node:http').ServerResponse} response - the response to fill.
 * @returns {Promise<void>} after the response is complete.
 */
async function handleRequest(deps, request, response) {
    const { ctx, settings, service } = deps;
    const headers = corsHeaders(settings.corsOrigin);
    if (request.method === 'OPTIONS') {
        response.writeHead(204, headers);
        response.end();
        return;
    }
    const pathname = new URL(request.url ?? '/', 'http://endpoint.invalid').pathname.replace(/\/+$/, '') || '/';
    const known = pathname === '/' || pathname === '/health' || pathname === '/v1/models' || pathname === '/v1/chat/completions' || pathname.startsWith('/v1/models/');
    if (!known) {
        throw new ApiFailure(404, 'not_found', `No route for ${request.method} ${pathname}. This endpoint serves /v1/models and /v1/chat/completions.`);
    }
    if (pathname === '/' || pathname === '/health') {
        const document = healthDocument(ctx, settings, service, deps.bound?.port, deps.tools);
        sendJson(response, document.status === 'ok' ? 200 : 503, document, headers);
        return;
    }
    if (!keyMatches(settings.apiKey, presentedKey(request))) {
        throw new ApiFailure(401, 'invalid_api_key', 'Missing or invalid API key. Send it as "Authorization: Bearer <key>".');
    }
    if (pathname === '/v1/models') {
        if (request.method !== 'GET') throw new ApiFailure(405, 'method_not_allowed', 'Use GET /v1/models.');
        await handleModels(ctx, settings, service, response, headers, undefined);
        return;
    }
    if (pathname.startsWith('/v1/models/')) {
        if (request.method !== 'GET') throw new ApiFailure(405, 'method_not_allowed', 'Use GET /v1/models/<id>.');
        await handleModels(ctx, settings, service, response, headers, decodeURIComponent(pathname.slice('/v1/models/'.length)));
        return;
    }
    if (request.method !== 'POST') throw new ApiFailure(405, 'method_not_allowed', 'Use POST /v1/chat/completions.');
    await handleChat(deps, request, response, headers);
}

/**
 * Mount the endpoint, rebinding it whenever a setting changes.
 * @param {object} ctx - the plugin context.
 * @param {object} config - the plugin Config.
 * @returns {void}
 */
export function apply(ctx, config) {
    // This plugin ships its own settings page, so suppress the generated form.
    ctx.inject(['settings'], (child) => {
        child.effect(() => child.settings.configure({ auto: false }, ctx.fiber));
    });

    const bound = { port: undefined };
    let service;
    let tools;
    let attachments;
    let live;
    let queue = Promise.resolve();
    let generation = 0;

    ctx.inject(['agentDefaultModel'], (child) => {
        service = child.agentDefaultModel;
        child.effect(() => () => {
            service = undefined;
        });
    });

    ctx.inject(['tools'], (child) => {
        tools = child.tools;
        child.effect(() => () => {
            tools = undefined;
        });
    });

    ctx.inject(['attachments'], (child) => {
        attachments = child.attachments;
        child.effect(() => () => {
            attachments = undefined;
        });
    });

    const settingsNow = () => snapshot(config);

    // A same-origin status route on the Harness web server, so the settings page
    // can show what is live without reaching across to the endpoint's own port
    // (which may be bound to a different interface, or not be up at all).
    ctx.inject(['webServer'], (child) => {
        child.effect(() => {
            const dispose = child.webServer.register({
                kind: 'prefix',
                path: '/plugins/model-endpoint',
                handler: async (request, response) => {
                    const settings = settingsNow();
                    const url = new URL(request.url ?? '/', 'http://dsh.internal');
                    const document = {
                        ok: true,
                        ...healthDocument(ctx, settings, service, bound.port, tools),
                    };
                    if (url.pathname.endsWith('/models')) {
                        document.catalog = await catalog(ctx);
                    }
                    if (url.pathname.endsWith('/tools')) {
                        // Every registered tool with its switch state, so the page
                        // can offer the whole surface without a second round trip.
                        document.toolList = visibleTools(tools).map((schema) => ({
                            name: schema.name,
                            description: schema.description,
                            enabled: settings.toolSwitches[schema.name] === true,
                        }));
                    }
                    if (url.pathname.endsWith('/efforts')) {
                        // Default to what the endpoint would actually serve, so
                        // the page can populate the dropdown before a provider
                        // and model have been chosen explicitly.
                        const fallback = settings.provider !== '' && settings.model !== ''
                            ? { provider: settings.provider, model: settings.model }
                            : selectedRoute(service) ?? { provider: '', model: '' };
                        document.efforts = await effortsFor(
                            ctx,
                            url.searchParams.get('provider') ?? fallback.provider,
                            url.searchParams.get('model') ?? fallback.model,
                        );
                    }
                    sendJson(response, 200, document);
                },
            });
            return () => {
                dispose();
            };
        }, 'dsh-model-endpoint: status route');
    });

    const stop = async () => {
        const current = live;
        live = undefined;
        bound.port = undefined;
        if (current === undefined) return;
        try {
            await current.close();
        } catch (error) {
            ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)));
        }
    };

    const start = async (mine) => {
        const settings = settingsNow();
        await stop();
        if (!settings.enabled) {
            ctx.logger?.info?.('dsh-model-endpoint: disabled, no listener started.');
            return;
        }
        const server = createServer((request, response) => {
            const deps = { ctx, settings: settingsNow(), service, tools, attachments, bound };
            handleRequest(deps, request, response).catch((error) => {
                ctx.logger?.warn?.(error instanceof Error ? error : new Error(String(error)));
                if (response.headersSent) {
                    if (!response.writableEnded) response.end();
                    return;
                }
                failRequest(response, error, corsHeaders(deps.settings.corsOrigin));
            });
        });
        server.on('clientError', (_error, socket) => {
            if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
        });
        try {
            await new Promise((resolve, reject) => {
                const onError = (error) => {
                    server.off('listening', onListening);
                    reject(error);
                };
                const onListening = () => {
                    server.off('error', onError);
                    resolve();
                };
                server.once('error', onError);
                server.once('listening', onListening);
                server.listen(settings.port, settings.host);
            });
        } catch (error) {
            ctx.logger?.warn?.(new Error(`dsh-model-endpoint: cannot bind ${settings.host}:${settings.port} — ${error instanceof Error ? error.message : String(error)}`));
            return;
        }
        if (mine !== generation) {
            await new Promise((resolve) => server.close(() => resolve()));
            return;
        }
        live = {
            close: () => new Promise((resolve) => server.close(() => resolve())),
        };
        const address = server.address();
        bound.port = typeof address === 'object' && address !== null ? address.port : settings.port;
        const unsafe = settings.apiKey === '' && !isLoopbackHost(settings.host);
        ctx.logger?.info?.(
            `dsh-model-endpoint: listening on http://${settings.host}:${bound.port}/v1${unsafe ? ' — WARNING: reachable off this machine with no API key set.' : ''}`,
        );
    };

    const restart = () => {
        generation += 1;
        const mine = generation;
        queue = queue.then(() => start(mine), () => start(mine));
        return queue;
    };

    ctx.effect(() => {
        void restart();
        return () => {
            generation += 1;
            void stop();
        };
    }, 'dsh-model-endpoint: http listener');

    // Volatile settings change at any time; rebind so the listener follows them.
    ctx.on('loader/volatile-update', () => {
        void restart();
    });
}
