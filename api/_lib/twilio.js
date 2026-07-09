import twilio from 'twilio';
import {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_FROM_NUMBER,
  TWILIO_TO_OVERRIDE,
} from './config.js';

let cachedClient;

// Twilio is fully configured only when SID + auth token + from-number are all set.
// Missing any one → the module is a no-op that reports a skip (never throws), so the
// agency-outreach workflow tasks (call_agency / sms_agency) still complete.
function isConfigured() {
  return Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN && TWILIO_FROM_NUMBER);
}

function getClient() {
  if (!isConfigured()) return null;
  if (!cachedClient) {
    cachedClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  }
  return cachedClient;
}

// TWILIO_TO_OVERRIDE (when set) redirects every outbound to one test number so a demo
// can't dial a real agency.
function resolveTo(to) {
  return TWILIO_TO_OVERRIDE || to;
}

// Sends an SMS. Returns { sent:true, sid } on success, else a non-fatal
// { sent:false, skipped:true, reason }. Never throws.
export async function sendSms({ to, body }) {
  const client = getClient();
  if (!client) {
    console.log('[twilio] not configured — would send SMS:', { to });
    return { sent: false, skipped: true, reason: 'twilio_not_configured' };
  }
  const dest = resolveTo(to);
  if (!dest) {
    return { sent: false, skipped: true, reason: 'no_recipient' };
  }
  try {
    const message = await client.messages.create({
      to: dest,
      from: TWILIO_FROM_NUMBER,
      body: body || '',
    });
    return { sent: true, sid: message.sid, status: message.status };
  } catch (error) {
    console.log('[twilio] SMS send failed — continuing:', error.message);
    return { sent: false, skipped: true, reason: `twilio_error: ${error.message}` };
  }
}

// Places a call. `twiml` (or a `url` pointing at TwiML) drives what the callee hears;
// defaults to a short spoken message when neither is supplied. Returns
// { sent:true, sid } on success, else a non-fatal { sent:false, skipped:true, reason }.
// Never throws.
export async function placeCall({ to, twiml, url, message }) {
  const client = getClient();
  if (!client) {
    console.log('[twilio] not configured — would place call:', { to });
    return { sent: false, skipped: true, reason: 'twilio_not_configured' };
  }
  const dest = resolveTo(to);
  if (!dest) {
    return { sent: false, skipped: true, reason: 'no_recipient' };
  }
  const params = { to: dest, from: TWILIO_FROM_NUMBER };
  if (url) {
    params.url = url;
  } else {
    params.twiml =
      twiml || `<Response><Say>${message || 'This is an automated message from your intake team.'}</Say></Response>`;
  }
  try {
    const call = await client.calls.create(params);
    return { sent: true, sid: call.sid, status: call.status };
  } catch (error) {
    console.log('[twilio] call failed — continuing:', error.message);
    return { sent: false, skipped: true, reason: `twilio_error: ${error.message}` };
  }
}
