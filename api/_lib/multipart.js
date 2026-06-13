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
  const isZip = (file) => String(file.originalFilename || '').toLowerCase().endsWith('.zip');
  // Unsigned order PDFs (to be sent for signature).
  const unsignedZips = [
    ...asArray(files.unsignedZip),
    ...asArray(files.unsignedZips),
    ...asArray(files.orderZip),
    ...asArray(files.orderZips),
    ...asArray(files.zip),
    ...asArray(files.zips),
  ].filter(isZip);
  // Already-signed order PDFs.
  const signedZips = [
    ...asArray(files.signedZip),
    ...asArray(files.signedZips),
  ].filter(isZip);

  return {
    fields,
    workbook,
    pdfs,
    unsignedZips,
    signedZips,
  };
}
