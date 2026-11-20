"""Trabalhador de vídeo do MediaBank (roda no Mac, fala com /api/lote do servidor).

Para cada vídeo pendente: baixa o original do Drive, gera a prévia de 540p e, sobre ela, corta em cenas,
tira o quadro-chave de cada cena, mede o tremido e a estética; o pôster sai do original. Entrega tudo ao
servidor e apaga o original local. Com --tarefas, também corta os trechos pedidos no painel ou na API.

Uso (na raiz do repositório):
  op run --env-file .env -- uv run --project py python py/videos.py [--limite N] [--tarefas] [--sem-estetica] [--transcrever]
Ambiente: MEDIABANK_URL, MEDIABANK_LOTE_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN.
"""
import argparse
import base64
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.parse
import urllib.request
from pathlib import Path

os.environ.setdefault('HF_HOME', str(Path.home() / '.cache' / 'mediabank-modelos'))

import cv2  # noqa: E402
import numpy as np  # noqa: E402
from PIL import Image  # noqa: E402

MAX_CENAS = 60
CENA_MIN_S = 1.0
LADO_PREVIA = 540
TREMIDO_LARGURA = 160


# ---------- servidor ----------

PARTE = 16 * 1024 * 1024  # o Traefik corta requisição de mais de 60 s; 16 MB sobem bem antes disso


def enviar_em_partes(url, chave, rota, arquivo):
    total = os.path.getsize(arquivo)
    n = max(1, -(-total // PARTE))
    with open(arquivo, 'rb') as f:
        for i in range(n):
            dados = f.read(PARTE)
            req = urllib.request.Request(f"{url.rstrip('/')}/api/lote{rota}?parte={i}{'&fim=1' if i == n - 1 else ''}", data=dados, method='PUT',
                                         headers={'X-API-Key': chave, 'Content-Type': 'video/mp4', 'Content-Length': str(len(dados))})
            with urllib.request.urlopen(req, timeout=120) as r:
                r.read()


def chamar(url, chave, rota, corpo=None, arquivo=None, metodo=None):
    cab = {'X-API-Key': chave}
    dados = None
    if corpo is not None:
        cab['Content-Type'] = 'application/json'
        dados = json.dumps(corpo).encode()
    elif arquivo is not None:
        cab['Content-Type'] = 'video/mp4'
        cab['Content-Length'] = str(os.path.getsize(arquivo))
        dados = open(arquivo, 'rb')
    req = urllib.request.Request(url.rstrip('/') + '/api/lote' + rota, data=dados, headers=cab,
                                 method=metodo or ('POST' if corpo is not None else 'PUT' if arquivo else 'GET'))
    try:
        with urllib.request.urlopen(req, timeout=600) as r:
            return json.loads(r.read() or b'null')
    finally:
        if hasattr(dados, 'close'):
            dados.close()


# ---------- Drive ----------

class Drive:
    def __init__(self):
        self.acesso, self.expira = None, 0

    def token(self):
        if self.acesso and time.time() < self.expira - 60:
            return self.acesso
        corpo = urllib.parse.urlencode({'client_id': os.environ['GOOGLE_CLIENT_ID'], 'client_secret': os.environ['GOOGLE_CLIENT_SECRET'],
                                        'refresh_token': os.environ['GOOGLE_REFRESH_TOKEN'], 'grant_type': 'refresh_token'}).encode()
        with urllib.request.urlopen('https://oauth2.googleapis.com/token', corpo, timeout=60) as r:
            j = json.load(r)
        self.acesso, self.expira = j['access_token'], time.time() + j['expires_in']
        return self.acesso

    def baixar(self, drive_id, destino):
        url = f'https://www.googleapis.com/drive/v3/files/{drive_id}?alt=media&supportsAllDrives=true'
        req = urllib.request.Request(url, headers={'Authorization': f'Bearer {self.token()}'})
        with urllib.request.urlopen(req, timeout=600) as r, open(destino, 'wb') as f:
            shutil.copyfileobj(r, f, 4 * 1024 * 1024)


# ---------- ffmpeg ----------

def sondar(arq):
    j = json.loads(subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-show_format', '-of', 'json', arq],
                                  capture_output=True, text=True, check=True).stdout)
    v = next(s for s in j['streams'] if s['codec_type'] == 'video')
    w, h = int(v['width']), int(v['height'])
    rot = int(v.get('tags', {}).get('rotate', 0) or 0)
    for sd in v.get('side_data_list', []):
        rot = int(sd.get('rotation', rot) or rot)
    if abs(rot) % 180 == 90:
        w, h = h, w
    num, den = (v.get('avg_frame_rate') or '0/1').split('/')
    # hora da gravação (o createdTime do Drive é a do upload): iPhone grava com fuso em com.apple.quicktime.creationdate
    tags = {**v.get('tags', {}), **j['format'].get('tags', {})}
    captura = tags.get('com.apple.quicktime.creationdate') or tags.get('creation_time')
    return {'duracao': float(j['format'].get('duration') or v.get('duration') or 0), 'fps': round(float(num) / float(den), 3) if float(den) else None,
            'codec': v.get('codec_name'), 'tem_audio': any(s['codec_type'] == 'audio' for s in j['streams']), 'largura': w, 'altura': h, 'captura': captura}


def gerar_previa(orig, destino, meta):
    # lado menor em 540 (a rotação já vem aplicada pelo ffmpeg); sem áudio; faststart para tocar enquanto baixa
    escala = f"scale='if(gt(iw,ih),-2,{LADO_PREVIA})':'if(gt(iw,ih),{LADO_PREVIA},-2)'"
    acel = ['-hwaccel', 'videotoolbox'] if sys.platform == 'darwin' else []
    subprocess.run(['ffmpeg', '-v', 'error', '-y', *acel, '-i', orig, '-vf', escala, '-c:v', 'libx264', '-preset', 'veryfast',
                    '-b:v', '1200k', '-maxrate', '1500k', '-bufsize', '2400k', '-pix_fmt', 'yuv420p', '-an', '-movflags', '+faststart', destino], check=True)


def quadro_original(orig, t, lado=1600):
    escala = f"scale='if(gt(iw,ih),{lado},-2)':'if(gt(iw,ih),-2,{lado})'"
    r = subprocess.run(['ffmpeg', '-v', 'error', '-ss', f'{t:.3f}', '-i', orig, '-frames:v', '1', '-vf', escala, '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', '-'],
                       capture_output=True, check=True)
    return r.stdout


# ---------- análise sobre a prévia ----------

class Previa:
    def __init__(self, arq):
        self.cap = cv2.VideoCapture(arq)
        self.fps = self.cap.get(cv2.CAP_PROP_FPS) or 30
        self.n = int(self.cap.get(cv2.CAP_PROP_FRAME_COUNT))

    def em(self, t):
        self.cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, min(self.n - 1, int(t * self.fps))))
        ok, q = self.cap.read()
        return q if ok else None


