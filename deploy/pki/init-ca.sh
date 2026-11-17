#!/usr/bin/env bash
# Создание УЦ для клиентских сертификатов. Запускать один раз от root.
set -euo pipefail
PKI=${PKI:-/etc/wsp-anonymizer/pki}
# Пароль ключа УЦ спросят интерактивно (или передайте в CA_PASS)
POUT=(); PIN=(); [[ -n ${CA_PASS:-} ]] && POUT=(-passout env:CA_PASS) && PIN=(-passin env:CA_PASS)
HERE="$(cd "$(dirname "$0")" && pwd)"
[[ -f $PKI/ca.crt ]] && { echo "УЦ уже существует: $PKI/ca.crt"; exit 1; }

install -d -m 0755 "$PKI"; install -d -m 0700 "$PKI/private" "$PKI/issued" "$PKI/out"
sed "s#^dir *=.*#dir               = $PKI#" "$HERE/openssl.cnf" > "$PKI/openssl.cnf"
touch "$PKI/index.txt"; echo 1000 > "$PKI/serial"; echo 1000 > "$PKI/crlnumber"

openssl genrsa -aes256 "${POUT[@]}" -out "$PKI/private/ca.key" 4096
chmod 600 "$PKI/private/ca.key"
openssl req -config "$PKI/openssl.cnf" -new -x509 -days 3650 "${PIN[@]}" -key "$PKI/private/ca.key" \
  -subj "/O=White Square Partners/CN=WSP Anonymizer Client CA" -extensions v3_ca -out "$PKI/ca.crt"
openssl ca -config "$PKI/openssl.cnf" "${PIN[@]}" -gencrl -out "$PKI/crl.pem"
chmod 644 "$PKI/ca.crt" "$PKI/crl.pem"
echo "Готово. УЦ: $PKI/ca.crt. Пароль ключа УЦ храните в Teampass."
