// AI Auditor rework — auto-fix structured audit findings, then re-audit in a bounded loop.
//
// Ported from the .NET8 reference AuditorService (HANDOFF §1.3):
//   reference/Order_Patient/Services/AuditorService.cs
//     - Part 2 fixes (~1135-2779): ProcessCommentsAndFixDataAsync + ApplyRule1Fixes
//       (fill missing PatientName/DOB/Insurance/SOC/SOE/EOE/Diagnoses from 485 extraction,
//       fallbacks), ApplyRule2Fixes (date-sequence repair), ApplyRule4Fixes (dedupe / delete
//       low-quality CCNotes, regenerate note text, hit the 30-min CPO target).
//     - Part 3 loop (~2783): ReAuditAsync re-runs all four rules; the "total audit" job loops
//       audit->fix->re-audit until rework < 10%.
//
// DELIBERATE DEVIATION (HANDOFF landmine): the source parsed Part 1's plain-text comments
// ("Missing: X", "Duplicate NoteText"). Here we consume the STRUCTURED findings written by
// audit.js into audit_records.rule_results, so fixes dispatch on { rule, code, field } —
// never prose. AI-regenerated CC-note text is tagged data_tags.generated_by='ai_service'
// and is NEVER marked physician-signed.
//
// Scope: item/agency-scoped. reworkAudits({ item }) consumes the rework-status audit_records
// for the item's agency, applies fixable fixes to the rcm_records payload, appends change_log
// entries, and re-audits (up to 3 cycles) until failed count is 0 or < 10% of records.

import { getSql } from '../db.js';
import { GoogleGenAI } from '@google/genai';
import { GEMINI_API_KEY, GEMINI_MODEL } from '../config.js';
import { auditRcm, cleanDiagnosisCode, isValidIcdCode } from './audit.js';

const MAX_CYCLES = 3;
const REWORK_TARGET_RATIO = 0.1; // stop when remaining < 10% of records

// Default medication fallback text (mirrors the source's hardcoded clinical template,
// preserved knowingly per HANDOFF landmine #8). Used only when Gemini is unavailable.
const MED_FALLBACK_TEXT =
  'Reviewed the current medication regimen with the patient, including Lisinopril and '
  + 'Metformin, confirming correct dosages and administration times. Reinforced adherence '
  + 'and screened for adverse effects; no new concerns reported.';

function nowIso() {
  return new Date().toISOString();
}

