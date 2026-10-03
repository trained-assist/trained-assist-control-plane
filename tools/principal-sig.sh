#!/usr/bin/env bash
# Подпись принципала для control plane (HMAC-SHA256 по binding PRINCIPAL_SECRET).
#
# Заголовок x-principal — не доказательство личности: контрольный слой принимает
# только подпись (src/auth/principal-auth.ts). Секрет читается из env и в
# репозиторий, в файлы и в вывод не попадает.
#
# Использование:
#   PRINCIPAL_SECRET=... ./tools/principal-sig.sh <principalId>   # -> hex
#   curl -H "x-principal: $P" -H "x-principal-sig: $(./tools/principal-sig.sh $P)" ...
set -euo pipefail

PRINCIPAL="${1:?principalId}"
SECRET="${PRINCIPAL_SECRET:?PRINCIPAL_SECRET не задан: секрет только из binding/SM}"

node -e '
const { createHmac } = require("node:crypto");
const [secret, principal] = process.argv.slice(1);
process.stdout.write(createHmac("sha256", secret).update(principal, "utf8").digest("hex"));
' "$SECRET" "$PRINCIPAL"
