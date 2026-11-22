#!/bin/bash
# think-aloud: one-time setup of the Kokoro voice (Kokoro-82M, Apache 2.0) on this Mac, run by the mod in the
# background the first time (and by `/speak setup`, which passes --repair). Until it finishes, the Mac's own voice
# speaks. Nothing needs to be installed first: everything comes from GitHub, checked against its SHA-256.
#
#   uv        from PATH, else uv's own release on GitHub          -> $H/bin/uv
#   Python    3.12, fetched by uv (python-build-standalone, GitHub) -> $H/venv
#   libraries kokoro-onnx + sounddevice and their dependencies: one tarball of wheels on this plugin's GitHub release
#             (built by .github/workflows/wheelhouse.yml); PyPI only if that download fails. Some networks reach
#             GitHub fast but stall on PyPI's CDN (22 Nov 2026).
#   model     kokoro-v1.0.onnx (~325 MB) and voices-v1.0.bin (~27 MB) from kokoro-onnx's GitHub release
#   ready-v1  written last: the mod starts the voice server only once it is there
# Safe to run again: each step skips what is already done and sound.
set -euo pipefail
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin"

H="${THINK_ALOUD_HOME:-$HOME/.claude/think-aloud}"
V="$H/venv"
M="$H/models"
PKGS=(kokoro-onnx==0.6.1 sounddevice==0.5.6)

UV_VERSION="0.13.9"
UV_SHA_arm64="5aeca67f2283f75235de40d0bd9c0a5bbc5fce23b6d48b3bf9fa1b2db08382ca"
UV_SHA_x86_64="617a3211261b0fc739562f0071aa34e9739797c510208ede8e2977c30903d041"
WHEELS_BASE="https://github.com/shashank42/claude-think-aloud/releases/download/wheels-v1"
WHEELS_SHA_arm64="050797394e4c11bdd9693277a24d9d75f2a3847cd991da814691667789f1514a"
WHEELS_SHA_x86_64="cd3e0347110c953871745f186920910ac24fc560c807c23b0e9534dd2b34c680"
MODEL_BASE="https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0"
MODEL_SHA="7d5df8ecf7d4b1878015a32686053fd0eebe2bc377234608764cc0ef3636a6c5"
VOICES_SHA="bca610b8308e8d99f32e6fe4197e7ec01679264efed0cac9140fe9c29f1fbf7d"

step() { echo "think-aloud: $*"; }
sha() { shasum -a 256 "$1" | cut -d' ' -f1; }

[ "$(uname -s)" = Darwin ] || { step "the Kokoro voice is set up on macOS only"; exit 2; }
ARCH="$(uname -m)"
case "$ARCH" in arm64 | x86_64) ;; *) step "unsupported Mac architecture $ARCH"; exit 2 ;; esac
mkdir -p "$H/bin" "$M"

# One setup at a time. The lock holds its setup's process id; it is stale once that process is gone.
LOCK="$H/setup.lock"
locked=0
unlock() { [ "$(cat "$LOCK/pid" 2>/dev/null)" = "$$" ] && { rm -f "$LOCK/pid"; rmdir "$LOCK" 2>/dev/null; } || true; }
for _ in $(seq 1 3600); do
  if mkdir "$LOCK" 2>/dev/null; then echo $$ > "$LOCK/pid"; locked=1; break; fi
  owner="$(cat "$LOCK/pid" 2>/dev/null || true)"
  if { [ -n "$owner" ] && ! kill -0 "$owner" 2>/dev/null; } ||
     { [ -z "$owner" ] && [ $(( $(date +%s) - $(stat -f %m "$LOCK" 2>/dev/null || date +%s) )) -gt 60 ]; }; then
    # Stale: move it aside first, so two waiters cannot both clear it and remove a lock someone just took.
    mv "$LOCK" "$LOCK.stale.$$" 2>/dev/null && { rm -f "$LOCK.stale.$$/pid"; rmdir "$LOCK.stale.$$" 2>/dev/null || true; }
    continue
  fi
  sleep 1
