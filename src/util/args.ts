export interface ParsedArgs {
  options: Map<string, string>;
  flags: Set<string>;
  positionals: string[];
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const options = new Map<string, string>();
  const flags = new Set<string>();
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (arg.startsWith("--")) {
      const withoutDashes = arg.slice(2);
      const equalsAt = withoutDashes.indexOf("=");
      if (equalsAt >= 0) {
        options.set(withoutDashes.slice(0, equalsAt), withoutDashes.slice(equalsAt + 1));
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        options.set(withoutDashes, next);
        index += 1;
      } else {
        flags.add(withoutDashes);
      }
      continue;
    }

    positionals.push(arg);
  }

  return { options, flags, positionals };
}

export function numberOption(args: ParsedArgs, name: string, fallback: number): number {
  const raw = args.options.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    throw new Error(`--${name} precisa ser um número (recebido: ${raw})`);
  }
  return value;
}

export function stringOption(args: ParsedArgs, name: string, fallback: string): string {
  return args.options.get(name) ?? fallback;
}

/** Registra SIGINT/SIGTERM para encerrar de forma limpa. */
export function onShutdown(shutdown: () => Promise<void>): void {
  let closing = false;
  const handler = (signal: NodeJS.Signals): void => {
    if (closing) {
      process.exit(130);
    }
    closing = true;
    process.stdout.write(`\n${signal} recebido, encerrando...\n`);
    shutdown()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        process.stderr.write(`falha ao encerrar: ${String(error)}\n`);
        process.exit(1);
      });
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
}

export function formatDuration(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

export function nowStamp(): string {
  return new Date().toLocaleTimeString("pt-BR", { hour12: false });
}
