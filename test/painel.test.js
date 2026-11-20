const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { abrirBanco } = require('../src/db');
const { criarApp } = require('../src/api');
const { criarUsuario } = require('../src/auth');

async function subir(t, { email, drive } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mb-painel-'));
  fs.mkdirSync(path.join(dir, 'midia/thumb'), { recursive: true });
  const db = abrirBanco(':memory:');
  const add = (id, campos) => {
    const base = { id, origem: 'local', md5: id, phash: '0', espaco: 'Deck', caminho_origem: `/Users/x/${id}.jpg`, ...campos };
    const cols = Object.keys(base);
    db.prepare(`INSERT INTO assets (${cols}) VALUES (${cols.map(c => '@' + c)})`).run(base);
    fs.writeFileSync(path.join(dir, 'midia/thumb', `${id}.jpg`), 'jpg');
  };
  add('liberada', { aprovacao: 'aprovada', tem_crianca: 0, destinos: '["prop"]' });
  add('crianca', { aprovacao: 'aprovada', tem_crianca: 1 });
  add('pendente', { tem_crianca: 0 });
  criarUsuario(db, { email: 'admin@x.com', nome: 'Admin', senha: 'senha-longa-1', admin: true });
  criarUsuario(db, { email: 'equipe@x.com', nome: 'Equipe', senha: 'senha-longa-2' });
  const srv = criarApp({ db, dirDados: dir, email, drive }).listen(0);
  t.after(() => srv.close());
  const base = `http://127.0.0.1:${srv.address().port}`;
  const req = (rota, { cookie, metodo = 'GET', corpo, tipo = 'application/json', headers = {} } = {}) => fetch(base + rota, {
    method: metodo,
    headers: { ...(cookie && { Cookie: cookie }), ...(corpo !== undefined && { 'Content-Type': tipo }), ...headers },
    body: corpo === undefined ? undefined : (typeof corpo === 'string' ? corpo : JSON.stringify(corpo)),
  });
  const logar = async (email, senha) => {
    const r = await req('/api/painel/login', { metodo: 'POST', corpo: { email, senha } });
    return r.headers.get('set-cookie')?.split(';')[0];
  };
  return { req, logar, db, add, base };
}

test('sem sessão dá 401; login errado dá 401; cookie é HttpOnly', async (t) => {
  const { req } = await subir(t);
  assert.equal((await req('/api/painel/fotos')).status, 401);
  const errado = await req('/api/painel/login', { metodo: 'POST', corpo: { email: 'admin@x.com', senha: 'nao' } });
  assert.equal(errado.status, 401);
  const certo = await req('/api/painel/login', { metodo: 'POST', corpo: { email: 'admin@x.com', senha: 'senha-longa-1' } });
  assert.match(certo.headers.get('set-cookie'), /mb_sessao=.+HttpOnly; SameSite=Lax/);
});

test('equipe vê tudo, com a marca de exposição, sem o caminho do Mac', async (t) => {
  const { req, logar } = await subir(t);
  const cookie = await logar('equipe@x.com', 'senha-longa-2');
  const { fotos, total } = await (await req('/api/painel/fotos?ordem=recente', { cookie })).json();
  assert.equal(total, 3);
  assert.ok(fotos.every(f => f.caminho_origem === undefined && f.arquivo.endsWith('.jpg')));
  assert.deepEqual(Object.fromEntries(fotos.map(f => [f.id, f.exposta])), { liberada: true, crianca: false, pendente: false });
  const uma = await (await req('/api/painel/fotos/liberada', { cookie })).json();
  assert.equal(uma.arquivo, 'liberada.jpg');
  assert.equal(uma.caminho_origem, undefined);
  assert.deepEqual(uma.destinos, ['prop']);
  assert.equal((await req('/api/painel/midia/thumb/crianca.jpg', { cookie })).status, 200);
  const voc = await (await req('/api/painel/vocabulario', { cookie })).json();
  assert.equal(voc.TIPOS_EVENTO.Palestra, 'Corporativo');
  assert.ok(voc.GASTRONOMIA.includes('Buffet'), 'o filtro de gastronomia monta as opções desta lista');
  const fac = await (await req('/api/painel/facetas', { cookie })).json();
  assert.deepEqual(fac.uso, { liberada: 1, interno: 2 });
});

