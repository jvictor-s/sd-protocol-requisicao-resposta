# Formato da mensagem (protocolo de fio)

Este é o contrato de interoperabilidade do protocolo de requisição-resposta.
Qualquer implementação (TypeScript, Java, Python, C…) que produza e consuma
estes bytes consegue conversar com a nossa — foi assim que o item 2 da
atividade foi pensado.

Regras gerais:

- Todos os inteiros são **int32 com sinal, 4 bytes, big-endian** (network byte order).
- Strings são **tamanho int32 + bytes UTF-8** (sem terminador `\0`).
- Vetores de bytes são **tamanho int32 + bytes crus** (sem padding).
- `messageType`: `0` = Requisição, `1` = Resposta.
- Não há cabeçalho de tamanho total: o tamanho vem do próprio datagrama UDP.
- Datagrama máximo: **65.507 bytes** (limite do payload UDP/IPv4).
- `requestId` válido: `0 .. 2.147.483.647`; o cliente deve usar ids diferentes
  por chamada e o servidor deve **ecoar o mesmo id** na resposta.
- `RemoteRef` = `host` (string), `porta` (int32) e `objectId` (int32).
- Datagrama que não decodifica é **descartado** (não derruba o servidor).

## 1. Requisição (cliente → servidor)

Layout exatamente como no slide "Requisição e Resposta: A mensagem":

| Offset | Tamanho | Campo              | Valor / observação                       |
| -----: | ------: | ------------------ | ---------------------------------------- |
|      0 |       4 | `messageType`      | `0` (Request)                            |
|      4 |       4 | `requestId`        | id da chamada                            |
|      8 |       4 | `tamanho do host`  | `N`                                      |
|     12 |       N | `remoteReference.host` | UTF-8, ex.: `192.168.0.10`           |
|  12+N  |       4 | `remoteReference.port` | porta UDP do servidor                |
|  16+N  |       4 | `remoteReference.objectId` | qual objeto remoto               |
|  20+N  |       4 | `operationId`      | número da operação (ver tabela abaixo)   |
|  24+N  |       4 | `tamanho dos argumentos` | `M`                                |
|  28+N  |       M | `arguments`        | bytes opacos para o protocolo            |

O campo `host` é **informativo** para o servidor: a resposta vai para o
endereço/porta de origem do datagrama (o `clientHost`/`clientPort` do slide),
que é o que o UDP entrega ao servidor. Isso evita spoofing trivial de
`RemoteRef` e funciona atrás de NAT.

### Exemplo real: `Ping` (requestId 7, objeto 127.0.0.1:4000/1)

```
0000  00 00 00 00 00 00 00 07 00 00 00 09 31 32 37 2e  ............127.
0010  30 2e 30 2e 31 00 00 0f a0 00 00 00 01 00 00 00  0.0.1...........
0020  00 00 00 00 00                                   .....
```

| Bytes           | Significado                                  |
| --------------- | -------------------------------------------- |
| `00 00 00 00`   | `messageType = 0`                            |
| `00 00 00 07`   | `requestId = 7`                              |
| `00 00 00 09`   | host tem 9 bytes                             |
| `31 … 31`       | `127.0.0.1`                                  |
| `00 00 0f a0`   | porta `4000`                                 |
| `00 00 00 01`   | `objectId = 1`                               |
| `00 00 00 00`   | `operationId = 0` (Ping)                     |
| `00 00 00 00`   | argumentos vazios (0 bytes)                  |

Total: **37 bytes**.

## 2. Resposta (servidor → cliente)

| Offset | Tamanho | Campo         | Valor / observação                                |
| -----: | ------: | ------------- | ------------------------------------------------- |
|      0 |       4 | `messageType` | `1` (Reply)                                       |
|      4 |       4 | `requestId`   | **igual** ao da requisição                        |
|      8 |       4 | `status`      | `0` = OK, `1` = erro de aplicação                 |
|     12 |       4 | `tamanho do resultado` | `M`                                      |
|     16 |       M | `result`      | bytes do resultado (ou mensagem de erro UTF-8)    |

- `status = 0`: `result` é o resultado da operação (marshalling da aplicação).
- `status = 1`: `result` é a **mensagem de erro em UTF-8 puro** (sem prefixo de
  tamanho), para facilitar a leitura e o log.

### Exemplo real: resposta do nosso `Ping` (`"pong"`)

O servidor devolve o texto com o marshalling da aplicação
(`int32 tamanho + UTF-8`), então o `result` tem 8 bytes:

```
0000  00 00 00 01 00 00 00 07 00 00 00 00 00 00 00 08  ................
0010  00 00 00 04 70 6f 6e 67                          ....pong
```

