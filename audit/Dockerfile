FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update -qq && \
    apt-get install -y -qq --no-install-recommends \
        curl \
        xz-utils \
        ca-certificates \
        git \
    && rm -rf /var/lib/apt/lists/*

# Nix -- Determinate Systems installer (handles root + no init system in Docker)
RUN curl --proto '=https' --tlsv1.2 -sSf -L https://install.determinate.systems/nix \
    | sh -s -- install linux --no-confirm --init none

# Enable flakes + k-framework substituters; disable sandbox (not available in Docker)
RUN mkdir -p /etc/nix && printf '\
experimental-features = nix-command flakes\n\
sandbox = false\n\
extra-substituters = https://k-framework.cachix.org https://cache.nixos.org\n\
extra-trusted-public-keys = k-framework.cachix.org-1:jeyMXB2h28gpNRjuVkehg+zLj62ma1RnyyopA/20yFE= cache.nixos.org-1:6NCHdD59X431o0gWypbMrAURkbJ16ZPMQFGspcDShjY=\n\
' >> /etc/nix/nix.conf

ENV PATH="/root/.cargo/bin:/root/.local/bin:/root/.nix-profile/bin:/nix/var/nix/profiles/default/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# Node.js -- for Hardhat and @openzeppelin remappings
RUN nix profile add nixpkgs#nodejs

# Slither -- via uv (works on FHS Ubuntu; uv fails on NixOS non-FHS)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    uv tool install slither-analyzer

# Aderyn -- official cargo-dist installer; works natively on Ubuntu (FHS).
#   Use `aderyn-update` inside the container to upgrade.
RUN curl --proto '=https' --tlsv1.2 -LsSf \
        https://github.com/cyfrin/aderyn/releases/latest/download/aderyn-installer.sh \
    | ADERYN_NO_MODIFY_PATH=1 sh && \
    aderyn --version

# kup + Kontrol (slow -- cached after first build; must come before Foundry so this
#   expensive layer stays cached when only the Foundry version changes)
RUN nix profile add github:runtimeverification/kup#kup \
    --option extra-substituters 'https://k-framework.cachix.org' \
    --option extra-trusted-public-keys 'k-framework.cachix.org-1:jeyMXB2h28gpNRjuVkehg+zLj62ma1RnyyopA/20yFE=' \
    --experimental-features 'nix-command flakes'
RUN kup install kontrol

# Foundry -- required by Kontrol (forge build step); installed after kontrol so
#   the expensive K-framework layer above is unaffected by foundry version bumps.
RUN curl -L https://foundry.paradigm.xyz | bash && \
    /root/.foundry/bin/foundryup && \
    ln -s /root/.foundry/bin/forge /usr/local/bin/forge && \
    ln -s /root/.foundry/bin/cast  /usr/local/bin/cast

WORKDIR /workspace

# Cache npm deps
COPY package.json ./
RUN npm install --ignore-scripts 2>/dev/null || npm install

COPY . .

# forge-std lives in lib/ (foundry.toml: libs = ["node_modules", "lib"])
RUN git clone --depth 1 https://github.com/foundry-rs/forge-std.git lib/forge-std
