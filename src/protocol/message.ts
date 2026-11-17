import { Reader, Writer } from "./codec.ts";
import { ProtocolError } from "./errors.ts";

export const MESSAGE_TYPE = {
  REQUEST: 0,
  REPLY: 1,
} as const;

export const REPLY_STATUS = {
  OK: 0,
  APPLICATION_ERROR: 1,
} as const;

export type ReplyStatus = (typeof REPLY_STATUS)[keyof typeof REPLY_STATUS];

/** Maior datagrama UDP possível (payload máximo do IPv4). */
export const MAX_DATAGRAM_BYTES = 65_507;

export const MAX_REQUEST_ID = 0x7fff_ffff;

/**
 * Referência para um objeto remoto: onde ele está (host/porta) e qual objeto é.
 * Equivale ao `RemoteRef` do material (Coulouris).
 */
export class RemoteRef {
  readonly host: string;
  readonly port: number;
  readonly objectId: number;

  constructor(host: string, port: number, objectId = 1) {
    if (host.length === 0) throw new ProtocolError("RemoteRef.host não pode ser vazio");
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new ProtocolError(`RemoteRef.port inválida: ${port}`);
    }
    if (!Number.isInteger(objectId) || objectId < 0) {
      throw new ProtocolError(`RemoteRef.objectId inválido: ${objectId}`);
    }
    this.host = host;
    this.port = port;
    this.objectId = objectId;
  }

  static local(port: number, objectId = 1): RemoteRef {
    return new RemoteRef("127.0.0.1", port, objectId);
  }

  equals(other: RemoteRef): boolean {
    return (
      this.host === other.host &&
      this.port === other.port &&
      this.objectId === other.objectId
    );
  }

  toString(): string {
    return `${this.host}:${this.port}/${this.objectId}`;
  }

  write(writer: Writer): void {
    writer.string(this.host);
    writer.int32(this.port);
    writer.int32(this.objectId);
  }

  static read(reader: Reader): RemoteRef {
    return new RemoteRef(reader.string(), reader.int32(), reader.int32());
  }
}

export interface RequestMessage {
  messageType: typeof MESSAGE_TYPE.REQUEST;
  requestId: number;
  remoteRef: RemoteRef;
  operationId: number;
  arguments: Buffer;
}

export interface ReplyMessage {
  messageType: typeof MESSAGE_TYPE.REPLY;
  requestId: number;
  status: ReplyStatus;
  result: Buffer;
}

export type Message = RequestMessage | ReplyMessage;

export interface NewRequest {
  requestId: number;
  remoteRef: RemoteRef;
  operationId: number;
  arguments: Buffer;
}

export interface NewReply {
  requestId: number;
  result: Buffer;
  status?: ReplyStatus;
}

/** Serializa uma mensagem de REQUISIÇÃO exatamente no formato do slide. */
export function encodeRequest(request: NewRequest): Buffer {
  if (
    !Number.isInteger(request.requestId) ||
    request.requestId < 0 ||
    request.requestId > MAX_REQUEST_ID
  ) {
    throw new ProtocolError(`requestId inválido: ${request.requestId}`);
  }

  const writer = new Writer();
  writer.int32(MESSAGE_TYPE.REQUEST);
  writer.int32(request.requestId);
  request.remoteRef.write(writer);
  writer.int32(request.operationId);
  writer.bytes(request.arguments);

  return checkDatagram(writer.toBuffer());
}

/** Serializa uma mensagem de RESPOSTA. */
export function encodeReply(reply: NewReply): Buffer {
  const writer = new Writer();
  writer.int32(MESSAGE_TYPE.REPLY);
  writer.int32(reply.requestId);
  writer.int32(reply.status ?? REPLY_STATUS.OK);
  writer.bytes(reply.result);

  return checkDatagram(writer.toBuffer());
}

/** Decodifica qualquer datagrama do protocolo (requisição ou resposta). */
export function decodeMessage(datagram: Buffer): Message {
  if (datagram.length < 4) {
    throw new ProtocolError(`datagrama curto demais: ${datagram.length} byte(s)`);
  }

  const reader = new Reader(datagram);
  const messageType = reader.int32();

  if (messageType === MESSAGE_TYPE.REQUEST) {
    const requestId = reader.int32();
    const remoteRef = RemoteRef.read(reader);
    const operationId = reader.int32();
    const args = reader.bytes();
    reader.expectEnd();
    return { messageType: MESSAGE_TYPE.REQUEST, requestId, remoteRef, operationId, arguments: args };
  }

  if (messageType === MESSAGE_TYPE.REPLY) {
    const requestId = reader.int32();
    const status = reader.int32();
    if (status !== REPLY_STATUS.OK && status !== REPLY_STATUS.APPLICATION_ERROR) {
      throw new ProtocolError(`status de resposta desconhecido: ${status}`);
    }
    const result = reader.bytes();
    reader.expectEnd();
    return { messageType: MESSAGE_TYPE.REPLY, requestId, status, result };
  }

  throw new ProtocolError(`messageType desconhecido: ${messageType}`);
}

/** Versão tolerante: devolve undefined em vez de lançar para lixo na rede. */
export function tryDecodeMessage(datagram: Buffer): Message | undefined {
  try {
    return decodeMessage(datagram);
  } catch {
    return undefined;
  }
}

export function isRequest(message: Message): message is RequestMessage {
  return message.messageType === MESSAGE_TYPE.REQUEST;
}

export function isReply(message: Message): message is ReplyMessage {
  return message.messageType === MESSAGE_TYPE.REPLY;
}

function checkDatagram(datagram: Buffer): Buffer {
  if (datagram.length > MAX_DATAGRAM_BYTES) {
    throw new ProtocolError(
      `datagrama de ${datagram.length} bytes excede o máximo de ${MAX_DATAGRAM_BYTES} bytes do UDP`,
    );
  }
  return datagram;
}