test('só admin aprova; POST sem JSON é recusado', async (t) => {
  const { req, logar } = await subir(t);
  const equipe = await logar('equipe@x.com', 'senha-longa-2');
  const admin = await logar('admin@x.com', 'senha-longa-1');
  const corpo = { ids: ['pendente'], aprovar: true };
  assert.equal((await req('/api/painel/fotos/aprovar', { cookie: equipe, metodo: 'POST', corpo })).status, 403);
  assert.equal((await req('/api/painel/fotos/aprovar', { cookie: admin, metodo: 'POST', corpo: 'ids=pendente', tipo: 'application/x-www-form-urlencoded' })).status, 415);
  const r = await req('/api/painel/fotos/aprovar', { cookie: admin, metodo: 'POST', corpo });
  assert.deepEqual(await r.json(), { n: 1 });
  const f = await (await req('/api/painel/fotos/pendente', { cookie: equipe })).json();
  assert.equal(f.aprovado_por_nome, 'Admin');
  assert.equal(f.exposta, true);
});

test('edição valida e devolve a foto atualizada', async (t) => {
  const { req, logar } = await subir(t);
  const cookie = await logar('equipe@x.com', 'senha-longa-2');
  const ruim = await req('/api/painel/fotos/liberada', { cookie, metodo: 'PATCH', corpo: { espaco: 'Varanda' } });
  assert.deepEqual(await ruim.json(), { erros: ['valor inválido em espaco'] });
  const bom = await (await req('/api/painel/fotos/liberada', { cookie, metodo: 'PATCH', corpo: { espaco: 'Arena', tier: 'hero' } })).json();
  assert.equal(bom.local, 'Parque Exemplo');
  assert.equal(bom.aprovacao, 'pendente');
  assert.equal((await req('/api/painel/fotos/nada', { cookie, metodo: 'PATCH', corpo: { tier: 'hero' } })).status, 404);
});

test('coleção publicada mostra ao cliente só o que passa na regra', async (t) => {
  const { req, logar } = await subir(t);
  const cookie = await logar('equipe@x.com', 'senha-longa-2');
  const { id } = await (await req('/api/painel/colecoes', { cookie, metodo: 'POST', corpo: { nome: 'Proposta Ana' } })).json();
  await req(`/api/painel/colecoes/${id}/fotos`, { cookie, metodo: 'POST', corpo: { ids: ['liberada', 'crianca'] } });
  const interna = await (await req(`/api/painel/colecoes/${id}`, { cookie })).json();
  assert.equal(interna.fotos.length, 2);
  assert.ok(interna.fotos.every(f => f.caminho_origem === undefined));
  const { url } = await (await req(`/api/painel/colecoes/${id}/publicar`, { cookie, metodo: 'POST', corpo: {} })).json();
  const dados = await (await req(`${url}/dados`)).json();
  assert.deepEqual(dados.fotos.map(f => f.id), ['liberada']);
  assert.equal((await req(`${url}/midia/thumb/liberada.jpg`)).status, 200);
  assert.equal((await req(`${url}/midia/thumb/crianca.jpg`)).status, 404);
  assert.equal((await req('/c/nao-existe/dados')).status, 404);
  assert.equal((await req(`/api/painel/colecoes/${id}/publicar`, { cookie, metodo: 'DELETE' })).status, 204);
  assert.equal((await req(`${url}/dados`)).status, 404);
});

test('pontuação no visor sem Elo; rotas de Marcar e Duelos saíram', async (t) => {
  const { req, logar, db } = await subir(t);
  const cookie = await logar('equipe@x.com', 'senha-longa-2');
  db.prepare("INSERT INTO pontuacao (asset_id, destino, elegivel, percentil) VALUES ('liberada', 'prop', 1, 80)").run();
  const f = await (await req('/api/painel/fotos/liberada', { cookie })).json();
  assert.deepEqual(f.pontuacao, [{ destino: 'prop', elegivel: 1, moodboard: null, score: null, percentil: 80 }]);
  assert.equal((await req('/api/painel/marcar/proxima?destino=prop', { cookie })).status, 404);
  assert.equal((await req('/api/painel/duelos/proximo?destino=prop', { cookie })).status, 404);
});