def cortar_cenas(arq, duracao):
    from scenedetect import open_video, SceneManager, AdaptiveDetector
    v = open_video(arq)
    sm = SceneManager()
    sm.add_detector(AdaptiveDetector(min_scene_len=max(1, int(CENA_MIN_S * (v.frame_rate or 30)))))
    sm.detect_scenes(v)
    cenas = [[a.get_seconds(), b.get_seconds()] for a, b in sm.get_scene_list()] or [[0.0, duracao]]
    cenas[-1][1] = max(cenas[-1][1], duracao)
    # filmagem longa: junta a cena mais curta com a vizinha até caber
    while len(cenas) > MAX_CENAS:
        i = min(range(len(cenas)), key=lambda k: cenas[k][1] - cenas[k][0])
        j = i - 1 if i == len(cenas) - 1 or (i > 0 and cenas[i - 1][1] - cenas[i - 1][0] < cenas[i + 1][1] - cenas[i + 1][0]) else i + 1
        a, b = sorted((i, j))
        cenas[a:b + 1] = [[cenas[a][0], cenas[b][1]]]
    return cenas


def dhash(img_bgr):
    # mesmo dHash de 64 bits do ingestao.js: cinza 9x8, compara vizinhos na linha
    g = cv2.resize(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY), (9, 8), interpolation=cv2.INTER_AREA)
    bits = ''.join('1' if g[y, x] > g[y, x + 1] else '0' for y in range(8) for x in range(8))
    return f'{int(bits, 2):016x}'


def nitidez(img_bgr):
    return float(cv2.Laplacian(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY), cv2.CV_64F).var())


