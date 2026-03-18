dev:
  npm run dev

build:
  npm run build

test:
  npm run test

kernel:
  cargo run --manifest-path kernel/Cargo.toml

ui:
  npm run dev --workspace ui
