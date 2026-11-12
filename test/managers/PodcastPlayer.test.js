const { expect } = require('chai')
const fs = require('fs')
const path = require('path')
const vm = require('vm')

describe('Podcast Web player download sequencing', () => {
  let Player, resolveDownload, sessions, errors, ctx
  beforeEach(() => {
    let source = fs.readFileSync(path.resolve(__dirname, '../../../client/players/PlayerHandler.js'), 'utf8')
    source = source.replace(/^import .*\n/gm, '').replace('export default class PlayerHandler', 'class PlayerHandler')
    const context = {
      LocalAudioPlayer: class {}, CastPlayer: class {}, AudioTrack: class {},
      console: { log() {}, error() {}, warn() {} }, clearInterval, setInterval,
      downloadPodcastEpisode: () => new Promise((resolve) => { resolveDownload = resolve })
    }
    vm.createContext(context)
    Player = vm.runInContext(`${source}\nPlayerHandler`, context)
    sessions = []; errors = []
    ctx = {
      $store: { state: { globals: {}, playerQueueItems: [] }, commit() {} },
      $axios: { $post: async (url) => { sessions.push(url); return {} } },
      $toast: { error: (e) => errors.push(e) },
      setPlaying() {}, setCurrentTime() {}
    }
  })
  function player() {
    const p = new Player(ctx)
    p.player = { pause() {}, getCurrentTime: () => 0, playableMimeTypes: [] }
    p.getDeviceId = () => 'device'
    p.libraryItem = { id: 'podcast', media: { episodes: [{ id: 'remote', downloaded: false }] } }
    p.episodeId = 'remote'
    p.prepareSession = () => {}
    return p
  }
  it('opens no playback session before download completion', async () => {
    const p = player()
    const preparing = p.prepare()
    expect(sessions).to.have.length(0)
    resolveDownload('remote')
    await preparing
    expect(sessions).to.deep.equal(['/api/items/podcast/play/remote'])
  })
  it('never starts an old episode after a newer request replaced it', async () => {
    const p = player()
    const preparing = p.prepare()
    p.prepareGeneration++
    resolveDownload('remote')
    await preparing
    expect(sessions).to.have.length(0)
  })
  it('reports playback failure and clears the loading state', async () => {
    const p = player()
    p.libraryItem.media.episodes[0].downloaded = true
    ctx.$axios.$post = async () => { throw new Error('server unavailable') }
    await p.prepare()
    expect(p.playerState).to.equal('IDLE')
    expect(ctx.playerLoading).to.equal(false)
    expect(errors).to.deep.equal(['server unavailable'])
  })
  it('retries preparation when Play is pressed after a failed request', async () => {
    const p = player()
    p.libraryItem.media.episodes[0].downloaded = true
    ctx.$axios.$post = async () => { throw new Error('temporarily unavailable') }
    await p.prepare()
    let retry = false
    ctx.$axios.$post = async () => { retry = true; return {} }
    await p.play()
    expect(retry).to.equal(true)
    expect(p.playWhenReady).to.equal(true)
  })
})
