import fs from 'node:fs/promises';
import { put } from '@vercel/blob';
import { BLOB_READ_WRITE_TOKEN } from './config.js';

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
