SHELL := /bin/zsh

VERSION := $(shell node -p "require('./package.json').version")
TAG := v$(VERSION)
VSIX_NAME := db-inspector-$(VERSION).vsix
LATEST_TAG := $(shell git tag --sort=-v:refname | head -n 1)
LATEST_TAG_VERSION := $(if $(LATEST_TAG),$(patsubst v%,%,$(LATEST_TAG)),$(VERSION))
CURSOR := cursor
EXTENSION_ID := local.db-inspector

.PHONY: install compile lint package vsix tag-version cursor-install clean

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
	$(MAKE) tag-version

tag-version:
	@git rev-parse --git-dir >/dev/null 2>&1
	@git tag -f "$(TAG)" HEAD
	@echo "Tagged current commit as $(TAG)"

cursor-install: cursor-install-$(LATEST_TAG_VERSION)

cursor-install-%: db-inspector-%.vsix
	@VSIX_FILE="$<"; \
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
