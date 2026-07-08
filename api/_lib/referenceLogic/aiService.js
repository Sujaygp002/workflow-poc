// AI Service — CPO billability + Care-Coordination (CC) note generation.
//
// Ported from the .NET 8 reference export:
//   reference/Order_Patient/Services/AIProcessingService.cs
//     - BuildBatchCCNotePrompt (~L709) — the ~50-line hybrid "nopii + 6para" prompt + 7 strict rules
//     - the attending-physician persona system prompt (~L666)
//     - DistributeMinutes (~L1770) — 3-5 min per note
//     - GetEpisodeCpoMonths (~L1736) — month-by-month walk of an episode
//     - CalculateCCNoteMonthDates / GetNextWeekday / GetPreviousWeekday (~L940) — weekday-only spread dates
//     - the per-month note plan (2x Preventive Care/Safety/Goals/Medications) (~L1203)
//     - CleanDiagnosisCode / IsValidIcdCode (~L1899)
//   reference/Order_Patient/docs/CCNote-Generation-Flow.md — the pipeline + prompt design
//
// Adapted to the POC stack: plain ES-module functions, Neon via getSql(), notes generated
// through Google Gemini (api/_lib/gemini.js style) instead of Azure GPT-3.5. NO external
// API keys are hardcoded here (HANDOFF landmine #1) — Gemini creds come from config.js.
//
// COMPLIANCE DEVIATION (deliberate, HANDOFF landmine #8): the .NET original stamped every
// generated CC note SignedByPhysicianStatus=true. Here every note is tagged
// data_tags.generated_by='ai_service' and is NEVER marked physician-signed. The stored notes
// carry a sent-to-physician date only; signing remains a real human/PG action elsewhere.

import { GoogleGenAI, Type } from '@google/genai';
import { getSql, jsonParam } from '../db.js';
import { GEMINI_API_KEY, GEMINI_MODEL } from '../config.js';
import { updateCpoMinutes } from '../repositories.js';
import { pgBillableMinutes, evaluateCpoMonthReadiness } from './businessRules.js';

// 8 notes per CPO month, two of each type (2x Preventive Care/Safety/Goals/Medications).
// 8 notes x ~4 min each => ~32 min, clearing the 30-min CPO target. (AIProcessingService NoteTypes)
const NOTE_TYPES = [
  'Preventive Care', 'Safety', 'Goals', 'Medications',
  'Preventive Care', 'Safety', 'Goals', 'Medications',
];

const CPO_TARGET_MINUTES = 30;

// ── date helpers (UTC, YYYY-MM-DD in / Date out) ──────────────────────────

function parseDateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  const ymd = String(value).slice(0, 10);
  const d = new Date(`${ymd}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function ymd(date) {
  return date.toISOString().slice(0, 10);
}

// "MMMM yyyy" label for a YYYY-MM-01 cpo-month bucket (matches the CPO_Month
// label pgBillableMinutes / RCMNew.CpoMonth compare against).
function formatCpoMonthLabel(cpoMonthYmd) {
  if (!cpoMonthYmd) return null;
  const s = String(cpoMonthYmd).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m] = s.split('-');
  const name = new Date(Date.UTC(Number(y), Number(m) - 1, 1)).toLocaleString('en-US', {
    month: 'long',
    timeZone: 'UTC',
  });
  return `${name} ${y}`;
}

function monthStartUtc(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function monthEndUtc(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function addDaysUtc(date, days) {
  const d = new Date(date.getTime());
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

function isWeekend(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}

function nextWeekday(date) {
  let d = date;
  while (isWeekend(d)) d = addDaysUtc(d, 1);
  return d;
}

function prevWeekday(date) {
  let d = date;
  while (isWeekend(d)) d = addDaysUtc(d, -1);
  return d;
}

// GetEpisodeCpoMonths — walk each calendar month the episode SOE..EOE touches,
// clamped to the episode boundaries. Returns [{ cpoMonth (YYYY-MM-01), monthStart, monthEnd }].
function episodeCpoMonths(soe, eoe) {
  const months = [];
  if (!soe || !eoe || eoe < soe) return months;
  let cursor = monthStartUtc(soe);
  while (cursor <= eoe) {
    const mStart = monthStartUtc(cursor);
    const mEnd = monthEndUtc(cursor);
    const effectiveStart = mStart < soe ? soe : mStart;
    const effectiveEnd = mEnd > eoe ? eoe : mEnd;
    const spanDays = (effectiveEnd.getTime() - effectiveStart.getTime()) / 86400000;
    if (spanDays >= 1) {
      months.push({ cpoMonth: ymd(mStart), monthStart: effectiveStart, monthEnd: effectiveEnd });
    }
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1));
  }
  return months;
}

// DistributeMinutes — split the remaining CPO minutes across N notes, each 3-5 min.
function distributeMinutes(totalMinutes, noteCount) {
  if (noteCount <= 0) return [];
  const result = [];
  let remaining = totalMinutes;
  for (let i = 0; i < noteCount; i += 1) {
    const notesLeft = noteCount - i;
    let minForThis = Math.max(3, remaining - (notesLeft - 1) * 5);
    let maxForThis = Math.min(5, remaining - (notesLeft - 1) * 3);
    if (minForThis > maxForThis) {
      minForThis = Math.min(5, remaining);
      maxForThis = minForThis;
    }
    let minutes = minForThis + Math.floor(Math.random() * (maxForThis - minForThis + 1));
    minutes = Math.max(3, Math.min(5, minutes));
    if (minutes > remaining) minutes = remaining;
    if (minutes < 0) minutes = 0;
    result.push(minutes);
    remaining -= minutes;
  }
  return result;
}

// CalculateCCNoteMonthDates — pick a weekday sent-date for a note, spread evenly across the
// month's available range and after the 485 sent-to-physician date. (No signed date is
// returned — see compliance deviation at top of file.)
function calculateCcNoteSentDate(orderSentDate, monthStart, monthEnd, episodeEnd, noteIndex, totalNotes) {
  let effectiveEnd = monthEnd;
  if (episodeEnd && episodeEnd < effectiveEnd) effectiveEnd = episodeEnd;

  let rangeStart = monthStart;
  if (orderSentDate && addDaysUtc(orderSentDate, 1) > rangeStart) rangeStart = addDaysUtc(orderSentDate, 1);
  if (rangeStart > effectiveEnd) rangeStart = addDaysUtc(effectiveEnd, -3);
  if (rangeStart < monthStart) rangeStart = monthStart;

  let totalDays = Math.floor((effectiveEnd.getTime() - rangeStart.getTime()) / 86400000);
  if (totalDays < 1) totalDays = 1;

  const notes = totalNotes < 1 ? 1 : totalNotes;
  const slotSize = totalDays / notes;
  const slotStart = Math.floor(noteIndex * slotSize);
  let slotEnd = Math.floor((noteIndex + 1) * slotSize);
  if (slotEnd <= slotStart) slotEnd = slotStart + 1;
  const offset = slotStart + Math.floor(Math.random() * (slotEnd - slotStart));

  let sentDate = nextWeekday(addDaysUtc(rangeStart, offset));
  if (sentDate > effectiveEnd) sentDate = prevWeekday(effectiveEnd);
  if (sentDate < rangeStart) sentDate = nextWeekday(rangeStart);
  return sentDate;
}

// ── diagnosis helpers (CleanDiagnosisCode / IsValidIcdCode) ───────────────

function isDiagnosisPlaceholder(value) {
  if (!value || !String(value).trim()) return true;
  const t = String(value).trim();
  return ['-', '_', '--', '---', 'N/A', 'n/a', 'NA'].includes(t);
}

function cleanDiagnosisCode(rawCode) {
  if (!rawCode || !String(rawCode).trim()) return '';
  const trimmed = String(rawCode).trim();
  if (isDiagnosisPlaceholder(trimmed)) return '';
  const match = trimmed.match(/^([A-Z]\d{2}(?:\.[A-Z0-9]{1,4})?)/i);
  return match ? match[1].toUpperCase() : trimmed;
}

function isValidIcdCode(code) {
  const cleaned = cleanDiagnosisCode(code);
  if (!cleaned) return false;
  return /^[A-Z]\d{2}(\.[A-Z0-9]{1,4})?$/i.test(cleaned);
}

// Back-fill demographics + diagnoses from the workflow item's extraction payload.
// The POC item carries extraction on item.extraction_payload; the AI PDF extraction (regex
// tier + Gemini) writes patient/order/diagnosis fields there. We only READ it here to build
// clinical context for the notes (the extraction subsystem owns the persistence of fields).
function collectClinicalContext(item) {
  const ex = item?.extraction_payload || {};
  const patient = { ...(item?.patient_payload || {}), ...(ex.patient || {}) };
  const rawDiag = []
    .concat(patient.diagnosis_codes || [])
    .concat(ex.diagnosis_codes || [])
    .concat(ex.patient?.diagnosis_codes || []);
  const diagnosisCodes = [...new Set(
    rawDiag.map(cleanDiagnosisCode).filter((c) => c && isValidIcdCode(c)),
  )].slice(0, 6);

  return {
    rawText: ex.rawText || ex.raw_text || ex.pdf?.text || '',
    diagnosisCodes,
    medicationNotes: ex.medicationNotes || ex.medications || [],
    safetyMeasures: ex.safetyMeasures || ex.safety || [],
    goals: ex.goals || [],
    preventiveCare: ex.preventiveCare || ex.preventive_care || [],
  };
}

function buildDocumentContext(ctx) {
  let documentText = ctx.rawText || '';
  if (documentText.length > 12000) documentText = documentText.slice(0, 12000);
  const parts = [documentText];
  if (ctx.diagnosisCodes.length) parts.push(`\nDiagnosis Codes: ${ctx.diagnosisCodes.join(', ')}`);
  if (ctx.medicationNotes.length) parts.push(`Medications: ${ctx.medicationNotes.join('; ')}`);
  if (ctx.safetyMeasures.length) parts.push(`Safety Measures: ${ctx.safetyMeasures.join('; ')}`);
  if (ctx.goals.length) parts.push(`Goals: ${ctx.goals.join('; ')}`);
  if (ctx.preventiveCare.length) parts.push(`Preventive Care: ${ctx.preventiveCare.join('; ')}`);
  return parts.join('\n');
}

// BuildBatchCCNotePrompt — ported verbatim (adapted to Gemini). 7 strict rules kept intact.
function buildBatchCcNotePrompt(documentText, batchNumber = 1, usedTitles = [], usedNoteSnippets = []) {
  let usedTitleSection = '';
  if (usedTitles.length) {
    const titleList = usedTitles.map((t) => `"${t}"`).join(', ');
    usedTitleSection = `
- ALREADY USED TITLES (DO NOT reuse or paraphrase any): ${titleList}`;
  }

  let usedContentSection = '';
  if (usedNoteSnippets.length) {
    const snippetList = usedNoteSnippets.map((s, i) => `${i + 1}. ${s}`).join('\n  ');
    usedContentSection = `
- PREVIOUSLY WRITTEN NOTE SUMMARIES (you MUST write about DIFFERENT clinical topics, do NOT repeat these angles or phrases):
  ${snippetList}`;
  }

  const batchLabel = batchNumber > 1 ? ` (Batch #${batchNumber} — explore completely new clinical angles)` : '';

  return `You are an experienced and empathetic Home Health Skilled Nurse/Case Manager. Read the CMS-485 order text below and write 4 Care Coordination Notes (CCNs).${batchLabel}

Document Text:
${documentText}

STRICT RULES:

1. PII REMOVAL (ZERO TOLERANCE):
   - NEVER include: patient name, physician name, HHA/HHAH/agency name, PG company name, Physician Group name, caregiver names, any dates (no MM/DD/YYYY, no month names, no year references), ICD codes, addresses, phone numbers, DOB.
   - NEVER write phrases like "coordinating with physician", "communicated with physician", "per physician orders", "physician was notified", "educating the patient", "patient was educated", "patient education provided".
   - Do NOT use the abbreviations HHAH, HHA, or PG anywhere in the note text.
   - Do NOT reference any physician by name, title (Dr./MD), or role.
   - Do NOT reference the patient by name - use "Pt" or "Patient" only.
   - Violation of this rule makes the note invalid.

2. OUTPUT FORMAT:
   - Valid JSON only. Top-level key "Notes", value is array of exactly 4 objects.
   - Each object keys: "Note Title", "Note ID", "Note Text", "Note Type".
   - Note ID: always "CCN-NA-NA".
   - Note Type: one of [Preventive Care, Safety, Goals, Medications]. Each type exactly once.

3. NOTE TITLE:
   - AI-generated, unique, 5-10 words summarizing the specific clinical focus of that note.
   - Every title across the entire episode must be different. No repeated or similar titles.${usedTitleSection}

4. NOTE TEXT:
   - Single paragraph, <= 1100 characters, physician clinical chart note voice.
   - Write from the PHYSICIAN's point of view — documenting clinical oversight, medical decision-making, assessment findings, and plan of care.
   - Start naturally — vary openers like "Pt presents with", "Reviewed Pt's", "Assessment reveals", "Continued monitoring of", "Adjusted plan for", "Pt currently managing", "Upon review", "Clinical assessment indicates".
   - Write as if the physician is hand-writing or dictating the note — natural, slightly informal clinical tone. Avoid robotic or templated phrasing. Each note must read differently.
   - Include objective clinical findings (vital signs, measurements, assessment scores) where applicable.
   - Use standard abbreviations (Pt, d/t, BID, TID, PRN, etc.).
   - NO dates, NO patient/physician/agency names, NO ICD codes anywhere in text.
   - Do NOT mention "HHAH", "HHA", "PG", or any proper names.
   - Use diagnosis DESCRIPTIONS (e.g., "type 2 diabetes mellitus", "congestive heart failure") instead of ICD codes.

5. TYPE-SPECIFIC REQUIREMENTS (Write from PHYSICIAN perspective — clinical oversight, assessments, medical decisions):
   - Preventive Care: Document clinical assessments and preventive interventions — e.g., reviewed wound status (measurements, wound bed appearance, drainage), trended vital signs (BP, HR, O2 sat, temp, BG) against baseline, assessed respiratory and cardiac status, evaluated skin integrity and Braden score, performed diabetic foot exam, neurological screening. Write as the physician reviewing and assessing, not as a teaching summary. Each note should cover a DIFFERENT preventive focus.
   - Safety: Document safety assessments and clinical decisions — e.g., evaluated fall risk (Morse/Tinetti), assessed gait/balance/transfer ability, identified home hazards and ordered modifications, reviewed sharps disposal compliance, assessed infection control measures, established vital sign alert parameters (notify if SBP <100/>160, HR <60/>100, O2 sat <90%, temp >101F, BG <70/>300). Each note should address a DIFFERENT safety concern with specific findings.
   - Goals: Document measurable clinical goals and progress — e.g., Pt to achieve independent ADLs within 30 days (currently moderate assist x2), wound to decrease 25% in 2 weeks (current 3.2x2.1x0.5cm), Pt to ambulate 150 ft independently (currently 50 ft with standby assist), BG target 80-180 mg/dL, pain <=4/10. Write about actual progress and clinical reasoning. Each note must have DIFFERENT measurable benchmarks.
   - Medications: MUST list ALL medications found in the document — the 485 often has 12+ pages of medication data, use ALL of them. Include specific drug names with dosages, strengths, routes, and frequencies. List at LEAST 4-6 medications per note with full details. Cover medications across ALL the patient's conditions, not just one or two diagnoses. Document medication reconciliation, interactions assessed, side effect monitoring, therapeutic response. Each Medications note must cover DIFFERENT medications from the document.

6. UNIQUENESS & ANTI-PLAGIARISM (CRITICAL):
   - Every note across ALL batches in this episode must be completely unique in content, phrasing, and clinical angle.
   - Do NOT repeat wound care descriptions, fall risk assessments, or medication lists across notes.
   - Each note should explore a DIFFERENT clinical dimension of the patient's care.
   - Vary sentence structure, vocabulary, sentence length, and clinical perspective for EVERY note.
   - Write as if dictating — some notes can be more concise, others more detailed. Mix up the rhythm.
   - NEVER copy-paste or closely paraphrase another note. Each must read as freshly written.${usedContentSection}

7. For Medications notes, use your clinical knowledge to provide standard medication regimens and dosages appropriate for the documented diagnoses. For all other note types, do NOT fabricate clinical data that is not supported by the document.

Respond with valid JSON only:`;
}

// Attending-physician persona system prompt (ported from the .NET system message).
const PHYSICIAN_PERSONA = 'You are an attending physician overseeing a home health patient. Write clinical notes from YOUR perspective as the certifying/recertifying physician documenting your clinical oversight, assessments, and medical decision-making. Write naturally as if hand-writing a chart note — vary your phrasing, avoid templated or robotic language, and make each note sound authentically dictated. Output valid JSON only. NEVER include patient name, physician name, HHA, HHAH, PG, or agency name in note text.';

const CC_NOTE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    Notes: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          'Note Title': { type: Type.STRING },
          'Note ID': { type: Type.STRING },
          'Note Text': { type: Type.STRING },
          'Note Type': { type: Type.STRING },
        },
      },
    },
  },
};

