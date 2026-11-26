# Como o MediaBank funciona

O MediaBank é o banco de fotos e vídeos de um ou mais clientes. Ele lê o acervo no Google Drive, descreve cada
imagem e cada cena de vídeo com IA, guarda tudo num SQLite com busca por significado e entrega o material para
pessoas (painel), para agentes (MCP) e para outros sistemas (API v1, API v2 e o plugin do get-brolls).

## Peças

| Peça | Onde | O que faz |
|---|---|---|
| Servidor | `server.js`, `src/` (Node 22, Express 5, better-sqlite3, sqlite-vec) | Painel, APIs, MCP, agendador |
| Banco | `dados/mediabank.db` (em produção, `/dados` no container) | Assets, cenas, vetores, clientes, guias, peças |
| Trabalhador | `py/videos.py` e `py/sinais.py` (no Mac, com `uv`) | O que pesa: vídeo (prévia, cenas, tremido, estética, trechos) e estética das fotos |
| Vocabulário | `src/vocabularios/<cliente>.js` | Listas fechadas, prompts e regras de exposição de cada cliente |
| Painel | `public/` | Biblioteca, vídeos, coleções, revisão de peças, guias |
| Plugin do get-brolls | biblioteca de plugins do get-brolls | O get-brolls busca cenas do MediaBank e traz o trecho |

## Do Drive ao acervo

### Fotos
1. **Sync** (`src/sync.js`, a cada ciclo do agendador com `SYNC_AUTOMATICO=1`): lista as mudanças do Drive compartilhado,
   baixa só imagem nova (pula pelo id do Drive e pelo md5) e gera thumb (600 px) e prévia (1600 px).
2. **Portão técnico** (`src/tecnica.js`): reprova foto pequena, sem foco ou mal exposta.
3. **IA** (`src/ia.js`, `IA_AUTOMATICA=1`): um modelo de visão pelo OpenRouter preenche título, descrição, espaço,
   tipo de evento, luz, plano, pessoas, crianças, marca de terceiro e seis notas de qualidade, sempre dentro do
   vocabulário do cliente. Valor fora da lista é recusado.
4. **Embedding** do texto (`text-embedding-3-small`) vai para `vec_texto`, que é o que a busca usa.
5. **Curadoria** (`src/curadoria.js`): estética (do trabalhador), rubrica da IA e moodboard viram uma nota por
   destino (`prop`, `social`, `site`) e o tier (`hero`, `social`, `arquivo`, `variacao`, `descartar`).

### Vídeos
1. **Sync sem download** (`SYNC_VIDEO=1`): o servidor registra o vídeo só com o metadado do Drive
   (`st_video = 'pendente'`). Ele nunca baixa vídeo.
2. **Trabalhador do Mac** (`uv run --project py python py/videos.py`): pede os pendentes, baixa o original, gera a
   prévia em 540p, corta em cenas (PySceneDetect), mede tremido e estética, extrai pôster, tira e um quadro por cena,
   e devolve tudo para `/api/lote`. Opções: `--limite`, `--cliente`, `--todos`, `--transcrever` (Whisper local),
   `--tarefas` (corta os trechos pedidos pela API).
3. **IA por grade de quadros** (`src/video.js`, `IA_VIDEO=1`): até 16 quadros numerados numa imagem; a IA descreve
   o vídeo e cada cena.
4. **Busca de vídeo** (`src/busca_video.js`): junta a semelhança da frase com o texto da cena e com a imagem do quadro
   (`emb_quadro`). Takes repetidos viram um grupo e só o melhor aparece. A **nota de take** (`src/takes.js`) ordena
   quando não há frase.
5. **Trecho**: `POST /api/v2/midias/:id/trecho` cria uma tarefa; o trabalhador com `--tarefas` corta do original
   (com recorte 9:16 se pedido) e sobe o MP4; quem pediu baixa em `/api/v2/tarefas/:id/arquivo`.

## Clientes e acesso

- **Cliente** (`src/clientes.js`): tudo tem `cliente_id`. Cada cliente tem seu vocabulário, sua regra de exposição
  e seus guias. Para criar um cliente novo: um arquivo em `src/vocabularios/`, o registro em `src/clientes.js` e a pasta
  do Drive. O repositório traz dois clientes fictícios de exemplo: `exemplo` (Casa Exemplo, acervo de fotos de um
  espaço de eventos, é o cliente padrão) e `outro` (Marca Exemplo, banco de cenas para anúncios em vídeo).
