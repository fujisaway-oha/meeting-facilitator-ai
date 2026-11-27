# AI会議ファシリテーター（MVP v0.1 / Docker対応版）

対面会議室に同席し、**「書記役」「ファシリテーター（進行役）」「まとめ役」**を担当する完全ローカル志向のAI会議支援システムです。

Docker Composeにより、**手元のMac・一般的な検証用PC・本番のNVIDIA GB10（Linux `arm64` / 128GB）**のどのPCでも同じコマンドで再現・実行できます。

---

## 主な機能（MVP v0.1 実装済み）

* **簡易パスワード認証**：社内LANアクセスをパスコード（初期値：`1234`）と署名付き `HttpOnly` Cookieで保護
* **ローカル音声認識（耳）**：マイク録音データをコンテナ内の `faster-whisper`（VADフィルタ付）で文字起こし
* **ローカル音声合成（口）＆ 動画アバター**：`VOICEVOX Engine` コンテナで自然な日本語音声を生成し、`AvatarRenderer` 抽象インターフェース経由で口パク／ループ動画（`idle.mp4` / `talk.mp4`）と同期再生
* **自己音声エコー抑止ゲート**：AI発話中および再生終了後300msはマイク録音を自動遮断し、スピーカー音の回り込みを防止
* **SQLite (WAL) 永続化 ＆ 次回会議への課題引き継ぎ**：会議履歴を `./data/app.db` に保存し、新規会議作成時に前回の「素材待ち」「未決定事項」を自動引き継ぎ（手動追加ロック `🔒保護` 対応）
* **マルチLLM設定基盤**：[models.yaml](config/models.yaml) で役割別に `Llama 3.1` / `Qwen 2.5` / `Gemma 2` 等を割り当て可能（Ollama未接続PCでも内蔵デモモードで一通り実演可能）

---

## 起動方法1：手元のMac / 一般PCでDocker起動する（おすすめ）

Docker Desktopを起動した状態で、クローン先のフォルダに移動して以下を実行します。

```bash
docker compose up --build
```

起動したらブラウザで **`http://localhost:8000`** を開き、初期パスコード **`1234`** でログインしてください。
（パスコードを変更する場合は `APP_PASSCODE=任意のパスコード docker compose up` で指定できます）

### MacBook NeoからMac mini上の検証環境を開く（SSHトンネル）

Mac miniでアプリが `127.0.0.1:8000` で起動しており、MacBook NeoからSSH接続できることが前提です。同じネットワーク上のMacBook Neoの「ターミナル」で、ユーザー名とLAN内IPアドレスを実際の値に置き換えて実行します。

```bash
ssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:18000:127.0.0.1:8000 MAC_MINI_USER@MAC_MINI_LAN_IP
```

SSH接続を維持したまま、MacBook Neoのブラウザで `http://localhost:18000/` を開きます。検証が終わったら、ターミナルで `Ctrl+C` を押してトンネルを閉じます。

### 手元のMacで動かしながら、頭脳だけGB10のOllamaにつなぐ場合
別ターミナルでGB10の `11434` ポートをSSH転送しておくと、Docker内の `app` コンテナ（`host.docker.internal:11434`）からGB10上のローカルLLMをそのまま呼び出せます。

```bash
ssh -L 11434:127.0.0.1:11434 <Linuxユーザー名>@<GB10のIPアドレス>
```

---

## 起動方法2：本番 GB10（Linux + NVIDIA Blackwell GPU）で起動する

GB10環境にプロジェクト一式を配置し、GPUオーバーライドファイルを併用して起動します。

```bash
docker compose -f compose.yaml -f compose.gpu.yaml up -d --build
```

また、GB10側のOllamaで複数モデル（`Llama 3.1` / `Qwen 2.5` / `Gemma 2`）をメモリ常駐させる場合は、Ollamaサービスに以下の環境変数を設定します。

```bash
OLLAMA_MAX_LOADED_MODELS=4
OLLAMA_KEEP_ALIVE=-1
```

---

## 実写・キャラクター動画への差し替え方法

`static/videos/` フォルダに以下の2ファイルを配置すると（Docker実行中も `/app/videos` に自動マウントされます）、内蔵SVGアバターから動画切替モードへ自動で切り替わります。

* `static/videos/idle.mp4`（待機・傾聴ループ動画）
* `static/videos/talk.mp4`（発話・口パクループ動画）

---

## ドキュメント

* [project-plan.md](docs/project-plan.md)：MVP先行型 開発計画書（全8週間ロードマップ）
* [requirements.md](docs/requirements.md)：技術要件定義書（アーキテクチャ・DB・API仕様）
