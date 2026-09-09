#!/usr/bin/env bash
# ─── Prune third-party apt sources before `playwright install --with-deps` ────
#
# TEAM-4311. `npx playwright install --with-deps chromium` shells out, as root, to
#     sh -c "apt-get update && apt-get install -y --no-install-recommends <libs>"
# (playwright-core, server/registry/dependencies.ts installDependenciesLinux +
# transformCommandsForRoot). `apt-get update` reads EVERY configured source and
# exits 100 if ANY of them fails to fetch; the `&&` then short-circuits, the child
# exits 100, and the CLI dies with "Failed to install browsers / Installation
# process exited with code: 100" -- before it has even tried to download a
# browser. So one broken third-party repo fails the whole INSTALL phase.
#
# The CodeBuild STANDARD_7_0 image (Ubuntu 22.04) bakes four sources this build
# does not use into /etc/apt/sources.list.d: google-chrome.list (dl.google.com),
# mozillateam-ubuntu-ppa-jammy.list (ppa.launchpadcontent.net), corretto.list
# (apt.corretto.aws) and github-cli.list (cli.github.com). On 2026-09-09
# dl.google.com served an inconsistent Packages.gz ("Hash Sum mismatch") and
# failed the deploy pipeline's Build stage twice. Playwright downloads Chromium
# from Microsoft's CDN and install-deps only needs Ubuntu main/universe for
# shared libs + fonts, so none of those repos may be able to fail this build.
#
# Rule: remove every file in the sources.list.d directory whose content does not
# reference an Ubuntu archive host (*.ubuntu.com -- archive / security / ports /
# esm). Keeping on ubuntu.com rather than a filename allowlist means a future
# 24.04 image's deb822 `ubuntu.sources` survives untouched, while the
# mozillateam PPA -- whose URL path contains "/ubuntu/" but whose host is
# ppa.launchpadcontent.net -- is still pruned.
#
# /etc/apt/sources.list (where 22.04 keeps the Ubuntu archive) is NEVER touched.
# Removing a source uninstalls nothing: gh, java and chrome stay on the image.
#
# DESTRUCTIVE BY DESIGN, for an ephemeral CI container. APT_SOURCES_DIR exists
# only so deploy/pipeline/test_prune_apt_sources.py can point this at a temp dir.
set -euo pipefail

dir="${APT_SOURCES_DIR:-/etc/apt/sources.list.d}"

if [ ! -d "$dir" ]; then
  echo "prune-apt-sources: $dir does not exist - nothing to prune"
  exit 0
fi

pruned=0
kept=0
for f in "$dir"/*; do
  [ -f "$f" ] || continue
  if grep -qiE 'ubuntu\.com' "$f"; then
    echo "prune-apt-sources: keep   $(basename "$f") (Ubuntu archive)"
    kept=$((kept + 1))
    continue
  fi
  # Report what is being dropped: first deb/deb-src line, or deb822 URIs line.
  line="$(grep -m1 -iE '^[[:space:]]*(deb(-src)?[[:space:]]|URIs:)' "$f" || true)"
  echo "prune-apt-sources: pruned $(basename "$f")${line:+ -> ${line}}"
  rm -f "$f"
  pruned=$((pruned + 1))
done

echo "prune-apt-sources: pruned ${pruned} third-party source file(s), kept ${kept}"
