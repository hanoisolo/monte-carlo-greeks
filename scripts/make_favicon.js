// Wraps a PNG into a single-image .ico container.
//
// The ICO format allows an embedded PNG payload directly (Vista and later),
// so no pixel decoding is needed: a 6-byte ICONDIR followed by one 16-byte
// ICONDIRENTRY whose image offset points at the PNG bytes.
import { readFileSync, writeFileSync, rmSync } from 'node:fs';

const source = new URL('../assets/favicon_source.png', import.meta.url);
const target = new URL('../assets/favicon.ico', import.meta.url);

const png = readFileSync(source);

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // image count

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // width 0 means 256
entry.writeUInt8(0, 1); // height 0 means 256
entry.writeUInt8(0, 2); // palette colours
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // colour planes
entry.writeUInt16LE(32, 6); // bits per pixel
entry.writeUInt32LE(png.length, 8); // payload size
entry.writeUInt32LE(22, 12); // payload offset (6 + 16)

writeFileSync(target, Buffer.concat([header, entry, png]));
rmSync(source, { force: true });

console.log(`Wrote assets/favicon.ico (${png.length + 22} bytes)`);
