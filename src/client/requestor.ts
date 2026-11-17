import { randomInt } from "node:crypto";
import { createSocket } from "node:dgram";
import type { RemoteInfo } from "node:dgram";
import { isIP } from "node:net";

import type { DebugSink } from "../protocol/debug.ts";
import { ProtocolError, RemoteError, RequestTimeoutError } from "../protocol/errors.ts";
import {
  decodeMessage,
  encodeRequest,
  MAX_DATAGRAM_BYTES,
  MAX_REQUEST_ID,
  MESSAGE_TYPE,
  REPLY_STATUS,
} from "../protocol/message.ts";
import type { RemoteRef, ReplyMessage } from "../protocol/message.ts";

const DEFAULT_TIMEOUT_MS = 500;
const DEFAULT_RETRANSMISSIONS = 2;

export interface RequestorOptions {
  /** Quanto tempo esperar por cada tentativa (padrão: 500 ms). */
  timeoutMs?: number;
  /** Quantas vezes reenviar a mesma requisição (padrão: 2). */
  retransmissions?: number;
  onDebug?: DebugSink;
}

export interface DoOperationOptions {
  timeoutMs?: number;
  retransmissions?: number;
  /** Só para testes de interoperabilidade: força um requestId fixo. */
  requestId?: number;
}

export class Requestor {
  #timeoutMs: number;
  #retransmissions: number;
  #onDebug: DebugSink | undefined;
  #lastRequestId: number;

  constructor(options: RequestorOptions = {}) {
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#retransmissions = options.retransmissions ?? DEFAULT_RETRANSMISSIONS;
    this.#onDebug = options.onDebug;

    if (!Number.isFinite(this.#timeoutMs) || this.#timeoutMs <= 0) {
      throw new Error(`timeoutMs inválido: ${this.#timeoutMs}`);
    }
    if (!Number.isInteger(this.#retransmissions) || this.#retransmissions < 0) {
      throw new Error(`retransmissions inválido: ${this.#retransmissions}`);
    }

    this.#lastRequestId = randomInt(1, MAX_REQUEST_ID);
  }

  /**
   * Invoca uma operação remota e devolve o vetor de bytes da resposta.
   *
   * @throws {RemoteError}          o servidor respondeu com status de erro
   * @throws {RequestTimeoutError}  nenhuma resposta chegou
   * @throws {ProtocolError}        argumentos grandes demais / inválidos
   */
  async doOperation(
    remoteRef: RemoteRef,
    operationId: number,
    args: Buffer = Buffer.alloc(0),
    options: DoOperationOptions = {},
  ): Promise<Buffer> {
    if (args.length > MAX_DATAGRAM_BYTES) {
      throw new ProtocolError(
        `argumentos de ${args.length} bytes excedem o máximo de ${MAX_DATAGRAM_BYTES} bytes do UDP`,
      );
    }

    const timeoutMs = options.timeoutMs ?? this.#timeoutMs;
    const retransmissions = options.retransmissions ?? this.#retransmissions;
    const requestId = options.requestId ?? this.#nextRequestId();

    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error(`timeoutMs inválido: ${timeoutMs}`);
    }
    if (!Number.isInteger(retransmissions) || retransmissions < 0) {
      throw new Error(`retransmissions inválido: ${retransmissions}`);
    }

    const datagram = encodeRequest({
      requestId,
      remoteRef,
      operationId,
      arguments: args,
    });

    const socket = createSocket("udp4");

    return await new Promise<Buffer>((resolve, reject) => {
      let attempt = 0;
      let settled = false;
      let timer: NodeJS.Timeout | undefined;

      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) {
          clearTimeout(timer);
          timer = undefined;
        }
        try {
          socket.close();
        } catch {
          // socket já estava fechado
        }
        action();
      };

      const fail = (error: unknown): void => {
        settle(() => reject(error instanceof Error ? error : new Error(String(error))));
      };

      const succeed = (result: Buffer): void => {
        settle(() => resolve(result));
      };

      const onTimeout = (): void => {
        if (settled) return;
        if (attempt <= retransmissions) {
          sendOnce();
          return;
        }
        fail(new RequestTimeoutError(requestId, attempt, timeoutMs));
      };

      const sendOnce = (): void => {
        if (settled) return;
        attempt += 1;
        this.#onDebug?.({
          direction: "tx",
          peer: remoteRef.toString(),
          bytes: datagram,
          attempt,
        });
        socket.send(datagram, remoteRef.port, remoteRef.host, (error) => {
          if (error) fail(error);
        });
        timer = setTimeout(onTimeout, timeoutMs);
      };

      socket.on("message", (data, info) => {
        if (settled || !isExpectedPeer(remoteRef, info)) return;

        this.#onDebug?.({ direction: "rx", peer: `${info.address}:${info.port}`, bytes: data });

        let message: ReplyMessage;
        try {
          const decoded = decodeMessage(data);
          if (decoded.messageType !== MESSAGE_TYPE.REPLY) return;
          message = decoded;
        } catch {
          // Lixo na rede ou resposta de outra implementação: ignora e continua esperando.
          return;
        }

        if (message.requestId !== requestId) return;

        if (message.status === REPLY_STATUS.APPLICATION_ERROR) {
          fail(new RemoteError(operationId, message.result.toString("utf8")));
          return;
        }

        succeed(Buffer.from(message.result));
      });

      socket.on("error", fail);

      try {
        sendOnce();
      } catch (error) {
        fail(error);
      }
    });
  }

  #nextRequestId(): number {
    this.#lastRequestId = (this.#lastRequestId % MAX_REQUEST_ID) + 1;
    return this.#lastRequestId;
  }
}

function isExpectedPeer(remoteRef: RemoteRef, info: RemoteInfo): boolean {
  if (info.port !== remoteRef.port) return false;
  if (isIP(remoteRef.host) === 4) return info.address === remoteRef.host;
  return true;
}
