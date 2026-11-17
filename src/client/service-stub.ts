import type { RemoteRef } from "../protocol/message.ts";
import {
  decodeDouble,
  decodeText,
  encodeDoublePair,
  encodeDoubles,
  encodeInt32,
  encodeText,
  Operation,
} from "../service/operations.ts";
import type { DoOperationOptions } from "./requestor.ts";
import { Requestor } from "./requestor.ts";

export class OperationsStub {
  readonly remoteRef: RemoteRef;
  #requestor: Requestor;

  constructor(remoteRef: RemoteRef, requestor: Requestor = new Requestor()) {
    this.remoteRef = remoteRef;
    this.#requestor = requestor;
  }

  /** Acesso cru às primitivas, útil para depurar a interoperabilidade. */
  callRaw(operationId: number, args: Buffer = Buffer.alloc(0), options?: DoOperationOptions): Promise<Buffer> {
    return this.#requestor.doOperation(this.remoteRef, operationId, args, options ?? {});
  }

  async ping(): Promise<string> {
    return decodeText(await this.callRaw(Operation.Ping));
  }

  async add(a: number, b: number): Promise<number> {
    return decodeDouble(await this.callRaw(Operation.Add, encodeDoublePair(a, b)));
  }

  async sub(a: number, b: number): Promise<number> {
    return decodeDouble(await this.callRaw(Operation.Sub, encodeDoublePair(a, b)));
  }

  async mul(a: number, b: number): Promise<number> {
    return decodeDouble(await this.callRaw(Operation.Mul, encodeDoublePair(a, b)));
  }

  async div(a: number, b: number): Promise<number> {
    return decodeDouble(await this.callRaw(Operation.Div, encodeDoublePair(a, b)));
  }

  async echo(text: string): Promise<string> {
    return decodeText(await this.callRaw(Operation.Echo, encodeText(text)));
  }

  async upper(text: string): Promise<string> {
    return decodeText(await this.callRaw(Operation.Upper, encodeText(text)));
  }

  async sum(values: readonly number[]): Promise<number> {
    return decodeDouble(await this.callRaw(Operation.Sum, encodeDoubles(values)));
  }

  async sleep(ms: number): Promise<string> {
    return decodeText(await this.callRaw(Operation.Sleep, encodeInt32(ms)));
  }

  async serverTime(): Promise<string> {
    return decodeText(await this.callRaw(Operation.ServerTime));
  }
}
