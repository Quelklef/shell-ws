{
  description = "shell-ws development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-24.11";
    flake-utils.url = "github:numtide/flake-utils";
    rust-overlay.url = "github:oxalica/rust-overlay";
  };

  outputs = { self, nixpkgs, flake-utils, rust-overlay }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        overlays = [ (import rust-overlay) ];
        pkgs = import nixpkgs { inherit system overlays; };
        rustToolchain = pkgs.rust-bin.stable.latest.default;
        rustPlatform = pkgs.makeRustPlatform {
          cargo = rustToolchain;
          rustc = rustToolchain;
        };
        ui = pkgs.buildNpmPackage {
          pname = "shell-ws-ui";
          version = "0.1.0";
          src = ./.;
          npmDepsHash = "sha256-tZnmgx/9QNa7neAY262TXH7aoeTYsyZIB7j/RhkmPdw=";

          buildPhase = ''
            runHook preBuild
            (
              cd ui
              node ../node_modules/typescript/bin/tsc -b
              node ../node_modules/vite/bin/vite.js build
            )
            runHook postBuild
          '';

          installPhase = ''
            runHook preInstall
            mkdir -p $out/share/shell-ws/ui
            cp -r ui/dist $out/share/shell-ws/ui/dist
            runHook postInstall
          '';
        };
        kernel = rustPlatform.buildRustPackage {
          pname = "shell-ws-kernel";
          version = "0.1.0";
          src = ./.;
          cargoLock.lockFile = ./Cargo.lock;
          cargoBuildFlags = [ "--package" "shell-ws-kernel" ];
          cargoTestFlags = [ "--package" "shell-ws-kernel" ];
          preCheck = ''
            export HOME=$TMPDIR/home
            mkdir -p "$HOME"
          '';
          nativeCheckInputs = [
            pkgs.bash
            pkgs.coreutils
          ];
        };
        shell-ws = pkgs.writeShellApplication {
          name = "shell-ws";
          runtimeInputs = [ kernel ];
          text = ''
            export SHELL_WS_UI_DIST=${ui}/share/shell-ws/ui/dist
            exec shell-ws-kernel "$@"
          '';
        };
      in
      {
        packages = {
          default = shell-ws;
          shell-ws = shell-ws;
          shell-ws-kernel = kernel;
          shell-ws-ui = ui;
        };

        apps.default = {
          type = "app";
          program = "${shell-ws}/bin/shell-ws";
        };

        devShells.default = pkgs.mkShell {
          packages = [
            rustToolchain
            pkgs.cargo-watch
            pkgs.just
            pkgs.nodejs_22
            pkgs.nodePackages.npm
            pkgs.pkg-config
          ];

          shellHook = ''
            export CODEX_HOME=$(realpath ./.codex)
            mkdir -p "$CODEX_HOME"
          '';
        };
      });
}