// Generate one batch of 4 CC notes through Gemini. Throws on API failure so the caller can
// record the month as a failure (partial success across the episode is acceptable).
async function generateCcNoteBatch({ documentText, minutesPerNote, batchNumber, usedTitles, usedNoteSnippets }) {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');

  const prompt = buildBatchCcNotePrompt(documentText, batchNumber, usedTitles, usedNoteSnippets);
  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const response = await ai.models.generateContent({
    model: GEMINI_MODEL,
    contents: [{ text: `${PHYSICIAN_PERSONA}\n\n${prompt}` }],
    config: {
      responseMimeType: 'application/json',
      responseSchema: CC_NOTE_SCHEMA,
      temperature: 0.85,
      maxOutputTokens: 4000,
    },
  });

  return parseBatchResponse(response.text || '{}', minutesPerNote);
}

// ParseBatchCCNoteResponse — pull the Notes[] out of the model JSON.
function parseBatchResponse(aiResponse, minutesPerNote) {
  const results = [];
  let root;
  try {
    root = JSON.parse(aiResponse);
  } catch {
    const match = aiResponse.match(/\{[\s\S]*\}/);
    if (!match) return results;
    try {
      root = JSON.parse(match[0]);
    } catch {
      return results;
    }
  }

  const notesArray = root.Notes || root.notes;
  if (!Array.isArray(notesArray)) return results;

  for (const note of notesArray) {
    const noteText = note['Note Text'] || note.noteText || '';
    const noteType = note['Note Type'] || note.noteType || '';
    let noteTitle = note['Note Title'] || note.noteTitle || '';
    if (!noteText.trim() || !noteType.trim()) continue;
    if (!noteTitle.trim() || noteTitle === 'CCN - REDACTED - NA') {
      noteTitle = `${noteType} - Clinical Note #${results.length + 1}`;
    }
    results.push({ noteTitle, noteText, noteType, cpoMinutes: minutesPerNote });
  }
  return results;
}

