/**
 * rinka native-host/src/native.ts — Native Messaging のフレーミング。
 *
 * Firefox仕様: stdout/stdin は「4byte リトルエンディアン uint32 長さ前置き + UTF-8 JSON」。
 * 1フレーム上限は32MB（screenshotも1メッセージで流す。これを超える相手は
 * 壊れた相手と見做して拒否）。
 * 構文規約: クラスでなく単一ファイルのclosureで閉じた可変状態を持つ。
 */

export const NATIVE_FRAME_MAX = 32 * 1024 * 1024;

export const encodeNativeFrame = (json: string): Buffer => {
  const body = Buffer.from(json, "utf8");
  if (body.length > NATIVE_FRAME_MAX) {
    throw new Error(`rinka: フレームが32MB上限を超えました（${body.length}バイト）`);
  }
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
};

/** stdin への data chunk を積み、完全フレームが揃った分だけ文字列で返す。 */
export type NativeReader = {
  push: (chunk: Buffer) => string[];
};

export const createNativeReader = (): NativeReader => {
  let buf = Buffer.alloc(0);
  return {
    push: (chunk: Buffer): string[] => {
      buf = buf.length === 0 ? chunk : Buffer.concat([buf, chunk]);
      const out: string[] = [];
      while (buf.length >= 4) {
        const len = buf.readUInt32LE(0);
        if (len > NATIVE_FRAME_MAX) {
          throw new Error(`rinka: フレーム長${len}が32MB上限を超えます（壊れた相手と見做して拒否）`);
        }
        if (buf.length < 4 + len) break; // まだ未完成。続きを待つ
        out.push(buf.subarray(4, 4 + len).toString("utf8"));
        buf = buf.subarray(4 + len);
      }
      return out;
    },
  };
};
