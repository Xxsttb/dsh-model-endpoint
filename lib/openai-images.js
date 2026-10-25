import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';

export const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;
const SUPPORTED_MEDIA_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);

export class ImageInputFailure extends Error {
    constructor(status, code, message) {
        super(message);
        this.name = 'ImageInputFailure';
        this.status = status;
        this.code = code;
    }
}

function invalidImage(message) {
    return new ImageInputFailure(400, 'invalid_request_error', message);
}

/** Check whether an IP is globally routable before the endpoint fetches it. */
export function isPublicAddress(address) {
    const family = isIP(address);
    if (family === 4) {
        const [a, b, c] = address.split('.').map(Number);
        return !(
            a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 100 && b >= 64 && b <= 127)
            || (a === 169 && b === 254)
            || (a === 172 && b >= 16 && b <= 31)
            || (a === 192 && b === 0)
            || (a === 192 && b === 2)
            || (a === 192 && b === 88 && c === 99)
            || (a === 192 && b === 168)
            || (a === 198 && (b === 18 || b === 19))
            || (a === 198 && b === 51 && c === 100)
            || (a === 203 && b === 0 && c === 113)
        );
    }
    if (family === 6) {
        // Only global-unicast 2000::/3 is eligible. This excludes loopback,
        // mapped IPv4, unique-local, link-local, multicast, and unspecified ranges.
        const groups = address.split('%', 1)[0].toLowerCase().split(':');
        const first = Number.parseInt(groups[0] || '0', 16);
        const second = Number.parseInt(groups[1] || '0', 16);
        if (first < 0x2000 || first > 0x3fff) return false;
        // IETF protocol assignments, documentation, and 6to4 are not public origins.
        if (first === 0x2001 && (second <= 0x01ff || second === 0x0db8)) return false;
        if (first === 0x2002) return false;
        if (first === 0x3fff && second < 0x1000) return false;
        return true;
    }
    return false;
}

/** Decode an OpenAI-style base64 data URL, rejecting oversized or non-image input. */
export function decodeImageDataUrl(value, maxBytes = MAX_IMAGE_BYTES) {
    if (typeof value !== 'string' || !value.startsWith('data:')) {
        throw invalidImage('image_url must be an HTTP(S) URL or a base64 image data URL.');
    }
    const comma = value.indexOf(',');
    if (comma < 0) throw invalidImage('The image data URL is malformed.');
    const metadata = value.slice(5, comma).split(';');
    const mediaType = (metadata.shift() ?? '').trim().toLowerCase();
    if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
        throw new ImageInputFailure(400, 'unsupported_content', 'Only PNG, JPEG, WebP, and GIF image inputs are supported.');
    }
    if (metadata.length === 0 || metadata.at(-1)?.toLowerCase() !== 'base64') {
        throw invalidImage('Image data URLs must use base64 encoding.');
    }
    const allowedBytes = Math.max(0, Math.min(MAX_IMAGE_BYTES, Math.floor(Number(maxBytes) || 0)));
    const encoded = value.slice(comma + 1);
    const encodedLimit = Math.ceil(allowedBytes / 3) * 4 + 4;
    if (encoded.length > encodedLimit) {
        throw new ImageInputFailure(413, 'request_too_large', 'Image exceeds ' + allowedBytes + ' bytes.');
    }
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1) {
        throw invalidImage('The image data URL contains invalid base64.');
    }
    const data = Buffer.from(encoded, 'base64');
    if (data.length === 0 || data.length > allowedBytes) {
        throw new ImageInputFailure(413, 'request_too_large', 'Image must contain between 1 and ' + allowedBytes + ' bytes.');
    }
    const normalized = encoded.replace(/=+$/, '');
    if (data.toString('base64').replace(/=+$/, '') !== normalized) {
        throw invalidImage('The image data URL contains invalid base64.');
    }
    return { data, mediaType };
}

function validateWebUrl(value) {
    let url;
    try {
        url = value instanceof URL ? value : new URL(value);
    } catch {
        throw invalidImage('image_url must be a valid HTTP(S) or base64 image URL.');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw invalidImage('Remote image URLs must use HTTP or HTTPS.');
    }
    if (url.username !== '' || url.password !== '') {
        throw invalidImage('Credentials are not allowed in image URLs.');
    }
    if (url.port !== '') {
        throw invalidImage('Remote image URLs must use the default HTTP or HTTPS port.');
    }
    if (url.hostname === '') throw invalidImage('image_url must include a host.');
    return url;
}

async function publicAddressFor(hostname) {
    const host = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
    const normalized = host.toLowerCase().replace(/\.$/, '');
    if (
        normalized === 'localhost'
        || normalized.endsWith('.localhost')
        || normalized.endsWith('.local')
        || normalized.endsWith('.internal')
        || normalized.endsWith('.home.arpa')
    ) {
        throw invalidImage('Private and local image URLs are not allowed.');
    }
    let addresses;
    const family = isIP(normalized);
    if (family !== 0) {
        addresses = [{ address: normalized, family }];
    } else {
        try {
            addresses = await dnsLookup(normalized, { all: true, verbatim: true });
        } catch {
            throw new ImageInputFailure(502, 'upstream_error', 'The image_url host could not be resolved by the endpoint.');
        }
    }
    if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
        throw invalidImage('Private, reserved, and non-public image URL destinations are not allowed.');
    }
    return addresses[0];
}

