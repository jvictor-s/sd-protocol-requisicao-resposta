import { wireDebugEnabled, hexDumpSink } from "../protocol/debug.ts";
import { RemoteError, RequestTimeoutError, errorMessage } from "../protocol/errors.ts";
import { RemoteRef } from "../protocol/message.ts";
import { decodeText, encodeInt32, Operation } from "../service/operations.ts";
import {
  formatDuration,
  numberOption,
  parseArgs,
  stringOption,
} from "../util/args.ts";
import { Requestor } from "./requestor.ts";
import { OperationsStub } from "./service-stub.ts";

const args = parseArgs(process.argv.slice(2));

if (args.flags.has("help")) {
  console.log(`Uso: node src/client/client-demo.ts [opções]

  --host <ip>       servidor (padrão: 127.0.0.1)
  --port <porta>    porta do servidor (padrão: 4000)
  --object <id>     objectId do objeto remoto (padrão: 1)
  --timeout <ms>    timeout por tentativa (padrão: 500)
  --retries <n>     retransmissões (padrão: 2)
  --help            esta ajuda

Variável de ambiente: DEBUG_WIRE=1 mostra os datagramas em hexdump.`);
  process.exit(0);
}

const host = stringOption(args, "host", "127.0.0.1");
const port = numberOption(args, "port", 4000);
const objectId = numberOption(args, "object", 1);
const timeoutMs = numberOption(args, "timeout", 500);
const retransmissions = numberOption(args, "retries", 2);

const remoteRef = new RemoteRef(host, port, objectId);
const requestor = new Requestor({
  timeoutMs,
  retransmissions,
  onDebug: wireDebugEnabled() ? hexDumpSink : undefined,
});
const stub = new OperationsStub(remoteRef, requestor);

interface StepResult {
  name: string;
  ok: boolean;
  detail: string;
}

const results: StepResult[] = [];

async function step(name: string, run: () => Promise<string>): Promise<void> {
  const startedAt = performance.now();
  try {
    const detail = await run();
    const elapsed = performance.now() - startedAt;
    results.push({ name, ok: true, detail });
    console.log(`[ok]    ${name}  (${formatDuration(elapsed)})`);
    if (detail.length > 0) console.log(`        ${detail}`);
  } catch (error) {
    results.push({ name, ok: false, detail: errorMessage(error) });
    console.log(`[falha] ${name}`);
    console.log(`        ${errorMessage(error)}`);
  }
}

const address = `${host}:${port}/${objectId}`;
console.log("=".repeat(72));
console.log(`Cliente de requisição-resposta (UDP) -> ${address}`);
console.log(`timeout=${timeoutMs} ms por tentativa, retransmissões=${retransmissions}`);
console.log("=".repeat(72));

await step("doOperation cru: ping", async () => {
  const reply = await requestor.doOperation(remoteRef, Operation.Ping);
  return `${reply.length} byte(s) de resposta; texto decodificado: ${JSON.stringify(decodeText(reply))}`;
});

await step("stub.ping()", async () => `servidor respondeu: ${await stub.ping()}`);

await step("stub.add(2.5, 4.25)", async () => {
  const value = await stub.add(2.5, 4.25);
  if (value !== 6.75) throw new Error(`resultado inesperado: ${value}`);
  return `2.5 + 4.25 = ${value}`;
});

await step("stub.sub(10, 3.5)", async () => {
  const value = await stub.sub(10, 3.5);
  if (value !== 6.5) throw new Error(`resultado inesperado: ${value}`);
  return `10 - 3.5 = ${value}`;
});

await step("stub.mul(6, 7)", async () => {
  const value = await stub.mul(6, 7);
  if (value !== 42) throw new Error(`resultado inesperado: ${value}`);
  return `6 * 7 = ${value}`;
});

await step("stub.div(10, 4)", async () => {
  const value = await stub.div(10, 4);
  if (value !== 2.5) throw new Error(`resultado inesperado: ${value}`);
  return `10 / 4 = ${value}`;
});

await step("stub.div(1, 0) -> erro remoto", async () => {
  try {
    const value = await stub.div(1, 0);
    throw new Error(`deveria ter falhado, mas retornou ${value}`);
  } catch (error) {
    if (error instanceof RemoteError) {
      return `RemoteError recebido do servidor: "${error.remoteMessage}"`;
    }
    throw error;
  }
});

await step("stub.echo('olá, mundo')", async () => {
  const text = "olá, mundo";
  const echoed = await stub.echo(text);
  if (echoed !== text) throw new Error(`eco diferente: ${JSON.stringify(echoed)}`);
  return `servidor devolveu ${JSON.stringify(echoed)}`;
});

await step("stub.upper('sistemas distribuídos')", async () => {
  const value = await stub.upper("sistemas distribuídos");
  if (value !== "SISTEMAS DISTRIBUÍDOS") throw new Error(`resultado inesperado: ${value}`);
  return value;
});

await step("stub.sum([1..10])", async () => {
  const values = Array.from({ length: 10 }, (_, index) => index + 1);
  const total = await stub.sum(values);
  if (total !== 55) throw new Error(`soma inesperada: ${total}`);
  return `soma de 1..10 = ${total}`;
});

await step("stub.serverTime()", async () => `horário do servidor: ${await stub.serverTime()}`);

await step("timeout: sleep(1200) com timeout de 300 ms", async () => {
  try {
    await requestor.doOperation(remoteRef, Operation.Sleep, encodeInt32(1200), {
      timeoutMs: 300,
      retransmissions: 1,
    });
    throw new Error("deveria ter estourado o timeout");
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      return `RequestTimeoutError após ${error.attempts} tentativa(s): o cliente desiste, mas o servidor continua executando`;
    }
    throw error;
  }
});

await step("concorrência: 30 chamadas add() simultâneas", async () => {
  const startedAt = performance.now();
  const calls = Array.from({ length: 30 }, (_, index) => stub.add(index, index * 12));
  const values = await Promise.all(calls);
  const wrong = values.findIndex((value, index) => value !== index + index * 12);
  if (wrong >= 0) throw new Error(`resposta incorreta na chamada ${wrong}: ${values[wrong]}`);
  const elapsed = performance.now() - startedAt;
  return `30 respostas corretas em ${formatDuration(elapsed)} (cada chamada tem seu requestId e sua porta UDP)`;
});

console.log("-".repeat(72));
const failures = results.filter((result) => !result.ok);
console.log(
  `${results.length - failures.length}/${results.length} etapas concluídas` +
    (failures.length === 0 ? " - tudo certo!" : ` - ${failures.length} falha(s)`),
);

if (failures.length > 0) {
  for (const failure of failures) console.log(`  - ${failure.name}: ${failure.detail}`);
  process.exitCode = 1;
}
