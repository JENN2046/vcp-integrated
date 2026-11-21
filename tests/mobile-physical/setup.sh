#!/usr/bin/env bash
set -euo pipefail
control=${1:?Usage: bash tests/mobile-physical/setup.sh CONTROL_DIRECTORY}
mkdir -p "$control"
chmod 700 "$control"
cd "$control"
umask 077
if [[ -e hardware-ca.pem || -e loopback-key.pem ]]; then
    echo "A fixture CA or leaf key already exists. Use a fresh control directory." >&2
    exit 1
fi
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=VCP physical fixture CA' \
    -addext 'basicConstraints=critical,CA:TRUE,pathlen:0' -addext 'keyUsage=critical,keyCertSign,cRLSign' \
    -out hardware-ca.pem -keyout hardware-ca.key
openssl req -new -newkey rsa:2048 -nodes -subj '/CN=VCP physical fixture' -out leaf.csr -keyout loopback-key.pem
printf 'basicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1,DNS:localhost\n' > leaf.ext
openssl x509 -req -in leaf.csr -CA hardware-ca.pem -CAkey hardware-ca.key -set_serial 1 -days 1 -out loopback-cert.pem -extfile leaf.ext
openssl x509 -in hardware-ca.pem -outform der -out hardware-ca.der
rm hardware-ca.key leaf.csr leaf.ext
printf 'VCP physical attachment fixture 2026\n' > fixture-note.txt
