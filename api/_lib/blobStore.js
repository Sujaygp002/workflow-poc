import fs from 'node:fs/promises';
import { S3Client, PutObjectCommand, DeleteObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { S3_BUCKET, S3_REGION, S3_PUBLIC_URL_BASE, BLOB_READ_WRITE_TOKEN } from './config.js';

// If no S3 bucket configured, fall back to the old Vercel Blob path (for local dev)
let _vercelBlob = null;
async function getVercelBlob() {
  if (!_vercelBlob) _vercelBlob = await import('@vercel/blob');
  return _vercelBlob;
}

function s3Client() {
  return new S3Client({ region: S3_REGION || 'eu-north-1' });
}

function keyFromPath(blobPath) {
  return blobPath.startsWith('/') ? blobPath.slice(1) : blobPath;
}

function publicUrl(blobPath) {
  const key = keyFromPath(blobPath);
  if (S3_PUBLIC_URL_BASE) return `${S3_PUBLIC_URL_BASE}/${key}`;
  return `https://${S3_BUCKET}.s3.${S3_REGION || 'eu-north-1'}.amazonaws.com/${key}`;
}

export async function deleteBlobUrls(urls) {
  const list_ = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
  if (!list_.length) return { deleted: 0, skipped: 0 };

  if (S3_BUCKET) {
    const client = s3Client();
    let deleted = 0;
    for (const url of list_) {
      try {
        // Extract key from URL
        const key = url.includes('.amazonaws.com/') ? url.split('.amazonaws.com/')[1] : url;
        await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
        deleted += 1;
      } catch {
        // best-effort
      }
    }
    return { deleted, skipped: list_.length - deleted };
  }

  if (!BLOB_READ_WRITE_TOKEN) return { deleted: 0, skipped: list_.length, error: 'no_token' };
  const { del } = await getVercelBlob();
  try {
    await del(list_, { token: BLOB_READ_WRITE_TOKEN });
    return { deleted: list_.length, skipped: 0 };
  } catch (error) {
    return { deleted: 0, skipped: list_.length, error: error.message || String(error) };
  }
}

export async function deleteBlobPrefix(prefix) {
  if (S3_BUCKET) {
    const client = s3Client();
    try {
      const listed = await client.send(new ListObjectsV2Command({ Bucket: S3_BUCKET, Prefix: prefix }));
      const keys = (listed.Contents || []).map((o) => o.Key);
      for (const key of keys) {
        await client.send(new DeleteObjectCommand({ Bucket: S3_BUCKET, Key: key }));
      }
      return { deleted: keys.length, skipped: 0, urls: keys.map(publicUrl) };
    } catch (error) {
      return { deleted: 0, skipped: 0, error: error.message || String(error), urls: [] };
    }
  }

  if (!BLOB_READ_WRITE_TOKEN) return { deleted: 0, skipped: 0, error: 'no_token', urls: [] };
  const { list, del } = await getVercelBlob();
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
  const safeName = String(originalFilename || 'document.pdf').replace(/[^a-zA-Z0-9._-]/g, '_');
  const blobPath = `workflow-runs/${runId}/${Date.now()}-${safeName}`;

  if (S3_BUCKET) {
    const client = s3Client();
    await client.send(new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: blobPath,
      Body: buffer,
      ContentType: mimetype || 'application/pdf',
    }));
    return {
      buffer,
      blobUrl: publicUrl(blobPath),
      blobPath,
      skippedBlob: false,
    };
  }

  if (!BLOB_READ_WRITE_TOKEN) {
    return { buffer, blobUrl: null, blobPath: null, skippedBlob: true };
  }

  const { put } = await getVercelBlob();
  const uploaded = await put(blobPath, buffer, {
    access: 'public',
    token: BLOB_READ_WRITE_TOKEN,
    contentType: mimetype || 'application/pdf',
  });
  return { buffer, blobUrl: uploaded.url, blobPath, skippedBlob: false };
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