test('rota /esqueci-senha responde 200 igual para e-mail existente e inexistente e chama o enviar falso só no existente, sem token na resposta', async (t) => {
  const enviados = [];
  const emailFalso = {
    async enviar(msg) { enviados.push(msg); },
  };
  const { req } = await subir(t, { email: emailFalso });

  // inexistente responde 200 {ok: true}, sem token, e não chama enviar
  const resInexistente = await req('/api/painel/esqueci-senha', { metodo: 'POST', corpo: { email: 'ninguem@x.com' } });
  assert.equal(resInexistente.status, 200);
  const dadosInexistente = await resInexistente.json();
  assert.deepEqual(dadosInexistente, { ok: true });
  assert.equal(dadosInexistente.token, undefined);
  assert.equal(enviados.length, 0);

  // existente responde 200 {ok: true}, sem token, e chama enviar
  const resExistente = await req('/api/painel/esqueci-senha', { metodo: 'POST', corpo: { email: 'admin@x.com' } });
  assert.equal(resExistente.status, 200);
  const dadosExistente = await resExistente.json();
  assert.deepEqual(dadosExistente, { ok: true });
  assert.equal(dadosExistente.token, undefined);
  assert.equal(enviados.length, 1);
  assert.equal(enviados[0].para, 'admin@x.com');
  assert.equal(enviados[0].assunto, 'Redefinir senha do MediaBank');
  assert.match(enviados[0].html, /login\.html\?redefinir=[a-zA-Z0-9_-]+/);
  assert.match(enviados[0].html, /Admin/);

  // rota /redefinir-senha com o token gerado
  const token = enviados[0].html.match(/redefinir=([a-zA-Z0-9_-]+)/)[1];
  const redCurta = await req('/api/painel/redefinir-senha', { metodo: 'POST', corpo: { token, senha: 'curta' } });
  assert.equal(redCurta.status, 400);
  assert.deepEqual(await redCurta.json(), { erro: 'A senha precisa ter pelo menos 10 caracteres.' });

  const redInvalido = await req('/api/painel/redefinir-senha', { metodo: 'POST', corpo: { token: 'invalido', senha: 'nova-senha-longa-1' } });
  assert.equal(redInvalido.status, 400);
  assert.deepEqual(await redInvalido.json(), { erro: 'Link inválido ou vencido. Peça um novo.' });

  const redOk = await req('/api/painel/redefinir-senha', { metodo: 'POST', corpo: { token, senha: 'nova-senha-longa-1' } });
  assert.equal(redOk.status, 200);
  assert.deepEqual(await redOk.json(), { ok: true });

  // token agora é inválido (já usado)
  const redReuso = await req('/api/painel/redefinir-senha', { metodo: 'POST', corpo: { token, senha: 'nova-senha-longa-1' } });
  assert.equal(redReuso.status, 400);
  assert.deepEqual(await redReuso.json(), { erro: 'Link inválido ou vencido. Peça um novo.' });

  // login com a nova senha funciona
  const loginOk = await req('/api/painel/login', { metodo: 'POST', corpo: { email: 'admin@x.com', senha: 'nova-senha-longa-1' } });
  assert.equal(loginOk.status, 200);
});

test('rotas /esqueci-senha e /redefinir-senha exigem application/json', async (t) => {
  const { req } = await subir(t);
  const r1 = await req('/api/painel/esqueci-senha', { metodo: 'POST', corpo: 'email=admin@x.com', tipo: 'application/x-www-form-urlencoded' });
  assert.equal(r1.status, 415);
  const r2 = await req('/api/painel/redefinir-senha', { metodo: 'POST', corpo: 'token=x&senha=1234567890', tipo: 'application/x-www-form-urlencoded' });
  assert.equal(r2.status, 415);
});

function extrairEntradasZip(buf) {
  const entradas = {};
  let i = 0;
  while (i < buf.length - 4) {
    if (buf.readUInt32LE(i) === 0x02014b50) {
      const compSize = buf.readUInt32LE(i + 20);
      const nomeLen = buf.readUInt16LE(i + 28);
      const extraLen = buf.readUInt16LE(i + 30);
      const commentLen = buf.readUInt16LE(i + 32);
      const localOffset = buf.readUInt32LE(i + 42);
      const nome = buf.toString('utf8', i + 46, i + 46 + nomeLen);
      const localNomeLen = buf.readUInt16LE(localOffset + 26);
      const localExtraLen = buf.readUInt16LE(localOffset + 28);
      const dataOffset = localOffset + 30 + localNomeLen + localExtraLen;
      const conteudo = buf.toString('utf8', dataOffset, dataOffset + compSize);
      entradas[nome] = conteudo;
      i += 46 + nomeLen + extraLen + commentLen;
    } else {
      i++;
    }
  }
  return entradas;
}

test('rotas de original e zip exigem login', async (t) => {
  const { req } = await subir(t);
  assert.equal((await req('/api/painel/fotos/liberada/original')).status, 401);
  assert.equal((await req('/api/painel/originais.zip', { metodo: 'POST', corpo: { ids: ['liberada'] } })).status, 401);
  assert.equal((await req('/api/painel/colecoes/1/originais.zip')).status, 401);
});

