#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="$SCRIPT_DIR/dist"
DEST_DIR="/home/kaizonaro/.hfs/plugins/directory-plugin"

if [[ ! -d "$SOURCE_DIR" ]]; then
	echo "Erro: diretório de origem não encontrado: $SOURCE_DIR"
	exit 1
fi

mkdir -p "$DEST_DIR"

# Copia o conteúdo de dist para o diretório de plugin alvo.
cp -a "$SOURCE_DIR"/. "$DEST_DIR"/

echo "Deploy concluído com sucesso."
echo "Origem: $SOURCE_DIR"
echo "Destino: $DEST_DIR"
