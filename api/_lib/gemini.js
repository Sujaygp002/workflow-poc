import { GoogleGenAI, Type } from '@google/genai';
import { GEMINI_API_KEY, GEMINI_MODEL } from './config.js';

const extractionSchema = {
  type: Type.OBJECT,
  properties: {
    patient: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        sex: { type: Type.STRING },
        DOB: { type: Type.STRING },
        MRN: { type: Type.STRING },
        address: { type: Type.STRING },
        SOC: { type: Type.STRING },
        EOC: { type: Type.STRING },
        SOE: { type: Type.STRING },
        EOE: { type: Type.STRING },
        diagnosis_codes: { type: Type.ARRAY, items: { type: Type.STRING } },
      },
    },
    order: {
      type: Type.OBJECT,
      properties: {
        order_number: { type: Type.STRING },
        order_type: { type: Type.STRING },
        order_date: { type: Type.STRING },
        signed_date: { type: Type.STRING },
        NPI: { type: Type.STRING },
      },
    },
    PG: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        NPI: { type: Type.STRING },
        type: { type: Type.STRING },
      },
    },
    HHAH: {
      type: Type.OBJECT,
      properties: {
        name: { type: Type.STRING },
        NPI: { type: Type.STRING },
        type: { type: Type.STRING },
        type_of_service: { type: Type.STRING },
      },
    },
    practitioner: {
      type: Type.OBJECT,
      properties: {
        physician_name: { type: Type.STRING },
        speciality: { type: Type.STRING },
        NPI: { type: Type.STRING },
      },
    },
    confidence: { type: Type.STRING },
    notes: { type: Type.STRING },
  },
};

export async function extractMissingDataFromPdf({ pdfBuffer, missingFields, currentPayload }) {
  if (!GEMINI_API_KEY) {
    return {
      ok: false,
      skipped: true,
      error: 'GEMINI_API_KEY is not configured',
      data: {},
    };
  }
  if (!pdfBuffer) {
    return {
      ok: false,
      skipped: true,
      error: 'No PDF was provided for extraction',
      data: {},
    };
  }

  const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
  const model = GEMINI_MODEL;
  const response = await ai.models.generateContent({
    model,
    contents: [
      {
        inlineData: {
          mimeType: 'application/pdf',
          data: pdfBuffer.toString('base64'),
        },
      },
      {
        text:
          'Extract missing structured healthcare workflow fields from this order PDF. ' +
          'Return only values that are visible or strongly supported by the document. ' +
          `Missing fields: ${missingFields.join(', ')}. ` +
          `Current payload: ${JSON.stringify(currentPayload)}`,
      },
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: extractionSchema,
    },
  });

  const text = response.text || '{}';
  const data = JSON.parse(text);
  return {
    ok: true,
    model,
    data,
  };
}
