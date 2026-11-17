import { createSocket } from "node:dgram";
import type { Socket } from "node:dgram";

import { hexDumpSink, wireDebugEnabled } from "../protocol/debug.ts";
import { errorMessage } from "../protocol/errors.ts";
import {
  encodeRequest,
  MESSAGE_TYPE,
  REPLY_STATUS,
  RemoteRef,
  tryDecodeMessage,
} from "../protocol/message.ts";
import type { Message } from "../protocol/message.ts";
import { decodeText, Operation } from "../service/operations.ts";
import { formatDuration, numberOption, parseArgs, stringOption } from "../util/args.ts";
import { Requestor } from "../client/requestor.ts";

type Verdict = "PASS" | "WARN" | "FAIL";

interface CheckResult {
  name: string;
  verdict: Verdict;
  detail: string;
}

interface RawReply {
  bytes: Buffer;
  message: Message | undefined;
  rttMs: number;
}

interface RawChannel {
  send(datagram: Buffer): Promise<void>;
  receive(timeoutMs: number): Promise<RawReply | undefined>;
  close(): void;
}

const args = parseArgs(process.argv.slice(2));

if (args.flags.has("help")) {
  console.log(`Uso: node src/interop/probe.ts [opções]

  --host <ip>       servidor a testar (padrão: 127.0.0.1)
  --port <porta>    porta do servidor (padrão: 4000)
  --object <id>     objectId do objeto remoto (padrão: 1)
  --help            esta ajuda

Sai com código 1 se algum teste essencial falhar.`);
  process.exit(0);
}

const host = stringOption(args, "host", "127.0.0.1");
const port = numberOption(args, "port", 4000);
const objectId = numberOption(args, "object", 1);

const remoteRef = new RemoteRef(host, port, objectId);
const requestor = new Requestor({
  timeoutMs: 800,
  retransmissions: 1,
  onDebug: wireDebugEnabled() ? hexDumpSink : undefined,
});

const results: CheckResult[] = [];

function record(name: string, verdict: Verdict, detail: string): void {
  results.push({ name, verdict, detail });
  console.log(`[${verdict}] ${name}`);
  console.log(`        ${detail}`);
}

console.log("=".repeat(72));
console.log(`Probe de interoperabilidade -> ${remoteRef.toString()}`);
console.log("Formato esperado: docs/FORMATO_MENSAGEM.md");
console.log("=".repeat(72));

/* 1. doOperation completo ------------------------------------------------ */
try {
  const startedAt = performance.now();
  const reply = await requestor.doOperation(remoteRef, Operation.Ping, Buffer.alloc(0));
  record(
    "1. doOperation() completo (Ping)",
    "PASS",
    `${formatDuration(performance.now() - startedAt)} - ${reply.length} byte(s): ${JSON.stringify(pingText(reply))}`,
  );
} catch (error) {
  record("1. doOperation() completo (Ping)", "FAIL", errorMessage(error));
}

/* 2. correlação de requestId -------------------------------------------- */
await withChannel(async (channel) => {
  const requestId = 424_242;
  try {
    await channel.send(
      encodeRequest({
        requestId,
        remoteRef,
        operationId: Operation.Ping,
        arguments: Buffer.alloc(0),
      }),
    );
    const reply = await channel.receive(1200);

    if (!reply) {
      record("2. correlação de requestId", "FAIL", "nenhuma resposta em 1200 ms");
      return;
    }
    if (!reply.message) {
      record(
        "2. correlação de requestId",
        "FAIL",
        `resposta de ${reply.bytes.length} bytes não segue o formato esperado: ${reply.bytes.toString("hex")}`,
      );
      return;
    }
    if (reply.message.messageType !== MESSAGE_TYPE.REPLY) {
      record(
        "2. correlação de requestId",
        "FAIL",
        `recebemos messageType=${reply.message.messageType}, esperávamos 1 (Reply)`,
      );
      return;
    }
    if (reply.message.requestId !== requestId) {
      record(
        "2. correlação de requestId",
        "FAIL",
        `requestId devolvido=${reply.message.requestId}, enviado=${requestId}`,
      );
      return;
    }
    record(
      "2. correlação de requestId",
      "PASS",
      `requestId ${requestId} ecoado corretamente (${formatDuration(reply.rttMs)})`,
    );
  } catch (error) {
    record("2. correlação de requestId", "FAIL", errorMessage(error));
  }
});

/* 3. retransmissão duplicada -------------------------------------------- */
await withChannel(async (channel) => {
  const requestId = 424_243;
  const datagram = encodeRequest({
    requestId,
    remoteRef,
    operationId: Operation.Ping,
    arguments: Buffer.alloc(0),
  });

  try {
    const firstStarted = performance.now();
    await channel.send(datagram);
    const first = await channel.receive(1200);
    if (!first) {
      record("3. retransmissão duplicada", "FAIL", "a primeira requisição não teve resposta");
      return;
    }

    await delay(80);
    await channel.send(datagram); // MESMO socket, MESMO requestId
    const second = await channel.receive(1200);

    if (!second) {
      record(
        "3. retransmissão duplicada",
        "WARN",
        "o servidor descartou a duplicata sem reenviar a resposta (at-most-once válido, mas o cliente ficaria esperando)",
      );
      return;
    }

    if (second.bytes.equals(first.bytes)) {
      record(
        "3. retransmissão duplicada",
        "PASS",
        `duplicata respondeu em ${formatDuration(second.rttMs)} com a resposta em cache (executou 1x)`,
      );
      return;
    }

    record(
      "3. retransmissão duplicada",
      "WARN",
      `as duas respostas diferem (${formatDuration(performance.now() - firstStarted)} no total): a operação provavelmente executou 2x`,
    );
  } catch (error) {
    record("3. retransmissão duplicada", "WARN", errorMessage(error));
  }
});

