export class ProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtocolError";
  }
}

/** Erro de aplicação lançado por um handler de operação. */
export class OperationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OperationError";
  }
}

/** O servidor executou a operação, mas ela terminou em erro. */
export class RemoteError extends Error {
  readonly operationId: number;
  readonly remoteMessage: string;

  constructor(operationId: number, remoteMessage: string) {
    super(`operação ${operationId} falhou no servidor: ${remoteMessage}`);
    this.name = "RemoteError";
    this.operationId = operationId;
    this.remoteMessage = remoteMessage;
  }
}

/** Nenhuma resposta chegou dentro do prazo, depois de todas as tentativas. */
export class RequestTimeoutError extends Error {
  readonly requestId: number;
  readonly attempts: number;
  readonly timeoutMs: number;

  constructor(requestId: number, attempts: number, timeoutMs: number) {
    super(
      `sem resposta para requestId=${requestId} após ${attempts} tentativa(s) de ${timeoutMs} ms`,
    );
    this.name = "RequestTimeoutError";
    this.requestId = requestId;
    this.attempts = attempts;
    this.timeoutMs = timeoutMs;
  }
}

/** O servidor foi encerrado enquanto alguém aguardava em getRequest(). */
export class ServerClosedError extends Error {
  constructor() {
    super("servidor encerrado");
    this.name = "ServerClosedError";
  }
}

/** Mensagem legível de um valor lançado (que pode não ser Error). */
export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
