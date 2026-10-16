#!/bin/sh
# Check a Logseq E2EE password against the sync server without changing anything.
#
# Runs `logseq sync ensure-keys` (WITHOUT --upload-keys) in a throwaway dsh container:
# it downloads your encrypted private key and tries to decrypt it with the password.
# Nothing is uploaded; the container and its data are discarded afterwards.
# On success the password is saved to ~/.dsh-logseq-test/config.json (mode 0600).
#
#   LOGSEQ_SERVER=https://sync.example.com scripts/verify-e2ee-password.sh
#
# Env: LOGSEQ_SERVER (required, e.g. https://sync.example.com), AUTH_JSON (default
# ~/logseq/auth.json), LOGSEQ_RUNTIME_ASAR (local app.asar; otherwise ~180MB download),
# DSH_IMAGE (default smanx/deepseek-harness:0.1.5-rc.2).
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
server=${LOGSEQ_SERVER:?set LOGSEQ_SERVER to your sync server, e.g. https://sync.example.com}
auth=${AUTH_JSON:-$HOME/logseq/auth.json}
image=${DSH_IMAGE:-smanx/deepseek-harness:0.1.5-rc.2}
out_dir=$HOME/.dsh-logseq-test

[ -f "$auth" ] || { echo "auth.json not found: $auth" >&2; exit 1; }

asar_mount=""
if [ -n "${LOGSEQ_RUNTIME_ASAR:-}" ]; then
	asar_mount="-v $LOGSEQ_RUNTIME_ASAR:/asar/app.asar:ro"
elif [ -f /tmp/linux-app.asar ]; then
	asar_mount="-v /tmp/linux-app.asar:/asar/app.asar:ro"
fi

printf 'E2EE password (input hidden): '
stty -echo 2>/dev/null || true
read -r LSQ_PW
stty echo 2>/dev/null || true
echo
export LSQ_PW

# shellcheck disable=SC2086
result=$(docker run --rm -e LSQ_PW -e LSQ_SERVER="$server" \
	-v "$repo":/plugin:ro -v "$auth":/seed/auth.json:ro $asar_mount \
	--entrypoint node "$image" --input-type=module -e '
import { existsSync, mkdirSync, copyFileSync } from "node:fs"
const { loadConfig } = await import("/plugin/lib/config.js")
const { runCli, seedAuth } = await import("/plugin/lib/cli.js")
mkdirSync("/tmp/d", { recursive: true })
copyFileSync("/seed/auth.json", "/tmp/d/auth.json")
const c = loadConfig({ dataDir: "/tmp/d", server: process.env.LSQ_SERVER, sync: false,
  runtimeAsar: existsSync("/asar/app.asar") ? "/asar/app.asar" : undefined })
await seedAuth(c)
await runCli(c, ["graph", "create", "--graph=probe"])
try {
  await runCli(c, ["sync", "ensure-keys", "--graph=probe", `--e2ee-password=${process.env.LSQ_PW}`], { timeoutMs: 60000, secrets: [`--e2ee-password=${process.env.LSQ_PW}`] })
  console.log("RESULT=OK")
} catch (e) {
  console.log(`RESULT=FAIL ${e.message}`)
}
' 2>&1 | tail -1)

case "$result" in
RESULT=OK)
	mkdir -p "$out_dir" && chmod 700 "$out_dir"
	umask 077
	LSQ_SERVER="$server" node -e 'const fs=require("fs");fs.writeFileSync(process.argv[1],JSON.stringify({server:process.env.LSQ_SERVER,graphs:["dsh-test"],e2eePassword:process.env.LSQ_PW},null,2)+"\n",{mode:0o600})' "$out_dir/config.json"
	echo "密码正确，已写入 $out_dir/config.json"
	;;
*invalid-e2ee-password*)
	echo "密码错误（服务器上的私钥解不开）"
	exit 2
	;;
*)
	echo "检查没跑完：$result" >&2
	exit 3
	;;
esac
