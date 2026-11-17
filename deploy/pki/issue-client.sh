#!/usr/bin/env bash
# Выпуск клиентского сертификата сотруднику.
#   ./issue-client.sh ivanov ivanov@whitesquarepartners.com
# Результат: /etc/wsp-anonymizer/pki/out/<login>.p12 — импортировать на ПК пользователя
# (двойной клик -> «Текущий пользователь», или через GPO / ManageEngine Endpoint Central).
set -euo pipefail
PKI=${PKI:-/etc/wsp-anonymizer/pki}
PIN=(); [[ -n ${CA_PASS:-} ]] && PIN=(-passin env:CA_PASS)
LOGIN=${1:?Укажите логин AD}; EMAIL=${2:-}; DAYS=${DAYS:-730}
[[ $LOGIN =~ ^[A-Za-z0-9._-]+$ ]] || { echo "Недопустимый логин"; exit 1; }
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

SUBJ="/O=White Square Partners/CN=$LOGIN"; [[ -n $EMAIL ]] && SUBJ="$SUBJ/emailAddress=$EMAIL"
openssl genrsa -out "$TMP/key.pem" 2048
openssl req -config "$PKI/openssl.cnf" -new -key "$TMP/key.pem" -subj "$SUBJ" -out "$TMP/req.csr"
openssl ca -config "$PKI/openssl.cnf" "${PIN[@]}" -batch -days "$DAYS" -extensions v3_client -in "$TMP/req.csr" -out "$TMP/cert.pem"

PASS=$(openssl rand -base64 12 | tr -d '/+=' | cut -c1-12)
# 3DES/SHA1 — чтобы файл импортировался и на старых Windows
openssl pkcs12 -export -inkey "$TMP/key.pem" -in "$TMP/cert.pem" -certfile "$PKI/ca.crt" \
  -name "WSP Anonymizer - $LOGIN" -out "$PKI/out/$LOGIN.p12" -passout "pass:$PASS" \
  -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES -macalg sha1
chmod 600 "$PKI/out/$LOGIN.p12"
SERIAL=$(openssl x509 -in "$TMP/cert.pem" -noout -serial | cut -d= -f2)
echo "Сертификат: $PKI/out/$LOGIN.p12  (серийный номер $SERIAL, срок $DAYS дн.)"
echo "Пароль для импорта: $PASS   — передайте пользователю отдельным каналом"