function titleCase(str) {
  return str.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

// Resolve the agency's episodes + their CPO months that still lack the 30-min CPO target.
// Scope: episodes of patients belonging to the item's agency (referencePayload.HHAH.id).
async function loadEpisodesNeedingCpo(agencyId) {
  const sql = getSql();
  const episodes = await sql`
    SELECT e.id AS episode_id, e.soe, e.eoe, e.status AS episode_status,
           e.diagnosis_codes, a.patient_id, a.soc, a.agency_id
    FROM patient_episodes e
    JOIN patient_admissions a ON a.id = e.admission_id
    WHERE a.agency_id = ${agencyId}
    ORDER BY e.updated_at DESC
    LIMIT 200
  `;
  return episodes;
}

// Load an episode's orders so pgBillableMinutes can find the earliest 485
// SentToPhysicianDate (the "count notes strictly after the order" gate) and any
// real physician documents that carry CPO minutes. Best-effort — an empty list
// just means no order gate / no doc minutes (notes then count on month match).
async function loadEpisodeDocs(episodeId) {
  const sql = getSql();
  try {
    return await sql`
      SELECT order_number, order_type, document_type, order_date, order_status
      FROM orders
      WHERE episode_id = ${episodeId}
    `;
  } catch {
    return [];
  }
}

// Load the episode's patient (demographics for isPatientDataComplete). Best-effort.
async function loadPatientForEpisode(patientId) {
  if (!patientId) return null;
  const sql = getSql();
  try {
    return (await sql`
      SELECT id, name, dob, sex, personal_information
      FROM patients
      WHERE id = ${patientId}
      LIMIT 1
    `)[0] || null;
  } catch {
    return null;
  }
}

async function ensureCpoMonthRows(episodeId, months) {
  const sql = getSql();
  for (const m of months) {
    await sql`
      INSERT INTO cpo_months (episode_id, cpo_month)
      VALUES (${episodeId}, ${m.cpoMonth})
      ON CONFLICT (episode_id, cpo_month) DO NOTHING
    `;
  }
  const rows = await sql`
    SELECT * FROM cpo_months WHERE episode_id = ${episodeId} ORDER BY cpo_month
  `;
  return rows;
}

// Persist generated notes + captured minutes for a single CPO month.
// Notes are stored on the cpo_months row payload (there is no dedicated CC-note table in the
// POC) tagged generated_by='ai_service'; minutes are committed via updateCpoMinutes so the
// billing status re-derives. NOTHING is marked physician-signed (compliance deviation).
async function persistMonthNotes(cpoMonthId, notes, totalMinutes, monthReady = null) {
  const sql = getSql();
  const tagged = notes.map((n) => ({
    noteTitle: n.noteTitle,
    noteText: n.noteText,
    noteType: n.noteType,
    cpoMinutes: n.cpoMinutes,
    sentToPhysicianDate: n.sentDate,
    // Deliberately NO signedByPhysician* fields — see file header.
    noteStatus: 'generated',
    data_tags: { generated_by: 'ai_service', physician_signed: false },
  }));

  const current = (await sql`SELECT reason FROM cpo_months WHERE id = ${cpoMonthId} LIMIT 1`)[0];
  const reason = (current && current.reason) || {};
  const nextReason = {
    ...reason,
    ccNotes: [...(reason.ccNotes || []), ...tagged],
    generated_by: 'ai_service',
  };
  await sql`
    UPDATE cpo_months
    SET reason = ${await jsonParam(nextReason)}::jsonb, updated_at = now()
    WHERE id = ${cpoMonthId}
  `;

  // Commit the accumulated minutes (existing + newly generated), capped so billing flips once
  // the 30-min target is met. updateCpoMinutes re-derives billing status, gated on the
  // CPO-month readiness co-requisite (AC10): monthReady === false suppresses the billable flip.
  await updateCpoMinutes({ cpoMonthId, cpoMin: totalMinutes, monthReady });
}

// Generate CC notes for one CPO month until it reaches the 30-min CPO target.
// Returns { generated, minutesAdded } or throws on Gemini failure.
async function processMonth({ cpoRow, monthMeta, ctx, usedTitles, usedNoteSnippets, batchCounterRef, episodeDocs = [], monthReady = null }) {
  const existingMin = Number(cpoRow.cpo_min || 0);
  const remainingMinutes = Math.max(0, CPO_TARGET_MINUTES - existingMin);
  if (remainingMinutes <= 0) return { generated: 0, minutesAdded: 0, skipped: true };

  // Plan: 2 of each note type (8 total), fewer if minutes already partly captured.
  const notesPlan = [];
  const perType = {};
  for (const nt of NOTE_TYPES) {
    const key = nt.toLowerCase();
    const desired = NOTE_TYPES.filter((n) => n.toLowerCase() === key).length;
    const planned = notesPlan.filter((p) => p === key).length;
    if (planned + (perType[key] || 0) < desired) notesPlan.push(key);
  }
  if (!notesPlan.length) return { generated: 0, minutesAdded: 0, skipped: true };

  const minPerNote = distributeMinutes(remainingMinutes, notesPlan.length);
  const documentText = buildDocumentContext(ctx);

  const created = [];
  const batchCount = Math.ceil(notesPlan.length / 4);
  for (let batch = 0; batch < batchCount; batch += 1) {
    batchCounterRef.value += 1;
    const avgMin = minPerNote.slice(batch * 4, batch * 4 + 4)[0] || 4;
    const generatedNotes = await generateCcNoteBatch({
      documentText,
      minutesPerNote: avgMin,
      batchNumber: batchCounterRef.value,
      usedTitles,
      usedNoteSnippets,
    });
    if (!generatedNotes.length) continue;

    for (const note of generatedNotes) {
      const idx = created.length;
      if (idx >= notesPlan.length) break;

      // Trust the model's type only if it still matches a needed slot; else override to plan.
      let assignedType = note.noteType;
      if (!notesPlan.slice(created.length).some((p) => p === (assignedType || '').toLowerCase())) {
        assignedType = notesPlan[idx];
        note.noteType = titleCase(assignedType);
      }
      if (idx < minPerNote.length) note.cpoMinutes = minPerNote[idx];

      note.sentDate = ymd(calculateCcNoteSentDate(
        null, monthMeta.monthStart, monthMeta.monthEnd, monthMeta.monthEnd,
        created.length, notesPlan.length,
      ));

      created.push(note);
      usedTitles.push(note.noteTitle);
      const snippet = note.noteText.length > 80 ? note.noteText.slice(0, 80) : note.noteText;
      usedNoteSnippets.push(`[${note.noteType}] ${snippet}`);
    }
  }

  if (!created.length) return { generated: 0, minutesAdded: 0, skipped: false };

  // Accumulate minutes through the GeneratePgBillable filters (businessRules.
  // pgBillableMinutes) rather than a raw sum: a generated CC note counts toward
  // this month ONLY if its effective (sent) date lands in the month AND is
  // strictly after the episode's earliest 485 SentToPhysicianDate, and 485/plan
  // documents themselves add 0 minutes. This is the AC11 wiring point — the
  // month's persisted CPO minutes are the pg-billable minutes.
  const monthLabelForBilling = formatCpoMonthLabel(monthMeta.cpoMonth);
  const pgMinutes = pgBillableMinutes(
    {
      documents: episodeDocs,
      notes: created.map((n) => ({
        cpoMinutes: n.cpoMinutes,
        sentToPhysicianDate: n.sentDate,
      })),
    },
    monthLabelForBilling,
  );
  // Fall back to the raw generated sum when the billing filters cannot resolve a
  // month label (defensive; keeps existing behaviour if labeling ever fails).
  const rawSum = created.reduce((sum, n) => sum + Number(n.cpoMinutes || 0), 0);
  const minutesAdded = monthLabelForBilling ? pgMinutes : rawSum;
  const totalMinutes = existingMin + minutesAdded;
  await persistMonthNotes(cpoRow.id, created, totalMinutes, monthReady);
  return { generated: created.length, minutesAdded, skipped: false };
}

/**
 * Run the AI CC-note generation service for one workflow item (one agency's daily bucket).
 *
 * Finds the agency's episodes and their under-target CPO months, builds clinical context from
 * the item extraction payload, and generates weekday-spread CC notes via Gemini until each month
 * reaches 30 CPO minutes. Gemini failures for a given month are collected in `failures` — the
 * rest of the months still process (partial success).
 *
 * @param {{ item: object }} args - workflow item (carries reference_payload.HHAH + extraction_payload)
 * @returns {Promise<{ ok: boolean, processedMonths: number, generatedNotes: number,
 *                      failures: Array<{ episodeId: string, cpoMonth: string, reason: string }> }>}
 */
export async function runAiService({ item }) {
  const failures = [];
  let processedMonths = 0;
  let generatedNotes = 0;

  const agencyId = item?.reference_payload?.HHAH?.id || item?.hhah_id || null;
  if (!agencyId) {
    return { ok: false, processedMonths, generatedNotes, failures: [{ episodeId: null, cpoMonth: null, reason: 'No agency id on item (reference_payload.HHAH.id)' }] };
  }

  const ctx = collectClinicalContext(item);
  const episodes = await loadEpisodesNeedingCpo(agencyId);

  // Uniqueness tracking spans the whole run so titles/angles do not repeat across months.
  const usedTitles = [];
  const usedNoteSnippets = [];
  const batchCounterRef = { value: 0 };

  for (const episode of episodes) {
    const soe = parseDateOnly(episode.soe);
    const eoe = parseDateOnly(episode.eoe);
    if (!soe || !eoe) continue;

    const months = episodeCpoMonths(soe, eoe);
    if (!months.length) continue;

    let cpoRows;
    try {
      cpoRows = await ensureCpoMonthRows(episode.episode_id, months);
    } catch (err) {
      failures.push({ episodeId: episode.episode_id, cpoMonth: null, reason: `Failed to load CPO months: ${err.message}` });
      continue;
    }

    // Episode's orders once (485 sent-date gate + any doc CPO minutes for pgBillableMinutes).
    const episodeDocs = await loadEpisodeDocs(episode.episode_id);
    // Patient once (demographics for the CPO-month readiness verdict, AC10).
    const patient = await loadPatientForEpisode(episode.patient_id);

    for (const monthMeta of months) {
      const cpoRow = cpoRows.find((r) => ymd(parseDateOnly(r.cpo_month)) === monthMeta.cpoMonth);
      if (!cpoRow) continue;
      if (Number(cpoRow.cpo_min || 0) >= CPO_TARGET_MINUTES) continue;

      // AC10 co-requisite: the billable flip is gated at updateCpoMinutes (the TRUE
      // flip site in repositories.js) on this readiness verdict — a month with
      // incomplete demographics or no signed 485 must NOT flip billable even at
      // >=30 minutes. evaluateCpoMonthReadiness reads the SAME businessRules port
      // surfaced on the rcm payload for audit.
      const readiness = evaluateCpoMonthReadiness({
        patient,
        episodes: [{ ...episode, id: episode.episode_id }],
        orders: episodeDocs.map((d) => ({ ...d, episode_id: episode.episode_id })),
        cpoMonth: formatCpoMonthLabel(monthMeta.cpoMonth),
      });

      try {
        const res = await processMonth({ cpoRow, monthMeta, ctx, usedTitles, usedNoteSnippets, batchCounterRef, episodeDocs, monthReady: readiness.dataComplete });
        if (!res.skipped) {
          processedMonths += 1;
          generatedNotes += res.generated;
          if (res.generated === 0) {
            failures.push({ episodeId: episode.episode_id, cpoMonth: monthMeta.cpoMonth, reason: 'Gemini returned no notes for this month' });
          }
        }
      } catch (err) {
        failures.push({ episodeId: episode.episode_id, cpoMonth: monthMeta.cpoMonth, reason: err.message || String(err) });
      }
    }
  }

  // Partial success is acceptable — ok is true unless nothing at all could be generated while
  // there was work to do.
  const ok = generatedNotes > 0 || failures.length === 0;
  return { ok, processedMonths, generatedNotes, failures };
}
