const fs = require('fs')
const Path = require('path')
const { spawn } = require('child_process')
const { parse: parseOPML } = require('../utils/parsers/parseOPML')

const STATIONS = ['franceinter', 'franceculture', 'franceinfo', 'francemusique', 'fip', 'mouv', 'ici', 'radiofrance']
const fail = (message, status = 400) => Object.assign(new Error(message), { status })
const titleKey = (title) => (title || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '')

function showURL(value) {
  try {
    const url = new URL(value)
    const parts = url.pathname.replace(/\/$/, '').split('/').slice(1)
    if (!['http:', 'https:'].includes(url.protocol) || !['www.radiofrance.fr', 'radiofrance.fr'].includes(url.hostname) || url.username || url.password || url.port || parts.length !== 3 || !STATIONS.includes(parts[0]) || parts[1] !== 'podcasts' || !/^[a-z0-9-]+$/.test(parts[2]) || /^(bouquet|selection)-/.test(parts[2])) throw Error()
    return `https://www.radiofrance.fr/${parts.join('/')}`
  } catch (_) { throw fail('Indiquez une page d’émission Radio France : https://www.radiofrance.fr/franceinter/podcasts/…') }
}

class RadioFranceManager {
  constructor({ root, script, spawnProcess = spawn, loadPodcasts, loadItem, refreshItem, emitItem } = {}) {
    this.rootOverride = root
    this.script = script || Path.resolve(__dirname, '../../tools/radiofrance/radiofrance_catalog.py')
    this.spawnProcess = spawnProcess
    this.loadPodcasts = loadPodcasts
    this.loadItem = loadItem || ((id) => require('../Database').libraryItemModel.getExpandedById(id))
    this.refreshItem = refreshItem || ((item) => require('./PodcastCatalog').refresh(item.media, true))
    this.emitItem = emitItem || ((item) => require('../SocketAuthority').libraryItemEmitter('item_updated', item))
    this.job = null
    this.child = null
    this.loaded = false
  }