test('original dá 404 sem drive_id e 503 sem drive configurado', async (t) => {
  const { req, logar, add } = await subir(t);
  const cookie = await logar('equipe@x.com', 'senha-longa-2');

  const rSemDriveId = await req('/api/painel/fotos/liberada/original', { cookie });
  assert.equal(rSemDriveId.status, 404);
  assert.deepEqual(await rSemDriveId.json(), { erro: 'foto sem original no Drive' });

  const rInexistente = await req('/api/painel/fotos/nao-existe/original', { cookie });
  assert.equal(rInexistente.status, 404);

  add('com_drive', { drive_id: 'drv-sem-config' });
  const rSemDriveCfg = await req('/api/painel/fotos/com_drive/original', { cookie });
  assert.equal(rSemDriveCfg.status, 503);
});

test('original transmite o corpo com Content-Disposition e nome', async (t) => {
  const drive = {
    arquivo: async (id, campos) => ({ name: 'foto alta resolução.jpg', mimeType: 'image/jpeg' }),
    abrirOriginal: async (id) => ({ corpo: 'bytes-alta-resolucao', tipo: 'image/jpeg', tamanho: 20 }),
  };
  const { req, logar, add } = await subir(t, { drive });
  const cookie = await logar('equipe@x.com', 'senha-longa-2');

  add('foto_alta', { drive_id: 'drv-123' });

  const rDetalhe = await req('/api/painel/fotos/foto_alta', { cookie });
  const foto = await rDetalhe.json();
  assert.equal(foto.drive_url, 'https://drive.google.com/file/d/drv-123/view');
  assert.equal(foto.original_url, '/api/painel/fotos/foto_alta/original');

  const res = await req('/api/painel/fotos/foto_alta/original', { cookie });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.equal(res.headers.get('content-length'), '20');
  assert.equal(res.headers.get('content-disposition'), "attachment; filename*=UTF-8''foto%20alta%20resolu%C3%A7%C3%A3o.jpg");
  assert.equal(await res.text(), 'bytes-alta-resolucao');
});

test('POST form sem Origin do mesmo host é 403', async (t) => {
  const drive = {
    arquivo: async () => ({ name: 'f.jpg', mimeType: 'image/jpeg' }),
    abrirOriginal: async () => ({ corpo: 'x', tipo: 'image/jpeg', tamanho: 1 }),
  };
  const { req, logar, add, base } = await subir(t, { drive });
  const cookie = await logar('equipe@x.com', 'senha-longa-2');
  add('f1', { drive_id: 'd1' });

  const corpoForm = 'ids=' + encodeURIComponent(JSON.stringify(['f1']));

  const rSemOrigem = await req('/api/painel/originais.zip', {
    cookie,
    metodo: 'POST',
    corpo: corpoForm,
    tipo: 'application/x-www-form-urlencoded',
  });
  assert.equal(rSemOrigem.status, 403);

  const rOutroHost = await req('/api/painel/originais.zip', {
    cookie,
    metodo: 'POST',
    corpo: corpoForm,
    tipo: 'application/x-www-form-urlencoded',
    headers: { Origin: 'http://outro-host.com' },
  });
  assert.equal(rOutroHost.status, 403);

  const rOrigemCerta = await req('/api/painel/originais.zip', {
    cookie,
    metodo: 'POST',
    corpo: corpoForm,
    tipo: 'application/x-www-form-urlencoded',
    headers: { Origin: base },
  });
  assert.equal(rOrigemCerta.status, 200);
});