function pinnedLookup(address) {
    return (_hostname, options, callback) => {
        if (typeof options === 'function') {
            callback = options;
            options = {};
        }
        if (options?.all) callback(null, [{ address: address.address, family: address.family }]);
        else callback(null, address.address, address.family);
    };
}

function requestImage(url, address, signal, maxBytes) {
    return new Promise((resolve, reject) => {
        let request;
        let timer;
        let settled = false;
        const cleanup = () => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        };
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            cleanup();
            if (error) reject(error);
            else resolve(value);
        };
        const onAbort = () => request?.destroy(signal.reason instanceof Error ? signal.reason : new Error('Image request aborted.'));
        if (signal?.aborted) {
            finish(signal.reason instanceof Error ? signal.reason : new Error('Image request aborted.'));
            return;
        }
        const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;
        request = transport(url, {
            method: 'GET',
            headers: { accept: 'image/*', 'accept-encoding': 'identity', 'user-agent': 'dsh-model-endpoint' },
            lookup: pinnedLookup(address),
        }, (response) => {
            const status = Number(response.statusCode ?? 0);
            if ([301, 302, 303, 307, 308].includes(status)) {
                const location = response.headers.location;
                response.destroy();
                if (typeof location !== 'string' || location === '') {
                    finish(invalidImage('The image server returned an invalid redirect.'));
                } else {
                    finish(undefined, { redirect: location });
                }
                return;
            }
            if (status >= 500 && status < 600) {
                response.destroy();
                finish(new ImageInputFailure(502, 'upstream_error', 'The public image server returned a server error.'));
                return;
            }
            if (status < 200 || status >= 300) {
                response.destroy();
                finish(invalidImage('The image server did not return a successful response.'));
                return;
            }
            const contentEncoding = String(response.headers['content-encoding'] ?? '').toLowerCase();
            if (contentEncoding !== '' && contentEncoding !== 'identity') {
                response.destroy();
                finish(invalidImage('Compressed image responses are not supported.'));
                return;
            }
            const headerType = response.headers['content-type'];
            const mediaType = (Array.isArray(headerType) ? headerType[0] : headerType ?? '').split(';', 1)[0].trim().toLowerCase();
            if (!SUPPORTED_MEDIA_TYPES.has(mediaType)) {
                response.destroy();
                finish(new ImageInputFailure(400, 'unsupported_content', 'The image server must return PNG, JPEG, WebP, or GIF content.'));
                return;
            }
            const declared = Number(response.headers['content-length'] ?? 0);
            if (Number.isFinite(declared) && declared > maxBytes) {
                response.destroy();
                finish(new ImageInputFailure(413, 'request_too_large', 'Image exceeds the remaining request image-byte budget.'));
                return;
            }
            const chunks = [];
            let size = 0;
            response.on('data', (chunk) => {
                size += chunk.length;
                if (size > maxBytes) {
                    response.destroy();
                    request.destroy();
                    finish(new ImageInputFailure(413, 'request_too_large', 'Image exceeds the remaining request image-byte budget.'));
                    return;
                }
                chunks.push(chunk);
            });
            response.once('end', () => {
                if (size === 0) finish(invalidImage('The image server returned an empty image.'));
                else finish(undefined, { data: Buffer.concat(chunks, size), mediaType });
            });
            response.once('aborted', () => finish(new ImageInputFailure(502, 'upstream_error', 'The image download ended before the response was complete.')));
            response.once('error', (error) => finish(new ImageInputFailure(502, 'upstream_error', 'The public image server failed while sending the image.')));
        });
        request.once('error', (error) => {
            if (signal?.aborted) finish(signal.reason instanceof Error ? signal.reason : error);
            else if (error instanceof ImageInputFailure) finish(error);
            else finish(new ImageInputFailure(502, 'upstream_error', 'Unable to retrieve the public image URL.'));
        });
        signal?.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(() => request.destroy(new ImageInputFailure(504, 'request_timeout', 'The image server request timed out.')), IMAGE_FETCH_TIMEOUT_MS);
        timer.unref?.();
        request.end();
    });
}

async function readRemoteImage(rawUrl, signal, maxBytes) {
    let current = validateWebUrl(rawUrl);
    for (let redirects = 0; ; redirects += 1) {
        signal?.throwIfAborted();
        current = validateWebUrl(current);
        const address = await publicAddressFor(current.hostname);
        const result = await requestImage(current, address, signal, maxBytes);
        if (result.redirect === undefined) return result;
        if (redirects >= MAX_REDIRECTS) throw invalidImage('The image URL exceeded the redirect limit.');
        try {
            current = validateWebUrl(new URL(result.redirect, current));
        } catch (error) {
            if (error instanceof ImageInputFailure) throw error;
            throw invalidImage('The image server returned an invalid redirect.');
        }
    }
}

/** Resolve an OpenAI image_url to bounded bytes, without fetching private hosts. */
export async function readOpenAiImageUrl(value, { signal, maxBytes = MAX_IMAGE_BYTES } = {}) {
    if (typeof value !== 'string' || value.length === 0) {
        throw invalidImage('image_url.url must be a non-empty string.');
    }
    if (value.startsWith('data:')) return decodeImageDataUrl(value, maxBytes);
    if (value.length > 16_384) throw invalidImage('image_url is too long.');
    return readRemoteImage(value, signal, maxBytes);
}
