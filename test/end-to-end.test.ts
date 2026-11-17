import assert from "node:assert/strict";
import { createSocket } from "node:dgram";
import test from "node:test";

import { OperationsStub } from "../src/client/service-stub.ts";
import { Requestor } from "../src/client/requestor.ts";
import { RemoteError, RequestTimeoutError } from "../src/protocol/errors.ts";
import { decodeMessage, encodeRequest, MESSAGE_TYPE, RemoteRef } from "../src/protocol/message.ts";
import { ReplyServer } from "../src/server/reply-server.ts";
import {
  decodeDouble,
  decodeText,
  encodeDoublePair,
  encodeText,
  Operation,
  registerOperations,
} from "../src/service/operations.ts";

interface Fixture {
  server: ReplyServer;
  port: number;
  ref: RemoteRef;
  stub: OperationsStub;
}

async function startFixture(options: { duplicateWindowMs?: number } = {}): Promise<Fixture> {
  const server = new ReplyServer({
    port: 0,
    host: "127.0.0.1",
    objectId: 1,
    ...(options.duplicateWindowMs === undefined
      ? {}
      : { duplicateWindowMs: options.duplicateWindowMs }),
  });
  registerOperations(server);
  const { port } = await server.start();
  const ref = new RemoteRef("127.0.0.1", port, 1);
  const requestor = new Requestor({ timeoutMs: 1000, retransmissions: 2 });
  return { server, port, ref, stub: new OperationsStub(ref, requestor) };
}

interface RawSocket {
  send(datagram: Buffer): Promise<void>;
  receive(timeoutMs: number): Promise<Buffer | undefined>;
  close(): void;
}

