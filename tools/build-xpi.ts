/**
 * rinka tools/build-xpi.ts — extension/ から配布用 .xpi（= zip）を組む。
 * 依存ゼロ規約どおり Node 標準ライブラリのみ（zip本体は手組・STORED・固定日付で決定的）。
 *
 * 使い方（リポジトリのルートで）:
 *   node --experimental-strip-types --no-warnings tools/build-xpi.ts [outDir（既定 dist）]
 *
 * 出力: dist/rinka-<manifestのversion>.xpi（署名前の素xpi。AMOの
 *   「ファイルをアップロードして署名」経路にそのまま使える。web-ext を入れたくなったら
 *   このファイルは不要になるが、依存ゼロでも配布物を作れることが重要）。
 *
 * 仕様: STORED（無圧縮・method 0）。ZIP日付は固定値（決定性規約: 乱数・実測時刻を入れない）。
 *   CRC32 は node:zlib の crc32。EOCD/central directory を巻いて自己検証（readCentralDirectory）を
 *   main の最後で必ず通してから終了する（信頼できない出力を配布経路に流さない）。
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { crc32 } from "node:zlib";

/** 決定的な固定日付（DOS時間: 1980-01-01 00:00。書庫ビルドに実測時刻を混ぜない）。 */
const DOS_TIME = 0x0000;
const DOS_DATE = 0x0021; // (1980-01-01)

export type XpiEntry = {
  name: string; // 書庫内パス（/区切り）
  data: Buffer;
};

export type CentralRecord = {
  name: string;
  crc: number;
  size: number;
  offset: number; // データ部の先頭
};

/** little-endian で number を Buffer の pos へ書く。 */
const writeU16 = (buf: Buffer, pos: number, v: number): void => {
  buf.writeUInt16LE(v, pos);
};
const writeU32 = (buf: Buffer, pos: number, v: number): void => {
  buf.writeUInt32LE(v >>> 0, pos);
};

/** entries 全体を STORED の zip に組む。 */
export const buildXpi = (entries: XpiEntry[]): Buffer => {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = Buffer.from(e.name, "utf8");
    const crc = crc32(e.data) >>> 0;
    const size = e.data.length;
    // ---- local file header (0x04034b50) ----
    const lfh = Buffer.alloc(30 + name.length);
    writeU32(lfh, 0, 0x04034b50);
    writeU16(lfh, 4, 20); // 展開に必要な version
    writeU16(lfh, 6, 0x0800); // 一般目的フラグ: UTF-8 名
    writeU16(lfh, 8, 0); // method: STORED
    writeU16(lfh, 10, DOS_TIME);
    writeU16(lfh, 12, DOS_DATE);
    writeU32(lfh, 14, crc);
    writeU32(lfh, 18, size); // 圧縮後 = 元と同じ
    writeU32(lfh, 22, size); // 圧縮前
    writeU16(lfh, 26, name.length);
    writeU16(lfh, 28, 0); // extra 長
    name.copy(lfh, 30);
    chunks.push(lfh, e.data);
    // ---- central directory file header (0x02014b50) ----
    const cdh = Buffer.alloc(46 + name.length);
    writeU32(cdh, 0, 0x02014b50);
    writeU16(cdh, 4, 0x0014); // 作成 version
    writeU16(cdh, 6, 20); // 展開 version
    writeU16(cdh, 8, 0x0800);
    writeU16(cdh, 10, 0); // STORED
    writeU16(cdh, 12, DOS_TIME);
    writeU16(cdh, 14, DOS_DATE);
    writeU32(cdh, 16, crc);
    writeU32(cdh, 20, size);
    writeU32(cdh, 24, size);
    writeU16(cdh, 28, name.length);
    writeU16(cdh, 30, 0); // extra
    writeU16(cdh, 32, 0); // comment
    writeU16(cdh, 34, 0); // disk 番号始まり
    writeU16(cdh, 36, 0); // internal 属性
    writeU32(cdh, 38, 0); // external 属性
    writeU32(cdh, 42, offset); // local header 位置
    name.copy(cdh, 46);
    central.push(cdh);
    offset += lfh.length + size;
  }
  const centralBuf = Buffer.concat(central);
  // ---- EOCD (0x06054b50) ----
  const eocd = Buffer.alloc(22);
  writeU32(eocd, 0, 0x06054b50);
  writeU16(eocd, 4, 0);
  writeU16(eocd, 6, 0);
  writeU16(eocd, 8, entries.length);
  writeU16(eocd, 10, entries.length);
  writeU32(eocd, 12, centralBuf.length);
  writeU32(eocd, 16, offset);
  writeU16(eocd, 20, 0); // comment
  return Buffer.concat([...chunks, centralBuf, eocd]);
};

