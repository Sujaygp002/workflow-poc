import ExcelJS from 'exceljs';
import { cleanString, normalizeName, parseDate, patientKeyFromParts } from './normalizers.js';

const PATIENT_HEADERS = {
  patientName: ['patientname(fk)', 'patientname', 'patient name'],
  dob: ['dob(fk)', 'dob'],
  mrn: ['mrn(fk)', 'mrn'],
  patient_sex: ['patient_sex', 'sex'],
  address: ['address'],
  PgName: ['pg name', 'pgname', 'physician group'],
  Agencyname: ['agency name', 'agencyname', 'hhah', 'hha'],
  SOC: ['soc(admission start)', 'soc'],
  EOC: ['eoc(admission end)', 'eoc'],
  SOE: ['soe(startofepisode)', 'soe'],
  EOE: ['eoe(endofepisode)', 'eoe'],
  Diagnosis1: ['diagnosis 1', 'diagnosis1'],
  Diagnosis2: ['diagnosis 2', 'diagnosis2'],
  Diagnosis3: ['diagnosis 3', 'diagnosis3'],
  Diagnosis4: ['diagnosis 4', 'diagnosis4'],
  Diagnosis5: ['diagnosis 5', 'diagnosis5'],
  Diagnosis6: ['diagnosis 6', 'diagnosis6'],
};

const ORDER_HEADERS = {
  orderno: ['orderno', 'order number', 'order_number'],
  orderdate: ['orderdate', 'order date'],
  patientName: ['patientname(fk)', 'patientname', 'patient name'],
  dob: ['dob(fk)', 'dob'],
  mrn: ['mrn(fk)', 'mrn'],
  documentType: ['documenttype', 'document type', 'order type'],
  SOC: ['soc'],
  EOC: ['eoc'],
  SOE: ['soe'],
  EOE: ['eoe'],
  SignedDate: ['signeddate', 'signed date'],
  NPI: ['npi'],
};

function headerKey(value) {
  return cleanString(value).toLowerCase().replace(/\s+/g, ' ');
}

function headerIndex(row) {
  const byHeader = {};
  row.eachCell((cell, colNumber) => {
    byHeader[headerKey(cell.value)] = colNumber;
  });
  return byHeader;
}

function getMappedValue(row, index, aliases) {
  for (const alias of aliases) {
    const col = index[headerKey(alias)];
    if (col) return row.getCell(col).value;
  }
  return '';
}

function cellValue(value) {
  if (value == null) return '';
  if (value instanceof Date) return parseDate(value);
  if (typeof value === 'object') {
    if ('text' in value) return cleanString(value.text);
    if ('result' in value) return cellValue(value.result);
    if ('richText' in value) return value.richText.map((r) => r.text).join('');
    if ('hyperlink' in value && 'text' in value) return cleanString(value.text);
  }
  return cleanString(value);
}

function readRows(sheet, headerMap) {
  if (!sheet || sheet.rowCount < 1) return [];
  const header = headerIndex(sheet.getRow(1));
  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const mapped = {};
    for (const [key, aliases] of Object.entries(headerMap)) {
      mapped[key] = cellValue(getMappedValue(row, header, aliases));
    }
    if (Object.values(mapped).some((value) => cleanString(value))) {
      rows.push({ ...mapped, __rowNumber: rowNumber });
    }
  }
  return rows;
}

function diagnosisCodes(patientRow) {
  return [
    patientRow.Diagnosis1,
    patientRow.Diagnosis2,
    patientRow.Diagnosis3,
    patientRow.Diagnosis4,
    patientRow.Diagnosis5,
    patientRow.Diagnosis6,
  ].map(cleanString).filter(Boolean);
}

function makeReferencePayload(patientRow, orderRow) {
  const pgName = patientRow?.PgName || '';
  const agencyName = patientRow?.Agencyname || '';
  const npi = orderRow?.NPI || '';
  return {
    practitioner: {
      physician_name: '',
      speciality: '',
      NPI: npi,
      contact_info: {
        phone_number: '',
        alternative_number: '',
        email: '',
        doximity: '',
      },
      history: {
        PG_names: pgName ? [{ id: '', name: pgName }] : [],
      },
      data_tags: {
        source: 'excel_order_npi_or_pdf',
        match_key: npi ? `npi:${npi.replace(/\D/g, '')}` : '',
        validated_by: 'system',
        confidence: 'unconfirmed',
      },
    },
    PG: {
      name: pgName,
      NPI: '',
      type: '',
      contact_info: {
        phone_number: '',
        alternative_number: '',
        email: '',
        doximity: '',
        address: {
          street: '',
          city: '',
          state: '',
          county: '',
          zip: '',
        },
        map_link: '',
        logo_image: '',
        npp_ids: [],
        physician_ids: [],
      },
      data_tags: {
        source: 'excel_pg_name_or_pdf',
        match_key: pgName ? `pg_name:${normalizeName(pgName)}` : '',
        validated_by: 'system',
        confidence: 'unconfirmed',
      },
    },
    HHAH: {
      name: agencyName,
      NPI: '',
      type: 'Home Health Agency',
      type_of_service: '',
      contact_info: {
        phone_number: '',
        alternative_number: '',
        email: '',
        doximity: '',
        address: {
          street: '',
          city: '',
          state: '',
          county: '',
          zip: '',
        },
        map_link: '',
        logo_image: '',
        user_ids: [],
      },
      data_tags: {
        source: 'excel_agency_name_or_pdf',
        match_key: agencyName ? `hhah_name:${normalizeName(agencyName)}` : '',
        validated_by: 'system',
        confidence: 'unconfirmed',
      },
    },
  };
}

