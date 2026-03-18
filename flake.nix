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
      in
      {
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
            export CODEX_HOME=${toString ./.codex}
            mkdir -p "$CODEX_HOME"
          '';
        };
      });
}
