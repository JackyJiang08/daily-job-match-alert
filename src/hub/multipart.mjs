// Minimal multipart/form-data parser for the hub's local upload forms: one buffered body, a handful of
// text fields, and a single PDF. Buffer.indexOf keeps binary payloads intact; the request body is size
// capped before it reaches this parser.

export function multipartBoundary(contentType) {
  const match = /multipart\/form-data\s*;.*boundary=(?:"([^"]+)"|([^;]+))/i.exec(String(contentType || ''));
  if (!match) return null;
  return (match[1] || match[2]).trim();
}

function parseHeaders(block) {
  const headers = {};
  for (const line of block.split(/\r\n/)) {
    const index = line.indexOf(':');
    if (index > 0) headers[line.slice(0, index).trim().toLowerCase()] = line.slice(index + 1).trim();
  }
  return headers;
}

function disposition(value) {
  const result = {};
  for (const part of String(value || '').split(';').slice(1)) {
    const match = /^\s*([^=]+)=(?:"((?:[^"\\]|\\.)*)"|([^;]*))\s*$/.exec(part);
    if (match) result[match[1].trim()] = (match[2] ?? match[3] ?? '').replace(/\\"/g, '"');
  }
  return result;
}

export function parseMultipart(body, contentType) {
  const boundary = multipartBoundary(contentType);
  if (!boundary) throw new Error('multipart/form-data boundary is missing');
  const buffer = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const delimiter = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = [];
  let position = buffer.indexOf(delimiter);
  while (position >= 0) {
    let start = position + delimiter.length;
    if (buffer.slice(start, start + 2).toString() === '--') break;
    if (buffer.slice(start, start + 2).toString() === '\r\n') start += 2;
    const headerEnd = buffer.indexOf('\r\n\r\n', start);
    if (headerEnd < 0) break;
    const headers = parseHeaders(buffer.slice(start, headerEnd).toString('utf8'));
    const next = buffer.indexOf(delimiter, headerEnd + 4);
    if (next < 0) break;
    let dataEnd = next;
    if (buffer.slice(dataEnd - 2, dataEnd).toString() === '\r\n') dataEnd -= 2;
    const data = buffer.slice(headerEnd + 4, dataEnd);
    const meta = disposition(headers['content-disposition']);
    if (meta.name) {
      if (meta.filename !== undefined) {
        files.push({ field: meta.name, filename: meta.filename, contentType: headers['content-type'] || 'application/octet-stream', data });
      } else {
        fields[meta.name] = data.toString('utf8');
      }
    }
    position = next;
  }
  return { fields, files };
}
