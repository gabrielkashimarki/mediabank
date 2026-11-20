"""Estética e embedding CLIP das fotos com st_tecnica = 'ok' e st_estetica = 'pendente'.

Uso (na raiz do repositório):
  uv run --project py python py/sinais.py [--limite N] [--moodboard]            banco local (DIR_DADOS)
  uv run --project py python py/sinais.py --remoto [--limite N] [--moodboard]   servidor (MEDIABANK_URL e MEDIABANK_LOTE_KEY)

--moodboard recalcula a média das referências em <DIR_DADOS>/moodboard/<destino>/*.jpg.
No modo remoto, o modelo roda no Mac e o resultado volta pela API /api/lote do servidor.
"""
import argparse
import base64
import json
import os
import tempfile
import urllib.request
import sqlite3
import sys
from pathlib import Path

# ~/.cache/huggingface costuma apontar para um HD externo; os modelos ficam num cache local próprio
os.environ.setdefault('HF_HOME', str(Path.home() / '.cache' / 'mediabank-modelos'))

import numpy as np  # noqa: E402
import torch  # noqa: E402
import pyiqa  # noqa: E402
import open_clip  # noqa: E402
from PIL import Image  # noqa: E402

DESTINOS = ['prop', 'social', 'site']
EXT = {'.jpg', '.jpeg', '.png', '.webp'}


def carregar(dispositivo):
    estetica = pyiqa.create_metric('laion_aes', device=dispositivo)
    modelo, _, preparo = open_clip.create_model_and_transforms('ViT-L-14', pretrained='openai', device=dispositivo)
    modelo.eval()

    def clip(caminho):
        img = preparo(Image.open(caminho).convert('RGB')).unsqueeze(0).to(dispositivo)
        with torch.no_grad():
            v = modelo.encode_image(img)[0].float().cpu().numpy()
        return (v / np.linalg.norm(v)).astype(np.float32)

    return (lambda caminho: float(estetica(str(caminho)).item())), clip


def processar_fotos(db, dir_dados, estetica, clip, limite):
    fila = db.execute("SELECT id FROM assets WHERE st_tecnica = 'ok' AND st_estetica = 'pendente' LIMIT ?", (limite,)).fetchall()
    ok = erro = 0
    for n, (asset_id,) in enumerate(fila, 1):
        caminho = dir_dados / 'midia' / 'preview' / f'{asset_id}.jpg'
        try:
            nota = estetica(caminho)
            vetor = clip(caminho)
            db.execute('INSERT OR REPLACE INTO emb_imagem (asset_id, vetor) VALUES (?, ?)', (asset_id, vetor.tobytes()))
            db.execute("UPDATE assets SET nota_estetica = ?, st_estetica = 'ok' WHERE id = ?", (nota, asset_id))
            ok += 1
        except Exception as e:  # uma foto ruim não para o lote
            db.execute("UPDATE assets SET st_estetica = 'erro', erro = ? WHERE id = ?", (f'estetica: {e}'[:500], asset_id))
            erro += 1
        db.commit()
        if n % 50 == 0:
            print(f'{n}/{len(fila)}', flush=True)
    db.commit()
    return ok, erro


def processar_moodboard(db, dir_dados, clip):
    resultado = {}
    # calcula todos os vetores antes de abrir a escrita
    vetores = {}
    for destino in DESTINOS:
        pasta = dir_dados / 'moodboard' / destino
        arquivos = [p for p in pasta.glob('*') if p.suffix.lower() in EXT] if pasta.is_dir() else []
        if not arquivos:
            vetores[destino] = None
            continue
        media = np.mean([clip(p) for p in arquivos], axis=0)
        vetores[destino] = ((media / np.linalg.norm(media)).astype(np.float32), len(arquivos))
    # agora persiste, um commit por destino
    for destino in DESTINOS:
        v = vetores[destino]
        if v is None:
            db.execute('DELETE FROM moodboard WHERE destino = ?', (destino,))
        else:
            vetor, n = v
            db.execute('INSERT OR REPLACE INTO moodboard (destino, vetor, n) VALUES (?, ?, ?)', (destino, vetor.tobytes(), n))
            resultado[destino] = n
        db.commit()
    return resultado


def chamar(url, chave, rota, corpo=None):
    req = urllib.request.Request(url.rstrip('/') + '/api/lote' + rota, method='POST' if corpo is not None else 'GET',
                                 headers={'X-API-Key': chave, 'Content-Type': 'application/json'},
                                 data=json.dumps(corpo).encode() if corpo is not None else None)
    with urllib.request.urlopen(req, timeout=60) as r:
        return r.read()


def processar_remoto(url, chave, estetica, clip, limite):
    ok = erro = 0
    ids = json.loads(chamar(url, chave, f'/pendentes?limite={limite if limite > 0 else 500}'))
    for n, asset_id in enumerate(ids, 1):
        with tempfile.NamedTemporaryFile(suffix='.jpg') as tmp:
            try:
                tmp.write(chamar(url, chave, f'/preview/{asset_id}.jpg'))
                tmp.flush()
                nota, vetor = estetica(tmp.name), clip(tmp.name)
                chamar(url, chave, '/sinais', {'id': asset_id, 'nota_estetica': nota, 'vetor': base64.b64encode(vetor.tobytes()).decode()})
                ok += 1
            except Exception as e:  # uma foto ruim não para o lote
                chamar(url, chave, '/erro', {'id': asset_id, 'erro': str(e)[:400]})
                erro += 1
        if n % 50 == 0:
            print(f'{n}/{len(ids)}', flush=True)
    return ok, erro


def moodboard_remoto(url, chave, dir_dados, clip):
    resultado = {}
    for destino in DESTINOS:
        pasta = dir_dados / 'moodboard' / destino
        arquivos = [p for p in pasta.glob('*') if p.suffix.lower() in EXT] if pasta.is_dir() else []
        if not arquivos:
            continue
        media = np.mean([clip(p) for p in arquivos], axis=0)
        media = (media / np.linalg.norm(media)).astype(np.float32)
        chamar(url, chave, '/moodboard', {'destino': destino, 'vetor': base64.b64encode(media.tobytes()).decode(), 'n': len(arquivos)})
        resultado[destino] = len(arquivos)
    return resultado


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--limite', type=int, default=-1)
    ap.add_argument('--moodboard', action='store_true')
    ap.add_argument('--remoto', action='store_true')
    args = ap.parse_args()
    dir_dados = Path(os.environ.get('DIR_DADOS', 'dados')).resolve()
    dispositivo = 'mps' if torch.backends.mps.is_available() else 'cpu'
    if args.remoto:
        url, chave = os.environ.get('MEDIABANK_URL'), os.environ.get('MEDIABANK_LOTE_KEY')
        if not url or not chave:
            sys.exit('faltam MEDIABANK_URL e MEDIABANK_LOTE_KEY')
        estetica, clip = carregar(dispositivo)
        if args.moodboard:
            print('moodboard:', moodboard_remoto(url, chave, dir_dados, clip))
        ok, erro = processar_remoto(url, chave, estetica, clip, args.limite)
        print(f'estetica: {ok} ok, {erro} erro')
        return
    db = sqlite3.connect(dir_dados / 'mediabank.db', timeout=60)
    estetica, clip = carregar(dispositivo)
    if args.moodboard:
        print('moodboard:', processar_moodboard(db, dir_dados, clip))
    ok, erro = processar_fotos(db, dir_dados, estetica, clip, args.limite)
    print(f'estetica: {ok} ok, {erro} erro')


if __name__ == '__main__':
    sys.exit(main())
