# Item 2 da atividade: testar com a implementação de um colega

O protocolo só está "pronto" quando duas implementações independentes
conversam. Este roteiro cobre os dois sentidos e gera um registro para
entregar.

## Antes de começar

1. Os dois na **mesma rede local** (ou VPN). Anote o IP de cada máquina:
   - Linux: `ip -4 addr show | grep inet`
   - Windows: `ipconfig`
   - macOS: `ipconfig getifaddr en0`
2. Escolham uma **porta UDP** livre (ex.: `4000`) e um `objectId` (ex.: `1`).
3. O servidor precisa escutar em `0.0.0.0` (padrão do projeto) e o firewall
   precisa liberar a porta UDP:
   - Linux (ufw): `sudo ufw allow 4000/udp`
   - Windows: permitir o Node.js na rede privada
   - macOS: aceitar a notificação do firewall
4. Confirme que ninguém está usando a porta: `ss -lunp | grep 4000`.

## Sentido A — nosso cliente contra o servidor do colega

Na máquina do colega:

```bash
npm run server -- --port 4000 --object 1
```

Na nossa máquina:

```bash
npm run ping  -- --host <IP-do-colega> --port 4000 --object 1
npm run probe -- --host <IP-do-colega> --port 4000 --object 1
npm run client -- --host <IP-do-colega> --port 4000 --object 1
```

- `ping` = uma chamada. Se falhar aqui, nada mais vai funcionar: revise IP,
  porta, firewall e formato.
- `probe` = 6 verificações (PASS/WARN/FAIL). É o que documenta a
  interoperabilidade.
- `client` = bateria funcional completa. As operações além do `Ping` só
  funcionam se o colega implementou os mesmos `operationId`s e o mesmo
  marshalling de aplicação (`docs/FORMATO_MENSAGEM.md`, seção 3).

## Sentido B — cliente do colega contra o nosso servidor

Na nossa máquina:

```bash
npm run server -- --port 4000 --object 1
```

O banner mostra os nossos IPs. Na máquina do colega, ele roda o cliente/probe
dele apontando para `<nosso-IP>:4000`.

Enquanto isso, nosso servidor registra cada requisição:

```text
[20:57:05] req#7 add de 192.168.0.20:51544 -> ok em 0.3 ms
[20:57:06] req#8 duplicada: retransmissão: reenviando resposta do cache (operação NÃO foi executada de novo)
```

Se as linhas aparecerem, o datagrama dele chegou e decodificou no nosso
formato. Se não aparecer nada, o problema é de rede/porta; se aparecer
`ignorado: datagrama inválido`, o problema é de formato.

## O que o probe verifica

| # | Verificação                | PASS significa                                              |
| - | -------------------------- | ----------------------------------------------------------- |
| 1 | `doOperation()` completo   | o ciclo requisição → execução → resposta fechou             |
| 2 | correlação de `requestId`  | a resposta traz o mesmo id enviado                          |
| 3 | retransmissão duplicada    | a operação não executou duas vezes (WARN se não reenvia)    |
| 4 | operação desconhecida      | devolve erro de aplicação em vez de derrubar/ignorar        |
| 5 | datagrama malformado       | lixo na rede não derruba o servidor                         |
| 6 | latência                   | 10 chamadas seguidas, com mín/média/máx                     |

`FAIL` em 1, 2 ou 5 indica incompatibilidade real. `WARN` em 3 ou 4 é uma
diferença de política (por exemplo, descartar duplicatas em silêncio), não
necessariamente um erro.

## Depuração lado a lado

Rode os dois lados com o hexdump ligado:

```bash
DEBUG_WIRE=1 npm run ping -- --host <IP> --port 4000
```

Compare o primeiro datagrama com o exemplo de `docs/FORMATO_MENSAGEM.md`.
Checklist dos erros mais comuns:

| Sintoma                                      | Causa provável                                              |
| -------------------------------------------- | ----------------------------------------------------------- |
| timeout em tudo                              | firewall, IP errado, servidor em `127.0.0.1` em vez de `0.0.0.0` |
| resposta chega, mas `requestId` diferente     | servidor gerou um id novo em vez de ecoar                   |
| `messageType` não é 1                        | servidor devolveu a própria requisição ou lixo              |
| "datagrama inválido" no servidor             | ordem dos campos, endianness ou falta do prefixo de tamanho |
| funciona `Ping`, falha `add`                 | marshalling de aplicação diferente (float64 big-endian)     |
| funciona local, falha entre máquinas         | porta bloqueada, redes diferentes, VPN com NAT              |
| resposta grande some                         | resultado passou de 65.507 bytes (UDP não fragmenta aqui)   |

## Registro para entregar

Preencha com o colega (uma linha por sentido):

| Sentido                        | Aluno A (nós)        | Aluno B (colega)       | PASS/WARN/FAIL | Observações |
| ------------------------------ | -------------------- | ---------------------- | -------------- | ----------- |
| A: nosso cliente → servidor B  | `<nosso IP>:4000/1`  | `<IP colega>:4000/1`   |                |             |
| B: cliente B → nosso servidor  | `<nosso IP>:4000/1`  | `<IP colega>:4000/1`   |                |             |

Resultados do probe (cole uma linha por verificação):

```text
1. doOperation() completo .....
2. correlação de requestId ....
3. retransmissão duplicada ....
4. operação desconhecida ......
5. datagrama malformado .......
6. latência ...................
```

Nomes / matrículas:

- Aluno A: ______________________  Matrícula: __________
- Aluno B: ______________________  Matrícula: __________

Data do teste: ____ / ____ / ______
