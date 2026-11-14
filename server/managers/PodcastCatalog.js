const Crypto = require('crypto')
const Path = require('path')
const fs = require('fs')
const { imageUrl } = require('../utils/podcastArtwork')

// Catalogue metadata stays separate from local audio rows: the scanner, storage
// quotas and playback sessions must never mistake an RSS entry for a file.
class PodcastCatalog {
  constructor({ fetchFeed, loadItem, cacheSeriesImage, ttl = 300000, waitLimit = 1800000, pollInterval = 500 } = {}) {
    this.fetchFeed = fetchFeed || ((url) => require('../utils/podcastUtils').getPodcastFeed(url))
    this.loadItem = loadItem || ((id) => require('../Database').libraryItemModel.getExpandedById(id))
    this.cacheSeriesImage = cacheSeriesImage || ((url) => require('../utils/podcastArtwork').cacheImage(url))
    this.seriesArtwork = new Map()
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
    if (!force && previous && Date.now() - previous.checkedAt < this.ttl) return this.restoreSeriesCover(media, previous)
    if (this.pending.has(key)) {
      await this.pending.get(key)
      return this.restoreSeriesCover(media, this.cached(media))
    }
    const task = (async () => {
      try {
        const feed = await this.fetchFeed(media.feedURL)
        if (!feed || !Array.isArray(feed.episodes)) throw new Error('RSS unavailable')
        const data = { feedURL: media.feedURL, checkedAt: Date.now(), image: imageUrl(feed.metadata?.image), episodes: feed.episodes.filter((ep) => ep.enclosure?.url) }
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
    await this.restoreSeriesCover(media, this.cached(media))
  }

  async restoreSeriesCover(media, data) {
    if (media.coverPath || typeof media.save !== 'function') return
    const url = imageUrl(media.imageURL || data?.image)
    if (!url) return
    const key = `${media.id}:${url}`
    let pending = this.seriesArtwork.get(key)
    if (!pending || Date.now() - pending.checkedAt > 60000) {
      if (this.seriesArtwork.size >= 200) this.seriesArtwork.delete(this.seriesArtwork.keys().next().value)
      pending = { checkedAt: Date.now(), promise: Promise.resolve().then(() => this.cacheSeriesImage(url)).catch(() => null) }
      this.seriesArtwork.set(key, pending)
    }
    const cover = await pending.promise
    if (!cover || media.coverPath) return
    const previousImage = media.imageURL
    media.coverPath = cover
    media.imageURL = url
    try { await media.save() } catch (_) {
      media.coverPath = null
      media.imageURL = previousImage
    }
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
      imageUrl: imageUrl(ep.imageUrl || cached.find((rss) => this.matches(ep, rss))?.imageUrl),
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
      remotes.push({ ...ep, imageUrl: imageUrl(ep.imageUrl), id, libraryItemId: itemId, podcastId: media.id, index: null, addedAt: null, updatedAt: null,
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
    if (local?.audioFile?.metadata?.path && fs.existsSync(local.audioFile.metadata.path)) return { downloaded: true, queued: false, episodeId: local.id }
    if (!rss) throw Object.assign(new Error('Épisode absent du flux RSS et du stockage local.'), { status: 404 })
    const id = local?.id || this.episodeId(item.media, rss)
    const key = `${item.id}:${id}`
    const existing = this.jobs.get(key)
    if (existing && !existing.done) return { downloaded: false, downloading: true, queued: false, episodeId: id }
    const alreadyQueued = [manager.currentDownload, ...(manager.downloadQueue || [])].some((download) => download?.libraryItemId === item.id && download.rssPodcastEpisode && this.matches({ guid: download.rssPodcastEpisode.guid, enclosure: download.rssPodcastEpisode.enclosure }, rss))
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
    return { downloaded: false, downloading: true, queued: !alreadyQueued, episodeId: id }
  }

  async requestAllDownloads(item, manager) {
    await this.refresh(item.media)
    const locals = item.media.podcastEpisodes.map((episode) => ({ id: episode.id,
      guid: episode.guid || episode.extraData?.guid, enclosure: { url: episode.enclosureURL || episode.enclosure?.url }, audioFile: episode.audioFile }))
    const episodes = this.merge(item.media, item.id, locals)
    const result = { total: episodes.length, queued: 0, alreadyDownloaded: 0, alreadyQueued: 0, failed: 0, errors: [] }
    // Resolve every episode against the server's catalogue, never URLs supplied
    // by the browser or its current search/page/filter.
    for (const episode of episodes) {
      try {
        const state = await this.requestDownload(item, episode.id, manager)
        if (state.downloaded) result.alreadyDownloaded++
        else if (state.queued) result.queued++
        else result.alreadyQueued++
      } catch (error) {
        result.failed++
        if (result.errors.length < 50) result.errors.push({ episodeId: episode.id, title: episode.title, error: error.message })
      }
    }
    return result
  }

  async download(item, rss, id, manager) {
    const key = rss.guid || rss.enclosure.url
    const downloads = await manager.downloadPodcastEpisodes(item, [rss], false, { [key]: id })
    const download = downloads[0]
    let started = null
    while (!download.isFinished) {
      // A large batch may legitimately spend more than 30 minutes in the queue.
      // Only time actually spent downloading counts towards the timeout.
      if (manager.currentDownload === download) {
        if (started === null) started = Date.now()
        if (Date.now() - started > this.waitLimit) throw new Error('Délai de téléchargement dépassé. Réessayez.')
      }
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
