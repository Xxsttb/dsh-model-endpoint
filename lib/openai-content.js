import { Buffer } from 'node:buffer';
import { ImageInputFailure, MAX_IMAGE_BYTES, readOpenAiImageUrl } from './openai-images.js';

export { ImageInputFailure };

export const MAX_IMAGES_PER_REQUEST = 8;
export const MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;

/** Reject excess image counts and explicit model modality mismatches. */
export function assertUserImageInputSupported(messages, inputModalities) {
    const imageCount = Array.isArray(messages)
        ? messages.reduce((count, message) => count + (message?.role === 'user' && Array.isArray(message.content)
            ? message.content.filter((part) => part?.type === 'image_url').length
            : 0), 0)
        : 0;
    if (imageCount > MAX_IMAGES_PER_REQUEST) {
        throw new ImageInputFailure(400, 'invalid_request_error', 'The request exceeds the image-count limit of ' + MAX_IMAGES_PER_REQUEST + '.');
    }
    if (imageCount > 0 && Array.isArray(inputModalities) && !inputModalities.includes('image')) {
        throw new ImageInputFailure(400, 'unsupported_content', 'The selected model does not accept image inputs.');
    }
}

/** Convert and admit one OpenAI user message while preserving text/image order. */
export async function admitOpenAiUserContent(content, index, {
    attachments,
    signal,
    readImageUrl = readOpenAiImageUrl,
    imageBudget = { imageCount: 0, imageBytes: 0 },
} = {}) {
    if (typeof content === 'string') return [{ type: 'text', text: content }];
    if (content === undefined || content === null) return [];
    if (!Array.isArray(content)) {
        throw new ImageInputFailure(400, 'invalid_request_error', 'messages[' + index + '].content must be a string or an array.');
    }
    const blocks = [];
    let hasImage = false;
    const messageImageCount = content.filter((part) => part?.type === 'image_url').length;
    if (imageBudget.imageCount + messageImageCount > MAX_IMAGES_PER_REQUEST) {
        throw new ImageInputFailure(400, 'invalid_request_error', 'The request exceeds the image-count limit of ' + MAX_IMAGES_PER_REQUEST + '.');
    }
    imageBudget.imageCount += messageImageCount;
    for (const part of content) {
        const type = typeof part === 'string' ? 'text' : part?.type;
        if (type === 'text' || type === 'input_text') {
            blocks.push({ type: 'text', text: typeof part === 'string' ? part : typeof part.text === 'string' ? part.text : '' });
            continue;
        }
        if (type !== 'image_url') {
            throw new ImageInputFailure(
                400,
                'unsupported_content',
                'messages[' + index + '].content part type "' + String(type) + '" is not supported.',
            );
        }
        const url = part?.image_url?.url;
        if (typeof url !== 'string' || url.trim() === '') {
            throw new ImageInputFailure(400, 'invalid_request_error', 'messages[' + index + '].content image_url.url must be a non-empty string.');
        }
        if (!attachments || typeof attachments.admitPromptContent !== 'function') {
            throw new ImageInputFailure(503, 'attachment_service_unavailable', 'This Harness profile does not expose image attachment storage.');
        }
        const remainingBytes = MAX_TOTAL_IMAGE_BYTES - imageBudget.imageBytes;
        if (remainingBytes < 1) {
            throw new ImageInputFailure(413, 'request_too_large', 'The request exceeds the aggregate image-byte limit.');
        }
        const maxBytes = Math.min(MAX_IMAGE_BYTES, remainingBytes);
        const image = await readImageUrl(url, { signal, maxBytes });
        const imageBytes = image?.data?.byteLength;
        if (!Number.isInteger(imageBytes) || imageBytes < 1 || imageBytes > maxBytes) {
            throw new ImageInputFailure(413, 'request_too_large', 'An image exceeds the remaining request image-byte budget.');
        }
        imageBudget.imageBytes += imageBytes;
        // The Harness attachments service requires canonical base64, not raw bytes.
        blocks.push({ type: 'image', data: Buffer.from(image.data).toString('base64'), mediaType: image.mediaType });
        hasImage = true;
    }
    if (!hasImage) return blocks;
    signal?.throwIfAborted();
    try {
        return await attachments.admitPromptContent(blocks);
    } catch (error) {
        const code = error?.code;
        if (code === 'TOO_MANY_IMAGES') {
            throw new ImageInputFailure(400, 'invalid_request_error', 'The image count exceeds this Harness profile limit.');
        }
        if (code === 'IMAGES_TOO_LARGE') {
            throw new ImageInputFailure(413, 'request_too_large', 'The combined images exceed this Harness profile size limit.');
        }
        if (code === 'UNSUPPORTED_IMAGE_TYPE') {
            throw new ImageInputFailure(400, 'unsupported_content', 'The image type is not accepted by this Harness profile.');
        }
        if (error instanceof ImageInputFailure) throw error;
        const failure = new ImageInputFailure(500, 'attachment_error', 'The Harness attachment service could not store the image input.');
        failure.cause = error;
        throw failure;
    }
}
