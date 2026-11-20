// Cliente mínimo da Drive API v3 com refresh token (escopo drive.readonly).
// Com driveId, lista e acompanha só aquele drive compartilhado (a conta pode ver outros drives).
// Toda chamada leva supportsAllDrives e includeItemsFromAllDrives: sem isso o Drive devolve 404 enganoso.

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://www.googleapis.com/drive/v3';
const CAMPOS_ARQUIVO = 'id,name,mimeType,md5Checksum,size,parents,owners(emailAddress),createdTime,modifiedTime,trashed,imageMediaMetadata(time)';
const CAMPOS_VIDEO = `${CAMPOS_ARQUIVO},videoMediaMetadata(width,height,durationMillis)`;
const TODOS = { supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' };

function criarDrive({ clientId, clientSecret, refreshToken, driveId = null, fetch = globalThis.fetch }) {
  const escopo = driveId ? { corpora: 'drive', driveId } : { corpora: 'allDrives' };
  let acesso = null, expira = 0;

  async function token() {
    if (acesso && Date.now() < expira - 60_000) return acesso;
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refreshToken, grant_type: 'refresh_token' }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(`Google token ${r.status}: ${j.error || 'sem detalhe'} ${j.error_description || ''}`.trim());
    acesso = j.access_token;
    expira = Date.now() + j.expires_in * 1000;
    return acesso;
  }

  async function get(rota, params = {}) {
    const url = `${API}${rota}?${new URLSearchParams({ ...TODOS, ...params })}`;
    const r = await fetch(url, { headers: { Authorization: `Bearer ${await token()}` } });
    if (!r.ok) throw new Error(`Drive ${r.status} em ${rota}: ${(await r.text()).slice(0, 200)}`);
    return r;
  }

  // arquivos que casam com q, página a página
  async function* listar(q, campos) {
    let pageToken;
    do {
      const j = await (await get('/files', {
        q, ...escopo, pageSize: '1000',
        fields: `nextPageToken,files(${campos})`, ...(pageToken && { pageToken }),
      })).json();
      yield* j.files;
      pageToken = j.nextPageToken;
    } while (pageToken);
  }

  return {
    // todas as imagens que a conta vê (dela e compartilhadas com ela)
    imagens: () => listar("mimeType contains 'image/' and trashed = false", CAMPOS_ARQUIVO),
    // vídeos, com duração e dimensões que o Drive já calculou (vazio enquanto o Drive processa)
    videos: () => listar("mimeType contains 'video/' and trashed = false", CAMPOS_VIDEO),
    async tokenInicial() {
      return (await (await get('/changes/startPageToken', driveId ? { driveId } : {})).json()).startPageToken;
    },
    // mudanças desde o token; devolve {arquivos, novoToken}
    async mudancas(desde) {
      const arquivos = [];
      let pageToken = desde, novoToken;
      while (pageToken) {
        const j = await (await get('/changes', {
          pageToken, pageSize: '1000', includeRemoved: 'false', spaces: 'drive', ...(driveId && { driveId }),
          fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${CAMPOS_ARQUIVO}))`,
        })).json();
        for (const c of j.changes) if (c.file) arquivos.push(c.file);
        pageToken = j.nextPageToken;
        novoToken = j.newStartPageToken || novoToken;
      }
      return { arquivos, novoToken };
    },
    async arquivo(id, campos) {
      const params = campos ? { fields: campos } : {};
      return (await get(`/files/${id}`, params)).json();
    },
    async baixar(id) {
      return Buffer.from(await (await get(`/files/${id}`, { alt: 'media' })).arrayBuffer());
    },
    async abrirOriginal(id) {
      const res = await get(`/files/${id}`, { alt: 'media' });
      const tipo = res.headers?.get ? res.headers.get('content-type') : (res.headers?.['content-type'] ?? null);
      const tamanhoRaw = res.headers?.get ? res.headers.get('content-length') : (res.headers?.['content-length'] ?? null);
      const tamanho = tamanhoRaw != null ? (Number.isNaN(Number(tamanhoRaw)) ? tamanhoRaw : Number(tamanhoRaw)) : null;
      return { corpo: res.body, tipo, tamanho };
    },
  };
}

module.exports = { criarDrive };
