#!/usr/bin/env bash
# Отзыв сертификата (увольнение, утеря ПК):  ./revoke-client.sh ivanov
set -euo pipefail
PKI=${PKI:-/etc/wsp-anonymizer/pki}
PIN=(); [[ -n ${CA_PASS:-} ]] && PIN=(-passin env:CA_PASS)
LOGIN=${1:?Укажите логин}
found=0
# index.txt: статус 	 срок 	 дата_отзыва 	 серийный 	 файл 	 subject
for serial in $(awk -F'	' -v cn="/CN=$LOGIN" '$1=="V" && (index($6, cn"/") || substr($6, length($6)-length(cn)+1)==cn) {print $4}' "$PKI/index.txt"); do
  openssl ca -config "$PKI/openssl.cnf" "${PIN[@]}" -revoke "$PKI/issued/$serial.pem" -crl_reason cessationOfOperation
  found=1
done
[[ $found == 1 ]] || { echo "Действующих сертификатов для $LOGIN не найдено"; exit 1; }
openssl ca -config "$PKI/openssl.cnf" "${PIN[@]}" -gencrl -out "$PKI/crl.pem"
chmod 644 "$PKI/crl.pem"
systemctl reload nginx 2>/dev/null || echo "Перезагрузите nginx: systemctl reload nginx"
echo "Готово: сертификат(ы) $LOGIN отозваны, CRL обновлён."
