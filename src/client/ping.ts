import { hexDumpSink, wireDebugEnabled } from "../protocol/debug.ts";
import { errorMessage } from "../protocol/errors.ts";
import { RemoteRef } from "../protocol/message.ts";
import { decodeText, Operation } from "../service/operations.ts";
import { formatDuration, numberOption, parseArgs, stringOption } from "../util/args.ts";
import { Requestor } from "./requestor.ts";

const args = parseArgs(process.argv.slice(2));

if (args.flags.has("help")) {
  console.log(`Uso: node src/client/ping.ts [opções]

  --host <ip>       servidor (padrão: 127.0.0.1)
  --port <porta>    porta do servidor (padrão: 4000)
  --object <id>     objectId do objeto remoto (padrão: 1)
  --timeout <ms>    timeout por tentativa (padrão: 800)
  --retries <n>     retransmissões (padrão: 1)
  --help            esta ajuda`);
  process.exit(0);
}

const host = stringOption(args, "host", "127.0.0.1");
const port = numberOption(args, "port", 4000);
const objectId = numberOption(args, "object", 1);

const remoteRef = new RemoteRef(host, port, objectId);
const requestor = new Requestor({
  timeoutMs: numberOption(args, "timeout", 800),
  retransmissions: numberOption(args, "retries", 1),
  onDebug: wireDebugEnabled() ? hexDumpSink : undefined,
});

const startedAt = performance.now();

try {
  const reply = await requestor.doOperation(remoteRef, Operation.Ping);
  const elapsed = performance.now() - startedAt;
  console.log(`[ok] ${remoteRef.toString()} respondeu em ${formatDuration(elapsed)}`);
  console.log(`     ${decodeText(reply)}`);
} catch (error) {
  const elapsed = performance.now() - startedAt;
  console.error(`[falha] ${remoteRef.toString()} não respondeu (${formatDuration(elapsed)})`);
  console.error(`        ${errorMessage(error)}`);
  console.error("");
  console.error("Verifique: o servidor está rodando? o IP/porta estão certos? o firewall liberou a porta UDP?");
  process.exitCode = 1;
}
