import { ProtocolError } from "./errors.ts";

const INT32_MIN = -0x8000_0000;
const INT32_MAX = 0x7fff_ffff;

/** Escritor sequencial de bytes. */
export class Writer {
  readonly chunks: Buffer[] = [];
  length = 0;

  uint8(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) {
      throw new ProtocolError(`uint8 fora do intervalo: ${value}`);
    }
    const buffer = Buffer.allocUnsafe(1);
    buffer.writeUInt8(value, 0);
    this.#push(buffer);
    return this;
  }

  int32(value: number): this {
    if (!Number.isInteger(value) || value < INT32_MIN || value > INT32_MAX) {
      throw new ProtocolError(`int32 fora do intervalo: ${value}`);
    }
    const buffer = Buffer.allocUnsafe(4);
    buffer.writeInt32BE(value, 0);
    this.#push(buffer);
    return this;
  }

  float64(value: number): this {
    const buffer = Buffer.allocUnsafe(8);
    buffer.writeDoubleBE(value, 0);
    this.#push(buffer);
    return this;
  }

  /** int32 com o tamanho + bytes UTF-8. */
  string(value: string): this {
    const data = Buffer.from(value, "utf8");
    this.int32(data.length);
    this.#push(data);
    return this;
  }

  /** int32 com o tamanho + bytes crus. */
  bytes(value: Buffer): this {
    this.int32(value.length);
    this.#push(value);
    return this;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks, this.length);
  }

  #push(buffer: Buffer): void {
    this.chunks.push(buffer);
    this.length += buffer.length;
  }
}

/** Leitor sequencial de bytes, com verificação de limites. */
export class Reader {
  #buffer: Buffer;
  #offset = 0;

  constructor(buffer: Buffer) {
    this.#buffer = buffer;
  }

  get remaining(): number {
    return this.#buffer.length - this.#offset;
  }

  get offset(): number {
    return this.#offset;
  }

  uint8(): number {
    this.#need(1);
    const value = this.#buffer.readUInt8(this.#offset);
    this.#offset += 1;
    return value;
  }

  int32(): number {
    this.#need(4);
    const value = this.#buffer.readInt32BE(this.#offset);
    this.#offset += 4;
    return value;
  }

  float64(): number {
    this.#need(8);
    const value = this.#buffer.readDoubleBE(this.#offset);
    this.#offset += 8;
    return value;
  }

  string(): string {
    const length = this.#length();
    const data = this.#buffer.subarray(this.#offset, this.#offset + length);
    this.#offset += length;
    return data.toString("utf8");
  }

  bytes(): Buffer {
    const length = this.#length();
    // Copia: o Buffer devolvido não deve compartilhar memória com o datagrama.
    const data = Buffer.from(this.#buffer.subarray(this.#offset, this.#offset + length));
    this.#offset += length;
    return data;
  }

  /** Garante que a mensagem terminou exatamente aqui (sem lixo no final). */
  expectEnd(): void {
    if (this.remaining !== 0) {
      throw new ProtocolError(
        `mensagem com ${this.remaining} byte(s) sobrando no final (offset ${this.#offset})`,
      );
    }
  }

  #length(): number {
    const length = this.int32();
    if (length < 0) throw new ProtocolError(`tamanho negativo: ${length}`);
    this.#need(length);
    return length;
  }

  #need(count: number): void {
    if (this.remaining < count) {
      throw new ProtocolError(
        `mensagem truncada: esperados ${count} byte(s), restam ${this.remaining} (offset ${this.#offset})`,
      );
    }
  }
}
