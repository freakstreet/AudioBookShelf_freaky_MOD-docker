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
- Per-episode `itunes:image`/media thumbnails are retained independently from the series cover. They appear in episode rows, detail/search/queue views, the Web player and media-session artwork. Downloaded artwork is cached locally and served through the existing item cover route with `?episode=<id>`; the series image is the fallback.
- New MP3/M4A downloads embed the episode image (or series cover if unavailable) into the file itself using audio stream copy. The implementation checks the resulting audio codec, sample rate, channels, duration and attached-picture flag before atomic replacement. An image failure keeps the original audio usable; existing downloads are not modified automatically.

## Integrated Radio France panel

In a podcast library, administrators have a **Radio France** sidebar entry (also available in the mobile library navigation). The Docker includes Python and the generator: no second container or manual OPML upload is required.

1. Paste a Radio France show page and choose **Générer son flux**, or discover available shows with **Actualiser le catalogue** (one station or all).
2. Select shows and **Générer / actualiser les flux**. The progress, bounded log and interruption control remain accessible after navigation. Restarted jobs are marked interrupted and can be resumed from the persistent cache.
3. Choose the podcast library folder and **Ajouter / relier à la bibliothèque**. The generated OPML is read automatically on the server. **Recharger l’OPML** refreshes this view without uploading a file.

Existing shows are matched by their original RSS/managed feed or a unique normalized title. Linking preserves their item IDs, media, progress and download settings; ambiguous matches are refused. New shows do not auto-download audio. Selective episode download/play works as elsewhere in the fork.

State, generated XML/OPML and job status persist together in `/metadata/radiofrance/`; retain this volume when upgrading or migrating to TrueNAS. The panel and generated-feed HTTP route use the existing administrator authentication. The server reads its own registered feeds directly from disk rather than bypassing SSRF or making unauthenticated loopback requests. Legacy local catalogue URLs are resolved from these same registered files during migration.

Manual refresh revalidates show index pages while retaining the episode-page cache. Traversal is sequential/rate-limited and can take several minutes for large archives; failures retain previously generated episodes. Publication restrictions and missing source episodes are not bypassed.

Management API (administrator + library access): `GET /api/libraries/:id/radiofrance`; `POST /api/libraries/:id/radiofrance/{discover,generate,import,cancel}`. Generate/import accept selected show `urls`; import also requires a `folderId` from that library. Jobs return 202 and are polled through the GET endpoint. A single server-wide job prevents simultaneous writes to the catalogue.

## Radio France Web catalogue generator

[`tools/radiofrance/README.md`](tools/radiofrance/README.md) documents the standalone Python script that walks public Radio France pages and pagination, then writes one RSS XML per show plus OPML. It preserves series/episode illustrations, stable IDs where possible, caches its progress separately from public files, and can serve the generated files read-only. It does not download audio or require Radio France API credentials.

Ordinary RSS sources only expose episodes advertised by their feed or already downloaded locally. The Radio France panel can supply additional archives by generating its own feeds from the public show pages. It does not bypass subscriptions, protected media or publisher restrictions. Metadata listing alone does not download audio. Explicit download and playback require access to the podcast's library; the existing RSS/download URL protections remain in place.

## API

Authenticated API clients receive the combined episode list from `GET /api/items/:id` (also with `?expanded=1`) in `media.episodes`. Availability is exposed as `downloaded`, `downloading`, `downloadError`; remote episodes have duration metadata and no local audio track until downloaded.

Artwork fields are `imageUrl`, `hasCover`, `artworkEmbedded` and `artworkSource` (`episode`, `series`, or null). `artworkEmbedded` describes the downloaded file, not merely whether a remote cover URL exists. Embedded art is implemented for MP3/M4A (also compatible MP4 containers); other audio formats retain normal playback with UI artwork where available.

- `GET /api/podcasts/:id/episodes?q=search&refresh=1`: full list, optional title/subtitle search and forced RSS refresh; `{ episodes, total, catalogError }`.
- `GET /api/podcasts/:id/episode/:episodeId`: one combined episode and download status.
- `POST /api/podcasts/:id/episode/:episodeId/download`: resolves the episode server-side against its configured RSS; returns 202 while queued/downloading, or 200 when already local. Poll the GET endpoint until `downloaded` or `downloadError`. No client-supplied media URL is accepted.
- `POST /api/items/:id/play/:episodeId`: the standard playback endpoint also materializes missing audio before opening a session. The Web client uses short status requests before opening this session, avoiding long reverse-proxy requests.

Local ORM audio rows remain distinct from RSS catalogue metadata, so scanning and storage accounting continue to describe real files.

## Docker / TrueNAS SCALE

Image: `ghcr.io/freakstreet/audiobookshelf_freaky_mod-docker:v2.37.2-freaky.3` (Linux amd64, suitable for x86 TrueNAS).

Import [`docker/freaky/compose.truenas.yaml`](docker/freaky/compose.truenas.yaml) in TrueNAS custom app YAML. Replace `/mnt/storage/appData/audiobookshelf-freaky` with your dataset path. When upgrading an existing installation, preserve its current host paths for config, metadata and media. Ensure the dataset directories are writable by the container. Open port **13378** on the TrueNAS LAN address. Persist and back up **config, metadata and media** together. New libraries should use `/podcasts` and `/audiobooks`.

For migration from the Mac test instance, stop it and copy its config, metadata and podcast/audio directories into those datasets before starting TrueNAS. Podcast library folders should use `/podcasts`, matching the deployment YAML. Do not run two servers against the same writable SQLite configuration. The image contains no personal accounts, secrets or podcasts.

The runtime reuses the pinned official v2.37.2 image for native libraries/FFmpeg and replaces the compiled server and Web client. Build locally:

```sh
docker build -f Dockerfile.freaky --target test -t abs-freaky-tests .
docker build -f Dockerfile.freaky --target artwork-test -t abs-artwork-tests .
docker build -f Dockerfile.freaky -t audiobookshelf-freaky:2.37.2-freaky.3 .
```

The fork's workflow builds/tests each main push and publishes tagged releases to GHCR. Upstream-specific workflows are retained in `.github/upstream-workflows` without running against this fork.
