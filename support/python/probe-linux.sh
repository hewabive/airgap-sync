#!/bin/sh
set -eu

probe_arch="$(uname -m 2>/dev/null || true)"
case "$probe_arch" in
  x86_64|amd64) probe_arch="x86_64" ;;
  aarch64|arm64) probe_arch="aarch64" ;;
  *) probe_arch="unknown" ;;
esac

probe_libc_output="$(ldd --version 2>&1 || true)"
probe_libc_family=""
probe_libc_version=""
case "$probe_libc_output" in
  *musl*)
    probe_libc_family="musl"
    probe_libc_version="$(printf '%s\n' "$probe_libc_output" | sed -n 's/^Version \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -n 1)"
    ;;
  *)
    probe_libc_family="glibc"
    probe_libc_version="$(getconf GNU_LIBC_VERSION 2>/dev/null | sed -n 's/^glibc //p' || true)"
    ;;
esac

probe_python_version=""
probe_python_command=""
if command -v python3 >/dev/null 2>&1; then
  probe_python_command="python3"
  probe_python_version="$(python3 --version 2>&1 | sed -n 's/^Python //p')"
elif command -v python >/dev/null 2>&1; then
  probe_python_command="python"
  probe_python_version="$(python --version 2>&1 | sed -n 's/^Python //p')"
fi

printf '{\n'
printf '  "os": "linux",\n'
printf '  "architecture": "%s",\n' "$probe_arch"
printf '  "capabilities": {}'
if [ -n "$probe_libc_family" ] && [ -n "$probe_libc_version" ]; then
  printf ',\n  "libc": {"family": "%s", "version": "%s"}' "$probe_libc_family" "$probe_libc_version"
fi
if [ -n "$probe_python_version" ]; then
  printf ',\n  "python": {"command": "%s", "version": "%s"}' "$probe_python_command" "$probe_python_version"
fi
printf '\n}\n'