/* 4. operação desconhecida ----------------------------------------------- */
await withChannel(async (channel) => {
  try {
    await channel.send(
      encodeRequest({
        requestId: 424_244,
        remoteRef,
        operationId: 9999,
        arguments: Buffer.alloc(0),
      }),
    );
    const reply = await channel.receive(1200);

    if (!reply) {
      record(
        "4. operação desconhecida",
        "WARN",
        "servidor ignorou a requisição (não respondeu); o cliente só veria timeout",
      );
      return;
    }
    if (!reply.message || reply.message.messageType !== MESSAGE_TYPE.REPLY) {
      record("4. operação desconhecida", "WARN", "resposta fora do formato esperado");
      return;
    }
    if (reply.message.status === REPLY_STATUS.APPLICATION_ERROR) {
      record(
        "4. operação desconhecida",
        "PASS",
        `erro de aplicação devolvido: "${reply.message.result.toString("utf8")}"`,
      );
      return;
    }
    record("4. operação desconhecida", "WARN", "servidor respondeu OK para uma operação que não existe");
  } catch (error) {
    record("4. operação desconhecida", "FAIL", errorMessage(error));
  }
});

/* 5. tolerância a datagrama malformado ----------------------------------- */
await withChannel(async (channel) => {
  try {
    await channel.send(Buffer.from("isto não é uma mensagem do protocolo", "utf8"));
    await channel.send(Buffer.from([0, 0, 0, 7, 1, 2])); // body truncado
    await delay(150);

    const text = await pingText(await requestor.doOperation(remoteRef, Operation.Ping));
    record("5. datagrama malformado", "PASS", `servidor continuou vivo e respondeu: ${text}`);
  } catch (error) {
    record(
      "5. datagrama malformado",
      "FAIL",
      `o servidor não respondeu depois do lixo: ${errorMessage(error)}`,
    );
  }
});

/* 6. latência ------------------------------------------------------------ */
try {
  const samples: number[] = [];
  for (let index = 0; index < 10; index += 1) {
    const startedAt = performance.now();
    await requestor.doOperation(remoteRef, Operation.Ping, Buffer.alloc(0));
    samples.push(performance.now() - startedAt);
  }
  const min = Math.min(...samples);
  const max = Math.max(...samples);
  const avg = samples.reduce((total, value) => total + value, 0) / samples.length;
  record(
    "6. latência (10 chamadas)",
    "PASS",
    `mín ${formatDuration(min)} / média ${formatDuration(avg)} / máx ${formatDuration(max)}`,
  );
} catch (error) {
  record("6. latência (10 chamadas)", "FAIL", errorMessage(error));
}

/* Resumo ----------------------------------------------------------------- */
const failures = results.filter((result) => result.verdict === "FAIL").length;
const warnings = results.filter((result) => result.verdict === "WARN").length;
const passes = results.length - failures - warnings;

console.log("-".repeat(72));
console.log(`Resumo: ${passes} PASS, ${warnings} WARN, ${failures} FAIL`);

if (failures > 0) {
  console.log("");
  console.log("Interoperabilidade NÃO confirmada. Confira, dos dois lados:");
  console.log("  - ordem e tamanho dos campos (big-endian, int32 de 4 bytes);");
  console.log("  - RemoteRef: host como string (int32 tamanho + UTF-8), porta e objectId;");
  console.log("  - requestId ecoado na resposta;");
  console.log("  - messageType 0 = requisição / 1 = resposta;");
  console.log("  - o servidor está escutando em 0.0.0.0 e o firewall liberou a porta UDP.");
  process.exitCode = 1;
}

console.log("");
console.log("Para o teste nos dois sentidos: rode o seu servidor e peça ao colega");
console.log("para executar o probe dele com --host <seu-ip> --port <sua-porta>.");

/* ------------------------------------------------------------------------ */

/**
 * O resultado do Ping é texto. Se a implementação do colega não usar o mesmo
 * marshalling de aplicação (int32 tamanho + UTF-8), cai para UTF-8 cru.
 */
function pingText(reply: Buffer): string {
  try {
    return decodeText(reply);
  } catch {
    return reply.toString("utf8");
  }
}

async function withChannel(run: (channel: RawChannel) => Promise<void>): Promise<void> {
  const channel = await openChannel();
  try {
    await run(channel);
  } finally {
    channel.close();
  }
}

async function openChannel(): Promise<RawChannel> {
  const socket: Socket = createSocket("udp4");
  const queue: RawReply[] = [];
  let waiter: ((reply: RawReply | undefined) => void) | undefined;
  let sentAt = 0;

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
    socket.bind(0);
  });

  socket.on("message", (data, info) => {
    if (info.port !== port) return;
    const reply: RawReply = {
      bytes: Buffer.from(data),
      message: tryDecodeMessage(data),
      rttMs: performance.now() - sentAt,
    };
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(reply);
    } else {
      queue.push(reply);
    }
  });
  socket.on("error", () => {});

  return {
    send: (datagram) =>
      new Promise<void>((resolve, reject) => {
        sentAt = performance.now();
        socket.send(datagram, port, host, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    receive: (timeoutMs) => {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);

      return new Promise<RawReply | undefined>((resolve) => {
        waiter = resolve;
        setTimeout(() => {
          if (waiter === resolve) {
            waiter = undefined;
            resolve(undefined);
          }
        }, timeoutMs);
      });
    },
    close: () => {
      try {
        socket.close();
      } catch {
        // já fechado
      }
    },
  };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
