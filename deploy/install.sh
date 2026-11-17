#!/usr/bin/env bash
# Установка WSP Anonymizer на CentOS Stream 9 (запуск от root из корня проекта):
#   bash deploy/install.sh
# Повторный запуск = обновление кода (конфиг, БД и ключи не трогаются).
set -euo pipefail
APP=/opt/wsp-anonymizer
DATA=/var/lib/wsp-anonymizer
ETC=/etc/wsp-anonymizer
SRC="$(cd "$(dirname "$0")/.." && pwd)"

echo "==> Пакеты"
dnf -y install dnf-plugins-core
dnf config-manager --set-enabled crb || true
dnf -y install epel-release || true
dnf -y module reset nodejs && dnf -y module enable nodejs:22 || echo "!! модуль nodejs:22 недоступен — поставьте Node.js 20+ вручную (NodeSource)"
dnf -y install nodejs npm nginx openssl poppler-utils tesseract tesseract-langpack-rus tesseract-langpack-eng \
  gcc-c++ make python3 sqlite policycoreutils-python-utils rsync
node -e 'process.exit(+process.versions.node.split(".")[0] >= 20 ? 0 : 1)' || { echo "Нужен Node.js >= 20"; exit 1; }

echo "==> Пользователь и каталоги"
id anonymizer &>/dev/null || useradd -r -s /sbin/nologin -d "$DATA" anonymizer
install -d -o anonymizer -g anonymizer -m 0750 "$DATA"
install -d -o root -g anonymizer -m 0750 "$ETC"
install -d -m 0755 "$APP"

echo "==> Код"
rsync -a --delete --exclude node_modules --exclude data --exclude test --exclude .git "$SRC/" "$APP/"
cd "$APP" && npm ci --omit=dev --no-audit --no-fund
chown -R root:root "$APP"

echo "==> Конфигурация"
if [[ ! -f $ETC/anonymizer.env ]]; then
  sed -e "s#^MASTER_KEY=.*#MASTER_KEY=$(openssl rand -base64 32)#" \
      -e "s#^SESSION_SECRET=.*#SESSION_SECRET=$(openssl rand -hex 32)#" \
      -e "s#^DATA_DIR=.*#DATA_DIR=$DATA#" \
      -e "s#^NODE_ENV=.*#NODE_ENV=production#" \
      "$SRC/.env.example" > "$ETC/anonymizer.env"
  chown root:anonymizer "$ETC/anonymizer.env"; chmod 0640 "$ETC/anonymizer.env"
  echo "!! Создан $ETC/anonymizer.env — заполните LDAP_* и OLLAMA_*."
  echo "!! СРАЗУ сохраните MASTER_KEY в Teampass: без него таблицы замен не расшифровать."
fi

echo "==> systemd"
install -m 0644 "$SRC/deploy/systemd/wsp-anonymizer.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable wsp-anonymizer

echo "==> nginx"
[[ -f /etc/nginx/conf.d/wsp-anonymizer.conf ]] || install -m 0644 "$SRC/deploy/nginx/wsp-anonymizer.conf" /etc/nginx/conf.d/
install -d -m 0750 -o root -g nginx "$ETC/tls"
setsebool -P httpd_can_network_connect 1 || true
systemctl enable nginx

echo "==> Firewall"
if systemctl is-active -q firewalld; then
  firewall-cmd -q --permanent --add-service=https --add-service=http && firewall-cmd -q --reload
fi

cat <<MSG

Дальше:
 1. УЦ клиентских сертификатов:  bash $SRC/deploy/pki/init-ca.sh
    (или пропишите в nginx ssl_client_certificate корпоративного AD CS)
 2. Серверный сертификат: $ETC/tls/server.crt и server.key
 3. Заполните $ETC/anonymizer.env, затем:
       systemctl restart wsp-anonymizer && nginx -t && systemctl restart nginx
 4. Сертификат сотруднику:  bash $SRC/deploy/pki/issue-client.sh <логин> <email>
 5. Проверка: journalctl -u wsp-anonymizer -f
MSG