function get(obj, path) {
  return path.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function set(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

// Map an R1 MISSING_FIELD field name onto (payload path, extraction path, fallback).
const R1_FIELD_MAP = {
  PatientName: { payloadPath: 'patient.name', extractPath: 'patient.name', fallback: 'Unknown Patient' },
  DOB: { payloadPath: 'patient.dob', extractPath: 'patient.DOB', fallback: '01/01/1950' },
  Gender: { payloadPath: 'patient.sex', extractPath: 'patient.sex', fallback: null },
  PatientAddress: { payloadPath: 'patient.address', extractPath: 'patient.address', fallback: null },
  PatientState: { payloadPath: 'patient.state', extractPath: 'patient.state', fallback: null },
  Zip: { payloadPath: 'patient.zip', extractPath: 'patient.zip', fallback: null },
  InsuranceCompanyName: { payloadPath: 'patient.insurance_company', extractPath: null, fallback: 'Medicare' },
  StartOfCare: { payloadPath: 'episode.soc', extractPath: 'patient.SOC', fallback: null },
  StartofEpisode: { payloadPath: 'episode.soe', extractPath: 'patient.SOE', fallback: null },
  EndofEpisode: { payloadPath: 'episode.eoe', extractPath: 'patient.EOE', fallback: null },
};

async function regenerateNoteText(noteType, extraction) {
  const context = extraction?.patient
    ? `Patient diagnoses: ${(extraction.patient.diagnosis_codes || []).join(', ') || 'n/a'}.`
    : '';
  if (!GEMINI_API_KEY) {
    return noteType && noteType.toLowerCase().includes('medication') ? MED_FALLBACK_TEXT : null;
  }
  try {
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
    const response = await ai.models.generateContent({
      model: GEMINI_MODEL,
      contents: [{
        text:
          `Write one concise care-coordination note (3-5 minutes of physician CPO work) for a home-health `
          + `patient, note type "${noteType || 'Care Coordination'}". ${context} `
          + `Do not include any calendar dates. Do not fabricate a physician signature. `
          + `Return only the note body text, 2-3 sentences.`,
      }],
    });
    const text = (response.text || '').trim();
    return text || null;
  } catch {
    return noteType && noteType.toLowerCase().includes('medication') ? MED_FALLBACK_TEXT : null;
  }
}

// Apply the fixable findings for one rcm_record's payload in place.
// Returns { fixedCount, changes:[{ts, rule, action, before, after}], remainingUnfixable }.
async function applyFixes(payload, findings, extraction) {
  const changes = [];
  let fixedCount = 0;
  let remainingUnfixable = 0;

  // Track which CC-note indices need regeneration (dedup/gibberish/short/date/med) and
  // which should be removed (duplicates) so we can hit the minute target afterward.
  const notesToRegenerate = new Set();

  for (const f of findings) {
    if (!f.fixable) {
      remainingUnfixable += 1;
      continue;
    }

    if (f.rule === 'R1' && f.code === 'MISSING_FIELD') {
      const map = R1_FIELD_MAP[f.field];
      if (!map) { remainingUnfixable += 1; continue; }
      const before = get(payload, map.payloadPath);
      let after = map.extractPath ? get(extraction, map.extractPath) : null;
      if (after == null || after === '') after = map.fallback;
      if (after == null || after === '') { remainingUnfixable += 1; continue; }
      set(payload, map.payloadPath, after);
      changes.push({ ts: nowIso(), rule: f.rule, action: `fill ${f.field}`, before: before ?? null, after });
      fixedCount += 1;
      continue;
    }

    if (f.rule === 'R1' && (f.code === 'INVALID_ICD' || f.code === 'DIAGNOSIS_ORDERING')) {
      const before = Array.isArray(payload.diagnoses) ? [...payload.diagnoses] : [];
      const source = (extraction?.patient?.diagnosis_codes && extraction.patient.diagnosis_codes.length)
        ? extraction.patient.diagnosis_codes
        : before;
      const cleaned = source.map(cleanDiagnosisCode).filter((c) => c && isValidIcdCode(c));
      const deduped = [...new Set(cleaned)].slice(0, 6);
      if (deduped.length > 0) {
        payload.diagnoses = deduped;
        changes.push({ ts: nowIso(), rule: f.rule, action: 'clean/reorder diagnoses', before, after: deduped });
        fixedCount += 1;
      } else {
        remainingUnfixable += 1;
      }
      continue;
    }

    if (f.rule === 'R2' || (f.rule === 'R3' && ['SOC_MISMATCH', 'SOE_MISMATCH', 'EOE_MISMATCH'].includes(f.code))) {
      // Repair episode dates from extraction where available.
      const dateFieldMap = {
        StartOfCare: { payloadPath: 'episode.soc', extractPath: 'patient.SOC' },
        StartofEpisode: { payloadPath: 'episode.soe', extractPath: 'patient.SOE' },
        EndofEpisode: { payloadPath: 'episode.eoe', extractPath: 'patient.EOE' },
      };
      const map = dateFieldMap[f.field];
      const after = map ? get(extraction, map.extractPath) : null;
      if (map && after) {
        const before = get(payload, map.payloadPath);
        set(payload, map.payloadPath, after);
        changes.push({ ts: nowIso(), rule: f.rule, action: `repair date ${f.field}`, before: before ?? null, after });
        fixedCount += 1;
      } else {
        remainingUnfixable += 1;
      }
      continue;
    }

    if (f.rule === 'R3' && f.code === 'DIAGNOSIS_MISMATCH') {
      // Prefer authoritative PDF diagnoses.
      const source = extraction?.patient?.diagnosis_codes || [];
      const cleaned = source.map(cleanDiagnosisCode).filter((c) => c && isValidIcdCode(c));
      const deduped = [...new Set(cleaned)].slice(0, 6);
      if (deduped.length > 0) {
        const before = Array.isArray(payload.diagnoses) ? [...payload.diagnoses] : [];
        payload.diagnoses = deduped;
        changes.push({ ts: nowIso(), rule: f.rule, action: 'sync diagnoses from PDF', before, after: deduped });
        fixedCount += 1;
      } else {
        remainingUnfixable += 1;
      }
      continue;
    }

    if (f.rule === 'R4') {
      if (!Array.isArray(payload.ccNotes)) payload.ccNotes = [];
      const idxMatch = String(f.field).match(/ccNotes\[(\d+)\]/);
      if (f.code === 'DUPLICATE_NOTE' || f.code === 'SIMILAR_NOTE' || f.code === 'NOTE_GIBBERISH'
        || f.code === 'NOTE_TOO_SHORT' || f.code === 'NOTE_HAS_DATE' || f.code === 'MED_NOTE_NO_MEDS') {
        if (idxMatch) notesToRegenerate.add(Number(idxMatch[1]));
        // R4 note fixes are handled in the post-pass below.
        continue;
      }
      if (f.code === 'NO_CCNOTES' || f.code === 'CPO_UNDER_TARGET') {
        // Handled in the minute-target post-pass.
        continue;
      }
      remainingUnfixable += 1;
    }
  }

  // Post-pass: regenerate flagged notes, then top up to the 30-minute CPO target.
  const needsNotePass = notesToRegenerate.size > 0
    || findings.some((f) => f.rule === 'R4' && f.fixable && (f.code === 'NO_CCNOTES' || f.code === 'CPO_UNDER_TARGET'));

  if (needsNotePass) {
    const notes = Array.isArray(payload.ccNotes) ? payload.ccNotes : (payload.ccNotes = []);

    for (const idx of notesToRegenerate) {
      const note = notes[idx];
      if (!note) continue;
      const before = note.noteText;
      const newText = await regenerateNoteText(note.noteType, extraction);
      if (newText) {
        note.noteText = newText;
        note.minutes = note.minutes || 4;
        note.data_tags = { ...(note.data_tags || {}), generated_by: 'ai_service' };
        note.signed_by_physician = false;
        changes.push({ ts: nowIso(), rule: 'R4', action: `regenerate note[${idx}]`, before: before ?? null, after: newText });
        fixedCount += 1;
      } else {
        remainingUnfixable += 1;
      }
    }

    // Top up minutes to the 30-min target by generating additional notes.
    const noteTypes = ['Preventive Care', 'Safety', 'Goals', 'Medications'];
    let total = notes.reduce((sum, n) => sum + (Number(n.minutes) || 0), 0);
    let guard = 0;
    while (total < 30 && guard < 10) {
      const type = noteTypes[notes.length % noteTypes.length];
      const text = await regenerateNoteText(type, extraction);
      if (!text) break;
      const minutes = 4;
      notes.push({
        id: `note-${notes.length}`,
        noteType: type,
        noteText: text,
        minutes,
        data_tags: { generated_by: 'ai_service' },
        signed_by_physician: false,
      });
      total += minutes;
      changes.push({ ts: nowIso(), rule: 'R4', action: `add ${type} note`, before: null, after: `${minutes} min` });
      fixedCount += 1;
      guard += 1;
    }
    if (total < 30) remainingUnfixable += 1;
  }

  return { fixedCount, changes, remainingUnfixable };
}

/**
 * Consume the rework-status audit_records for the item's agency, auto-fix fixable findings,
 * append change_log entries, mark fully-resolved records 'done', and re-audit in a bounded
 * loop (max 3 cycles) until failed count is 0 or < 10% of records. Unfixable stay 'rework'.
 *
 * @param {{ item: object }} args — item is the workflow_item row (reference_payload.HHAH,
 *   extraction_payload).
 * @returns {Promise<{ ok: boolean, cycles: number, fixed: number, remaining: number }>}
 */
export async function reworkAudits({ item, maxCycles = MAX_CYCLES }) {
  const sql = getSql();
  const agencyId = item?.reference_payload?.HHAH?.id || null;
  const extraction = item?.extraction_payload || null;

  if (!agencyId) {
    return { ok: false, cycles: 0, fixed: 0, remaining: 0, error: 'No agency id on workflow item' };
  }

  // Milestone B lets the audit-cycle caller widen the bound (<=5) or narrow it to a
  // single re-audit pass; default preserves the original 3-cycle behaviour.
  const boundedCycles = Math.max(1, Number.isFinite(Number(maxCycles)) ? Number(maxCycles) : MAX_CYCLES);
  let totalFixed = 0;
  let cycles = 0;
  let remaining = 0;

  for (let cycle = 0; cycle < boundedCycles; cycle += 1) {
    cycles = cycle + 1;

    // Pull rework audits joined to their rcm_records payloads.
    const rows = await sql`
      SELECT a.id AS audit_id, a.rule_results, a.change_log,
             r.id AS rcm_id, r.payload
      FROM audit_records a
      JOIN rcm_records r ON r.id = a.rcm_record_id
      WHERE a.agency_id = ${agencyId} AND a.status = 'rework'`;

    if (rows.length === 0) break;

    for (const row of rows) {
      const findings = Array.isArray(row.rule_results) ? row.rule_results : [];
      const fixable = findings.filter((f) => f.fixable);
      if (fixable.length === 0) continue; // leave as rework — nothing auto-fixable

      const payload = row.payload || {};
      const { fixedCount, changes, remainingUnfixable } = await applyFixes(payload, findings, extraction);

      if (fixedCount === 0) continue;
      totalFixed += fixedCount;

      const priorLog = Array.isArray(row.change_log) ? row.change_log : [];
      const newLog = JSON.stringify([...priorLog, ...changes]);
      const nextStatus = remainingUnfixable === 0 ? 'done' : 'rework';

      // rcm_records has no updated_at column (see 004_rcm_pipeline.sql) — only the
      // audit_records side tracks updated_at.
      await sql`
        UPDATE rcm_records SET payload = ${JSON.stringify(payload)}::jsonb
        WHERE id = ${row.rcm_id}`;
      await sql`
        UPDATE audit_records
        SET change_log = ${newLog}::jsonb, status = ${nextStatus}, updated_at = now()
        WHERE id = ${row.audit_id}`;
    }

    // Re-audit: rewrites rule_results/status for every record; loop stops when clean enough.
    const reAudit = await auditRcm({ item });
    const totalRecords = reAudit.passed.length + reAudit.failed.length;
    remaining = reAudit.failed.length;
    if (remaining === 0) break;
    if (totalRecords > 0 && remaining / totalRecords < REWORK_TARGET_RATIO) break;
  }

  return { ok: true, cycles, fixed: totalFixed, remaining };
}