async function openRawSocket(port: number): Promise<RawSocket> {
  const socket = createSocket("udp4");
  const queue: Buffer[] = [];
  let waiter: ((datagram: Buffer | undefined) => void) | undefined;

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

  socket.on("message", (data) => {
    const copy = Buffer.from(data);
    if (waiter) {
      const resolve = waiter;
      waiter = undefined;
      resolve(copy);
    } else {
      queue.push(copy);
    }
  });
  socket.on("error", () => {});

  return {
    send: (datagram) =>
      new Promise<void>((resolve, reject) => {
        socket.send(datagram, port, "127.0.0.1", (error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    receive: (timeoutMs) => {
      const ready = queue.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise<Buffer | undefined>((resolve) => {
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

test("e2e: operações básicas", async () => {
  const fixture = await startFixture();
  try {
    assert.match(await fixture.stub.ping(), /^pong de /);
    assert.equal(await fixture.stub.add(2, 3), 5);
    assert.equal(await fixture.stub.sub(2, 3), -1);
    assert.equal(await fixture.stub.mul(6, 7), 42);
    assert.equal(await fixture.stub.div(10, 4), 2.5);
    assert.equal(await fixture.stub.echo("olá"), "olá");
    assert.equal(await fixture.stub.upper("abc"), "ABC");
    assert.equal(await fixture.stub.sum([1, 2, 3, 4]), 10);
    assert.match(await fixture.stub.serverTime(), /^\d{4}-\d{2}-\d{2}T/);
  } finally {
    await fixture.server.stop();
  }
});

test("e2e: erro de aplicação chega como RemoteError", async () => {
  const fixture = await startFixture();
  try {
    await assert.rejects(fixture.stub.div(1, 0), (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.equal(error.remoteMessage, "divisão por zero");
      return true;
    });
  } finally {
    await fixture.server.stop();
  }
});

test("e2e: operação não registrada devolve erro, não timeout", async () => {
  const fixture = await startFixture();
  try {
    await assert.rejects(fixture.stub.callRaw(9999), (error: unknown) => {
      assert.ok(error instanceof RemoteError);
      assert.match(error.remoteMessage, /não registrada/);
      return true;
    });
  } finally {
    await fixture.server.stop();
  }
});

test("e2e: 40 chamadas concorrentes com resultados corretos", async () => {
  const fixture = await startFixture();
  try {
    const values = await Promise.all(
      Array.from({ length: 40 }, (_, index) => fixture.stub.add(index, index * 2)),
    );
    values.forEach((value, index) => assert.equal(value, index + index * 2));
  } finally {
    await fixture.server.stop();
  }
});

test("e2e: operação lenta não bloqueia as demais", async () => {
  const fixture = await startFixture();
  try {
    const slow = fixture.stub.sleep(300);
    const startedAt = performance.now();
    const fast = await fixture.stub.add(1, 1);
    const fastElapsed = performance.now() - startedAt;

    assert.equal(fast, 2);
    assert.ok(fastElapsed < 250, `chamada rápida demorou ${fastElapsed.toFixed(0)} ms`);
    assert.equal(await slow, "dormiu 300 ms");
  } finally {
    await fixture.server.stop();
  }
});

test("e2e: at-most-once - retransmissão não executa a operação de novo", async () => {
  const fixture = await startFixture();
  try {
    let executions = 0;
    fixture.server.register(100, "contador", async () => {
      executions += 1;
      await delay(300);
      return encodeText("executou uma vez");
    });

    const requestor = new Requestor({ timeoutMs: 100, retransmissions: 9 });
    const result = await requestor.doOperation(fixture.ref, 100, Buffer.alloc(0));

    assert.equal(decodeText(result), "executou uma vez");
    assert.equal(executions, 1, `a operação executou ${executions} vezes`);
  } finally {
    await fixture.server.stop();
  }
});

test("e2e: timeout quando o servidor não responde", async () => {
  const fixture = await startFixture();
  try {
    fixture.server.register(101, "lenta", async () => {
      await delay(300);
      return encodeText("tarde demais");
    });

    const requestor = new Requestor({ timeoutMs: 50, retransmissions: 0 });
    await assert.rejects(requestor.doOperation(fixture.ref, 101, Buffer.alloc(0)), (error: unknown) => {
      assert.ok(error instanceof RequestTimeoutError);
      assert.equal(error.attempts, 1);
      return true;
    });

    await delay(350); // deixa o handler terminar antes de encerrar o servidor
  } finally {
    await fixture.server.stop();
  }
});

test("e2e: objectId diferente é ignorado", async () => {
  const fixture = await startFixture();
  try {
    const wrongRef = new RemoteRef("127.0.0.1", fixture.port, 2);
    const requestor = new Requestor({ timeoutMs: 80, retransmissions: 0 });
    await assert.rejects(
      requestor.doOperation(wrongRef, Operation.Ping, Buffer.alloc(0)),
      RequestTimeoutError,
    );
    // O servidor continua atendendo o objeto correto.
    assert.match(await fixture.stub.ping(), /^pong de /);
  } finally {
    await fixture.server.stop();
  }
});

test("e2e: datagrama malformado é descartado sem derrubar o servidor", async () => {
  const fixture = await startFixture();
  const raw = await openRawSocket(fixture.port);
  try {
    await raw.send(Buffer.from("lixo", "utf8"));
    await raw.send(Buffer.from([0, 0, 0, 7, 1, 2, 3]));
    await delay(100);
    assert.equal(await fixture.stub.add(2, 2), 4);
  } finally {
    raw.close();
    await fixture.server.stop();
  }
});

test("e2e: duplicata no mesmo socket recebe a resposta do cache", async () => {
  const fixture = await startFixture();
  const raw = await openRawSocket(fixture.port);
  try {
    let executions = 0;
    fixture.server.register(102, "contador2", () => {
      executions += 1;
      return encodeText(`execução ${executions}`);
    });

    const datagram = encodeRequest({
      requestId: 555,
      remoteRef: fixture.ref,
      operationId: 102,
      arguments: Buffer.alloc(0),
    });

    await raw.send(datagram);
    const first = await raw.receive(1000);
    assert.ok(first);

    await raw.send(datagram);
    const second = await raw.receive(1000);
    assert.ok(second);

    assert.deepEqual(second, first);
    assert.equal(executions, 1);

    const message = decodeMessage(second);
    assert.ok(message.messageType === MESSAGE_TYPE.REPLY);
    assert.equal(message.requestId, 555);
    assert.equal(decodeText(message.result), "execução 1");
  } finally {
    raw.close();
    await fixture.server.stop();
  }
});

test("e2e: cache de duplicatas expira", async () => {
  const fixture = await startFixture({ duplicateWindowMs: 50 });
  const raw = await openRawSocket(fixture.port);
  try {
    let executions = 0;
    fixture.server.register(103, "contador3", () => {
      executions += 1;
      return encodeText(`execução ${executions}`);
    });

    const datagram = encodeRequest({
      requestId: 777,
      remoteRef: fixture.ref,
      operationId: 103,
      arguments: Buffer.alloc(0),
    });

    await raw.send(datagram);
    assert.ok(await raw.receive(1000));

    await delay(120);
    await raw.send(datagram);
    const reply = await raw.receive(1000);
    assert.ok(reply);

    const message = decodeMessage(reply);
    assert.ok(message.messageType === MESSAGE_TYPE.REPLY);
    assert.equal(decodeText(message.result), "execução 2");
    assert.equal(executions, 2);
  } finally {
    raw.close();
    await fixture.server.stop();
  }
});

test("e2e: argumentos inválidos viram erro de aplicação", async () => {
  const fixture = await startFixture();
  try {
    await assert.rejects(
      fixture.stub.callRaw(Operation.Add, Buffer.from([1, 2, 3])),
      (error: unknown) => {
        assert.ok(error instanceof RemoteError);
        assert.match(error.remoteMessage, /argumentos inválidos/);
        return true;
      },
    );

    // Com argumentos válidos, a mesma operação funciona.
    const result = await fixture.stub.callRaw(Operation.Add, encodeDoublePair(1, 2));
    assert.equal(decodeDouble(result), 3);
  } finally {
    await fixture.server.stop();
  }
});
