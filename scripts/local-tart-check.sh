#!/bin/bash
# Trusted-main commands for isolated CI checks.
# Invoked only inside an isolated disposable guest; no host execution.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"
export npm_config_prefix="$HOME/.local"
case "${1:-}" in
  format)
    printf '::group::Check formatting\n'
    npm run format:check
    printf '::endgroup::\n'
    ;;
  lint)
    printf '::group::Lint lockfile\n'
    npx --yes lockfile-lint --path package-lock.json --type npm --allowed-hosts npm --validate-https --validate-integrity
    printf '::endgroup::\n'
    printf '::group::Verify dependency signatures\n'
    npm audit signatures
    printf '::endgroup::\n'
    printf '::group::Lint\n'
    npm run lint
    printf '::endgroup::\n'
    ;;
  typecheck)
    printf '::group::Build server stack\n'
    npm run build:server
    printf '::endgroup::\n'
    printf '::group::Typecheck all packages\n'
    npm run typecheck
    printf '::endgroup::\n'
    printf '::group::Install website test browsers\n'
    npx playwright install --with-deps chromium webkit
    printf '::endgroup::\n'
    printf '::group::Verify website mockups\n'
    npm run test:e2e --workspace=@getpaseo/website
    printf '::endgroup::\n'
    printf '::group::Verify public package contents\n'
    npm pack --dry-run --ignore-scripts --workspace=@getpaseo/protocol
    npm pack --dry-run --ignore-scripts --workspace=@getpaseo/client
    npm pack --dry-run --ignore-scripts --workspace=@getpaseo/server
    printf '::endgroup::\n'
    ;;
  server-tests-ubuntu)
    printf '::group::Fetch origin/main (worktree tests)\n'
    git fetch --no-tags origin main:refs/remotes/origin/main
    printf '::endgroup::\n'
    printf '::group::Install agent CLIs for provider tests\n'
    node scripts/npm-retry.mjs install -g @anthropic-ai/claude-code opencode-ai
    printf '::endgroup::\n'
    printf '::group::Build server dependencies\n'
    npm run build:server-deps
    printf '::endgroup::\n'
    printf '::group::Run server tests\n'
    npm run test --workspace=@getpaseo/server
    printf '::endgroup::\n'
    ;;
  desktop-tests-ubuntu)
    printf '::group::Build server stack\n'
    npm run build:server
    printf '::endgroup::\n'
    printf '::group::Run desktop tests\n'
    npm run test --workspace=@getpaseo/desktop
    printf '::endgroup::\n'
    printf '::group::Install virtual display\n'
    sudo apt-get update && sudo apt-get install -y xvfb xauth xdotool
    printf '::endgroup::\n'
    printf '::group::Install Playwright browser\n'
    npx playwright install chromium
    printf '::endgroup::\n'
    printf '::group::Run desktop lifecycle E2E (Linux)\n'
    export PASEO_DESKTOP_LIFECYCLE_ARTIFACT_DIR="$RUNNER_TEMP/desktop-lifecycle"
    xvfb-run -a --server-args="-screen 0 1280x800x24" npm run test:e2e:lifecycle --workspace=@getpaseo/desktop
    printf '::endgroup::\n'
    printf '::group::Run desktop renderer E2E\n'
    npm run test:e2e:renderer --workspace=@getpaseo/desktop
    printf '::endgroup::\n'
    printf '::group::Run desktop browser E2E\n'
    export PASEO_DESKTOP_BROWSER_E2E_ARTIFACT_DIR="$RUNNER_TEMP/desktop-browser-e2e"
    npm run test:e2e:browser-tabs --workspace=@getpaseo/desktop
    printf '::endgroup::\n'
    ;;
  app-tests)
    printf '::group::Install Playwright browsers\n'
    npx playwright install chromium
    printf '::endgroup::\n'
    printf '::group::Build app dependencies\n'
    npm run build:app-deps
    printf '::endgroup::\n'
    printf '::group::Run app unit tests\n'
    npm run test --workspace=@getpaseo/app
    printf '::endgroup::\n'
    ;;
  sdk-tests)
    printf '::group::Build client dependencies\n'
    npm run build:relay && npm run build:client
    printf '::endgroup::\n'
    printf '::group::Build plugin SDK\n'
    npm run build:plugin
    printf '::endgroup::\n'
    printf '::group::Run plugin SDK tests\n'
    npm run test --workspace=@getpaseo/plugin
    printf '::endgroup::\n'
    printf '::group::Run protocol tests\n'
    npm run test --workspace=@getpaseo/protocol
    printf '::endgroup::\n'
    printf '::group::Run client tests\n'
    npm run test --workspace=@getpaseo/client
    printf '::endgroup::\n'
    printf '::group::Run highlight tests\n'
    npm run test --workspace=@getpaseo/highlight
    printf '::endgroup::\n'
    printf '::group::Typecheck client examples\n'
    npm run typecheck:examples --workspace=@getpaseo/client
    printf '::endgroup::\n'
    ;;
  playwright-1)
    export PLAYWRIGHT_SHARD=1/4
    export PLAYWRIGHT_ARTIFACT=1
    printf '::group::Install Playwright browsers\n'
    npx playwright install chromium
    printf '::endgroup::\n'
    printf '::group::Build server stack\n'
    npm run build:server
    printf '::endgroup::\n'
    printf '::group::Build native app dependency\n'
    npm run build --workspace=@getpaseo/expo-two-way-audio
    printf '::endgroup::\n'
    printf '::group::Install agent CLIs for provider tests\n'
    node scripts/npm-retry.mjs install -g @anthropic-ai/claude-code @openai/codex@0.105.0 opencode-ai
    printf '::endgroup::\n'
    printf '::group::Run Playwright E2E tests\n'
    export PWTEST_SHARD_WEIGHTS=111:172:137:160
    npm run test:e2e --workspace=@getpaseo/app -- --shard=$PLAYWRIGHT_SHARD
    printf '::endgroup::\n'
    ;;
  playwright-2)
    export PLAYWRIGHT_SHARD=2/4
    export PLAYWRIGHT_ARTIFACT=2
    printf '::group::Install Playwright browsers\n'
    npx playwright install chromium
    printf '::endgroup::\n'
    printf '::group::Build server stack\n'
    npm run build:server
    printf '::endgroup::\n'
    printf '::group::Build native app dependency\n'
    npm run build --workspace=@getpaseo/expo-two-way-audio
    printf '::endgroup::\n'
    printf '::group::Install agent CLIs for provider tests\n'
    node scripts/npm-retry.mjs install -g @anthropic-ai/claude-code @openai/codex@0.105.0 opencode-ai
    printf '::endgroup::\n'
    printf '::group::Run Playwright E2E tests\n'
    export PWTEST_SHARD_WEIGHTS=111:172:137:160
    npm run test:e2e --workspace=@getpaseo/app -- --shard=$PLAYWRIGHT_SHARD
    printf '::endgroup::\n'
    ;;
  playwright-3)
    export PLAYWRIGHT_SHARD=3/4
    export PLAYWRIGHT_ARTIFACT=3
    printf '::group::Install Playwright browsers\n'
    npx playwright install chromium
    printf '::endgroup::\n'
    printf '::group::Build server stack\n'
    npm run build:server
    printf '::endgroup::\n'
    printf '::group::Build native app dependency\n'
    npm run build --workspace=@getpaseo/expo-two-way-audio
    printf '::endgroup::\n'
    printf '::group::Install agent CLIs for provider tests\n'
    node scripts/npm-retry.mjs install -g @anthropic-ai/claude-code @openai/codex@0.105.0 opencode-ai
    printf '::endgroup::\n'
    printf '::group::Run Playwright E2E tests\n'
    export PWTEST_SHARD_WEIGHTS=111:172:137:160
    npm run test:e2e --workspace=@getpaseo/app -- --shard=$PLAYWRIGHT_SHARD
    printf '::endgroup::\n'
    ;;
  playwright-4)
    export PLAYWRIGHT_SHARD=4/4
    export PLAYWRIGHT_ARTIFACT=4
    printf '::group::Install Playwright browsers\n'
    npx playwright install chromium
    printf '::endgroup::\n'
    printf '::group::Build server stack\n'
    npm run build:server
    printf '::endgroup::\n'
    printf '::group::Build native app dependency\n'
    npm run build --workspace=@getpaseo/expo-two-way-audio
    printf '::endgroup::\n'
    printf '::group::Install agent CLIs for provider tests\n'
    node scripts/npm-retry.mjs install -g @anthropic-ai/claude-code @openai/codex@0.105.0 opencode-ai
    printf '::endgroup::\n'
    printf '::group::Run Playwright E2E tests\n'
    export PWTEST_SHARD_WEIGHTS=111:172:137:160
    npm run test:e2e --workspace=@getpaseo/app -- --shard=$PLAYWRIGHT_SHARD
    printf '::endgroup::\n'
    ;;
  relay-tests)
    printf '::group::Build relay\n'
    npm run build:relay
    printf '::endgroup::\n'
    printf '::group::Run relay tests\n'
    npm run test --workspace=@getpaseo/relay
    printf '::endgroup::\n'
    ;;
  cli-tests-1)
    export PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=0
    export PASEO_DICTATION_ENABLED=0
    export PASEO_VOICE_MODE_ENABLED=0
    export PASEO_CLI_TEST_SHARD=1
    export PASEO_CLI_TEST_SHARD_TOTAL=3
    printf '::group::Install agent CLIs for provider tests\n'
    node scripts/npm-retry.mjs install -g @anthropic-ai/claude-code @openai/codex@0.105.0 opencode-ai
    printf '::endgroup::\n'
    printf '::group::Run CLI E2E tests\n'
    npm run test:local --workspace=@getpaseo/cli
    printf '::endgroup::\n'
    ;;
  cli-tests-2)
    export PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=0
    export PASEO_DICTATION_ENABLED=0
    export PASEO_VOICE_MODE_ENABLED=0
    export PASEO_CLI_TEST_SHARD=2
    export PASEO_CLI_TEST_SHARD_TOTAL=3
    printf '::group::Install agent CLIs for provider tests\n'
    node scripts/npm-retry.mjs install -g @anthropic-ai/claude-code @openai/codex@0.105.0 opencode-ai
    printf '::endgroup::\n'
    printf '::group::Run CLI E2E tests\n'
    npm run test:local --workspace=@getpaseo/cli
    printf '::endgroup::\n'
    ;;
  cli-tests-3)
    export PASEO_LOCAL_SPEECH_AUTO_DOWNLOAD=0
    export PASEO_DICTATION_ENABLED=0
    export PASEO_VOICE_MODE_ENABLED=0
    export PASEO_CLI_TEST_SHARD=3
    export PASEO_CLI_TEST_SHARD_TOTAL=3
    printf '::group::Install agent CLIs for provider tests\n'
    node scripts/npm-retry.mjs install -g @anthropic-ai/claude-code @openai/codex@0.105.0 opencode-ai
    printf '::endgroup::\n'
    printf '::group::Run CLI E2E tests\n'
    npm run test:local --workspace=@getpaseo/cli
    printf '::endgroup::\n'
    printf '::group::Run CLI source tests\n'
    npm run test:unit --workspace=@getpaseo/cli
    printf '::endgroup::\n'
    ;;
  nix-linux)
    export PATH="/nix/var/nix/profiles/default/bin:$PATH"
    ./scripts/update-nix.sh --check
    nix build .#default -o result
    (
      set -euo pipefail

      export PASEO_HOME
      PASEO_HOME="$(mktemp -d)"
      export PASEO_LISTEN=127.0.0.1:6767

      WRAPPER_LOG="$PASEO_HOME/paseo-server-wrapper.log"

      cleanup() {
        if [[ -n "${DAEMON_PID:-}" ]] && kill -0 "$DAEMON_PID" 2>/dev/null; then
          kill "$DAEMON_PID"
          wait "$DAEMON_PID" || true
        fi
        rm -rf "$PASEO_HOME"
      }
      trap cleanup EXIT

      PASEO_WEB_UI_ENABLED=true ./result/bin/paseo-server --no-relay >"$WRAPPER_LOG" 2>&1 &
      DAEMON_PID=$!

      deadline=$((SECONDS + 30))
      while (( SECONDS < deadline )); do
        if STATUS_JSON="$(./result/bin/paseo daemon status --json)" \
          && jq -e '.connectedDaemon == "reachable"' <<<"$STATUS_JSON" >/dev/null; then
          echo "$STATUS_JSON"
          curl --fail --silent --show-error http://127.0.0.1:6767/ >"$PASEO_HOME/web-ui.html"
          [[ -s "$PASEO_HOME/web-ui.html" ]]
          exit 0
        fi

        if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
          echo "Nix daemon exited before becoming reachable."
          break
        fi

        sleep 1
      done

      echo "::group::daemon.log"
      cat "$PASEO_HOME/daemon.log" 2>/dev/null || echo "<missing>"
      echo "::endgroup::"

      echo "::group::paseo-server stdout/stderr"
      cat "$WRAPPER_LOG" 2>/dev/null || echo "<missing>"
      echo "::endgroup::"

      echo "::group::paseo daemon status"
      ./result/bin/paseo daemon status || true
      echo "::endgroup::"

      exit 1

    )
    nix build .#desktop -o result-desktop
    ;;
  nix-hash)
    export PATH="/nix/var/nix/profiles/default/bin:$PATH"
    ./scripts/update-nix.sh --check
    git diff --exit-code -- package-lock.json nix/npm-deps.hash
    nix build .#default -o result
    ;;
  nix-macos)
    export PATH="/nix/var/nix/profiles/default/bin:$PATH"
    nix build .#desktop -o result-desktop
    set -euo pipefail

    app="result-desktop/Applications/Paseo.app"
    test -x "$app/Contents/MacOS/Paseo"
    test -L result-desktop/bin/paseo-desktop
    test "$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$app/Contents/Info.plist")" = "sh.paseo.desktop"
    find "$app" -name Info.plist -print0 | xargs -0 -n 1 plutil -lint
    ;;
  *) printf "Unknown fixed CI check\n" >&2; exit 2 ;;
esac
