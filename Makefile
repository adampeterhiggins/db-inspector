SHELL := /bin/zsh

VERSION := $(shell node -p "require('./package.json').version")
TAG := v$(VERSION)
VSIX_NAME := db-inspector-$(VERSION).vsix
CURSOR := cursor
EXTENSION_ID := local.db-inspector

.PHONY: install compile lint package vsix tag-version prepare-release cursor-install clean

install:
	npm install

compile:
	npm run compile

lint:
	npm run lint

package: $(VSIX_NAME)

vsix: $(VSIX_NAME)
	@echo "Built $(VSIX_NAME)"

$(VSIX_NAME): compile
	npm run package

tag-version:
	@git rev-parse --git-dir >/dev/null 2>&1
	@git tag -f "$(TAG)" HEAD
	@echo "Tagged current commit as $(TAG)"

prepare-release: prepare-release-$(VERSION)

prepare-release-%:
	@git rev-parse --git-dir >/dev/null 2>&1
	@if [ -n "$$(git status --porcelain)" ]; then \
		DEFAULT_MSG="$*"; \
		INPUT_MSG=""; \
		if [ -t 0 ]; then \
			printf "Working tree is dirty. Commit message [$$DEFAULT_MSG]: "; \
			read -r INPUT_MSG; \
		fi; \
		COMMIT_MSG="$${INPUT_MSG:-$$DEFAULT_MSG}"; \
		git add -A; \
		git commit -m "$$COMMIT_MSG"; \
		echo "Committed changes with message: $$COMMIT_MSG"; \
	else \
		echo "Working tree is clean."; \
	fi; \
	git tag -f "v$*" HEAD; \
	echo "Tagged current commit as v$*"

cursor-install: cursor-install-$(VERSION)

cursor-install-%: prepare-release-%
	@$(MAKE) db-inspector-$*.vsix
	@VSIX_FILE="db-inspector-$*.vsix"; \
	EXPECTED_VERSION="$*"; \
	$(CURSOR) --uninstall-extension "$(EXTENSION_ID)" >/dev/null 2>&1 || true; \
	$(CURSOR) --install-extension "$$VSIX_FILE" --force; \
	INSTALLED_VERSION="$$( $(CURSOR) --list-extensions --show-versions | awk -F@ '/^$(EXTENSION_ID)@/{print $$2; exit}' )"; \
	if [ "$$INSTALLED_VERSION" != "$$EXPECTED_VERSION" ]; then \
		echo "Install verification failed: expected $(EXTENSION_ID)@$$EXPECTED_VERSION, got $(EXTENSION_ID)@$$INSTALLED_VERSION"; \
		exit 1; \
	fi; \
	echo "Reinstalled $(EXTENSION_ID)@$$EXPECTED_VERSION from $$VSIX_FILE into Cursor"; \
	echo "Reload Cursor window to activate the new extension process."

clean:
	rm -rf dist
	rm -f ./*.vsix
