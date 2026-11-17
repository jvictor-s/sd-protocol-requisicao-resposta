import { networkInterfaces } from "node:os";

import { hexDumpSink, wireDebugEnabled } from "../protocol/debug.ts";
import { REPLY_STATUS } from "../protocol/message.ts";
import { formatDuration, numberOption, nowStamp, onShutdown, parseArgs, stringOption } from "../util/args.ts";
import { operationList, registerOperations } from "../service/operations.ts";
import { ReplyServer } from "./reply-server.ts";
import type { ServerLogEvent } from "./reply-server.ts";

const args = parseArgs(process.argv.slice(2));

if (args.flags.has("help")) {
  console.log(`Uso: node src/server/server-demo.ts [opções]

  --port <porta>    porta UDP (padrão: 4000)
  --host <ip>       interface de escuta (padrão: 0.0.0.0)
  --object <id>     objectId deste objeto (padrão: 1)
  --quiet           não registra cada requisição
  --help            esta ajuda

Variável de ambiente: DEBUG_WIRE=1 mostra os datagramas em hexdump.`);
  process.exit(0);
}

const port = numberOption(args, "port", 4000);
const host = stringOption(args, "host", "0.0.0.0");
const objectId = numberOption(args, "object", 1);
const quiet = args.flags.has("quiet");

const server = new ReplyServer({
  port,
  host,
  objectId,
  onDebug: wireDebugEnabled() ? hexDumpSink : undefined,
  logger: quiet ? undefined : logEvent,
});

registerOperations(server);

const bound = await server.start();

console.log("=".repeat(72));
console.log("Servidor de requisição-resposta (UDP)");
console.log("=".repeat(72));
console.log(`  escutando em ....... ${bound.address}:${bound.port}`);
console.log(`  objectId ........... ${objectId}`);
console.log(`  operações .......... ${operationList()}`);
console.log(`  cache de duplicatas  ativo (semântica at-most-once por requestId)`);
console.log("");
console.log("  IPs desta máquina (use um deles no cliente do colega):");
for (const localIp of localAddresses()) {
  console.log(`    ${localIp}:${bound.port}`);
}
console.log("");
console.log("  Cliente de teste:");
console.log(`    node src/client/client-demo.ts --host <ip> --port ${bound.port} --object ${objectId}`);
console.log("  Verificação de interoperabilidade:");
console.log(`    node src/interop/probe.ts --host <ip> --port ${bound.port} --object ${objectId}`);
console.log("");
console.log("  Ctrl+C para encerrar.");
console.log("=".repeat(72));

onShutdown(async () => {
  await server.stop();
});

function logEvent(event: ServerLogEvent): void {
  const prefix = `[${nowStamp()}]`;

  switch (event.kind) {
    case "reply": {
      const status = event.status === REPLY_STATUS.APPLICATION_ERROR ? "ERRO" : "ok";
      const name = event.operationName ?? `operação-${event.operationId ?? "?"}`;
      const client = event.client ? `${event.client.address}:${event.client.port}` : "?";
      console.log(
        `${prefix} req#${event.requestId} ${name} de ${client} -> ${status}` +
          (event.durationMs === undefined ? "" : ` em ${formatDuration(event.durationMs)}`),
      );
      if (status === "ERRO") console.log(`          ${event.message}`);
      break;
    }
    case "duplicate":
      console.log(`${prefix} req#${event.requestId} duplicada: ${event.message}`);
      break;
    case "ignored":
      console.log(`${prefix} ignorado: ${event.message}`);
      break;
    case "error":
      console.log(`${prefix} erro: ${event.message}`);
      break;
    case "listen":
      // O banner já cobre o início; não repete.
      break;
    case "close":
      console.log(`${prefix} ${event.message}`);
      break;
    default:
      console.log(`${prefix} ${event.kind}: ${event.message}`);
  }
}

function localAddresses(): string[] {
  const addresses: string[] = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal) addresses.push(entry.address);
    }
  }
  return addresses.length > 0 ? addresses : ["127.0.0.1"];
}