- **Pessoas**: `membros` liga usuário a cliente com papel `admin`, `editor` ou `leitor`. Convite por e-mail
  (`scripts/convidar.js`), link válido por 7 dias.
- **Chaves** (`node scripts/criar-chave.js <nome> --cliente <slug> --escopo "<escopos>"`; a chave sai uma vez só no stdout):
  - `v1`: API de fotos aprovadas (site, bot de atendimento).
  - `v2`: API de vídeo e imagem do cliente, só o aprovado e liberado.
  - `v2 acervo`: a mesma v2 vendo o acervo interno do cliente (o que ainda não foi aprovado entra; criança, descartado
    e sem autorização nunca). Use para a própria equipe, como o get-brolls.
  - `mcp`: o conector do Claude (`/mcp/<chave>`), acervo interno.
  - `lote`: o trabalhador do Mac.
- **Exposição**: nada com criança, descartado ou sem autorização sai. Para fora (v1, v2, link público) só sai o aprovado.

## Tags e filtros

- **Tags**: de 8 a 15 palavras-chave curtas por mídia (objetos, ação, clima, luz e sinônimos), em minúsculas. A IA preenche junto com a
  descrição; para o que já foi classificado antes, `node scripts/tags-das-descricoes.js` gera a partir do título e da descrição
  (só texto, custa uma fração da IA de visão). Aparecem como chips na ficha (clicar filtra), viram faceta na lateral (as 40 mais
  comuns do recorte; marcar duas traz o que tem as duas) e podem ser editadas no visor.
- **Tags por take**: no vídeo, cada cena tem as próprias tags (3 a 8, só do que aparece naquele trecho), e o vídeo mostra as mais
  frequentes entre as cenas. O filtro por tag acha o take, não o vídeo inteiro, e o texto da busca de cada cena usa as tags dela.
  `node scripts/tags-das-descricoes.js --cenas` preenche as cenas classificadas antes, a partir da descrição de cada uma.
- **Na busca**: as tags entram no mesmo texto que vira vetor, junto com o título e a descrição. Numa medição com 200 buscas, isso
  levou o resultado certo para os 5 primeiros em 93% das vezes, contra 86% só com a descrição. O casamento exato de palavra
  com a tag piorou a ordem, por isso a tag serve para navegar e filtrar, não para pontuar.
- **Vídeos**: a aba Vídeos usa a mesma lateral da Biblioteca (local, espaço, evento, assunto, luz, plano, tags) e tem ainda
  **Uso** (TV e telão, rede social, anúncio e institucional, captação), **Formato** (horizontal ou vertical), nota mínima e pessoas.
  O uso vem da IA de vídeo e mora em `etiquetas.uso`.
- **Função do vídeo**: B-roll, Insert, Abertura, Fala para câmera, Registro de convidados, Bastidor ou Editado, preenchida pela IA
  de vídeo (`etiquetas.funcao`). Serve para achar B-roll sem trazer gente falando para a câmera. Filtro na aba Vídeos, `funcao` na
  v2 e no MCP.
- **Artes gráficas**: posts, flyers e cardápios com texto ou grafismo sobre a imagem (`tem_texto` da IA). A Biblioteca filtra
  "Só fotos" ou "Só artes gráficas", e arte gráfica nunca vira hero na curadoria.
- **Link próprio**: ao abrir uma foto ou um vídeo, a URL vira `#foto/<id>` ou `#video/<id>`; colar o link abre direto na mídia.
- Na API v2 e no MCP: `tag` (pode repetir), `et_uso`, `et_funcao` e `orientacao`.

## Classificar vídeo pela assinatura do Claude (sem IA paga)

Com `IA_VIDEO_FORA=<cliente>` no servidor, a IA paga deixa de classificar os vídeos desse cliente. Eles ficam na fila da
assinatura:

1. `node scripts/classificar-pela-assinatura.js baixar <pasta> --limite 40 --cliente <slug>` grava as instruções (as mesmas
   da IA, com o vocabulário do cliente), a lista de vídeos e as grades de quadros numerados de cada um.
2. O Claude (ou subagentes dele) olha as grades e escreve um JSON por vídeo, no formato das instruções.
3. `node scripts/classificar-pela-assinatura.js enviar <arquivo.json>` manda para `/api/lote/videos/:id/analise`; o servidor
   valida contra o vocabulário e grava como se a IA tivesse respondido.

Dá para agendar a rodada (por exemplo, uma tarefa do Claude a cada 4 horas) e deixar o trabalhador do Mac processando a fila em
paralelo.

