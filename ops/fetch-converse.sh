#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
destination="$repo_root/apps/website/dist"
registry_url="https://registry.npmjs.org/converse.js/latest"
tmp_dir=$(mktemp -d)
trap 'rm -rf "$tmp_dir"' EXIT

curl -fsSL --proto '=https' --tlsv1.2 "$registry_url" -o "$tmp_dir/metadata.json"
readarray -t release < <(python3 - "$tmp_dir/metadata.json" <<'PY'
import json
import sys

metadata = json.load(open(sys.argv[1], encoding="utf-8"))
print(metadata["version"])
print(metadata["dist"]["tarball"])
print(metadata["dist"]["integrity"])
PY
)
version=${release[0]}
tarball_url=${release[1]}
integrity=${release[2]}
archive="$tmp_dir/converse.tgz"

curl -fsSL --proto '=https' --tlsv1.2 "$tarball_url" -o "$archive"
python3 - "$archive" "$integrity" <<'PY'
import base64
import hashlib
import sys

archive, integrity = sys.argv[1:]
algorithm, expected = integrity.split("-", 1)
if algorithm != "sha512":
    raise SystemExit(f"unsupported registry integrity algorithm: {algorithm}")
actual = base64.b64encode(hashlib.sha512(open(archive, "rb").read()).digest()).decode()
if actual != expected:
    raise SystemExit("Converse.js archive integrity check failed")
PY

tar -xzf "$archive" -C "$tmp_dir" package/dist package/LICENSE package/COPYRIGHT
rm -rf "$destination"
mkdir -p "$destination"
cp -a "$tmp_dir/package/dist/." "$destination/"
cp "$tmp_dir/package/LICENSE" "$destination/LICENSE"
cp "$tmp_dir/package/COPYRIGHT" "$destination/COPYRIGHT"
printf '%s\n' "$version" > "$destination/VERSION"

# Keep login-page sponsor assets self-hosted; avoid runtime requests to conversejs.org.
sponsor_dir="$destination/images/sponsors"
mkdir -p "$sponsor_dir"
for filename in \
  bairesdev-dark.png \
  BairesDev_logo-orange.png \
  blokt-invert.png \
  blokt.png \
  litslink-dark.svg \
  litslink-light.svg; do
  curl -fsSL --proto '=https' --tlsv1.2 \
    "https://conversejs.org/media/logos/$filename" -o "$sponsor_dir/$filename"
done
python3 - "$destination/converse.min.js" <<'PY'
import sys

path = sys.argv[1]
bundle = open(path, encoding="utf-8").read()
bundle = bundle.replace("https://conversejs.org/media/logos/", "/dist/images/sponsors/")
open(path, "w", encoding="utf-8").write(bundle)
PY

printf 'Fetched Converse.js %s into %s\n' "$version" "$destination"
