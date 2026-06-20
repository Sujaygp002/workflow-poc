import nodemailer from 'nodemailer';
import { SMTP_FROM, SMTP_HOST, SMTP_PASS, SMTP_PORT, SMTP_SECURE, SMTP_USER } from './config.js';

let cachedTransport;

function getTransport() {
  if (!SMTP_HOST) return null;
  if (!cachedTransport) {
    cachedTransport = nodemailer.createTransport({
      host: SMTP_HOST,
      port: SMTP_PORT,
      secure: SMTP_SECURE,
      auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined,
    });
  }
  return cachedTransport;
}

// Sends an email via SMTP. If SMTP is not configured, logs the message and
// returns { sent: false, skipped: true } so the workflow still completes.
export async function sendEmail({ to, subject, text, html }) {
  const transport = getTransport();
  if (!transport) {
    console.log('[mailer] SMTP not configured — would send:', { to, subject });
    return { sent: false, skipped: true, reason: 'smtp_not_configured' };
  }
  if (!to) {
    return { sent: false, skipped: true, reason: 'no_recipient' };
  }
  // Best-effort: a dead/rejected SMTP login must never throw and deadlock the
  // workflow (e.g. Trigger 4 human tasks). Log and return a non-fatal skip.
  try {
    const info = await transport.sendMail({
      from: SMTP_FROM,
      to,
      subject: subject || '(no subject)',
      text: text || '',
      html: html || undefined,
    });
    return { sent: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected };
  } catch (error) {
    console.log('[mailer] send failed — continuing without email:', error.message);
    return { sent: false, skipped: true, reason: `smtp_error: ${error.message}` };
  }
}
