import assert from "node:assert/strict";
import test from "node:test";

import { ProtocolError } from "../src/protocol/errors.ts";
import {
  decodeMessage,
  encodeReply,
  encodeRequest,
  MAX_DATAGRAM_BYTES,
  MESSAGE_TYPE,
  REPLY_STATUS,
  RemoteRef,
  tryDecodeMessage,
} from "../src/protocol/message.ts";

test("mensagem: requisição ida e volta", () => {
  const remoteRef = new RemoteRef("192.168.0.10", 4000, 7);
  const args = Buffer.from("argumentos \u0000 binários", "utf8");
  const buffer = encodeRequest({ requestId: 42, remoteRef, operationId: 5, arguments: args });
  const message = decodeMessage(buffer);

  assert.equal(message.messageType, MESSAGE_TYPE.REQUEST);
  assert.ok(message.messageType === MESSAGE_TYPE.REQUEST);
  assert.equal(message.requestId, 42);
  assert.equal(message.remoteRef.host, "192.168.0.10");
  assert.equal(message.remoteRef.port, 4000);
  assert.equal(message.remoteRef.objectId, 7);
  assert.equal(message.operationId, 5);
  assert.deepEqual(message.arguments, args);
});

test("mensagem: resposta ida e volta", () => {
  const result = Buffer.from("resultado", "utf8");
  const buffer = encodeReply({ requestId: 9, result });
  const message = decodeMessage(buffer);

  assert.equal(message.messageType, MESSAGE_TYPE.REPLY);
  assert.ok(message.messageType === MESSAGE_TYPE.REPLY);
  assert.equal(message.requestId, 9);
  assert.equal(message.status, REPLY_STATUS.OK);
  assert.deepEqual(message.result, result);
});

test("mensagem: resposta de erro ida e volta", () => {
  const buffer = encodeReply({
    requestId: 10,
    result: Buffer.from("divisão por zero"),
    status: REPLY_STATUS.APPLICATION_ERROR,
  });
  const message = decodeMessage(buffer);

  assert.ok(message.messageType === MESSAGE_TYPE.REPLY);
  assert.equal(message.status, REPLY_STATUS.APPLICATION_ERROR);
  assert.equal(message.result.toString("utf8"), "divisão por zero");
});

test("mensagem: layout de fio da requisição (contrato de interoperabilidade)", () => {
  const buffer = encodeRequest({
    requestId: 7,
    remoteRef: new RemoteRef("127.0.0.1", 4000, 1),
    operationId: 0,
    arguments: Buffer.alloc(0),
  });

  const expected = [
    "00000000", // messageType = 0 (Request)
    "00000007", // requestId = 7
    "00000009", // tamanho do host
    Buffer.from("127.0.0.1").toString("hex"), // host
    "00000fa0", // porta = 4000
    "00000001", // objectId = 1
    "00000000", // operationId = 0 (Ping)
    "00000000", // tamanho dos argumentos
  ].join("");

  assert.equal(buffer.toString("hex"), expected);
  assert.equal(buffer.length, 37);
});

test("mensagem: layout de fio da resposta", () => {
  const buffer = encodeReply({ requestId: 7, result: Buffer.from("oi", "utf8") });
  assert.equal(buffer.toString("hex"), "000000010000000700000000000000026f69");
});

test("mensagem: messageType desconhecido é rejeitado", () => {
  const buffer = Buffer.alloc(8);
  buffer.writeInt32BE(2, 0);
  assert.throws(() => decodeMessage(buffer), ProtocolError);
});

test("mensagem: status desconhecido é rejeitado", () => {
  const buffer = encodeReply({ requestId: 1, result: Buffer.alloc(0) });
  buffer.writeInt32BE(99, 8);
  assert.throws(() => decodeMessage(buffer), ProtocolError);
});

test("mensagem: datagrama truncado é rejeitado", () => {
  const buffer = encodeRequest({
    requestId: 1,
    remoteRef: new RemoteRef("127.0.0.1", 4000, 1),
    operationId: 0,
    arguments: Buffer.alloc(0),
  });

  assert.throws(() => decodeMessage(buffer.subarray(0, buffer.length - 1)), ProtocolError);
  assert.throws(() => decodeMessage(buffer.subarray(0, 2)), ProtocolError);
});

test("mensagem: lixo depois dos campos é rejeitado", () => {
  const buffer = Buffer.concat([encodeReply({ requestId: 1, result: Buffer.alloc(0) }), Buffer.from([0])]);
  assert.throws(() => decodeMessage(buffer), ProtocolError);
});

test("mensagem: tryDecodeMessage devolve undefined para lixo", () => {
  assert.equal(tryDecodeMessage(Buffer.from("isto não é uma mensagem")), undefined);
  assert.equal(tryDecodeMessage(Buffer.alloc(0)), undefined);
});

test("mensagem: requisição maior que o UDP é rejeitada", () => {
  assert.throws(
    () =>
      encodeRequest({
        requestId: 1,
        remoteRef: new RemoteRef("127.0.0.1", 4000, 1),
        operationId: 0,
        arguments: Buffer.alloc(MAX_DATAGRAM_BYTES),
      }),
    ProtocolError,
  );
});

test("mensagem: RemoteRef valida porta e objectId", () => {
  assert.throws(() => new RemoteRef("127.0.0.1", 70_000), ProtocolError);
  assert.throws(() => new RemoteRef("", 4000), ProtocolError);
  assert.throws(() => new RemoteRef("127.0.0.1", 4000, -1), ProtocolError);
});
