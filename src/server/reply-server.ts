import { createSocket } from "node:dgram";
import type { RemoteInfo, Socket } from "node:dgram";

import type { DebugSink } from "../protocol/debug.ts";
import {
  OperationError,
  ProtocolError,
  ServerClosedError,
  errorMessage,
} from "../protocol/errors.ts";
import {
  decodeMessage,
  encodeReply,
  MAX_DATAGRAM_BYTES,
  MESSAGE_TYPE,
  REPLY_STATUS,
  RemoteRef,
} from "../protocol/message.ts";
import type { ReplyStatus, RequestMessage } from "../protocol/message.ts";

export interface ClientEndpoint {
  address: string;
  port: number;
}

export interface IncomingRequest {
  requestId: number;
  remoteRef: RemoteRef;
  operationId: number;
  arguments: Buffer;
  client: ClientEndpoint;
  receivedAt: number;
}

export interface OperationContext {
  request: IncomingRequest;
  server: ReplyServer;
}

export type OperationHandler = (
  args: Buffer,
  context: OperationContext,
) => Promise<Buffer> | Buffer;

export interface OperationDefinition {
  id: number;
  name: string;
  handler: OperationHandler;
}

export type ServerLogEventKind =
  | "listen"
  | "close"
  | "reply"
  | "duplicate"
  | "ignored"
  | "error";

export interface ServerLogEvent {
  kind: ServerLogEventKind;
  message: string;
  requestId?: number;
  operationId?: number;
  operationName?: string;
  client?: ClientEndpoint;
  durationMs?: number;
  status?: ReplyStatus;
}

export type ServerLogger = (event: ServerLogEvent) => void;

export interface ReplyServerOptions {
  port: number;
  /** Padrão: 0.0.0.0 (todas as interfaces, para o colega conseguir conectar). */
  host?: string;
  /** Identidade deste objeto; o cliente coloca em RemoteRef.objectId. */
  objectId?: number;
  /** Quanto tempo manter respostas no cache de duplicatas (padrão: 60 s). */
  duplicateWindowMs?: number;
  logger?: ServerLogger;
  onDebug?: DebugSink;
}

interface CachedReply {
  status: ReplyStatus;
  result: Buffer;
  expiresAt: number;
}

interface Waiter {
  resolve: (request: IncomingRequest) => void;
  reject: (error: Error) => void;
}

/** Reserva espaço para o cabeçalho da resposta ao checar o tamanho do resultado. */
const MAX_RESULT_BYTES = MAX_DATAGRAM_BYTES - 128;

export class ReplyServer {
  #host: string;
  #port: number;
  #objectId: number;
  #duplicateWindowMs: number;
  #logger: ServerLogger;
  #onDebug: DebugSink | undefined;

  #socket: Socket | undefined;
  #bound: { address: string; port: number } | undefined;
  #running = false;
  #dispatchLoop: Promise<void> | undefined;

  #operations = new Map<number, OperationDefinition>();
  #queue: IncomingRequest[] = [];
  #waiters: Waiter[] = [];
  #pending = new Set<string>();
  #cache = new Map<string, CachedReply>();

