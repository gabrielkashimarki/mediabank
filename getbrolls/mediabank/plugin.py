"""Fonte do getbrolls que busca cenas de vídeo no MediaBank (API v2).

O MediaBank guarda os vídeos já cortados em cenas, descritos pela IA e com nota de take; os originais ficam no
Google Drive. A busca devolve um candidato por cena. A rota pede o trecho da cena (POST /midias/:id/trecho),
espera o trabalhador do MediaBank cortar (py/videos.py --tarefas, no Mac de quem cuida do acervo) e baixa o MP4.

Configuração (no .env do getbrolls ou no ambiente):
  MEDIABANK_URL    endereço do MediaBank, ex.: https://mediabank.exemplo.com ou http://127.0.0.1:3000
  MEDIABANK_CHAVE  chave com escopo v2 (node scripts/criar-chave.js getbrolls v2, no MediaBank)
  MEDIABANK_ESPERA segundos esperando o trecho ficar pronto (padrão 600)

GET em HTTPS passa pelo transporte do core (o host tem que estar em permissions.network). O SDK não tem POST,
então o pedido do trecho sai pelo urllib, só para o mesmo endereço de MEDIABANK_URL. MediaBank na mesma máquina
(127.0.0.1/localhost) é lido direto, porque o core só aceita IP público.
"""

import json
import time
import urllib.error
import urllib.parse
import urllib.request

from getbrolls.sdk import PluginError, ProviderCapabilities, RouteResult

LOCAIS = {"127.0.0.1", "localhost", "::1"}
# 30 s em 1080p fica muito abaixo do teto de 512 MB do core
JANELA_S = 30
FORMATO = "1080p"


class MediaBank:
    """Provider: busca cenas pela API v2 do MediaBank."""

    name = "mediabank"
    capabilities = ProviderCapabilities(
        search=True, match_kind="illustrative", env_key="MEDIABANK_CHAVE", transport="mediabank", route="mediabank"
    )

    def __init__(self, api):
        self.api = api

    def config(self):
        """Endereço da v2, se é a própria máquina e o cabeçalho com a chave."""
        base = (self.api.env("MEDIABANK_URL") or "").rstrip("/")
        chave = self.api.env("MEDIABANK_CHAVE")
        if not base or not chave:
            raise PluginError("Configure MEDIABANK_URL (endereço do MediaBank) e MEDIABANK_CHAVE (chave com escopo v2).")
        url = urllib.parse.urlsplit(base)
        if url.hostname not in LOCAIS and url.scheme != "https":
            raise PluginError("MEDIABANK_URL precisa ser https, ou http://127.0.0.1 para o MediaBank local.")
        return base + "/api/v2", url.hostname in LOCAIS, {"X-API-Key": chave}

    def get_json(self, rota, params=None):
        """GET na v2: pelo core em HTTPS, direto quando o MediaBank roda na própria máquina."""
        base, local, headers = self.config()
        if not local:
            return self.api.get_json(base + rota, params, headers=headers)
        url = base + rota + ("?" + urllib.parse.urlencode(params) if params else "")
        with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=30) as r:  # noqa: S310 - só loopback
            return json.load(r)

    def post_json(self, rota, corpo):
        """POST na v2 (o SDK só tem GET); sempre para o endereço de MEDIABANK_URL."""
        base, _, headers = self.config()
        req = urllib.request.Request(base + rota, data=json.dumps(corpo).encode(), method="POST",
                                     headers={**headers, "Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=30) as r:  # noqa: S310 - endereço configurado pela pessoa
                return json.load(r)
        except urllib.error.HTTPError as e:
            raise PluginError(f"O MediaBank recusou o pedido do trecho (HTTP {e.code}).") from None

    def download(self, rota, nome, workdir):
        """Baixa o arquivo pronto para a pasta de trabalho do core."""
        base, local, headers = self.config()
        if not local:
            return self.api.download(base + rota, nome, headers=headers)
        destino = workdir / nome
        with urllib.request.urlopen(urllib.request.Request(base + rota, headers=headers), timeout=300) as r, open(destino, "xb") as f:  # noqa: S310
            while bloco := r.read(1 << 20):
                f.write(bloco)
        return destino

    def search(self, query, limit, media):
        """Uma candidata por cena, na ordem da busca do MediaBank (texto da cena e imagem do quadro)."""
        if media == "image":
            return []
        data = self.get_json("/midias", {"q": query, "tipo": "video", "limite": limit})
        found = []
        for v in data.get("midias", []):
            for c in v.get("cenas") or []:
                if len(found) >= limit:
                    return found
                ini, fim = c["ini"], min(c["fim"], c["ini"] + JANELA_S)
                item = self.api.candidate(self.name, f"{v['id']}:{c['id']}", v.get("titulo") or "Cena sem título")
                item["media"].update(duration_s=round(fim - ini, 2), width=v.get("largura"), height=v.get("altura"), kind="video")
                motivo = " / ".join(str(x) for x in [c.get("descricao"), v.get("espaco"), f"nota de take {c.get('nota_take')}"] if x)
                item["match"].update(kind="illustrative", reason=motivo[:280] or None)
                item["creator"].update(name="MediaBank")
                found.append(item)
        return found

    def resolve(self, url):  # noqa: ARG002 - assinatura fixa de Provider.resolve
        """O MediaBank não tem URL pública de cena: sempre `None`."""
        return

    def refresh(self, item):
        """Nada expira: devolve `item` sem mudança."""
        return item


class TrechoDaCena:  # pylint: disable=too-few-public-methods  # contrato do SDK: rota é só um `prepare`
    """Rota de prévia: o acervo é da própria pessoa, não consome licença; traz o trecho da cena em MP4."""

    name = "mediabank"
    stage = "preview"

    def __init__(self, fonte):
        self.fonte = fonte

    def prepare(self, item, workdir):
        """Pede o trecho, espera o trabalhador cortar e baixa."""
        midia, cena = item["source_id"].split(":", 1)
        v = self.fonte.get_json(f"/midias/{urllib.parse.quote(midia)}")
        c = next((x for x in v.get("cenas") or [] if str(x["id"]) == cena), None)
        if not c:
            raise PluginError("A cena não está mais no MediaBank; rode a busca de novo.")
        pedido = self.fonte.post_json(f"/midias/{urllib.parse.quote(midia)}/trecho",
                                      {"ini": c["ini"], "fim": min(c["fim"], c["ini"] + JANELA_S), "formato": FORMATO, "vertical": False})
        tarefa = pedido["tarefa"]
        espera = int(self.fonte.api.env("MEDIABANK_ESPERA") or 600)
        limite = time.monotonic() + espera
        while time.monotonic() < limite:
            t = self.fonte.get_json(f"/tarefas/{tarefa}")
            if t.get("estado") == "pronta":
                return RouteResult(self.fonte.download(f"/tarefas/{tarefa}/arquivo", "trecho.mp4", workdir))
            if t.get("estado") == "erro":
                raise PluginError(f"O MediaBank não conseguiu cortar o trecho: {str(t.get('erro'))[:200]}")
            time.sleep(5)
        raise PluginError(f"O trecho não ficou pronto em {espera} s. O trabalhador do MediaBank (py/videos.py --tarefas) está rodando?")


def register(api):
    """Ponto de entrada do SDK: registra a fonte `mediabank` e a rota de prévia."""
    fonte = MediaBank(api)
    api.provider(fonte)
    api.route(TrechoDaCena(fonte))
