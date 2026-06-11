import fs from 'node:fs/promises';
import { put } from '@vercel/blob';
import { BLOB_READ_WRITE_TOKEN } from './config.js';

export async function uploadPdfToBlob(file, runId) {
  const buffer = await fs.readFile(file.filepath);
  if (!BLOB_READ_WRITE_TOKEN) {
    return {
      buffer,
      blobUrl: null,
      blobPath: null,
      skippedBlob: true,
    };
  }

  const safeName = String(file.originalFilename || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const blobPath = `workflow-runs/${runId}/${Date.now()}-${safeName}`;
  const uploaded = await put(blobPath, buffer, {
    access: 'public',
    token: BLOB_READ_WRITE_TOKEN,
    contentType: file.mimetype || 'application/pdf',
  });

  return {
    buffer,
    blobUrl: uploaded.url,
    blobPath,
    skippedBlob: false,
  };
}
