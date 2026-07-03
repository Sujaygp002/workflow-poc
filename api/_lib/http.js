export function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(body));
}

export function methodNotAllowed(res, allowed) {
  res.setHeader('Allow', allowed.join(', '));
  sendJson(res, 405, { error: `Method not allowed. Use ${allowed.join(' or ')}.` });
}

export function handleError(res, error) {
  const message = error instanceof Error ? error.message : String(error);
  // Errors thrown with an explicit `status` (auth/validation) map straight to
  // that HTTP status; `details` (e.g. actionErrors, messages) merge into the body.
  const status = Number.isInteger(error?.status)
    ? error.status
    : message.includes('not configured') ? 503 : 500;
  const details = error?.details && typeof error.details === 'object' ? error.details : {};
  sendJson(res, status, { error: message, ...details });
}

export async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}
