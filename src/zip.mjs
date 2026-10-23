// A minimal zip writer and reader (no dependency): deflate or store per entry, UTF-8 names, Unix modes,
// CRC-32 checked on read. No ZIP64: an entry or archive past 4 GB, or more than 65,535 entries, is refused.
// Used by src/backup.mjs; the archives open with Finder, `unzip`, and `ditto -x -k`.
import zlib from 'node:zlib';
import { promisify } from 'node:util';

const deflateRaw = promisify(zlib.deflateRaw);
const inflateRaw = promisify(zlib.inflateRaw);
const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;
const UTF8_FLAG = 0x0800;
const LIMIT = 0xffffffff;

let crcTable = null;
function tableCrc32(buffer) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) crc = crcTable[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32(buffer) {
  return typeof zlib.crc32 === 'function' ? zlib.crc32(buffer) >>> 0 : tableCrc32(buffer);
}

// MS-DOS date and time (local time, two-second resolution), as zip tools expect.
function dosDateTime(date) {
  const value = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = Math.min(Math.max(value.getFullYear(), 1980), 2107);
  return {
    time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate(),
  };
}

function fromDosDateTime(date, time) {
  return new Date(((date >> 9) & 0x7f) + 1980, ((date >> 5) & 0x0f) - 1, date & 0x1f, (time >> 11) & 0x1f, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

// entries: [{ name (forward slashes), data (Buffer), mode (permission bits), mtime (Date) }] → Buffer.
export async function createZip(entries) {
  if (entries.length > 0xffff) throw new Error(`too many files for a zip without ZIP64 (${entries.length})`);
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(String(entry.name), 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    if (data.length >= LIMIT) throw new Error(`${entry.name} is too large for a zip without ZIP64`);
    const deflated = await deflateRaw(data, { level: 6 });
    const stored = deflated.length >= data.length;
    const body = stored ? data : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(data);
    const { time, date } = dosDateTime(entry.mtime);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_SIGNATURE, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(UTF8_FLAG, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const record = Buffer.alloc(46);
    record.writeUInt32LE(CENTRAL_SIGNATURE, 0);
    record.writeUInt16LE((3 << 8) | 20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(UTF8_FLAG, 8);
    record.writeUInt16LE(method, 10);
    record.writeUInt16LE(time, 12);
    record.writeUInt16LE(date, 14);
    record.writeUInt32LE(crc, 16);
    record.writeUInt32LE(body.length, 20);
    record.writeUInt32LE(data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt32LE((((0o100000 | (Number(entry.mode ?? 0o644) & 0o7777)) << 16) >>> 0), 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    chunks.push(local, name, body);
    offset += local.length + name.length + body.length;
    if (offset >= LIMIT) throw new Error('backup archive is too large for a zip without ZIP64');
  }
  const centralSize = central.reduce((sum, chunk) => sum + chunk.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_SIGNATURE, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...chunks, ...central, end]);
}

function findEnd(buffer) {
  for (let position = buffer.length - 22; position >= Math.max(0, buffer.length - 22 - 0xffff); position -= 1) {
    if (buffer.readUInt32LE(position) === END_SIGNATURE) return position;
  }
  throw new Error('not a zip file (no end of central directory)');
}

// → [{ name, data, mode, mtime }], every entry's size and CRC-32 checked.
export async function readZip(buffer) {
  const end = findEnd(buffer);
  const count = buffer.readUInt16LE(end + 10);
  let position = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(position) !== CENTRAL_SIGNATURE) throw new Error('corrupt zip central directory');
    const method = buffer.readUInt16LE(position + 10);
    const time = buffer.readUInt16LE(position + 12);
    const date = buffer.readUInt16LE(position + 14);
    const crc = buffer.readUInt32LE(position + 16);
    const compressedSize = buffer.readUInt32LE(position + 20);
    const size = buffer.readUInt32LE(position + 24);
    const nameLength = buffer.readUInt16LE(position + 28);
    const extraLength = buffer.readUInt16LE(position + 30);
    const commentLength = buffer.readUInt16LE(position + 32);
    const external = buffer.readUInt32LE(position + 38);
    const offset = buffer.readUInt32LE(position + 42);
    const name = buffer.subarray(position + 46, position + 46 + nameLength).toString('utf8');
    position += 46 + nameLength + extraLength + commentLength;
    if (buffer.readUInt32LE(offset) !== LOCAL_SIGNATURE) throw new Error(`corrupt zip entry ${name}`);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    const body = buffer.subarray(start, start + compressedSize);
    let data;
    if (method === 0) data = Buffer.from(body);
    else if (method === 8) data = await inflateRaw(body);
    else throw new Error(`${name}: unsupported zip compression method ${method}`);
    if (data.length !== size || crc32(data) !== crc) throw new Error(`${name}: size or checksum does not match; the archive is damaged`);
    if (name.endsWith('/')) continue;
    const mode = (external >>> 16) & 0o7777;
    entries.push({ name, data, mode: mode || 0o644, mtime: fromDosDateTime(date, time) });
  }
  return entries;
}