def tremido(previa, ini, fim):
    """Tremido = variação do movimento global entre quadros vizinhos. Panorâmica suave dá pouco; câmera na mão balançando dá muito."""
    passo = 1 / 10
    ts = np.arange(ini + 0.1, max(ini + 0.2, fim - 0.1), passo)[:24]
    cinzas = []
    for t in ts:
        q = previa.em(t)
        if q is None:
            continue
        h = int(q.shape[0] * TREMIDO_LARGURA / q.shape[1])
        cinzas.append(cv2.cvtColor(cv2.resize(q, (TREMIDO_LARGURA, h), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2GRAY))
    if len(cinzas) < 4:
        return None
    mov = []
    for a, b in zip(cinzas, cinzas[1:]):
        fluxo = cv2.calcOpticalFlowFarneback(a, b, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        mov.append(np.median(fluxo.reshape(-1, 2), axis=0))
    mov = np.array(mov)
    return round(float(np.mean(np.linalg.norm(np.diff(mov, axis=0), axis=1))), 3)


def jpg_b64(img, qualidade=85):
    if isinstance(img, np.ndarray):
        img = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    b = io.BytesIO()
    img.convert('RGB').save(b, 'JPEG', quality=qualidade)
    return base64.b64encode(b.getvalue()).decode()


def montar_tira(previa, duracao):
    ts = [duracao * (k + 0.5) / 4 for k in range(4)]
    quadros = [q for q in (previa.em(t) for t in ts) if q is not None]
    h = 320
    imgs = [Image.fromarray(cv2.cvtColor(cv2.resize(q, (int(q.shape[1] * h / q.shape[0]), h), interpolation=cv2.INTER_AREA), cv2.COLOR_BGR2RGB)) for q in quadros]
    tira = Image.new('RGB', (sum(i.width for i in imgs), h))
    x = 0
    for i in imgs:
        tira.paste(i, (x, 0))
        x += i.width
    return tira


def transcrever(orig):
    try:
        import mlx_whisper
    except ImportError:
        print('mlx_whisper não instalado: sem transcrição', flush=True)
        return None
    r = mlx_whisper.transcribe(orig, path_or_hf_repo='mlx-community/whisper-large-v3-turbo', language='pt')
    return {'texto': r['text'].strip(), 'segmentos': [{'ini': s['start'], 'fim': s['end'], 'texto': s['text'].strip()} for s in r['segments']]}


def analisar(orig, previa_arq, estetica=None, com_transcricao=False):
    meta = sondar(orig)
    gerar_previa(orig, previa_arq, meta)
    meta['duracao'] = meta['duracao'] or sondar(previa_arq)['duracao']
    previa = Previa(previa_arq)
    cenas = []
    for ini, fim in cortar_cenas(previa_arq, meta['duracao']):
        q = previa.em((ini + fim) / 2)
        if q is None:
            continue
        c = {'ini': round(ini, 3), 'fim': round(fim, 3), 'quadro': jpg_b64(q), 'phash': dhash(q), 'tremido': tremido(previa, ini, fim)}
        if estetica:
            with tempfile.NamedTemporaryFile(suffix='.jpg') as tmp:
                Image.fromarray(cv2.cvtColor(q, cv2.COLOR_BGR2RGB)).save(tmp.name, quality=90)
                c['estetica'] = estetica(tmp.name)
        cenas.append(c)
    # pôster: o quadro mais nítido entre 10% e 30% da duração (o primeiro quadro costuma ser preto), tirado do original
    candidatos = [meta['duracao'] * f for f in (0.10, 0.15, 0.20, 0.25, 0.30)]
    t_poster = max(candidatos, key=lambda t: nitidez(q) if (q := previa.em(t)) is not None else -1)
    poster = quadro_original(orig, t_poster)
    meta['phash'] = dhash(cv2.imdecode(np.frombuffer(poster, np.uint8), cv2.IMREAD_COLOR))
    corpo = {'meta': meta, 'poster': base64.b64encode(poster).decode(), 'tira': jpg_b64(montar_tira(previa, meta['duracao'])), 'cenas': cenas}
    if com_transcricao and meta['tem_audio']:
        corpo['transcricao'] = transcrever(orig)
    previa.cap.release()
    return corpo


# ---------- trechos ----------

def cortar_trecho(orig, destino, p):
    """Corte exato (recodifica). Com -c copy o trecho começaria no keyframe anterior: no teste, 18 s para um pedido de 13 s."""
    ini, fim = float(p['ini']), float(p['fim'])
    lado = {'1080p': 1080, '540p': 540}.get(p.get('formato', 'original'))
    filtros = ["crop='min(iw,ih*9/16)':ih"] if p.get('vertical') else []
    if lado:
        filtros.append(f"scale='if(gt(iw,ih),-2,{lado})':'if(gt(iw,ih),{lado},-2)'")
    cmd = ['ffmpeg', '-v', 'error', '-y', '-ss', f'{ini:.3f}', '-i', orig, '-t', f'{fim - ini:.3f}', *(['-vf', ','.join(filtros)] if filtros else []),
           '-c:v', 'libx264', '-crf', '17', '-preset', 'medium', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', destino]
    subprocess.run(cmd, check=True)


# ---------- laço ----------

def baixar_original(url, chave, drive, v, destino):
    # do Drive (acervo de fotos) ou do volume do servidor (importação, ex.: banco de cenas)
    if v.get('drive_id'):
        return drive.baixar(v['drive_id'], destino)
    req = urllib.request.Request(f"{url.rstrip('/')}/api/lote/videos/{v.get('asset_id') or v['id']}/original", headers={'X-API-Key': chave})
    with urllib.request.urlopen(req, timeout=600) as r, open(destino, 'wb') as f:
        shutil.copyfileobj(r, f, 4 * 1024 * 1024)


def processar_videos(url, chave, drive, limite, estetica, com_transcricao, tmpdir, cliente=None, drive_ids=None):
    ok = erro = 0
    filtro = (f'&cliente={urllib.parse.quote(cliente)}' if cliente else '') + (f'&drive_ids={urllib.parse.quote(drive_ids)}' if drive_ids else '')
    for v in chamar(url, chave, f'/videos/pendentes?limite={limite}' + filtro):
        orig, prev = os.path.join(tmpdir, f'{v["id"]}.orig'), os.path.join(tmpdir, f'{v["id"]}.mp4')
        t0 = time.time()
        try:
            baixar_original(url, chave, drive, v, orig)
            corpo = analisar(orig, prev, estetica, com_transcricao)
            r = chamar(url, chave, f'/videos/{v["id"]}', corpo)
            enviar_em_partes(url, chave, f'/videos/{v["id"]}/previa', prev)
            ok += 1
            print(f'{v["id"]}: {r["cenas"]} cenas ({r["reprovadas"]} reprovadas), {os.path.getsize(orig) / 2**20:.0f} MB em {time.time() - t0:.0f} s', flush=True)
        except Exception as e:  # um vídeo ruim não para o lote
            erro += 1
            print(f'{v["id"]}: erro {e}', flush=True)
            try:
                chamar(url, chave, f'/videos/{v["id"]}/erro', {'erro': str(e)[:400]})
            except Exception:
                pass
        finally:
            for f in (orig, prev):
                if os.path.exists(f):
                    os.remove(f)
    return ok, erro


def processar_tarefas(url, chave, drive, tmpdir):
    feitas = 0
    for t in chamar(url, chave, '/tarefas/pendentes'):
        orig, saida = os.path.join(tmpdir, f't{t["id"]}.orig'), os.path.join(tmpdir, f't{t["id"]}.mp4')
        try:
            if t['tipo'] != 'trecho':
                raise ValueError(f'tipo de tarefa desconhecido: {t["tipo"]}')
            baixar_original(url, chave, drive, t, orig)
            cortar_trecho(orig, saida, t['parametros'])
            enviar_em_partes(url, chave, f'/tarefas/{t["id"]}/arquivo', saida)
            feitas += 1
        except Exception as e:
            chamar(url, chave, f'/tarefas/{t["id"]}/erro', {'erro': str(e)[:400]})
        finally:
            for f in (orig, saida):
                if os.path.exists(f):
                    os.remove(f)
    return feitas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limite', type=int, default=20)
    ap.add_argument('--tarefas', action='store_true', help='corta também os trechos pedidos')
    ap.add_argument('--sem-estetica', action='store_true')
    ap.add_argument('--transcrever', action='store_true')
    ap.add_argument('--cliente', help='só os vídeos deste cliente (ex.: outro)')
    ap.add_argument('--todos', action='store_true', help='segue de lote em lote até a fila acabar')
    ap.add_argument('--drive-ids', help='só estes arquivos do Drive, separados por vírgula')
    args = ap.parse_args()
    url, chave = os.environ.get('MEDIABANK_URL'), os.environ.get('MEDIABANK_LOTE_KEY')
    if not url or not chave:
        sys.exit('faltam MEDIABANK_URL e MEDIABANK_LOTE_KEY')
    estetica = None
    if not args.sem_estetica:
        import pyiqa
        import torch
        metrica = pyiqa.create_metric('laion_aes', device='mps' if torch.backends.mps.is_available() else 'cpu')
        estetica = lambda caminho: round(float(metrica(caminho).item()), 3)  # noqa: E731
    drive = Drive()
    with tempfile.TemporaryDirectory(prefix='mb-videos-') as tmpdir:
        if args.tarefas:
            print('trechos:', processar_tarefas(url, chave, drive, tmpdir), flush=True)
        total_ok = total_erro = 0
        while True:
            ok, erro = processar_videos(url, chave, drive, args.limite, estetica, args.transcrever, tmpdir, args.cliente, args.drive_ids)
            total_ok, total_erro = total_ok + ok, total_erro + erro
            print(f'lote: {ok} ok, {erro} erro (total {total_ok} ok, {total_erro} erro)', flush=True)
            if not args.todos or ok + erro == 0 or ok == 0:  # fila vazia, ou só erro (não fica em laço)
                break
    print(f'videos: {total_ok} ok, {total_erro} erro')


if __name__ == '__main__':
    sys.exit(main())
