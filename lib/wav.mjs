// dsh-breeze — PCM/WAV helpers.
//
// breeze-server streams headerless s16le PCM on the native endpoint, and its
// OpenAI-compatible WAV output carries 0xFFFFFFFF in both size fields because
// the length is unknown when the header goes out. Neither is a defect on its
// side; both are something a consumer has to normalise. We always wrap PCM
// ourselves and repair any WAV the server hands back, so everything this
// plugin writes is a strictly valid file for players, editors and ffmpeg.

/**
 * Walk the RIFF chunk list. Chunk ids are compared as ASCII text: reading them
 * little-endian and comparing against a big-endian constant silently matches
 * nothing, which is exactly the bug that made an earlier revision report every
 * duration as 0 s.
 */
function riffChunks(buf) {
  const chunks = [];
  let offset = 12;
  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const declared = buf.readUInt32LE(offset + 4);
    const bodyStart = offset + 8;
    const fits = bodyStart + declared <= buf.length;
    // 0xFFFFFFFF is the server's "length not known yet" marker for streamed WAV.
    const size = declared === 0xffffffff || declared === 0 || !fits ? buf.length - bodyStart : declared;
    chunks.push({ id, offset, bodyStart, declared, size, repaired: size !== declared });
    if (size <= 0) break;
    offset = bodyStart + size + (size % 2);
  }
  return chunks;
}

/** Build a canonical 16-bit PCM WAV file from headerless little-endian PCM. */
export function pcmToWav(pcm, { sampleRate = 24000, channels = 1, bitsPerSample = 16 } = {}) {
  const buffer = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm);
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + buffer.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16); // PCM fmt chunk size
  header.writeUInt16LE(1, 20); // format = PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(buffer.length, 40);
  return Buffer.concat([header, buffer]);
}

/**
 * Repair a streamed WAV: fix the RIFF size and every data chunk size that the
 * server left at 0xFFFFFFFF (or that is simply wrong), keeping the payload
 * bytes untouched. Returns the input unchanged when it is not identifiable as
 * RIFF/WAVE.
 */
export function fixWav(input) {
  const buf = Buffer.isBuffer(input) ? Buffer.from(input) : Buffer.from(input);
  if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return buf;
  }
  for (const chunk of riffChunks(buf)) {
    if (chunk.id === 'data' && chunk.repaired) buf.writeUInt32LE(chunk.size, chunk.offset + 4);
  }
  buf.writeUInt32LE(Math.max(36, buf.length - 8), 4);
  return buf;
}

/** Describe a WAV buffer well enough to report a duration. */
export function wavInfo(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    return { valid: false };
  }
  let sampleRate = 24000;
  let channels = 1;
  let bitsPerSample = 16;
  let dataBytes = 0;
  for (const chunk of riffChunks(buf)) {
    if (chunk.id === 'fmt ' && chunk.size >= 16) {
      channels = buf.readUInt16LE(chunk.bodyStart + 2);
      sampleRate = buf.readUInt32LE(chunk.bodyStart + 4);
      bitsPerSample = buf.readUInt16LE(chunk.bodyStart + 14);
    }
    if (chunk.id === 'data') dataBytes = chunk.size;
  }
  const blockAlign = Math.max(1, (channels * bitsPerSample) / 8);
  const frames = dataBytes / blockAlign;
  return {
    valid: true,
    sampleRate,
    channels,
    bitsPerSample,
    dataBytes,
    durationSec: sampleRate > 0 ? Number((frames / sampleRate).toFixed(3)) : 0,
  };
}

/** Duration of headerless s16le mono PCM. */
export function pcmDuration(pcm, sampleRate = 24000, channels = 1) {
  const bytes = Buffer.isBuffer(pcm) ? pcm.length : Number(pcm) || 0;
  const frames = bytes / (2 * Math.max(1, channels));
  return sampleRate > 0 ? Number((frames / sampleRate).toFixed(3)) : 0;
}
