{
  description = "rinka (燐火): Firefox⇄Vibe MCP橋。extension + native host を1 derivationに。";

  inputs.flake-utils.url = "github:numtide/flake-utils";

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
        nodejs = pkgs.nodejs_22;
      in
      {
        # 構想: derivation 1本に extension/ と native-host/ をまとめ、
        #   - $out/share/rinka/extension/ （about:debugging 一時読み込み用）
        #   - $out/bin/rinka-host （launcher）
        #   - $out/lib/mozilla/native-messaging-hosts/rinka.json （manifest内pathは$out/bin/rinka-host指す）
        # を出す。現状は素形として `nix build` でテストが走るに留める。
        packages.rinka = pkgs.stdenv.mkDerivation {
          pname = "rinka";
          version = "0.4.1";
          src = ./.;
          buildInputs = [ nodejs ];
          dontBuild = false;
          buildPhase = ''
            runHook preBuild
            export HOME="$TMP"
            ${nodejs}/bin/node --experimental-strip-types --no-warnings test/run-tests.ts
            runHook postBuild
          '';
          installPhase = ''
            mkdir -p "$out/share/rinka"
            cp -r extension "$out/share/rinka/extension"
            cp -r native-host "$out/share/rinka/native-host"
            chmod +x "$out/share/rinka/native-host/install/rinka-host.sh"
            mkdir -p "$out/bin"
            ln -s "$out/share/rinka/native-host/install/rinka-host.sh" "$out/bin/rinka-host"
          '';
        };

        defaultPackage = self.packages.${system}.rinka;
        devShells.default = pkgs.mkShell {
          packages = [ nodejs ];
        };
      });
}
