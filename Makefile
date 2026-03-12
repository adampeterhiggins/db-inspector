SHELL := /bin/zsh

VERSION := $(shell node -p "require('./package.json').version")
TAG := v$(VERSION)
VSIX_NAME := db-inspector-$(VERSION).vsix

.PHONY: install compile lint package vsix tag-version clean

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

clean:
	rm -rf dist
	rm -f ./*.vsix
