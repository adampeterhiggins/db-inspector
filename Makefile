SHELL := /bin/zsh

VERSION := $(shell node -p "require('./package.json').version")
TAG := v$(VERSION)
VSIX_NAME := db-inspector-$(VERSION).vsix
LATEST_TAG := $(shell git tag --sort=-v:refname | head -n 1)
LATEST_TAG_VERSION := $(if $(LATEST_TAG),$(patsubst v%,%,$(LATEST_TAG)),$(VERSION))
CURSOR := cursor

.PHONY: install compile lint package vsix tag-version cursor-install clean

install:
	npm install

compile:
	npm run compile

lint:
	npm run lint

package: compile
	npm run package
	$(MAKE) tag-version

vsix: package
	@echo "Built $(VSIX_NAME)"

tag-version:
	@git rev-parse --git-dir >/dev/null 2>&1
	@git tag -f "$(TAG)" HEAD
	@echo "Tagged current commit as $(TAG)"

cursor-install: cursor-install-$(LATEST_TAG_VERSION)

cursor-install-%:
	@VSIX_FILE="db-inspector-$*.vsix"; \
	if [ ! -f "$$VSIX_FILE" ]; then \
		echo "VSIX not found: $$VSIX_FILE"; \
		echo "Build it first with: make vsix"; \
		exit 1; \
	fi; \
	$(CURSOR) --install-extension "$$VSIX_FILE" --force; \
	echo "Installed $$VSIX_FILE into Cursor"

clean:
	rm -rf dist
	rm -f ./*.vsix
