import fs from 'node:fs/promises';
import { del, list, put } from '@vercel/blob';
import { BLOB_READ_WRITE_TOKEN } from './config.js';

// Delete blob objects by URL(s) or path(s). Best-effort: returns
// { deleted, skipped, error }. When the token is absent/invalid the caller
// should fall back to reporting orphaned URLs rather than aborting.
export async function deleteBlobUrls(urls) {
  const list_ = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!BLOB_READ_WRITE_TOKEN) return { deleted: 0, skipped: list_.length, error: 'no_token' };
  if (!list_.length) return { deleted: 0, skipped: 0 };
  try {
    await del(list_, { token: BLOB_READ_WRITE_TOKEN });
    return { deleted: list_.length, skipped: 0 };
  } catch (error) {
    return { deleted: 0, skipped: list_.length, error: error.message || String(error) };
  }
}

// List then delete every blob under a path prefix (e.g. preload/<slug>/).
export async function deleteBlobPrefix(prefix) {
  if (!BLOB_READ_WRITE_TOKEN) return { deleted: 0, skipped: 0, error: 'no_token', urls: [] };
  try {
    const { blobs } = await list({ prefix, token: BLOB_READ_WRITE_TOKEN });
    const urls = blobs.map((b) => b.url);
    if (!urls.length) return { deleted: 0, skipped: 0, urls: [] };
    await del(urls, { token: BLOB_READ_WRITE_TOKEN });
    return { deleted: urls.length, skipped: 0, urls };
  } catch (error) {
    return { deleted: 0, skipped: 0, error: error.message || String(error), urls: [] };
  }
}

export async function uploadPdfBufferToBlob({ buffer, originalFilename, mimetype }, runId) {
  if (!BLOB_READ_WRITE_TOKEN) {
    return {
      buffer,
      blobUrl: null,
      blobPath: null,
      skippedBlob: true,
    };
  }

  const safeName = String(originalFilename || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const blobPath = `workflow-runs/${runId}/${Date.now()}-${safeName}`;
  const uploaded = await put(blobPath, buffer, {
    access: 'public',
    token: BLOB_READ_WRITE_TOKEN,
    contentType: mimetype || 'application/pdf',
  });

  return {
    buffer,
    blobUrl: uploaded.url,
    blobPath,
    skippedBlob: false,
  };
}

export async function uploadPdfToBlob(file, runId) {
  const buffer = await fs.readFile(file.filepath);
  return uploadPdfBufferToBlob({
    buffer,
    originalFilename: file.originalFilename,
    mimetype: file.mimetype || 'application/pdf',
  }, runId);
}

export function orderNumberFromPdfName(fileName) {
  return String(fileName || '')
    .split('/')
    .pop()
    .replace(/\.pdf$/i, '')
    .trim()
    .toLowerCase();
}

export function withPdfOrderKey(uploaded) {
  return {
    ...uploaded,
    orderNumber: orderNumberFromPdfName(uploaded.fileName || uploaded.originalFilename),
  };
}
