export type DebugDirection = "tx" | "rx";

export interface DebugEvent {
  direction: DebugDirection;
  peer: string;
  bytes: Buffer;
  attempt?: number;
}

export type DebugSink = (event: DebugEvent) => void;

export function wireDebugEnabled(): boolean {
  const value = process.env["DEBUG_WIRE"];
  return value === "1" || value?.toLowerCase() === "true";
}

/** Sink que imprime o hexdump no stderr (para não misturar com a saída normal). */
export function hexDumpSink(event: DebugEvent): void {
  const arrow = event.direction === "tx" ? "-->" : "<--";
  const attempt = event.attempt === undefined ? "" : ` tentativa=${event.attempt}`;
  process.stderr.write(`${arrow} ${event.peer} ${event.bytes.length}B${attempt}\n`);
  process.stderr.write(`${hexDump(event.bytes)}\n`);
}

/** Hexdump estilo `xxd`: offset, 16 bytes em hexa e a coluna ASCII. */
export function hexDump(bytes: Buffer): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 16) {
    const slice = bytes.subarray(offset, offset + 16);
    const hex = [...slice].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...slice]
      .map((byte) => (byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : "."))
      .join("");
    lines.push(`${offset.toString(16).padStart(4, "0")}  ${hex.padEnd(47)}  ${ascii}`);
  }
  return lines.join("\n");
}