  get root() { return this.rootOverride || Path.join(global.MetadataPath, 'radiofrance') }
  get baseURL() { return global.RadioFranceBaseURL || 'http://127.0.0.1/api/radiofrance' }
  file(name) { return Path.join(this.root, name) }
  read(name, fallback) {
    try { return JSON.parse(fs.readFileSync(this.file(name), 'utf8')) } catch (_) { return fallback }
  }
  saveJob() {
    fs.mkdirSync(this.root, { recursive: true })
    fs.writeFileSync(this.file('job.json.tmp'), JSON.stringify(this.job), { mode: 0o600 })
    fs.renameSync(this.file('job.json.tmp'), this.file('job.json'))
  }
  status() {
    if (!this.loaded) {
      this.loaded = true
      this.job = this.read('job.json', null)
      if (this.job?.running) {
        this.job = { ...this.job, running: false, status: 'interrupted', finishedAt: Date.now(), error: 'Traitement interrompu par le redémarrage du serveur. Vous pouvez le relancer.' }
        this.saveJob()
      }
    }
    return this.job
  }
  begin(kind, libraryId) {
    if (this.status()?.running) throw fail('Un traitement Radio France est déjà en cours.', 409)
    this.job = { kind, libraryId, running: true, status: 'running', startedAt: Date.now(), logs: [], results: [] }
    this.saveJob()
  }
  log(message) {
    this.job.logs.push(String(message).slice(0, 1000))
    this.job.logs = this.job.logs.slice(-60)
    if (!this.lastSave || Date.now() - this.lastSave > 500) { this.saveJob(); this.lastSave = Date.now() }
  }
  finish(status, error) {
    this.job = { ...this.job, running: false, status, error: error || null, finishedAt: Date.now() }
    this.saveJob()
  }
  feedName(value) {
    try {
      const url = new URL(value)
      const name = url.pathname.split('/').pop()
      return /^[a-z0-9][a-z0-9-]*\.xml$/.test(name) ? name : null
    } catch (_) { return null }
  }
  catalogue() {
    const catalog = this.read('public/catalog.json', { shows: [] })
    let outlines = []
    try { outlines = parseOPML(fs.readFileSync(this.file('public/catalog.opml'), 'utf8')) } catch (_) { /* Not generated yet. */ }
    const registered = new Set(outlines.map((feed) => this.feedName(feed.feedUrl)))
    const shows = (catalog.shows || []).flatMap((show) => {
      try {
        const url = showURL(show.url)
        const filename = this.feedName(show.feed)
        if (!filename || !registered.has(filename) || !fs.existsSync(this.file(`public/feeds/${filename}`))) return []
        return [{ ...show, url, filename, feed: `${this.baseURL}/feeds/${filename}` }]
      } catch (_) { return [] }
    })
    return { generatedAt: catalog.generatedAt || null, shows }
  }
  // Resolve only files registered by our generated OPML. Never fetch a loopback
  // URL or an arbitrary file, and never relax the upstream SSRF policy.
  ownedName(value) {
    try {
      const url = new URL(value)
      const base = new URL(this.baseURL)
      const managed = url.protocol === 'http:' && url.hostname === '127.0.0.1' && url.pathname.startsWith(`${base.pathname}/feeds/`)
      const legacy = url.protocol === 'http:' && url.hostname === 'radiofrance-catalog-local' && url.pathname.startsWith('/feeds/')
      if ((!managed && !legacy) || url.username || url.password || url.search || url.hash) return null
      const name = this.feedName(value)
      const prefix = managed ? `${base.pathname}/feeds/` : '/feeds/'
      return name && url.pathname === prefix + name ? name : null
    } catch (_) { return null }
  }
  ownedFeed(value) {
    try {
      const name = this.ownedName(value)
      if (!name || !this.catalogue().shows.some((show) => show.filename === name)) return null
      const target = fs.realpathSync(this.file(`public/feeds/${name}`))
      const directory = fs.realpathSync(this.file('public/feeds'))
      if (Path.dirname(target) !== directory) return null
      return fs.readFileSync(target, 'utf8')
    } catch (_) { return null }
  }
  selected(urls) {
    if (!Array.isArray(urls) || !urls.length || urls.length > 500) throw fail('Sélectionnez de 1 à 500 émissions.')
    return [...new Set(urls.map(showURL))]
  }
  startProcess(kind, libraryId, args) {
    this.begin(kind, libraryId)
    fs.mkdirSync(this.file('state'), { recursive: true })
    const child = this.spawnProcess('python3', ['-u', this.script, ...args, '--state', this.file('state')], { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    this.child = child
    const job = this.job
    let pending = ''
    const output = (data) => {
      pending += data.toString()
      const lines = pending.split(/\r?\n/)
      pending = lines.pop().slice(-4000)
      lines.filter(Boolean).forEach((line) => this.log(line))
    }
    child.stdout.on('data', output)
    child.stderr.on('data', output)
    child.once('error', () => {
      this.child = null
      this.finish('failed', 'Impossible de démarrer le générateur Radio France.')
    })
    child.once('close', (code) => {
      if (this.job !== job) return
      if (pending) this.log(pending)
      this.child = null
      if (!this.job.running) return
      const cancelled = this.job.cancelRequested
      if (kind === 'generate') {
        const report = this.read('public/report.json', {})
        if (Date.parse(report.startedAt) >= job.startedAt - 1000) this.job.report = { errors: (report.errors || []).slice(0, 50), unavailable: (report.unavailable || []).length }
        const catalog = require('./PodcastCatalog')
        for (const [key, entry] of catalog.cache) {
          if (this.ownedName(entry.feedURL)) catalog.cache.set(key, { ...entry, checkedAt: 0 })
        }
      } else if (kind === 'discover') {
        const discovery = this.read('discovered.json', {}).discovery || {}
        if (Date.parse(discovery.updatedAt) >= job.startedAt - 1000) this.job.report = { errors: (discovery.errors || []).slice(0, 50), unavailable: 0 }
      }
      const partial = kind === 'discover'
        ? 'Le recensement est incomplet. Les émissions déjà trouvées restent disponibles ; une nouvelle tentative traitera les pages manquantes en priorité.'
        : 'Le parcours est incomplet. Les flux déjà générés restent disponibles ; les émissions incomplètes seront traitées en priorité à la prochaine tentative.'
      this.finish(cancelled ? 'cancelled' : code === 0 ? 'completed' : 'partial', cancelled ? null : code ? partial : null)
    })
    return this.job
  }
  generate(libraryId, urls) {
    const selected = this.selected(urls)
    return this.startProcess('generate', libraryId, ['build', '--output', this.file('public'), '--base-url', this.baseURL, '--refresh-index', ...selected.flatMap((url) => ['--show', url])])
  }
  discover(libraryId, station = '') {
    if (station && !STATIONS.includes(station)) throw fail('Station Radio France inconnue.')
    return this.startProcess('discover', libraryId, ['discover', '--config-out', this.file('discovered.json'), ...(station ? ['--station', station] : []), '--refresh'])
  }
  cancel(libraryId) {
    if (!this.status()?.running || this.job.libraryId !== libraryId) throw fail('Aucun traitement à interrompre pour cette bibliothèque.', 409)
    this.job.cancelRequested = true
    this.saveJob()
    if (this.child) {
      const child = this.child
      child.kill('SIGINT')
      const timer = setTimeout(() => { if (this.child === child) child.kill('SIGTERM') }, 5000)
      timer.unref()
    }
    return this.job
  }
  async podcasts(libraryId) {
    if (this.loadPodcasts) return this.loadPodcasts(libraryId)
    const Database = require('../Database')
    return Database.podcastModel.findAll({ include: { model: Database.libraryItemModel, attributes: ['id', 'libraryId'], where: { libraryId } } })
  }
  match(show, podcasts) {
    const exact = podcasts.filter((podcast) => podcast.feedURL === show.feed || (show.sourceRss && podcast.feedURL === show.sourceRss) || (this.ownedName(podcast.feedURL) && this.ownedName(podcast.feedURL) === show.filename))
    const matches = exact.length ? exact : podcasts.filter((podcast) => titleKey(podcast.title) === titleKey(show.title))
    if (matches.length > 1) return { ambiguous: true }
    const podcast = matches[0]
    return podcast ? { podcast, itemId: podcast.libraryItem.id, linked: podcast.feedURL === show.feed } : {}
  }
  async view(library) {
    const catalogue = this.catalogue()
    const podcasts = await this.podcasts(library.id)
    const discovered = this.read('discovered.json', { shows: [] })
    const urls = new Set(catalogue.shows.map((show) => show.url))
    const shows = [...catalogue.shows, ...(discovered.shows || []).flatMap((url) => {
      try {
        url = showURL(url)
        if (urls.has(url)) return []
        urls.add(url)
        const parts = new URL(url).pathname.split('/')
        return [{ url, title: parts[3].replace(/-/g, ' '), station: parts[1] }]
      } catch (_) { return [] }
    })].map((show) => {
      const { podcast, ...match } = this.match(show, podcasts)
      return { ...show, ...match }
    })
    return { ...catalogue, shows, stations: STATIONS, discovery: discovered.discovery || null, job: this.status(), folders: library.libraryFolders.map((folder) => ({ id: folder.id, path: folder.path })) }
  }
  import(library, folderId, urls, podcastManager, cronManager) {
    const selected = this.selected(urls)
    const shows = this.catalogue().shows.filter((show) => selected.includes(show.url))
    if (shows.length !== selected.length) throw fail('Générez d’abord les flux des émissions sélectionnées.')
    const folder = library.libraryFolders.find((folder) => folder.id === folderId)
    if (!folder) throw fail('Choisissez un dossier de cette bibliothèque.')
    this.begin('import', library.id)
    this.importShows(shows, library.id, folder, podcastManager, cronManager).catch((error) => this.finish('failed', error.message))
    return this.job
  }
  async importShows(shows, libraryId, folder, podcastManager, cronManager) {
    for (const show of shows) {
      if (this.job.cancelRequested) break
      this.log(`Bibliothèque : ${show.title}`)
      try {
        let match = this.match(show, await this.podcasts(libraryId))
        if (match.ambiguous) throw Error('Plusieurs émissions portent ce titre. Aucun rattachement automatique effectué.')
        let action = 'already'
        if (match.podcast) {
          if (!match.linked) {
            await match.podcast.updateFromRequest({ metadata: { feedUrl: show.feed } })
            action = 'linked'
          }
        } else {
          // Reuse upstream creation, keeping audio downloads explicitly disabled.
          await podcastManager.createPodcastsFromFeedUrls([show.feed], folder, false, cronManager)
          match = this.match(show, await this.podcasts(libraryId))
          if (!match.podcast) throw Error('Ajout impossible. Vérifiez le dossier et les journaux du serveur.')
          action = 'added'
        }
        const item = await this.loadItem(match.itemId)
        await this.refreshItem(item)
        this.emitItem(item)
        this.job.results.push({ url: show.url, title: show.title, itemId: match.itemId, action })
      } catch (error) {
        this.job.results.push({ url: show.url, title: show.title, action: 'error', error: error.message })
      }
      this.saveJob()
    }
    const errors = this.job.results.filter((result) => result.action === 'error').length
    this.finish(this.job.cancelRequested ? 'cancelled' : errors ? 'partial' : 'completed', errors ? `${errors} émission(s) n’ont pas pu être ajoutées.` : null)
  }
}
module.exports = new RadioFranceManager()
module.exports.RadioFranceManager = RadioFranceManager
module.exports.showURL = showURL
