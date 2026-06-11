.PHONY: fmt build test coverage slither audit clean

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

audit: fmt build test slither

clean:
	forge clean
