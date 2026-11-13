const Crypto = require('crypto')
const Path = require('path')
const fs = require('fs')

// Catalogue metadata stays separate from local audio rows: the scanner, storage
// quotas and playback sessions must never mistake an RSS entry for a file.
class PodcastCatalog {
  constructor({ fetchFeed, loadItem, ttl = 300000, waitLimit = 1800000, pollInterval = 500 } = {}) {
    this.fetchFeed = fetchFeed || ((url) => require('../utils/podcastUtils').getPodcastFeed(url))
    this.loadItem = loadItem || ((id) => require('../Database').libraryItemModel.getExpandedById(id))
    this.ttl = ttl
    this.waitLimit = waitLimit
    this.pollInterval = pollInterval
    this.cache = new Map()
    this.pending = new Map()
    this.jobs = new Map()
  }

  key(media) {
    return `${media.id}:${media.feedURL || ''}`
  }

  cacheFile(media) {
    if (!global.MetadataPath) return null
    const name = Crypto.createHash('sha256').update(this.key(media)).digest('hex')
    return Path.join(global.MetadataPath, 'freaky-podcast-catalog', `${name}.json`)
  }

  cached(media) {
    const key = this.key(media)
    if (!this.cache.has(key)) {
      const file = this.cacheFile(media)
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (data.feedURL === media.feedURL && Array.isArray(data.episodes)) this.cache.set(key, data)
      } catch (_) { /* First access or invalid cache: retrieve the RSS feed. */ }
    }
    return this.cache.get(key)
  }

  async refresh(media, force = false) {
    if (!media.feedURL) return
    const key = this.key(media)
    const previous = this.cached(media)
    if (!force && previous && Date.now() - previous.checkedAt < this.ttl) return
    if (this.pending.has(key)) return this.pending.get(key)
    const task = (async () => {
      try {
        const feed = await this.fetchFeed(media.feedURL)
        if (!feed || !Array.isArray(feed.episodes)) throw new Error('RSS unavailable')
        const data = { feedURL: media.feedURL, checkedAt: Date.now(), episodes: feed.episodes.filter((ep) => ep.enclosure?.url) }
        this.cache.set(key, data)
        const file = this.cacheFile(media)
        if (file) {
          try {
            await fs.promises.mkdir(Path.dirname(file), { recursive: true })
            const temp = `${file}.tmp`
            await fs.promises.writeFile(temp, JSON.stringify(data), { mode: 0o600 })
            await fs.promises.rename(temp, file)
          } catch (_) { /* The in-memory catalogue still works on a read-only metadata mount. */ }
        }
      } catch (_) {
        // Keep the last catalogue across feed outages, including after restart.
        this.cache.set(key, { ...previous, episodes: previous?.episodes || [], checkedAt: Date.now() - this.ttl + 30000, error: 'Flux RSS temporairement indisponible.' })
      }
    })()
    this.pending.set(key, task)
    try { await task } finally { this.pending.delete(key) }
  }

  episodeId(media, episode) {
    const key = episode.guid || episode.enclosure?.url
    const hash = Crypto.createHash('sha256').update(`${media.id}\0${key}`).digest('hex').slice(0, 32).split('')
    hash[12] = '5'
    hash[16] = ((parseInt(hash[16], 16) & 3) | 8).toString(16)
    const h = hash.join('')
    return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
  }

  matches(local, remote) {
    const guid = local.guid || local.extraData?.guid
    const url = local.enclosureURL || local.enclosure?.url
    return !!((guid && remote.guid && guid === remote.guid) || (url && url === remote.enclosure?.url))
  }

  localFor(media, remote) {
    return (media.podcastEpisodes || []).find((ep) => this.matches(ep, remote))
  }

  jobState(itemId, episodeId) {
    const job = this.jobs.get(`${itemId}:${episodeId}`)
    return { downloading: !!job && !job.done, downloadError: job?.error || null }
  }

  merge(media, itemId, locals) {
    const cached = this.cached(media)?.episodes || []
    const result = locals.map((ep) => ({ ...ep,
      imageUrl: ep.imageUrl || cached.find((rss) => this.matches(ep, rss))?.imageUrl || null,
      downloaded: !!ep.audioFile?.metadata?.path, ...this.jobState(itemId, ep.id) }))
    const ids = new Set(result.map((ep) => ep.id))
    const remotes = []
    for (const ep of this.cached(media)?.episodes || []) {
      if (result.some((local) => this.matches(local, ep)) || remotes.some((remote) => this.matches(remote, ep))) continue
      const id = this.episodeId(media, ep)
      if (ids.has(id)) continue
      ids.add(id)
      const duration = Number(ep.durationSeconds) || 0
      const size = Number(ep.enclosure?.length) || 0
      remotes.push({ ...ep, id, libraryItemId: itemId, podcastId: media.id, index: null, addedAt: null, updatedAt: null,
        downloaded: false, duration, size, audioTrack: null,
        audioFile: { duration, metadata: { filename: '', path: null, size: 0 } },
        ...this.jobState(itemId, id) })
    }
    return result.concat(remotes)
  }

  async find(item, episodeId) {
    await this.refresh(item.media)
    const local = item.media.podcastEpisodes.find((ep) => ep.id === episodeId)
    const rss = (this.cached(item.media)?.episodes || []).find((ep) => this.episodeId(item.media, ep) === episodeId || (local && this.matches(local, ep)))
    return { local: local || (rss && this.localFor(item.media, rss)), rss }
  }

  async requestDownload(item, episodeId, manager) {
    const { local, rss } = await this.find(item, episodeId)
    if (local?.audioFile?.metadata?.path && fs.existsSync(local.audioFile.metadata.path)) return { downloaded: true, episodeId: local.id }
    if (!rss) throw Object.assign(new Error('Épisode absent du flux RSS et du stockage local.'), { status: 404 })
    const id = local?.id || this.episodeId(item.media, rss)
    const key = `${item.id}:${id}`
    const existing = this.jobs.get(key)
    if (existing && !existing.done) return { downloaded: false, downloading: true, episodeId: id }
    // Completed jobs are only useful briefly for status polling.
    for (const [jobKey, value] of this.jobs) {
      if (value.done && Date.now() - value.finishedAt > 3600000) this.jobs.delete(jobKey)
    }
    const job = { done: false, error: null, promise: null }
    this.jobs.set(key, job)
    job.promise = this.download(item, rss, id, manager).then(() => {
      job.done = true
      job.finishedAt = Date.now()
    }).catch((error) => {
      job.done = true
      job.finishedAt = Date.now()
      job.error = error.message || 'Échec du téléchargement.'
    })
    return { downloaded: false, downloading: true, episodeId: id }
  }

  async download(item, rss, id, manager) {
    const key = rss.guid || rss.enclosure.url
    const downloads = await manager.downloadPodcastEpisodes(item, [rss], false, { [key]: id })
    const download = downloads[0]
    const started = Date.now()
    while (!download.isFinished) {
      if (Date.now() - started > this.waitLimit) throw new Error('Délai de téléchargement dépassé. Réessayez.')
      if (manager.currentDownload !== download && !manager.downloadQueue.includes(download)) throw new Error('Téléchargement annulé. Réessayez.')
      await new Promise((resolve) => setTimeout(resolve, this.pollInterval))
    }
    if (download.failed) throw new Error('Le téléchargement a échoué. Réessayez.')
    const latest = await this.loadItem(item.id)
    if (!latest || !this.localFor(latest.media, rss)) throw new Error('Le fichier téléchargé n’a pas pu être indexé.')
  }

  async ensureDownloaded(item, episodeId, manager) {
    const state = await this.requestDownload(item, episodeId, manager)
    if (!state.downloaded) {
      const job = this.jobs.get(`${item.id}:${state.episodeId}`)
      await job.promise
      if (job.error) throw Object.assign(new Error(job.error), { status: 502 })
    }
    const latest = await this.loadItem(item.id)
    if (!latest?.media) throw Object.assign(new Error('Podcast introuvable.'), { status: 404 })
    const { local } = await this.find(latest, state.episodeId)
    if (!local) throw Object.assign(new Error('Fichier audio introuvable après téléchargement.'), { status: 502 })
    return { item: latest, episode: local }
  }
}

module.exports = new PodcastCatalog()
module.exports.PodcastCatalog = PodcastCatalog