## Painel

- **Biblioteca** de fotos e **Vídeos**: busca por frase, facetas, visor, edição de campos, aprovação, coleções e link
  público de coleção.
- **Revisão**: peças em edição (vídeos montados) revisadas plano a plano: aprovar, reprovar com motivo ou trocar o
  plano por outro candidato, respeitando a regra de não repetir. Cada render novo vira uma versão.
- **Guias**: brandbook e playbook de edição do cliente, em Markdown ou HTML, com histórico de versões. O Claude lê pelo
  MCP (`ler_guia`) e a API v2 (`/api/v2/guias`).

## Para agentes e sistemas

| Quem | Como | Principais rotas |
|---|---|---|
| Claude (claude.ai ou Claude Code) | MCP em `/mcp/<chave>` | `buscar_fotos`, `ver_foto`, `buscar_videos`, `ver_video`, `ler_guia`, `pedir_trecho` |
| Site, bot de atendimento | API v1, cabeçalho `X-API-Key` | `/api/v1/fotos`, `/api/v1/fotos/sugerir`, `/api/v1/catalogo` |
| Edição (Remotion, scripts) | API v2, cabeçalho `X-API-Key` | `/api/v2/midias`, `/midias/:id`, `/midias/:id/trecho`, `/tarefas/:id`, `/pecas`, `/guias` |
| get-brolls | plugin `mediabank` | busca cenas e traz o trecho pela v2 |

## Plugin do get-brolls

O plugin não fala com o Google: o get-brolls chama o plugin, o plugin chama a API v2 do MediaBank e o MediaBank
(com o trabalhador) lê o Drive.

1. No MediaBank: `node scripts/criar-chave.js getbrolls --cliente <slug> --escopo "v2 acervo"`.
2. Deixe o trabalhador com `--tarefas` rodando, porque é ele que corta os trechos.
3. O plugin `mediabank` é distribuído pela biblioteca de plugins da comunidade do get-brolls, não por este
   repositório (a inclusão está em revisão). Com a biblioteca adicionada, instale em dois passos: `getbrolls plugins --action install --id
   mediabank@getbrolls-plugins` mostra a prévia, e o comando que ela traz em `next` confirma.
4. No `.env` do get-brolls: `MEDIABANK_URL=https://seu-mediabank` e `MEDIABANK_CHAVE=<chave>`
   (opcional `MEDIABANK_ESPERA`, segundos de espera pelo trecho, padrão 600).
5. O host do seu MediaBank precisa estar em `permissions.network` do manifesto do plugin. MediaBank rodando na mesma máquina (`http://127.0.0.1`) não precisa.

Cada cena vira um candidato. A prévia traz até 30 s da cena em 1080p; a aprovação, os direitos e a entrega continuam
sendo do get-brolls (o `permit` é humano).

## Instalar

### Local (Mac)
1. `npm ci` e `cp .env.example .env` (valores ou referências `op://`, se usar 1Password).
2. Drive: crie um cliente OAuth "App para computador" no Google Cloud Console do seu Workspace, rode
   `node scripts/autorizar-drive.js` e guarde `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` e `GOOGLE_REFRESH_TOKEN`.
   Sem Drive, `node scripts/importar-pasta.js <pasta>` importa de uma pasta local (inclusive a do Google Drive para
   computador).
3. `OPENROUTER_API_KEY` para a IA e o embedding.
4. `node scripts/criar-usuario.js` e `npm start`.
5. Trabalhador: `cd py && uv sync`, depois rode `uv run python videos.py` com `MEDIABANK_URL`, `MEDIABANK_LOTE_KEY`
   (chave `lote`) e as mesmas `GOOGLE_*` no ambiente, porque é ele que baixa os vídeos do Drive.

### Servidor (Docker)
O `Dockerfile` monta a imagem; `deploy/stack.yml` é o exemplo de stack Swarm com Traefik (troque domínio, rede e
variáveis). Variáveis principais: `DIR_DADOS`, `PORT`, `BASE_URL`, `AGENDADOR`, `SYNC_AUTOMATICO`, `SYNC_VIDEO`,
`IA_AUTOMATICA`, `IA_VIDEO`, `OPENROUTER_API_KEY`, `GOOGLE_*`, `DRIVE_ID`, `SMTP_*`.

## Testes

`npm test` (Node test runner). O trabalhador Python não tem teste automático; confira com um vídeo curto.