/** EOCD を見つけ、central directory の一覧を返す（自己検証とテストが使う解析側）。 */
export const readCentralDirectory = (xpi: Buffer): CentralRecord[] => {
  const EOCD_SIG = 0x06054b50;
  const CDH_SIG = 0x02014b50;
  const minEocd = 22;
  if (xpi.length < minEocd) throw new Error("rinka: xpi が短すぎます");
  // EOCD は末尾にある。comment は書かないので末尾22byteを直接見る。
  if (xpi.readUInt32LE(xpi.length - minEocd) !== EOCD_SIG) {
    throw new Error("rinka: EOCD が見つかりません（壊れたxpi）");
  }
  const eocd = xpi.length - minEocd;
  const count = xpi.readUInt16LE(eocd + 10);
  const cdSize = xpi.readUInt32LE(eocd + 12);
  const cdOffset = xpi.readUInt32LE(eocd + 16);
  let pos = cdOffset;
  const out: CentralRecord[] = [];
  for (let i = 0; i < count; i++) {
    if (pos + 46 > xpi.length || xpi.readUInt32LE(pos) !== CDH_SIG) {
      throw new Error("rinka: central directory が壊れています");
    }
    const crc = xpi.readUInt32LE(pos + 16);
    const size = xpi.readUInt32LE(pos + 24);
    const nameLen = xpi.readUInt16LE(pos + 28);
    const extraLen = xpi.readUInt16LE(pos + 30);
    const commentLen = xpi.readUInt16LE(pos + 32);
    const lfhOffset = xpi.readUInt32LE(pos + 42);
    const name = xpi.subarray(pos + 46, pos + 46 + nameLen).toString("utf8");
    out.push({ name, crc, size, offset: lfhOffset });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return out;
};

/** central directory の各欄を見て、実際の格納データとCRC・名前・サイズが一致するか検査する。 */
export const verifyStored = (xpi: Buffer, entries: XpiEntry[]): void => {
  const records = readCentralDirectory(xpi);
  if (records.length !== entries.length) {
    throw new Error(`rinka: xpi 検証NG: 件数不一致 (${records.length} vs ${entries.length})`);
  }
  entries.forEach((e, i) => {
    const r = records[i];
    if (r.name !== e.name) throw new Error(`rinka: xpi 検証NG: 名前不一致 (${r.name} vs ${e.name})`);
    if (r.size !== e.data.length) throw new Error(`rinka: xpi 検証NG: サイズ不一致 (${r.name})`);
    if (r.crc !== (crc32(e.data) >>> 0)) throw new Error(`rinka: xpi 検証NG: CRC不一致 (${r.name})`);
    // local header を読み、データ部を切り出して実byte比較
    const lfh = r.offset;
    if (lfh + 30 > xpi.length || xpi.readUInt32LE(lfh) !== 0x04034b50) {
      throw new Error(`rinka: xpi 検証NG: local header が無い (${r.name})`);
    }
    const nameLen = xpi.readUInt16LE(lfh + 26);
    const extraLen = xpi.readUInt16LE(lfh + 28);
    const dataStart = lfh + 30 + nameLen + extraLen;
    const sliced = xpi.subarray(dataStart, dataStart + r.size);
    if (sliced.length !== r.size) throw new Error(`rinka: xpi 検証NG: データが短い (${r.name})`);
    if (!sliced.equals(e.data)) throw new Error(`rinka: xpi 検証NG: データ不一致 (${r.name})`);
  });
};

/** extension/ から配布物を組む。出力パスを返す。 */
export const buildExtensionXpi = (rootDir: string, outDir: string): string => {
  const extDir = join(rootDir, "extension");
  const manifest = JSON.parse(readFileSync(join(extDir, "manifest.json"), "utf8"));
  const version = typeof manifest.version === "string" ? manifest.version : "";
  if (version === "") throw new Error("rinka: manifest.json に version がありません");
  const entries: XpiEntry[] = [
    { name: "manifest.json", data: readFileSync(join(extDir, "manifest.json")) },
    { name: "background.js", data: readFileSync(join(extDir, "background.js")) },
    { name: "icons/icon.svg", data: readFileSync(join(extDir, "icons", "icon.svg")) },
  ];
  const xpi = buildXpi(entries);
  verifyStored(xpi, entries); // 出力前に自己検証（信頼できない配布物を作らない）
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `rinka-${version}.xpi`);
  writeFileSync(outPath, xpi);
  return outPath;
};

// ---- CLI ----

const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
    const outDir = process.argv[2] !== undefined ? process.argv[2] : join(rootDir, "dist");
    const outPath = buildExtensionXpi(rootDir, outDir);
    const parsed: CentralRecord[] = readCentralDirectory(readFileSync(outPath));
    console.log(`rinka: ${outPath}（${parsed.length}ファイル: ${parsed.map((r) => `${r.name}(${r.size}B)`).join(", ")}）`);
    console.log("rinka: 署名前の素xpiです。AMO(unlisted)で署名するか、開発環境以外では未署名xpiは恒久installできません");
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
