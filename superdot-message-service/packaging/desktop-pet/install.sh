#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 1 || ! -f "$1/package.json" ]]; then
  echo "用法：$0 /path/to/node_modules/dsh-pet" >&2
  exit 2
fi
package=$(cd "$1" && pwd)
here=$(cd "$(dirname "$0")" && pwd)
if [[ $(node -p 'require(process.argv[1]).version' "$package/package.json") != 0.4.9 ]]; then
  echo "此桌宠接入适用于 dsh-pet 0.4.9，请核对安装版本。" >&2
  exit 2
fi

stage=$(mktemp -d)
swap=$(mktemp -d "$package/.superdot-install.XXXXXX")
backup="$package/.superdot-original"
runtime="$package/runtime/electron-helper"
complete=false
cleanup() {
  if [[ $complete == false && -d "$swap/previous-runtime" ]]; then
    rm -rf "$runtime"
    mv "$swap/previous-runtime" "$runtime"
    if [[ -f "$swap/previous-entry.js" ]]; then
      mv -f "$swap/previous-entry.js" "$package/lib/standalone.js"
    fi
  fi
  rm -rf "$stage" "$swap"
}
trap cleanup EXIT
mkdir -p "$stage/dsh-pet/runtime"
cp -R "$package/src" "$stage/dsh-pet/"
if [[ -e "$backup/electron-helper" ]]; then
  cp -R "$backup/electron-helper" "$stage/dsh-pet/runtime/"
else
  cp -R "$runtime" "$stage/dsh-pet/runtime/"
fi
(cd "$stage" && git apply --check "$here/dsh-pet-0.4.9.patch" && git apply "$here/dsh-pet-0.4.9.patch")

(
  cd "$stage/dsh-pet"
  args=(--bundle --platform=node --format=esm --packages=external
        --alias:@deepseek-ai/dsh-llm=./src/standalone/shims/dsh-llm.ts
        --alias:@deepseek-ai/dsh-credentials=./src/standalone/shims/dsh-credentials.ts
        --alias:@deepseek-ai/dsh-home-paths=./src/standalone/shims/dsh-home-paths.ts)
  npx --yes esbuild@0.28.2 src/standalone/cli.ts "${args[@]}" --outfile="$stage/standalone.js"
  npx --yes esbuild@0.28.2 src/shared/index.ts --bundle --platform=browser --format=iife --global-name=PetShared \
    --outfile="$stage/dsh-pet/runtime/electron-helper/shared-core.js"
)
node --check "$stage/standalone.js"
node --check "$stage/dsh-pet/runtime/electron-helper/shared-core.js"
node -e 'const {readFileSync}=require("node:fs"), {runInNewContext}=require("node:vm"); const context={}; runInNewContext(readFileSync(process.argv[1],"utf8"),context); if(typeof context.PetShared?.mountContextMenu!=="function") process.exit(1);' \
  "$stage/dsh-pet/runtime/electron-helper/shared-core.js"
if [[ ! -e "$backup/electron-helper" ]]; then
  mkdir -p "$backup"
  cp -R "$runtime" "$backup/"
  cp -p "$package/lib/standalone.js" "$backup/"
fi
cp -R "$stage/dsh-pet/runtime/electron-helper" "$swap/next-runtime"
cp -p "$package/lib/standalone.js" "$swap/previous-entry.js"
install -m 755 "$stage/standalone.js" "$swap/next-entry.js"
mv "$runtime" "$swap/previous-runtime"
mv "$swap/next-runtime" "$runtime"
mv -f "$swap/next-entry.js" "$package/lib/standalone.js"
complete=true
echo "SuperDot 桌宠接入已安装。重启桌宠后生效。"