| Bytes         | Significado                             |
| ------------- | --------------------------------------- |
| `00 00 00 01` | `messageType = 1`                       |
| `00 00 00 07` | `requestId = 7`                         |
| `00 00 00 00` | `status = 0` (OK)                       |
| `00 00 00 08` | `result` tem 8 bytes                    |
| `00 00 00 04` | dentro do result: texto tem 4 bytes     |
| `70 6f 6e 67` | `pong`                                  |

Total: **24 bytes**.

### Exemplo: resposta de erro (`div 1/0`)

```
0000  00 00 00 01 00 00 00 07 00 00 00 01 00 00 00 11  ................
0010  64 69 76 69 73 c3 a3 6f 20 70 6f 72 20 7a 65 72  divis..o por zer
0020  6f                                               o
```

`messageType = 1`, `requestId = 7`, `status = 1` (erro de aplicação),
`result` com 17 bytes: `divisão por zero` em UTF-8 puro (o `c3 a3` é o `ã`).

## 3. Operações desta implementação

Os ids são números para evitar transmitir nomes. O `Ping` (`0`) e o formato de
seu resultado são o mínimo que o probe de interoperabilidade espera.

| id | nome         | argumentos (marshalling)                  | resultado                        |
| -: | ------------ | ----------------------------------------- | -------------------------------- |
|  0 | `ping`       | vazio                                     | texto `pong de <ref> em <ISO>`   |
|  1 | `add`        | 2 × float64 (big-endian)                  | float64                          |
|  2 | `sub`        | 2 × float64                               | float64                          |
|  3 | `mul`        | 2 × float64                               | float64                          |
|  4 | `div`        | 2 × float64 (erro se divisor = 0)         | float64                          |
|  5 | `echo`       | texto (int32 tamanho + UTF-8)             | o mesmo texto                    |
|  6 | `upper`      | texto                                     | texto em maiúsculas              |
|  7 | `sum`        | int32 `n` + `n` × float64                 | float64                          |
|  8 | `sleep`      | int32 milissegundos                       | texto `dormiu <n> ms`            |
|  9 | `serverTime` | vazio                                     | texto ISO-8601                   |

`float64` = IEEE-754 de 8 bytes em big-endian.

Os argumentos das operações são **opacos para o protocolo**: uma implementação
pode usar JSON, MessagePack ou outro marshalling nas operações dela. O que
precisa bater para interoperar é o cabeçalho da seção 1/2 + o `Ping`.

## 4. Semântica de entrega

| Situação                                             | Comportamento                                             |
| ---------------------------------------------------- | --------------------------------------------------------- |
| Resposta não chega dentro de `timeoutMs`             | cliente reenvia a **mesma** requisição (mesmo `requestId`) |
| Esgotaram as retransmissões                          | cliente lança `RequestTimeoutError`                        |
| Duplicata chega com resposta em cache                | servidor reenvia a resposta **sem executar de novo**       |
| Duplicata chega enquanto a original executa          | servidor ignora; a resposta da original será enviada       |
| `objectId` diferente do servidor                     | servidor ignora o datagrama                                |
| `operationId` desconhecido                           | resposta com `status = 1` e mensagem explicativa           |
| Exceção no handler                                   | resposta com `status = 1`                                  |
| Datagrama malformado                                 | descartado e registrado no log                             |
| Resultado maior que o limite do UDP                  | resposta com `status = 1`                                  |

Isso dá **at-most-once**: em caso de retransmissão a operação não é executada
duas vezes. O cache é em memória e expira em 60 s (configurável); reiniciar o
servidor zera o cache.

## 5. Como implementar em outra linguagem

Pseudocódigo do cliente (`doOperation`):

```text
requestId = próximo id
bytes = int32(0) + int32(requestId) + string(ref.host) + int32(ref.port)
      + int32(ref.objectId) + int32(operationId) + bytes(arguments)
envia bytes para (ref.host, ref.port) com timeout
se chegou resposta:
    lê int32 messageType (=1), int32 requestId (deve ser igual),
        int32 status, bytes result
    se status == 1: lança erro(result como UTF-8)
    senão: retorna result
senão, se ainda há tentativas: reenvia os MESMOS bytes
senão: lança timeout
```

Dicas por linguagem:

- **Java**: `ByteBuffer.allocate(...).order(ByteOrder.BIG_ENDIAN)`;
  `DatagramSocket` + `DatagramPacket`.
- **Python**: `struct.pack(">i", valor)` / `struct.unpack(">i", ...)`,
  `socket.socket(AF_INET, SOCK_DGRAM)`.
- **C**: `htonl`/`ntohl`; lembre que `int32` tem 4 bytes.

Cuidado com os erros clássicos: escrever little-endian, esquecer o tamanho
antes da string, não ecoar o `requestId` ou responder para o `host` do
`RemoteRef` em vez do endereço de origem.
