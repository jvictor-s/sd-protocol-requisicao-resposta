# Protocolo de Requisição e Resposta sobre UDP

Implementação, em **TypeScript**, da atividade de *Invocação Remota de Métodos* (Sistemas Distribuídos): o protocolo de
requisição-resposta com as primitivas **`doOperation()`**, **`getRequest()`** e **`sendReply()`**, sobre sockets de datagrama (UDP).

## Requisitos

**Node.js >= 22.18 e TypeScript 7.0** 

## Como executar

> dentro no repositorio execute o comando abaixo:

```bash
npm install
```
> testes automatizados
```bash
npm test
```
> checagem de tipos
```bash
npm run typecheck
```

> servidor (no terminal execute)
```bash
npm run server
``` 
> cliente (abra outro terminal no mesmo repositorio e execute)
```bash
npm run client
```                

> Saída resumida do cliente de demonstração:

```text
[ok]    stub.add(2.5, 4.25)  (1.9 ms)
        2.5 + 4.25 = 6.75
[ok]    stub.div(1, 0) -> erro remoto  (2.1 ms)
        RemoteError recebido do servidor: "divisão por zero"
[ok]    timeout: sleep(1200) com timeout de 300 ms  (601.8 ms)
        RequestTimeoutError após 2 tentativa(s): o cliente desiste, mas o servidor continua executando
[ok]    concorrência: 30 chamadas add() simultâneas  (50.8 ms)
        30 respostas corretas em 50.2 ms (cada chamada tem seu requestId e sua porta UDP)
------------------------------------------------------------------------
13/13 etapas concluídas - tudo certo!
```
> volte ao terminal servidor e verá o exemplo: 
```bash
[18:33:47] req#1158963714 ping de 127.0.0.1:46001 -> ok em 0.6 ms
....
``` 

## Testes

`npm test` cobre:

- codec: ida e volta, big-endian, truncamento, tamanhos negativos, sobra de
  bytes;
- mensagem: layout de fio exato (37 bytes da requisição, resposta), eco de
  `requestId`, status desconhecido, datagrama truncado, datagrama grande demais;
- ponta a ponta: operações básicas, erro remoto, operação desconhecida,
  40 chamadas concorrentes, operação lenta sem bloquear as demais,
  at-most-once em retransmissão, timeout, `objectId` errado, datagrama
  malformado, duplicata no mesmo socket, expiração do cache e argumentos
  inválidos.

```text
ℹ tests 31
ℹ pass 31
ℹ fail 0
```

## Documentação

A documentação está dividida em três níveis:

| Arquivo | Conteúdo |
| --- | --- |
| `README.md` | visão geral, requisitos, comandos, testes e teste com o colega |
| `docs/FORMATO_MENSAGEM.md` | contrato de fio do protocolo: offsets, tipos, exemplos reais em hexdump, tabela de operações, semântica de entrega e pseudocódigo para implementar em outra linguagem |
| `docs/INTEROPERABILIDADE.md` | roteiro detalhado do item 2 (teste com o colega), checklist de erros comuns e formulário de registro |

Pontos importantes documentados em `docs/FORMATO_MENSAGEM.md`:

- todos os inteiros são **int32 big-endian**, strings são **tamanho + UTF-8** e
  vetores de bytes são **tamanho + bytes crus**;
- requisição de exemplo com **37 bytes** e resposta de exemplo com **24 bytes**,
  ambas com hexdump comentado campo a campo;
- `messageType` `0` = requisição e `1` = resposta; `status` `0` = OK e `1` =
  erro de aplicação;
- tabela de `operationId`s e do marshalling de cada operação;
- garantias sobre UDP (timeout, retransmissão, cache de duplicatas,
  at-most-once) e o que fazer em cada situação;
- pseudocódigo de `doOperation` e dicas para Java (`ByteBuffer`),
  Python (`struct.pack(">i", ...)`) e C (`htonl`).

Para ver os bytes que realmente trafegam:

```bash
DEBUG_WIRE=1 npm run ping -- --host 127.0.0.1 --port 4000
```

O código do protocolo é independente da aplicação: `src/protocol/` não conhece
`add` nem `ping`; `src/service/operations.ts` é só o serviço de exemplo. Isso é
o que permite trocar o serviço sem mexer no protocolo.

## Como testar com um colega (item 2)

