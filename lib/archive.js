/**
 * Minimal readers for the two container formats the Logseq release uses:
 * a ZIP (Linux release) holding `resources/app.asar`, and the asar archive itself.
 * Kept dependency-free on purpose; both are only read, never written.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'
import { createInflateRaw } from 'node:zlib'

/**
 * Extract one entry from a ZIP file to `dest`.
 * @param {string} zipPath
 * @param {string} entryName - exact path inside the archive
 * @param {string} dest
 */
export async function extractZipEntry(zipPath, entryName, dest) {
  const fh = await open(zipPath, 'r')
  let entry
  try {
    const { size } = await fh.stat()
    const tailLen = Math.min(size, 65_557)
    const tail = Buffer.alloc(tailLen)
    await fh.read(tail, 0, tailLen, size - tailLen)
    const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
    if (eocd < 0) throw new Error('not a zip file (no end-of-central-directory)')
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (cdOffset === 0xffffffff || count === 0xffff) throw new Error('zip64 archives are not supported')
    const cd = Buffer.alloc(cdSize)
    await fh.read(cd, 0, cdSize, cdOffset)
    let p = 0
    for (let i = 0; i < count && p < cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory')
      const method = cd.readUInt16LE(p + 10)
      const compSize = cd.readUInt32LE(p + 20)
      const nameLen = cd.readUInt16LE(p + 28)
      const extraLen = cd.readUInt16LE(p + 30)
      const commentLen = cd.readUInt16LE(p + 32)
      const localOffset = cd.readUInt32LE(p + 42)
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen)
      if (name === entryName) {
        entry = { method, compSize, localOffset }
        break
      }
      p += 46 + nameLen + extraLen + commentLen
    }
    if (!entry) throw new Error(`entry not found in zip: ${entryName}`)
    const local = Buffer.alloc(30)
    await fh.read(local, 0, 30, entry.localOffset)
    if (local.readUInt32LE(0) !== 0x04034b50) throw new Error('corrupt zip local header')
    entry.dataStart = entry.localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28)
  } finally {
    await fh.close()
  }
  if (entry.compSize === 0) throw new Error(`empty zip entry: ${entryName}`)
  const source = createReadStream(zipPath, { start: entry.dataStart, end: entry.dataStart + entry.compSize - 1 })
  if (entry.method === 0) await pipeline(source, createWriteStream(dest))
  else if (entry.method === 8) await pipeline(source, createInflateRaw(), createWriteStream(dest))
  else throw new Error(`unsupported zip compression method ${entry.method}`)
}

/**
 * Read the asar header and return a function that extracts files by path.
 * @param {string} asarPath
 */
export async function openAsar(asarPath) {
  const fh = await open(asarPath, 'r')
  const head = Buffer.alloc(16)
  await fh.read(head, 0, 16, 0)
  // Chromium pickle: [4: pickle payload size=4][4: header pickle size][4: payload size][4: json len][json]
  const headerPickleSize = head.readUInt32LE(4)
  const jsonLen = head.readUInt32LE(12)
  const json = Buffer.alloc(jsonLen)
  await fh.read(json, 0, jsonLen, 16)
  const header = JSON.parse(json.toString('utf8'))
  const base = 8 + headerPickleSize
  return {
    /** @param {string} path - e.g. `js/logseq-cli.js` */
    async read(path) {
      let node = header
      for (const part of path.split('/')) {
        node = node?.files?.[part]
        if (!node) throw new Error(`file not found in asar: ${path}`)
      }
      if (node.unpacked) throw new Error(`asar entry is unpacked, not embedded: ${path}`)
      const buf = Buffer.alloc(node.size)
      await fh.read(buf, 0, node.size, base + Number(node.offset))
      return buf
    },
    close: () => fh.close(),
  }
}
