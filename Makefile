.PHONY: fmt build test coverage slither aderyn audit clean

fmt:
	forge fmt --check

build:
	forge build --sizes

test:
	forge test

coverage:
	forge coverage

slither:
	slither . --compile-force-framework foundry --filter-paths 'lib/'

aderyn:
	aderyn . --src src --no-snippets --skip-update-check

audit: fmt build test slither aderyn

clean:
	forge clean
