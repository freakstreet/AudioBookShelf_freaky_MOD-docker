const { expect } = require('chai')
const fs = require('fs')
const os = require('os')
const Path = require('path')
const { EventEmitter } = require('events')
const { RadioFranceManager, showURL } = require('../../server/managers/RadioFranceManager')
const controller = require('../../server/controllers/RadioFranceController')

const URL_SHOW = 'https://www.radiofrance.fr/franceinter/podcasts/exemple'
const filename = 'franceinter-exemple.xml'

describe('Radio France integrated control panel', () => {
  let root, manager, show, library, spawnCalls, child
  beforeEach(() => {
    root = fs.mkdtempSync(Path.join(os.tmpdir(), 'abs-radiofrance-'))
    library = { id: 'library', mediaType: 'podcast', libraryFolders: [{ id: 'folder', path: '/podcasts', libraryId: 'library' }] }
    spawnCalls = []
    manager = new RadioFranceManager({ root, script: '/tool.py', spawnProcess: (...args) => {
      spawnCalls.push(args)
      child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = (signal) => { child.signal = signal }
      return child
    } })
    show = { url: URL_SHOW, title: 'Exemple', station: 'franceinter', episodes: 2, feed: `http://old:13400/feeds/${filename}`, sourceRss: 'https://radiofrance-podcast.net/podcast09/example.xml' }
    fs.mkdirSync(Path.join(root, 'public', 'feeds'), { recursive: true })
    fs.writeFileSync(Path.join(root, 'public', 'catalog.json'), JSON.stringify({ shows: [show], generatedAt: '2026-11-13T12:00:00Z' }))
    fs.writeFileSync(Path.join(root, 'public', 'catalog.opml'), `<opml><body><outline type="rss" xmlUrl="${show.feed}" /></body></opml>`)
    fs.writeFileSync(Path.join(root, 'public', 'feeds', filename), '<rss>registered</rss>')
  })
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }))

  it('validates station/show URLs and rejects arbitrary hosts, credentials and injection', () => {
    expect(showURL('http://radiofrance.fr/franceinter/podcasts/exemple/')).to.equal(URL_SHOW)
    for (const url of ['file:///etc/passwd', 'http://127.0.0.1/feed', 'https://www.radiofrance.fr.evil.org/franceinter/podcasts/exemple', 'https://x:y@www.radiofrance.fr/franceinter/podcasts/exemple', 'https://www.radiofrance.fr/franceinter/podcasts/a;touch']) expect(() => showURL(url)).to.throw()
  })
  it('loads only generated OPML entries and resolves owned feeds without HTTP or path escapes', () => {
    const ready = manager.catalogue().shows[0]
    expect(ready.feed).to.equal(`${manager.baseURL}/feeds/${filename}`)
    expect(manager.ownedFeed(ready.feed)).to.equal('<rss>registered</rss>')
    expect(manager.ownedFeed(`http://radiofrance-catalog-local:13400/feeds/${filename}`)).to.equal('<rss>registered</rss>')
    for (const url of [`http://evil.org/feeds/${filename}`, `${manager.baseURL}/feeds/unknown.xml`, `${manager.baseURL}/feeds/a/${filename}`, `${ready.feed}?path=/etc/passwd`, `${manager.baseURL}/feeds/%2e%2e%2fjob.json`]) expect(manager.ownedFeed(url)).to.equal(null)
    fs.writeFileSync(Path.join(root, 'public', 'catalog.opml'), '<opml/>')
    expect(manager.catalogue().shows).to.have.length(0)
    expect(manager.ownedFeed(ready.feed)).to.equal(null)
  })
  it('does not follow a feed symlink outside its output directory', () => {
    fs.unlinkSync(Path.join(root, 'public', 'feeds', filename))
    fs.writeFileSync(Path.join(root, 'private.xml'), 'secret')
    fs.symlinkSync(Path.join(root, 'private.xml'), Path.join(root, 'public', 'feeds', filename))
    expect(manager.ownedFeed(`${manager.baseURL}/feeds/${filename}`)).to.equal(null)
  })
  it('runs a single bounded-log job, cancels it and keeps the state across restart', () => {
    manager.generate(library.id, [URL_SHOW, URL_SHOW])
    expect(spawnCalls[0][0]).to.equal('python3')
    expect(spawnCalls[0][2].shell).to.equal(false)
    expect(spawnCalls[0][1].filter((arg) => arg === '--show')).to.have.length(1)
    expect(spawnCalls[0][1]).to.include('--refresh-index')
    expect(() => manager.discover(library.id)).to.throw('déjà')
    expect(() => manager.cancel('other-library')).to.throw()
    for (let n = 0; n < 100; n++) child.stdout.emit('data', Buffer.from(`line ${n}\n`))
    expect(manager.job.logs).to.have.length(60)
    manager.cancel(library.id)
    expect(child.signal).to.equal('SIGINT')
    child.emit('close', 1)
    expect(manager.job.status).to.equal('cancelled')
    expect(new RadioFranceManager({ root }).status().running).to.equal(false)
  })
  it('marks an unfinished persisted job as interrupted after a server restart', () => {
    manager.begin('generate', library.id)
    const restarted = new RadioFranceManager({ root })
    expect(restarted.status().status).to.equal('interrupted')
    expect(restarted.status().running).to.equal(false)
  })
  it('matches existing official RSS and legacy managed feeds; rejects ambiguous titles', () => {
    const podcast = { title: 'Changed title', feedURL: show.sourceRss, libraryItem: { id: 'same-item' } }
    const ready = manager.catalogue().shows[0]
    expect(manager.match(ready, [podcast]).itemId).to.equal('same-item')
    podcast.feedURL = `http://radiofrance-catalog-local:13400/feeds/${filename}`
    expect(manager.match(ready, [podcast]).itemId).to.equal('same-item')
    expect(manager.match(ready, [{ title: 'Exemple', libraryItem: {} }, { title: 'Exemple', libraryItem: {} }]).ambiguous).to.equal(true)
  })
  it('links an existing item idempotently without recreating it or changing downloads/progress', async () => {
    let updates = 0, refreshes = 0, emits = 0
    const podcast = { title: 'Exemple', feedURL: show.sourceRss, autoDownloadEpisodes: true, libraryItem: { id: 'keep-id' }, updateFromRequest: async (payload) => { updates++; podcast.feedURL = payload.metadata.feedUrl } }
    manager.loadPodcasts = async () => [podcast]
    manager.loadItem = async (id) => ({ id })
    manager.refreshItem = async () => { refreshes++ }
    manager.emitItem = () => { emits++ }
    const importer = { createPodcastsFromFeedUrls: async () => { throw Error('Must not recreate existing podcast') } }
    for (let run = 0; run < 2; run++) {
      manager.begin('import', library.id)
      await manager.importShows(manager.catalogue().shows, library.id, library.libraryFolders[0], importer, {})
      expect(manager.job.results[0]).to.include({ itemId: 'keep-id', action: run ? 'already' : 'linked' })
    }
    expect(updates).to.equal(1)
    expect(refreshes).to.equal(2)
    expect(emits).to.equal(2)
    expect(podcast.autoDownloadEpisodes).to.equal(true)
  })
  it('adds a prepared show through upstream creation with audio auto-download disabled', async () => {
    let podcasts = [], received
    manager.loadPodcasts = async () => podcasts
    manager.loadItem = async (id) => ({ id })
    manager.refreshItem = async () => {}
    manager.emitItem = () => {}
    const importer = { createPodcastsFromFeedUrls: async (urls, folder, automatic) => {
      received = { urls, folder, automatic }
      podcasts = [{ title: 'Exemple', feedURL: urls[0], libraryItem: { id: 'new-item' } }]
    } }
    manager.begin('import', library.id)
    await manager.importShows(manager.catalogue().shows, library.id, library.libraryFolders[0], importer, {})
    expect(received.automatic).to.equal(false)
    expect(received.folder.id).to.equal('folder')
    expect(manager.job.results[0]).to.include({ itemId: 'new-item', action: 'added' })
  })
  it('rejects missing feeds or another library folder before launching import', () => {
    expect(() => manager.import(library, 'other-folder', [URL_SHOW], {}, {})).to.throw('dossier')
    expect(() => manager.import(library, 'folder', [URL_SHOW + '-absent'], {}, {})).to.throw('Générez')
    expect(manager.status()).to.equal(null)
  })
  it('protects management and generated feeds with administrator access', () => {
    let code, next = false
    const res = { sendStatus: (value) => { code = value }, status: (value) => { code = value; return res }, send: () => {}, set: () => {} }
    controller.middleware({ user: { isAdminOrUp: false } }, res, () => { next = true })
    expect(code).to.equal(403); expect(next).to.equal(false)
    controller.middleware({ user: { isAdminOrUp: true }, library }, res, () => { next = true })
    expect(next).to.equal(true)
  })
})