test('zip de 3 ids contém 3 arquivos, nome repetido ganha sufixo, foto com erro vai para o LEIA-ME', async (t) => {
  const drive = {
    arquivo: async (id) => {
      if (id === 'd1' || id === 'd2') return { name: 'evento.jpg', mimeType: 'image/jpeg' };
      if (id === 'd3') return { name: 'detalhe.jpg', mimeType: 'image/jpeg' };
      if (id === 'd4') return { name: 'falha.jpg', mimeType: 'image/jpeg' };
      throw new Error('drive id desconhecido');
    },
    abrirOriginal: async (id) => {
      if (id === 'd1') return { corpo: 'conteudo-foto-1' };
      if (id === 'd2') return { corpo: 'conteudo-foto-2' };
      if (id === 'd3') return { corpo: 'conteudo-foto-3' };
      if (id === 'd4') throw new Error('arquivo inacessivel no Drive');
      throw new Error('drive id desconhecido');
    },
  };
  const { req, logar, add } = await subir(t, { drive });
  const cookie = await logar('equipe@x.com', 'senha-longa-2');

  add('f1', { drive_id: 'd1' });
  add('f2', { drive_id: 'd2' });
  add('f3', { drive_id: 'd3' });
  add('f4', { drive_id: 'd4' });

  const rZip3 = await req('/api/painel/originais.zip', {
    cookie,
    metodo: 'POST',
    corpo: { ids: ['f1', 'f2', 'f3'] },
  });
  assert.equal(rZip3.status, 200);
  assert.equal(rZip3.headers.get('content-type'), 'application/zip');
  assert.equal(rZip3.headers.get('content-disposition'), "attachment; filename*=UTF-8''fotos-exemplo.zip");

  const bufZip3 = Buffer.from(await rZip3.arrayBuffer());
  const entradas3 = extrairEntradasZip(bufZip3);
  const nomes3 = Object.keys(entradas3).sort();
  assert.deepEqual(nomes3, ['detalhe.jpg', 'evento (2).jpg', 'evento.jpg']);
  assert.equal(entradas3['evento.jpg'], 'conteudo-foto-1');
  assert.equal(entradas3['evento (2).jpg'], 'conteudo-foto-2');
  assert.equal(entradas3['detalhe.jpg'], 'conteudo-foto-3');
  assert.equal(entradas3['LEIA-ME.txt'], undefined);

  const rZipErro = await req('/api/painel/originais.zip', {
    cookie,
    metodo: 'POST',
    corpo: { ids: ['f1', 'f4', 'liberada'] },
  });
  assert.equal(rZipErro.status, 200);
  const bufZipErro = Buffer.from(await rZipErro.arrayBuffer());
  const entradasErro = extrairEntradasZip(bufZipErro);
  const nomesErro = Object.keys(entradasErro).sort();
  assert.deepEqual(nomesErro, ['LEIA-ME.txt', 'evento.jpg']);
  assert.equal(entradasErro['evento.jpg'], 'conteudo-foto-1');
  assert.match(entradasErro['LEIA-ME.txt'], /f4.+arquivo inacessivel no Drive/);
  assert.match(entradasErro['LEIA-ME.txt'], /liberada.+sem original no Drive/);
});

test('GET /colecoes/:id/originais.zip gera zip com nome da coleção sanitizado', async (t) => {
  const drive = {
    arquivo: async (id) => ({ name: 'foto.jpg', mimeType: 'image/jpeg' }),
    abrirOriginal: async (id) => ({ corpo: 'dados-foto' }),
  };
  const { req, logar, add, db } = await subir(t, { drive });
  const cookie = await logar('equipe@x.com', 'senha-longa-2');

  add('f1', { drive_id: 'd1' });
  const colRes = await req('/api/painel/colecoes', {
    cookie,
    metodo: 'POST',
    corpo: { nome: 'Casamento Ana & Pedro' },
  });
  const { id: colId } = await colRes.json();
  await req(`/api/painel/colecoes/${colId}/fotos`, {
    cookie,
    metodo: 'POST',
    corpo: { ids: ['f1'] },
  });

  const rColZip = await req(`/api/painel/colecoes/${colId}/originais.zip`, { cookie });
  assert.equal(rColZip.status, 200);
  assert.equal(rColZip.headers.get('content-type'), 'application/zip');
  assert.equal(rColZip.headers.get('content-disposition'), "attachment; filename*=UTF-8''Casamento-Ana-Pedro.zip");

  const bufCol = Buffer.from(await rColZip.arrayBuffer());
  const entradasCol = extrairEntradasZip(bufCol);
  assert.deepEqual(Object.keys(entradasCol), ['foto.jpg']);
  assert.equal(entradasCol['foto.jpg'], 'dados-foto');
});

test('onboarding: /eu traz false para usuário novo e true depois do POST; POST sem login é 401', async (t) => {
  const { req, logar } = await subir(t);
  assert.equal((await req('/api/painel/onboarding', { metodo: 'POST', corpo: {} })).status, 401);
  const cookie = await logar('equipe@x.com', 'senha-longa-2');
  const antes = await (await req('/api/painel/eu', { cookie })).json();
  assert.equal(antes.onboarding_feito, false);
  const post = await req('/api/painel/onboarding', { cookie, metodo: 'POST', corpo: {} });
  assert.equal(post.status, 200);
  assert.deepEqual(await post.json(), { ok: true });
  const depois = await (await req('/api/painel/eu', { cookie })).json();
  assert.equal(depois.onboarding_feito, true);
});



