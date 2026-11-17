import assert from "node:assert/strict";
import test from "node:test";

import { Reader, Writer } from "../src/protocol/codec.ts";
import { ProtocolError } from "../src/protocol/errors.ts";

test("codec: ida e volta dos tipos primitivos", () => {
  const buffer = new Writer()
    .uint8(0xab)
    .int32(-123_456)
    .float64(3.14159)
    .string("olá, mundo")
    .bytes(Buffer.from([1, 2, 3, 255]))
    .toBuffer();

  const reader = new Reader(buffer);
  assert.equal(reader.uint8(), 0xab);
  assert.equal(reader.int32(), -123_456);
  assert.equal(reader.float64(), 3.14159);
  assert.equal(reader.string(), "olá, mundo");
  assert.deepEqual(reader.bytes(), Buffer.from([1, 2, 3, 255]));
  reader.expectEnd();
  assert.equal(reader.remaining, 0);
});

test("codec: bytes são escritos em big-endian", () => {
  const buffer = new Writer().int32(1).float64(1).toBuffer();
  assert.equal(buffer.subarray(0, 4).toString("hex"), "00000001");
  assert.equal(buffer.subarray(4, 12).toString("hex"), "3ff0000000000000");
});

test("codec: int32 fora do intervalo é rejeitado", () => {
  assert.throws(() => new Writer().int32(0x8000_0000), ProtocolError);
  assert.throws(() => new Writer().int32(1.5), ProtocolError);
  assert.throws(() => new Writer().int32(-0x8000_0001), ProtocolError);
});

test("codec: uint8 fora do intervalo é rejeitado", () => {
  assert.throws(() => new Writer().uint8(-1), ProtocolError);
  assert.throws(() => new Writer().uint8(256), ProtocolError);
});

test("codec: leitura truncada falha com ProtocolError", () => {
  assert.throws(() => new Reader(Buffer.from([0, 0])).int32(), ProtocolError);
  assert.throws(() => new Reader(Buffer.alloc(4)).float64(), /truncada/);
});

test("codec: tamanho negativo de string/bytes é rejeitado", () => {
  const negativeLength = Buffer.alloc(4);
  negativeLength.writeInt32BE(-1, 0);
  assert.throws(() => new Reader(negativeLength).string(), ProtocolError);
  assert.throws(() => new Reader(negativeLength).bytes(), ProtocolError);
});

test("codec: expectEnd detecta bytes sobrando", () => {
  const reader = new Reader(Buffer.from([0, 0, 0, 1, 0x41, 0x42]));
  assert.equal(reader.string(), "A");
  assert.throws(() => reader.expectEnd(), ProtocolError);
});