done
[ "$locked" = 1 ] || { step "another setup is still running"; exit 5; }
trap unlock EXIT
trap 'exit 130' INT TERM HUP

if [ "${1:-}" = "--repair" ]; then rm -f "$H/ready-v1"; fi
[ -f "$H/ready-v1" ] && { step "the Kokoro voice is ready"; exit 0; }

# A download that stalls is retried and resumed, never left hanging.
fetch() { # url, file, sha256
  local url="$1" out="$2" want="$3"
  if [ -f "$out" ] && [ "$(sha "$out")" = "$want" ]; then return 0; fi
  for _ in 1 2 3; do
    if curl -fsSL --connect-timeout 30 --speed-time 60 --speed-limit 1024 --retry 5 --retry-delay 3 -C - -o "$out.part" "$url" &&
       [ "$(sha "$out.part")" = "$want" ]; then
      mv "$out.part" "$out"
      return 0
    fi
    rm -f "$out.part"
  done
  return 1
}

# uv
UV="$(command -v uv || true)"
if [ -z "$UV" ]; then
  UV="$H/bin/uv"
  if [ ! -x "$UV" ]; then
    step "downloading uv"
    T="$([ "$ARCH" = arm64 ] && echo aarch64 || echo x86_64)-apple-darwin"
    want="$([ "$ARCH" = arm64 ] && echo "$UV_SHA_arm64" || echo "$UV_SHA_x86_64")"
    fetch "https://github.com/astral-sh/uv/releases/download/$UV_VERSION/uv-$T.tar.gz" "$H/bin/uv.tar.gz" "$want" ||
      { step "could not download uv; check the network, then /speak setup"; exit 3; }
    tar -xzf "$H/bin/uv.tar.gz" -C "$H/bin" --strip-components 1 "uv-$T/uv"
    rm -f "$H/bin/uv.tar.gz"
  fi
fi

# Python 3.12 (a venv whose Python no longer runs, e.g. after an upgrade, is made again)
if ! "$V/bin/python" -c 'import sys' 2>/dev/null; then
  step "making the Python environment"
  rm -rf "$V"
  "$UV" venv -q --python 3.12 "$V"
fi

# The libraries: GitHub's wheel tarball, else PyPI
if ! "$V/bin/python" -c 'import kokoro_onnx, sounddevice' 2>/dev/null; then
  step "installing the voice libraries"
  want="$([ "$ARCH" = arm64 ] && echo "$WHEELS_SHA_arm64" || echo "$WHEELS_SHA_x86_64")"
  if fetch "$WHEELS_BASE/wheels-$ARCH.tar.gz" "$H/wheels-$ARCH.tar.gz" "$want"; then
    rm -rf "$H/wheels-$ARCH"
    tar -xzf "$H/wheels-$ARCH.tar.gz" -C "$H"
    "$UV" pip install -q --python "$V/bin/python" --no-index --find-links "$H/wheels-$ARCH" "${PKGS[@]}"
  else
    step "GitHub's wheels did not download; trying PyPI"
    UV_HTTP_TIMEOUT=300 "$UV" pip install -q --python "$V/bin/python" "${PKGS[@]}"
  fi
fi

# The model
step "downloading the voice model (about 350 MB)"
fetch "$MODEL_BASE/kokoro-v1.0.onnx" "$M/kokoro-v1.0.onnx" "$MODEL_SHA" || { step "the model did not download; /speak setup tries again"; exit 4; }
fetch "$MODEL_BASE/voices-v1.0.bin" "$M/voices-v1.0.bin" "$VOICES_SHA" || { step "the voices did not download; /speak setup tries again"; exit 4; }

"$V/bin/python" -c 'import kokoro_onnx, sounddevice'
touch "$H/ready-v1"
step "the Kokoro voice is ready"
