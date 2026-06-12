import formidable from 'formidable';

function asArray(value) {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

export async function parseMultipart(req) {
  const form = formidable({
    multiples: true,
    keepExtensions: true,
    maxFileSize: 100 * 1024 * 1024,
  });

  const [fields, files] = await form.parse(req);
  const workbook = asArray(files.workbook || files.file).find((file) =>
    String(file.originalFilename || '').toLowerCase().endsWith('.xlsx')
  );
  const pdfs = [
    ...asArray(files.pdfs),
    ...asArray(files.pdf),
    ...asArray(files.documents),
  ].filter((file) => String(file.originalFilename || '').toLowerCase().endsWith('.pdf'));
  const zips = [
    ...asArray(files.orderZip),
    ...asArray(files.orderZips),
    ...asArray(files.zip),
    ...asArray(files.zips),
  ].filter((file) => String(file.originalFilename || '').toLowerCase().endsWith('.zip'));

  return {
    fields,
    workbook,
    pdfs,
    zips,
  };
}