  constructor(options: ReplyServerOptions) {
    if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65_535) {
      throw new Error(`porta inválida: ${options.port}`);
    }
    this.#port = options.port;
    this.#host = options.host ?? "0.0.0.0";
    this.#objectId = options.objectId ?? 1;
    this.#duplicateWindowMs = options.duplicateWindowMs ?? 60_000;
    this.#logger = options.logger ?? (() => {});
    this.#onDebug = options.onDebug;
  }

  get objectId(): number {
    return this.#objectId;
  }

  get address(): { address: string; port: number } {
    if (!this.#bound) throw new Error("servidor não iniciado");
    return this.#bound;
  }

  get running(): boolean {
    return this.#running;
  }

  register(definition: OperationDefinition): this;
  register(id: number, name: string, handler: OperationHandler): this;
  register(
    definitionOrId: OperationDefinition | number,
    name?: string,
    handler?: OperationHandler,
  ): this {
    let definition: OperationDefinition;

    if (typeof definitionOrId === "number") {
      if (name === undefined || handler === undefined) {
        throw new Error("register(id, name, handler) precisa dos três argumentos");
      }
      definition = { id: definitionOrId, name, handler };
    } else {
      definition = definitionOrId;
    }

    if (this.#operations.has(definition.id)) {
      throw new Error(`operação ${definition.id} já registrada`);
    }
    this.#operations.set(definition.id, definition);
    return this;
  }

  /** Operações disponíveis: id -> nome (para logs e mensagens de erro). */
  operations(): ReadonlyMap<number, string> {
    const map = new Map<number, string>();
    for (const [id, definition] of this.#operations) map.set(id, definition.name);
    return map;
  }

  async start(): Promise<{ address: string; port: number }> {
    if (this.#socket) throw new Error("servidor já iniciado");

    const socket = createSocket("udp4");
    this.#socket = socket;

    socket.on("message", (data: Buffer, info: RemoteInfo) => {
      this.#onDatagram(data, info);
    });
    socket.on("error", (error: Error) => {
      this.#logger({ kind: "error", message: `socket: ${error.message}` });
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        socket.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        socket.off("error", onError);
        resolve();
      };
      socket.once("error", onError);
      socket.once("listening", onListening);
      socket.bind(this.#port, this.#host);
    });

    const address = socket.address();
    this.#bound = { address: address.address, port: address.port };
    this.#running = true;
    this.#dispatchLoop = this.#loop();

    this.#logger({
      kind: "listen",
      message: `escutando em ${this.#bound.address}:${this.#bound.port} (objectId=${this.#objectId})`,
    });

    return this.#bound;
  }

  async stop(): Promise<void> {
    if (!this.#running && !this.#socket) return;

    this.#running = false;

    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) waiter.reject(new ServerClosedError());

    if (this.#dispatchLoop) {
      await this.#dispatchLoop.catch(() => {});
      this.#dispatchLoop = undefined;
    }

    const socket = this.#socket;
    this.#socket = undefined;
    this.#bound = undefined;

    if (socket) {
      await new Promise<void>((resolve) => {
        try {
          socket.close(() => resolve());
        } catch {
          resolve();
        }
      });
    }

    this.#queue.length = 0;
    this.#pending.clear();
    this.#cache.clear();

    this.#logger({ kind: "close", message: "servidor encerrado" });
  }

  /**
   * Primitiva do servidor: devolve a próxima requisição recebida.
   * Fica bloqueada (Promise pendente) até chegar um datagrama de requisição.
   */
  getRequest(): Promise<IncomingRequest> {
    const next = this.#queue.shift();
    if (next) return Promise.resolve(next);
    if (!this.#running) return Promise.reject(new ServerClosedError());

    return new Promise<IncomingRequest>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  /**
   * Primitiva do servidor: envia a resposta ao cliente que fez a requisição.
   * Encerra o ciclo e desbloqueia o doOperation() do cliente.
   */
  async sendReply(
    result: Buffer,
    client: ClientEndpoint,
    requestId: number,
    status: ReplyStatus = REPLY_STATUS.OK,
  ): Promise<void> {
    const socket = this.#socket;
    if (!socket) throw new Error("servidor não está em execução");

    const datagram = encodeReply({ requestId, result, status });

    this.#onDebug?.({
      direction: "tx",
      peer: `${client.address}:${client.port}`,
      bytes: datagram,
    });

    await new Promise<void>((resolve, reject) => {
      socket.send(datagram, client.port, client.address, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  /* ---------------------------------------------------------------- */

  async #loop(): Promise<void> {
    while (this.#running) {
      let request: IncomingRequest;
      try {
        request = await this.getRequest();
      } catch {
        return; // servidor encerrado
      }
      // Executa em paralelo: uma operação lenta não bloqueia as demais.
      void this.#execute(request);
    }
  }

  #onDatagram(data: Buffer, info: RemoteInfo): void {
    const client: ClientEndpoint = { address: info.address, port: info.port };

    this.#onDebug?.({
      direction: "rx",
      peer: `${client.address}:${client.port}`,
      bytes: data,
    });

    let message: RequestMessage;
    try {
      const decoded = decodeMessage(data);
      if (decoded.messageType !== MESSAGE_TYPE.REQUEST) {
        this.#ignored("resposta recebida no servidor (messageType=1)", client);
        return;
      }
      message = decoded;
    } catch (error) {
      this.#ignored(`datagrama inválido descartado: ${errorMessage(error)}`, client);
      return;
    }

    if (message.remoteRef.objectId !== this.#objectId) {
      this.#ignored(
        `objectId ${message.remoteRef.objectId} não existe aqui (este servidor é o ${this.#objectId})`,
        client,
        message.requestId,
        message.operationId,
      );
      return;
    }

    const key = cacheKey(client, message.remoteRef.objectId, message.requestId);

    const cached = this.#cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
      this.#logger({
        kind: "duplicate",
        message: "retransmissão: reenviando resposta do cache (operação NÃO foi executada de novo)",
        requestId: message.requestId,
        operationId: message.operationId,
        operationName: this.#operationName(message.operationId),
        client,
        status: cached.status,
      });
      void this.sendReply(cached.result, client, message.requestId, cached.status).catch(
        (error: unknown) => {
          this.#logger({ kind: "error", message: `falha no reenvio: ${errorMessage(error)}`, client });
        },
      );
      return;
    }
    if (cached) this.#cache.delete(key);

    if (this.#pending.has(key)) {
      this.#logger({
        kind: "duplicate",
        message: "requisição duplicada enquanto a original ainda executa: ignorada",
        requestId: message.requestId,
        operationId: message.operationId,
        operationName: this.#operationName(message.operationId),
        client,
      });
      return;
    }

    this.#pending.add(key);

    const request: IncomingRequest = {
      requestId: message.requestId,
      remoteRef: message.remoteRef,
      operationId: message.operationId,
      arguments: message.arguments,
      client,
      receivedAt: Date.now(),
    };

    const waiter = this.#waiters.shift();
    if (waiter) waiter.resolve(request);
    else this.#queue.push(request);
  }

  async #execute(request: IncomingRequest): Promise<void> {
    const key = cacheKey(request.client, request.remoteRef.objectId, request.requestId);
    const startedAt = performance.now();

    let status: ReplyStatus = REPLY_STATUS.OK;
    let result: Buffer;

    try {
      const definition = this.#operations.get(request.operationId);
      if (!definition) {
        const available = [...this.#operations.keys()].sort((a, b) => a - b).join(", ");
        throw new OperationError(
          `operação ${request.operationId} não registrada (disponíveis: ${available || "nenhuma"})`,
        );
      }

      result = await definition.handler(request.arguments, { request, server: this });

      if (!Buffer.isBuffer(result)) {
        throw new OperationError("handler devolveu um valor que não é Buffer");
      }
      if (result.length > MAX_RESULT_BYTES) {
        throw new OperationError(
          `resposta de ${result.length} bytes excede o limite de ${MAX_RESULT_BYTES} bytes do UDP`,
        );
      }
    } catch (error) {
      status = REPLY_STATUS.APPLICATION_ERROR;
      result = Buffer.from(this.#describeError(error), "utf8");
    }

    const durationMs = performance.now() - startedAt;

    // Guarda no cache ANTES de enviar: se a resposta se perder na rede, uma
    // retransmissão do cliente recebe este mesmo resultado (at-most-once).
    this.#cache.set(key, {
      status,
      result,
      expiresAt: Date.now() + this.#duplicateWindowMs,
    });
    this.#pending.delete(key);
    this.#sweepCache();

    this.#logger({
      kind: "reply",
      message: status === REPLY_STATUS.OK ? "operação concluída" : `erro de aplicação: ${result.toString("utf8")}`,
      requestId: request.requestId,
      operationId: request.operationId,
      operationName: this.#operationName(request.operationId),
      client: request.client,
      durationMs,
      status,
    });

    if (!this.#running) return;

    try {
      await this.sendReply(result, request.client, request.requestId, status);
    } catch (error) {
      this.#logger({
        kind: "error",
        message: `falha ao enviar resposta: ${errorMessage(error)}`,
        requestId: request.requestId,
        client: request.client,
      });
    }
  }

  #describeError(error: unknown): string {
    if (error instanceof OperationError) return error.message;
    if (error instanceof ProtocolError) return `argumentos inválidos: ${error.message}`;
    return `erro interno: ${errorMessage(error)}`;
  }

  #operationName(operationId: number): string {
    return this.#operations.get(operationId)?.name ?? `operação-${operationId}`;
  }

  #ignored(
    message: string,
    client: ClientEndpoint,
    requestId?: number,
    operationId?: number,
  ): void {
    this.#logger({ kind: "ignored", message, client, requestId, operationId });
  }

  #sweepCache(): void {
    if (this.#cache.size < 256) return;
    const now = Date.now();
    for (const [key, cached] of this.#cache) {
      if (cached.expiresAt <= now) this.#cache.delete(key);
    }
  }
}

function cacheKey(client: ClientEndpoint, objectId: number, requestId: number): string {
  return `${client.address}:${client.port}#${objectId}#${requestId}`;
}
