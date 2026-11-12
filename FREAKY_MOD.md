# Audiobookshelf Freaky MOD

Personal fork of [advplyr/audiobookshelf](https://github.com/advplyr/audiobookshelf), based on **v2.37.2** (commit `edb1f7efc92ecacdef51aafb4d9d5054ce10604f`). The upstream remote and Git history are preserved. Original copyright notices and GPL-3.0 license remain applicable. This project is not an official Audiobookshelf release.

## Podcasts

Each podcast retains its own page. Its episode list combines all audio episodes currently advertised by its configured RSS feed and downloaded episodes still held locally, including archives removed from the feed. Search, sorting and playback queues use that combined list. The default filter is “Show all”; existing user filters remain selectable.

- **Télécharger** stores an episode in the podcast library folder.
- **Téléchargés uniquement** limits the list to local episodes, combines with search/other filters, and remembers the choice in this browser. It does not change the API catalogue.
- **Play** first downloads missing audio, then starts ordinary Audiobookshelf playback. Progress and local files use stable episode identifiers. Choosing a different episode prevents an older waiting request from starting playback later.
- Concurrent requests for one episode share a download. Failed/cancelled downloads can be retried.
- Downloaded episodes retain the existing editing, removal and playlist actions.
- RSS catalogues refresh on access after five minutes and are cached under `/metadata/freaky-podcast-catalog`. A temporary feed failure retains the previous catalogue; local audio remains usable.

The catalogue cannot recover episodes absent from the source RSS unless their files are already local. It does not bypass subscriptions, protected media or publisher restrictions. Metadata listing alone does not download audio. Explicit download and playback require access to the podcast's library; the existing RSS/download URL protections remain in place.

## API

Authenticated API clients receive the combined episode list from `GET /api/items/:id` (also with `?expanded=1`) in `media.episodes`. Availability is exposed as `downloaded`, `downloading`, `downloadError`; remote episodes have duration metadata and no local audio track until downloaded.

- `GET /api/podcasts/:id/episodes?q=search&refresh=1`: full list, optional title/subtitle search and forced RSS refresh; `{ episodes, total, catalogError }`.
- `GET /api/podcasts/:id/episode/:episodeId`: one combined episode and download status.
- `POST /api/podcasts/:id/episode/:episodeId/download`: resolves the episode server-side against its configured RSS; returns 202 while queued/downloading, or 200 when already local. Poll the GET endpoint until `downloaded` or `downloadError`. No client-supplied media URL is accepted.
- `POST /api/items/:id/play/:episodeId`: the standard playback endpoint also materializes missing audio before opening a session. The Web client uses short status requests before opening this session, avoiding long reverse-proxy requests.

Local ORM audio rows remain distinct from RSS catalogue metadata, so scanning and storage accounting continue to describe real files.

## Docker / TrueNAS SCALE

Image: `ghcr.io/freakstreet/audiobookshelf_freaky_mod-docker:v2.37.2-freaky.1` (Linux amd64, suitable for x86 TrueNAS).

Import [`docker/freaky/compose.truenas.yaml`](docker/freaky/compose.truenas.yaml) in TrueNAS custom app YAML. Set `ABS_DATA` or replace its default `/mnt/storage/appData/audiobookshelf-freaky` with your dataset path. Ensure the dataset directories are writable by the container. Open port **13378** on the TrueNAS LAN address. Persist and back up **config, metadata and media** together. New libraries should use `/podcasts` and `/audiobooks`.

For migration from the Mac test instance, stop it and copy its config, metadata and podcast/audio directories into those datasets before starting TrueNAS. The additional `/app/podcasts` mapping preserves the path chosen during initial setup. Do not run two servers against the same writable SQLite configuration. The image contains no personal accounts, secrets or podcasts.

The runtime reuses the pinned official v2.37.2 image for native libraries/FFmpeg and replaces the compiled server and Web client. Build locally:

```sh
docker build -f Dockerfile.freaky --target test -t abs-freaky-tests .
docker build -f Dockerfile.freaky -t audiobookshelf-freaky:2.37.2-freaky.1 .
```

The fork's workflow builds/tests each main push and publishes tagged releases to GHCR. Upstream-specific workflows are retained in `.github/upstream-workflows` without running against this fork.
