# dailies — developer task runner
#
# Thin, self-documenting wrapper over pnpm + turbo. Run `make` (or `make help`)
# for the menu. Workspace-scoped targets go through `turbo --filter` so the
# topological build graph (^build) is respected — e.g. building/testing the CLI
# first builds the daemon it embeds.

.DEFAULT_GOAL := help

# Local dev tools (turbo, ultracite) live in root devDependencies and aren't on
# PATH inside recipes, so invoke them via `pnpm exec`. We use `pnpm exec` rather
# than `pnpm <script>` for ultracite doctor specifically: the `pnpm run` wrapper
# trips a benign "Load npm builtin configs failed" warning and hides the doctor
# TUI when stdout isn't a terminal.
EXEC  := pnpm exec
TURBO := $(EXEC) turbo

# Workspace filter aliases.
DAEMON  := dailies-daemon
CLI     := dailies-cli

.PHONY: help install hooks outdated clean reset \
        dev dev-daemon dev-cli \
        build build-daemon build-cli \
        typecheck lint format doctor docs docs-check \
        test test-daemon test-cli \
        watch-daemon watch-cli \
        check ci release \
        install-local link unlink plugin-dev plugin-update

##@ General

help: ## Show this help
	@awk 'BEGIN {FS = ":.*##"; printf "\nUsage:\n  make \033[36m<target>\033[0m\n"} \
		/^[a-zA-Z0-9_-]+:.*?##/ { printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2 } \
		/^##@/ { printf "\n\033[1m%s\033[0m\n", substr($$0, 5) }' $(MAKEFILE_LIST)

install: ## Install all workspace dependencies
	pnpm install

hooks: ## (Re)install git hooks (husky)
	pnpm prepare

outdated: ## List outdated dependencies across all workspaces
	pnpm outdated -r

clean: ## Remove build artifacts and caches (keeps node_modules)
	pnpm clean

reset: clean ## clean + remove all node_modules (full re-install needed after)
	rm -rf node_modules apps/*/node_modules packages/*/node_modules

##@ Develop

dev: ## Run every workspace's dev script (turbo, parallel + persistent)
	pnpm dev


dev-daemon: ## Run the daemon from source (tsx)
	$(TURBO) run dev --filter=$(DAEMON)


dev-cli: ## Run the dailies session orchestrator from source (tsx)
	$(TURBO) run dev --filter=$(CLI)

##@ Build

build: ## Build all workspaces in topological order
	pnpm build


build-daemon: ## Build the daemon bundle + sandbox client
	$(TURBO) run build --filter=$(DAEMON)

build-cli: ## Build the dailies session orchestrator
	$(TURBO) run build --filter=$(CLI)

##@ Quality

typecheck: ## Type-check every workspace (tsc --noEmit)
	pnpm typecheck

lint: ## Lint + format-check with ultracite (biome) — no writes
	pnpm lint

format: ## Auto-fix lint + formatting with ultracite (biome)
	pnpm format

doctor: ## Verify the ultracite/biome setup is healthy
	$(EXEC) ultracite doctor

docs: ## Re-stitch docs/snippets/ into skills, README, and cli-kit
	node scripts/stitch-docs.mjs --write

docs-check: ## Verify stitched docs are in sync with docs/snippets/ (CI)
	node scripts/stitch-docs.mjs --check

##@ Test

test: ## Run all tests
	pnpm test


test-daemon: ## Test the daemon
	$(TURBO) run test --filter=$(DAEMON)


test-cli: ## Test the dailies session orchestrator
	$(TURBO) run test --filter=$(CLI)


watch-daemon: ## Watch-test the daemon
	pnpm --filter $(DAEMON) test:watch

watch-cli: ## Watch-test the dailies session orchestrator
	pnpm --filter $(CLI) test:watch

##@ CI

check: ## What CI runs: ultracite check + turbo compile + test
	pnpm check

ci: ## Full CI gate from clean: frozen install + check
	pnpm install --frozen-lockfile
	pnpm check

##@ Local install (run THIS checkout everywhere)

install-local: build link plugin-dev ## Build + global npm links + Claude Code plugin from this checkout

link: ## Globally symlink the CLI so `npx dailies-cli` / `dailies` run this checkout
	npm install -g ./apps/dailies
	@echo "Linked. New builds (make build) are picked up automatically;"
	@echo "restart the daemon to load them: dailies stop"

unlink: ## Remove the global npm links (next npx falls back to the registry)
	npm uninstall -g dailies-cli

plugin-dev: ## Point the Claude Code dailies plugin at this checkout (replaces the installed copy)
	-claude plugin marketplace remove dailies-marketplace 2>/dev/null
	claude plugin marketplace add "$(CURDIR)"
	claude plugin install dailies@dailies-marketplace --scope user
	@echo "Installed. The plugin cache is a SNAPSHOT - run 'make plugin-update' after skill edits."

# `claude plugin update` compares versions and the dev version rarely changes,
# so refresh by reinstalling — that always re-copies the checkout.
plugin-update: ## Re-copy this checkout's skills into the installed Claude Code plugin
	-claude plugin uninstall dailies@dailies-marketplace 2>/dev/null
	claude plugin install dailies@dailies-marketplace --scope user
	@echo "Updated. Restart Claude Code sessions to load the new skill content."

##@ Release

# Cutting stops at the tag. Publishing is separate and manual: push, dispatch
# release.yml on the tag, then `npm stage approve` — the script prints all three.
release: ## Cut a release: bump + commit + tag (publishing stays manual — see RELEASING.md)
	@BUMP="$(BUMP)" VERSION="$(VERSION)" YES="$(YES)" NO_VERIFY="$(NO_VERIFY)" \
		ALLOW_DIRTY="$(ALLOW_DIRTY)" bash scripts/release.sh