function makePatientPayload(patientRow, referencePayload) {
  return {
    entity: 'patient',
    patient_info: {
      name: patientRow?.patientName || '',
      sex: patientRow?.patient_sex || '',
      DOB: parseDate(patientRow?.dob) || '',
      age: null,
    },
    personal_information: {
      address: {
        street: patientRow?.address || '',
        city: '',
        state: '',
        county: '',
        zip: '',
      },
      phone_number: '',
      alternative_phone_number: '',
      next_to_kin: '',
    },
    insurance_details: {
      primary_insurance: { id: '', name: '' },
      secondary_insurance: { id: '', name: '' },
      tertiary_insurance: { id: '', name: '' },
    },
    admission_details: {
      HHAH: { id: '', name: referencePayload.HHAH.name },
      PG: { id: '', name: referencePayload.PG.name },
      care_provider: { id: '', name: '' },
      MRN: patientRow?.mrn || '',
      EHR_record_number: '',
      EHR_account_number: '',
      SOC: parseDate(patientRow?.SOC) || '',
      EOC: parseDate(patientRow?.EOC) || '',
      SOE: parseDate(patientRow?.SOE) || '',
      EOE: parseDate(patientRow?.EOE) || '',
      diagnosis_codes: diagnosisCodes(patientRow || {}),
      admission_ids: [],
    },
    data_tags: {
      source: 'excel_and_pdf',
      patient_key: patientKeyFromParts(patientRow?.patientName, parseDate(patientRow?.dob), patientRow?.mrn),
      validated_by: 'system',
      confidence: 'unconfirmed',
    },
  };
}

function makeOrderPayload(orderRow, patientRow, referencePayload) {
  return {
    entity: 'order',
    order_info: {
      order_number: orderRow?.orderno || '',
      order_type: orderRow?.documentType || '',
      order_date: parseDate(orderRow?.orderdate) || '',
      patient_id: '',
    },
    order_status: {
      order_status: 'received',
      order_sent_date: '',
      order_signed_date: parseDate(orderRow?.SignedDate) || '',
      order_EHR_upload_date: '',
    },
    order_admission_details: {
      agency: { id: '', name: referencePayload.HHAH.name },
      episode: { id: '' },
      PG: { id: '', name: referencePayload.PG.name },
      billing_provider: {
        id: '',
        name: '',
        NPI: orderRow?.NPI || '',
      },
      supervising_provider: {
        id: '',
        name: '',
        NPI: '',
      },
      SOC: parseDate(orderRow?.SOC || patientRow?.SOC) || '',
      EOC: parseDate(orderRow?.EOC || patientRow?.EOC) || '',
      SOE: parseDate(orderRow?.SOE || patientRow?.SOE) || '',
      EOE: parseDate(orderRow?.EOE || patientRow?.EOE) || '',
    },
    data_tags: {
      source: 'excel_and_pdf',
      order_key: orderRow?.orderno || '',
      validated_by: 'system',
      confidence: 'unconfirmed',
    },
  };
}

function mergePatientKeys(row) {
  return patientKeyFromParts(row?.patientName, parseDate(row?.dob), row?.mrn);
}

export async function parseWorkflowWorkbook(filePath) {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);

  const patientSheet = workbook.getWorksheet('Sheet1') || workbook.worksheets[0];
  const orderSheet = workbook.getWorksheet('Sheet2') || workbook.worksheets[1];
  const patientRows = readRows(patientSheet, PATIENT_HEADERS);
  const orderRows = readRows(orderSheet, ORDER_HEADERS);

  const patientsByKey = new Map(patientRows.map((row) => [mergePatientKeys(row), row]));
  const usedPatientKeys = new Set();
  const joined = [];

  for (const orderRow of orderRows) {
    const key = mergePatientKeys(orderRow);
    const patientRow = patientsByKey.get(key) || {
      patientName: orderRow.patientName,
      dob: orderRow.dob,
      mrn: orderRow.mrn,
    };
    const patientRowForOrder = {
      ...patientRow,
      SOC: orderRow.SOC || patientRow.SOC,
      EOC: orderRow.EOC || patientRow.EOC,
      SOE: orderRow.SOE || patientRow.SOE,
      EOE: orderRow.EOE || patientRow.EOE,
    };
    usedPatientKeys.add(key);
    const referencePayload = makeReferencePayload(patientRowForOrder, orderRow);
    joined.push({
      patientPayload: makePatientPayload(patientRowForOrder, referencePayload),
      orderPayload: makeOrderPayload(orderRow, patientRowForOrder, referencePayload),
      referencePayload,
      sourceRows: {
        patient: patientRowForOrder.__rowNumber || null,
        order: orderRow.__rowNumber || null,
      },
    });
  }

  for (const patientRow of patientRows) {
    const key = mergePatientKeys(patientRow);
    if (usedPatientKeys.has(key)) continue;
    const referencePayload = makeReferencePayload(patientRow, {});
    joined.push({
      patientPayload: makePatientPayload(patientRow, referencePayload),
      orderPayload: makeOrderPayload({}, patientRow, referencePayload),
      referencePayload,
      sourceRows: {
        patient: patientRow.__rowNumber || null,
        order: null,
      },
    });
  }

  return {
    patientRows,
    orderRows,
    joined,
    summary: {
      patientSheet: patientSheet?.name || null,
      orderSheet: orderSheet?.name || null,
      patientRows: patientRows.length,
      orderRows: orderRows.length,
      joinedRows: joined.length,
    },
  };
}
