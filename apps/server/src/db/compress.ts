import * as zlib from 'node:zlib';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Blobs are compressed JSON (docs/06: event logs are "write-once, read-rarely, and
 * large"): zstd where Node has it, gzip otherwise, and the encoding stored beside the
 * blob so either can be read back whichever wrote it.
 */

export type Encoding = 'zstd' | 'gzip';

type Codec = (input: Buffer) => Buffer;
const zstd = zlib as unknown as {
  zstdCompressSync?: Codec;
  zstdDecompressSync?: Codec;
};

export const defaultEncoding: Encoding =
  typeof zstd.zstdCompressSync === 'function' ? 'zstd' : 'gzip';

export const pack = (value: unknown, encoding: Encoding = defaultEncoding): Buffer => {
  const json = Buffer.from(JSON.stringify(value), 'utf8');
  if (encoding === 'zstd' && zstd.zstdCompressSync !== undefined)
    return zstd.zstdCompressSync(json);
  return gzipSync(json);
};

export const unpack = <T>(data: Buffer, encoding: string): T => {
  let json: Buffer;
  if (encoding === 'zstd') {
    if (zstd.zstdDecompressSync === undefined) throw new Error('this Node cannot read zstd');
    json = zstd.zstdDecompressSync(data);
  } else if (encoding === 'gzip') {
    json = gunzipSync(data);
  } else {
    throw new Error(`unknown encoding ${encoding}`);
  }
  return JSON.parse(json.toString('utf8')) as T;
};
