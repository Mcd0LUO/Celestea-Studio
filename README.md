# Celestea Studio

Local web UI for the Celestea-Agent engine (celestea-runtime). A single Rust
binary serves a dark-mode chat UI and streams engine turn events over SSE.

## Run (local)

export RUSTUP_HOME=/opt/rustup CARGO_HOME=/opt/cargo PATH=/opt/cargo/bin:$PATH
cd /src/celestea_studio
cargo build --release
CELESTEA_API_KEY=sk-... ./target/release/celestea-studio          # 127.0.0.1:3777

Config: celestea.toml in cwd (model / base_url / api_key_env), same rules as
the engine; API key via CELESTEA_API_KEY env, api_key_file, or ~/.celestea
config. No key is stored in this repo.

## Access via tunnel

ssh -L 3777:localhost:3777 <server>
# then open http://localhost:3777

## API

- GET / and GET /assets/* - frontend (embedded at compile time)
- POST /api/turn {"input":"..."} - start one turn (409 while busy)
- POST /api/cancel - cooperative cancel of the running turn
- GET /api/events - SSE stream (event names: status/text/thinking/tool/tool_result/done)
- GET /api/health - {ok, name, model, base_url, bind}
