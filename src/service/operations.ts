import { Reader, Writer } from "../protocol/codec.ts";
import { OperationError } from "../protocol/errors.ts";
import type { OperationDefinition, ReplyServer } from "../server/reply-server.ts";

export const Operation = {
  Ping: 0,
  Add: 1,
  Sub: 2,
  Mul: 3,
  Div: 4,
  Echo: 5,
  Upper: 6,
  Sum: 7,
  Sleep: 8,
  ServerTime: 9,
} as const;

export type OperationId = (typeof Operation)[keyof typeof Operation];

export const OPERATION_NAMES: Readonly<Record<number, string>> = {
  [Operation.Ping]: "ping",
  [Operation.Add]: "add",
  [Operation.Sub]: "sub",
  [Operation.Mul]: "mul",
  [Operation.Div]: "div",
  [Operation.Echo]: "echo",
  [Operation.Upper]: "upper",
  [Operation.Sum]: "sum",
  [Operation.Sleep]: "sleep",
  [Operation.ServerTime]: "serverTime",
};

export function operationName(operationId: number): string {
  return OPERATION_NAMES[operationId] ?? `operação-${operationId}`;
}

export function operationList(): string {
  return Object.entries(OPERATION_NAMES)
    .map(([id, name]) => `${name}(${id})`)
    .join(", ");
}

/* ------------------------------------------------------------------ */
/* Marshalling de argumentos (aplicação)                               */
/* ------------------------------------------------------------------ */

export function encodeInt32(value: number): Buffer {
  return new Writer().int32(value).toBuffer();
}

export function decodeInt32(buffer: Buffer): number {
  const reader = new Reader(buffer);
  const value = reader.int32();
  reader.expectEnd();
  return value;
}

export function encodeDouble(value: number): Buffer {
  return new Writer().float64(value).toBuffer();
}

export function decodeDouble(buffer: Buffer): number {
  const reader = new Reader(buffer);
  const value = reader.float64();
  reader.expectEnd();
  return value;
}

export function encodeDoublePair(first: number, second: number): Buffer {
  return new Writer().float64(first).float64(second).toBuffer();
}

export function decodeDoublePair(buffer: Buffer): [number, number] {
  const reader = new Reader(buffer);
  const first = reader.float64();
  const second = reader.float64();
  reader.expectEnd();
  return [first, second];
}

/** int32 com a quantidade + os valores. */
export function encodeDoubles(values: readonly number[]): Buffer {
  const writer = new Writer().int32(values.length);
  for (const value of values) writer.float64(value);
  return writer.toBuffer();
}

export function decodeDoubles(buffer: Buffer): number[] {
  const reader = new Reader(buffer);
  const count = reader.int32();
  if (count < 0 || count > 10_000) {
    throw new OperationError(`quantidade inválida de valores: ${count}`);
  }
  const values: number[] = [];
  for (let index = 0; index < count; index += 1) values.push(reader.float64());
  reader.expectEnd();
  return values;
}

export function encodeText(value: string): Buffer {
  return new Writer().string(value).toBuffer();
}

export function decodeText(buffer: Buffer): string {
  const reader = new Reader(buffer);
  const value = reader.string();
  reader.expectEnd();
  return value;
}

function expectNoArguments(args: Buffer): void {
  if (args.length !== 0) {
    throw new OperationError(`${args.length} byte(s) de argumento onde nenhum era esperado`);
  }
}

/* ------------------------------------------------------------------ */
/* Handlers                                                            */
/* ------------------------------------------------------------------ */

export const OPERATIONS: readonly OperationDefinition[] = [
  {
    id: Operation.Ping,
    name: "ping",
    handler: (args, context) => {
      expectNoArguments(args);
      return encodeText(
        `pong de ${context.request.remoteRef} em ${new Date().toISOString()}`,
      );
    },
  },
  {
    id: Operation.Add,
    name: "add",
    handler: (args) => {
      const [a, b] = decodeDoublePair(args);
      return encodeDouble(a + b);
    },
  },
  {
    id: Operation.Sub,
    name: "sub",
    handler: (args) => {
      const [a, b] = decodeDoublePair(args);
      return encodeDouble(a - b);
    },
  },
  {
    id: Operation.Mul,
    name: "mul",
    handler: (args) => {
      const [a, b] = decodeDoublePair(args);
      return encodeDouble(a * b);
    },
  },
  {
    id: Operation.Div,
    name: "div",
    handler: (args) => {
      const [a, b] = decodeDoublePair(args);
      if (b === 0) throw new OperationError("divisão por zero");
      const result = a / b;
      if (!Number.isFinite(result)) throw new OperationError("resultado não finito");
      return encodeDouble(result);
    },
  },
  {
    id: Operation.Echo,
    name: "echo",
    handler: (args) => encodeText(decodeText(args)),
  },
  {
    id: Operation.Upper,
    name: "upper",
    handler: (args) => encodeText(decodeText(args).toLocaleUpperCase("pt-BR")),
  },
  {
    id: Operation.Sum,
    name: "sum",
    handler: (args) => {
      const values = decodeDoubles(args);
      return encodeDouble(values.reduce((total, value) => total + value, 0));
    },
  },
  {
    id: Operation.Sleep,
    name: "sleep",
    handler: async (args) => {
      const requested = decodeInt32(args);
      if (requested < 0 || requested > 30_000) {
        throw new OperationError(`tempo inválido: ${requested} ms (0..30000)`);
      }
      await new Promise((resolve) => setTimeout(resolve, requested));
      return encodeText(`dormiu ${requested} ms`);
    },
  },
  {
    id: Operation.ServerTime,
    name: "serverTime",
    handler: (args) => {
      expectNoArguments(args);
      return encodeText(new Date().toISOString());
    },
  },
];

/** Registra todas as operações de exemplo em um servidor. */
export function registerOperations(server: ReplyServer): void {
  for (const definition of OPERATIONS) server.register(definition);
}
