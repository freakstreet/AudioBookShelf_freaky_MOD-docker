const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { PodcastCatalog } = require('../../server/managers/PodcastCatalog')

describe('Podcast RSS catalogue and download-on-play', () => {
  let dir, oldMetadata, catalog, media, item, remote
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'abs-catalog-'))
    oldMetadata = global.MetadataPath
    global.MetadataPath = dir
    remote = { guid: 'rss-1', title: 'A remote episode', durationSeconds: 42, enclosure: { url: 'https://example.org/audio.mp3', length: '9000' } }
    media = { id: 'podcast-1', feedURL: 'https://example.org/feed', podcastEpisodes: [] }
    item = { id: 'item-1', media }
    catalog = new PodcastCatalog({ fetchFeed: async () => ({ episodes: [remote] }), loadItem: async () => item, pollInterval: 1, waitLimit: 100 })
  })
  afterEach(() => { global.MetadataPath = oldMetadata; fs.rmSync(dir, { recursive: true, force: true }) })

  it('lists RSS-only episodes with usable durations without creating local audio rows', async () => {
    await catalog.refresh(media)
    const episodes = catalog.merge(media, item.id, [])
    expect(episodes).to.have.length(1)
    expect(episodes[0]).to.include({ downloaded: false, duration: 42, size: 9000 })
    expect(episodes[0].audioFile.duration).to.equal(42)
    expect(media.podcastEpisodes).to.have.length(0)
  })
  it('unifies local and RSS records by GUID or enclosure and retains local archives', async () => {
    await catalog.refresh(media)
    const locals = [
      { id: 'existing', guid: remote.guid, audioFile: { metadata: { path: '/file' } } },
      { id: 'archive', guid: 'removed-from-feed', audioFile: { metadata: { path: '/old' } } }
    ]
    expect(catalog.merge(media, item.id, locals).map((e) => e.id)).to.deep.equal(['existing', 'archive'])
    locals[0].guid = 'changed-guid'
    locals[0].enclosure = remote.enclosure
    expect(catalog.merge(media, item.id, locals)).to.have.length(2)
  })
  it('deduplicates duplicate feed entries', async () => {
    catalog.fetchFeed = async () => ({ episodes: [remote, { ...remote, guid: 'alias' }, remote] })
    await catalog.refresh(media)
    expect(catalog.merge(media, item.id, [])).to.have.length(1)
  })
  it('shares refreshes and respects the refresh interval', async () => {
    let calls = 0
    catalog.fetchFeed = async () => { calls++; await new Promise((r) => setTimeout(r, 5)); return { episodes: [remote] } }
    await Promise.all([catalog.refresh(media), catalog.refresh(media)])
    await catalog.refresh(media)
    expect(calls).to.equal(1)
    await catalog.refresh(media, true)
    expect(calls).to.equal(2)
  })
  it('restores a missing series cover from its legacy image URL and caches the shared fetch', async () => {
    const broken = 'https://www.radiofrance.fr/pikapi/images/e6db8a26-67d2-4f81-b318-8f62579d7ad8/1200'
    const urls = []; let saves = 0
    media.imageURL = broken
    media.save = async () => { saves++ }
    const other = { ...media }
    catalog.cacheSeriesImage = async (url) => { urls.push(url); return '/metadata/podcast-artwork/series.jpg' }
    await Promise.all([catalog.refresh(media), catalog.refresh(other)])
    expect(urls).to.deep.equal([broken + 'x680'])
    expect(media.coverPath).to.equal('/metadata/podcast-artwork/series.jpg')
    expect(other.coverPath).to.equal(media.coverPath)
    expect(media.imageURL).to.equal(broken + 'x680')
    expect(saves).to.equal(2)
    expect(catalog.merge(media, item.id, [])).to.have.length(1)
  })
  it('keeps custom covers and keeps the catalogue usable during an image outage', async () => {
    let requests = 0
    media.imageURL = 'https://example.org/cover.jpg'
    media.save = async () => {}
    catalog.cacheSeriesImage = async () => { requests++; throw new Error('image unavailable') }
    media.coverPath = '/custom/cover.jpg'
    await catalog.refresh(media)
    expect(requests).to.equal(0)
    media.coverPath = null
    await catalog.refresh(media)
    await catalog.refresh(media)
    expect(requests).to.equal(1)
    expect(media.coverPath).to.equal(null)
    expect(catalog.merge(media, item.id, [])).to.have.length(1)
  })
  it('repairs cached episode artwork without changing episode IDs or fetching the feed again', async () => {
    const broken = 'https://www.radiofrance.fr/pikapi/images/e6db8a26-67d2-4f81-b318-8f62579d7ad8/1200'
    remote.imageUrl = broken
    await catalog.refresh(media)
    const id = catalog.episodeId(media, remote)
    catalog.fetchFeed = async () => { throw new Error('must use cache') }
    await catalog.refresh(media)
    expect(catalog.merge(media, item.id, [])[0]).to.include({ id, imageUrl: broken + 'x680' })
  })
  it('keeps stable IDs and the persisted catalogue after restart and a feed outage', async () => {
    await catalog.refresh(media)
    const id = catalog.merge(media, item.id, [])[0].id
    const restarted = new PodcastCatalog({ fetchFeed: async () => { throw new Error('offline') } })
    await restarted.refresh(media, true)
    const episodes = restarted.merge(media, item.id, [])
    expect(episodes[0].id).to.equal(id)
    expect(restarted.cached(media).error).to.include('indisponible')
    const other = { ...media, feedURL: 'https://example.org/other-feed' }
    expect(restarted.merge(other, item.id, [])).to.have.length(0)
  })

  function manager({ fail = false, localId } = {}) {
    const m = { calls: 0, downloadQueue: [], currentDownload: null }
    m.downloadPodcastEpisodes = async (_item, [rss], _auto, ids) => {
      m.calls++
      const download = { isFinished: false, failed: false }
      m.currentDownload = download
      setTimeout(() => {
        if (!fail) {
          const file = path.join(dir, 'episode.mp3')
          fs.writeFileSync(file, 'audio')
          const id = localId || ids[rss.guid]
          media.podcastEpisodes = media.podcastEpisodes.filter((e) => e.id !== id)
          media.podcastEpisodes.push({ id, extraData: { guid: rss.guid }, enclosureURL: rss.enclosure.url, audioFile: { metadata: { path: file } } })
        }
        download.failed = fail
        download.isFinished = true
        m.currentDownload = null
      }, 5)
      return [download]
    }
    return m
  }
  it('deduplicates concurrent download/play requests and waits for the local file', async () => {
    const m = manager()
    const id = catalog.episodeId(media, remote)
    const [a, b] = await Promise.all([catalog.ensureDownloaded(item, id, m), catalog.ensureDownloaded(item, id, m)])
    expect(m.calls).to.equal(1)
    expect(a.episode.id).to.equal(id)
    expect(b.episode.id).to.equal(id)
    expect(fs.existsSync(a.episode.audioFile.metadata.path)).to.equal(true)
    await catalog.ensureDownloaded(item, id, m)
    expect(m.calls).to.equal(1)
  })
  it('resolves virtual IDs to files downloaded by the upstream download queue', async () => {
    const m = manager({ localId: 'upstream-generated-id' })
    const result = await catalog.ensureDownloaded(item, catalog.episodeId(media, remote), m)
    expect(result.episode.id).to.equal('upstream-generated-id')
  })
  it('surfaces a failed download and permits a fresh retry', async () => {
    const id = catalog.episodeId(media, remote)
    const failing = manager({ fail: true })
    let error
    try { await catalog.ensureDownloaded(item, id, failing) } catch (e) { error = e }
    expect(error.status).to.equal(502)
    expect(catalog.jobState(item.id, id).downloadError).to.include('échoué')
    const result = await catalog.ensureDownloaded(item, id, manager())
    expect(result.episode.id).to.equal(id)
    expect(catalog.jobState(item.id, id).downloadError).to.equal(null)
  })
  it('rejects arbitrary episode IDs without starting a download', async () => {
    const m = manager()
    let error
    try { await catalog.requestDownload(item, 'unknown', m) } catch (e) { error = e }
    expect(error.status).to.equal(404)
    expect(m.calls).to.equal(0)
  })
  it('queues the entire 625-episode catalogue, deduplicates feeds and skips local files', async () => {
    const episodes = Array.from({ length: 625 }, (_, i) => ({ ...remote, guid: `rss-${i}`, enclosure: { url: `https://example.org/${i}.mp3` } }))
    catalog.fetchFeed = async () => ({ episodes: episodes.concat(episodes[20]) })
    const file = path.join(dir, 'already-downloaded.mp3'); fs.writeFileSync(file, 'audio')
    media.podcastEpisodes = [{ id: 'local', extraData: { guid: 'rss-0' }, audioFile: { metadata: { path: file } } }]
    const requested = []
    catalog.download = async (_item, rss, id) => { requested.push({ rss, id }) }
    const result = await catalog.requestAllDownloads(item, { downloadQueue: [] })
    expect(result).to.include({ total: 625, queued: 624, alreadyDownloaded: 1, failed: 0 })
    expect(requested).to.have.length(624)
    expect(new Set(requested.map((entry) => entry.id)).size).to.equal(624)
    expect(requested.some((entry) => entry.rss.guid === 'rss-0')).to.equal(false)
  })
  it('shares concurrent bulk and individual requests and counts already queued episodes', async () => {
    let finish
    const gate = new Promise((resolve) => { finish = resolve })
    let downloads = 0
    catalog.download = async () => { downloads++; await gate }
    const m = { downloadQueue: [] }
    const results = await Promise.all([catalog.requestAllDownloads(item, m), catalog.requestAllDownloads(item, m)])
    const state = await catalog.requestDownload(item, catalog.episodeId(media, remote), m)
    expect(downloads).to.equal(1)
    expect(results.reduce((n, result) => n + result.queued, 0)).to.equal(1)
    expect(results.reduce((n, result) => n + result.alreadyQueued, 0)).to.equal(1)
    expect(state.queued).to.equal(false)
    finish()
    await Promise.all([...catalog.jobs.values()].map((job) => job.promise))
  })
  it('continues a bulk request when a missing local archive is absent from the feed', async () => {
    media.podcastEpisodes = [{ id: 'lost-archive', guid: 'removed-from-feed', audioFile: { metadata: { path: path.join(dir, 'missing.mp3') } } }]
    catalog.download = async () => {}
    const result = await catalog.requestAllDownloads(item, { downloadQueue: [] })
    expect(result).to.include({ total: 2, queued: 1, failed: 1 })
    expect(result.errors[0].episodeId).to.equal('lost-archive')
  })
  it('does not expire an episode while waiting behind a large download queue', async () => {
    catalog.waitLimit = 10
    const file = path.join(dir, 'queued.mp3')
    const download = { isFinished: false }
    const m = { currentDownload: {}, downloadQueue: [download], downloadPodcastEpisodes: async () => [download] }
    const timer = setTimeout(() => {
      m.currentDownload = download; m.downloadQueue = []
      fs.writeFileSync(file, 'audio')
      media.podcastEpisodes = [{ id: catalog.episodeId(media, remote), guid: remote.guid, audioFile: { metadata: { path: file } } }]
      download.isFinished = true
    }, 30)
    try {
      const result = await catalog.ensureDownloaded(item, catalog.episodeId(media, remote), m)
      expect(result.episode.audioFile.metadata.path).to.equal(file)
    } finally { clearTimeout(timer) }
  })
  it('still expires a stalled active download', async () => {
    catalog.waitLimit = 5
    const download = { isFinished: false }
    const m = { currentDownload: download, downloadQueue: [], downloadPodcastEpisodes: async () => [download] }
    let error
    try { await catalog.ensureDownloaded(item, catalog.episodeId(media, remote), m) } catch (e) { error = e }
    expect(error.message).to.include('Délai')
  })
  it('reports queue cancellation instead of waiting forever', async () => {
    const m = { currentDownload: null, downloadQueue: [], downloadPodcastEpisodes: async () => [{ isFinished: false }] }
    let error
    try { await catalog.ensureDownloaded(item, catalog.episodeId(media, remote), m) } catch (e) { error = e }
    expect(error.message).to.include('annulé')
  })
  it('redownloads a missing local file while preserving the existing episode ID', async () => {
    media.podcastEpisodes = [{ id: 'existing', guid: remote.guid, audioFile: { metadata: { path: path.join(dir, 'missing.mp3') } } }]
    const m = manager()
    const result = await catalog.ensureDownloaded(item, 'existing', m)
    expect(m.calls).to.equal(1)
    expect(fs.existsSync(result.episode.audioFile.metadata.path)).to.equal(true)
  })
})