O protocolo só está pronto quando **duas implementações independentes
conversam**. O teste deve ser feito nos dois sentidos: o seu cliente contra o
servidor dele e o cliente dele contra o seu servidor.

### Antes de começar

- os dois na mesma rede local (ou VPN) e com a porta UDP liberada no firewall
  (`sudo ufw allow 4000/udp` no Linux, ou permitir o Node na rede privada no
  Windows);
- escolham uma porta livre (ex.: `4000`) e um `objectId` (ex.: `1`);
- o servidor precisa escutar em `0.0.0.0` (padrão do projeto) — se escutar em
  `127.0.0.1`, ninguém de fora conecta;
- descubra seu IP: `ip -4 addr show | grep inet` (Linux), `ipconfig` (Windows)
  ou `ipconfig getifaddr en0` (macOS). O banner do servidor também mostra os
  IPs da máquina.

### Sentido A — seu cliente contra o servidor do colega

Na máquina do colega:

```bash
npm run server -- --port 4000 --object 1
```

Na sua máquina:

```bash
# 1. uma chamada só: se isso falhar, nada mais vai funcionar
npm run ping -- --host <IP-do-colega> --port 4000 --object 1

# 2. verificação de interoperabilidade (6 checagens PASS/WARN/FAIL)
npm run probe -- --host <IP-do-colega> --port 4000 --object 1

# 3. bateria funcional completa
npm run client -- --host <IP-do-colega> --port 4000 --object 1
```

Se o colega implementou em outra linguagem, os passos 1 e 2 continuam valendo:
eles usam apenas o formato de fio documentado. O passo 3 só funciona se ele
também implementou os mesmos `operationId`s e o mesmo marshalling de aplicação.

### Sentido B — cliente do colega contra o seu servidor

Na sua máquina:

```bash
npm run server -- --port 4000 --object 1
```

O banner mostra os IPs. Peça ao colega para rodar o cliente/probe dele apontando
para `<seu-IP>:4000`. Enquanto ele chama, seu terminal registra cada requisição:

```text
[18:33:47] req#1158963714 ping de 192.168.0.20:51544 -> ok em 0.6 ms
[18:33:48] req#1158963715 duplicada: retransmissão: reenviando resposta do cache (operação NÃO foi executada de novo)
```

Se nada aparecer, o problema é de rede/porta/firewall. Se aparecer
`ignorado: datagrama inválido`, o datagrama chegou, mas o formato não bate.

### O que o `probe` verifica

| # | Verificação | PASS significa |
| - | --- | --- |
| 1 | `doOperation()` completo | o ciclo requisição → execução → resposta fechou |
| 2 | correlação de `requestId` | a resposta traz o mesmo id enviado |
| 3 | retransmissão duplicada | a operação não executou duas vezes (WARN se o servidor só descarta a duplicata) |
| 4 | operação desconhecida | devolve erro de aplicação em vez de derrubar ou ignorar |
| 5 | datagrama malformado | lixo na rede não derruba o servidor |
| 6 | latência | 10 chamadas seguidas, com mínimo/média/máximo |

`FAIL` em 1, 2 ou 5 indica incompatibilidade real. `WARN` em 3 ou 4 é uma
diferença de política (por exemplo, descartar duplicatas em silêncio), não
necessariamente um erro.

### Registro para entregar

Depois dos dois sentidos, preencha a tabela e cole a saída do `probe` em
`docs/INTEROPERABILIDADE.md`. O formulário já está pronto no arquivo.

### Problemas comuns

| Sintoma | Causa provável |
| --- | --- |
| timeout em tudo | firewall, IP errado ou servidor escutando em `127.0.0.1` |
| resposta com `requestId` diferente | servidor gerou um id novo em vez de ecoar |
| `messageType` não é 1 | servidor devolveu a própria requisição ou lixo |
| "datagrama inválido" no servidor | ordem dos campos, endianness ou falta do prefixo de tamanho |
| `ping` funciona, `add` falha | marshalling de aplicação diferente (float64 big-endian) |
| funciona local, falha entre máquinas | portas bloqueadas, redes diferentes ou VPN com NAT |
| resposta grande some | resultado passou de 65.507 bytes (limite do UDP) |

Dica: rode os dois lados com `DEBUG_WIRE=1` e compare o primeiro datagrama com
o exemplo de `docs/FORMATO_MENSAGEM.md`.

