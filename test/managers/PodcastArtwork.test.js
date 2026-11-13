const { expect } = require('chai')
const Path = require('path')
const { imageUrl, safeArtworkPath, prepareAndEmbed } = require('../../server/utils/podcastArtwork')
const { parsePodcastRssFeedXml } = require('../../server/utils/podcastUtils')

describe('Podcast episode artwork', () => {
  it('keeps episode and series images separate while parsing RSS', async () => {
    const { podcast } = await parsePodcastRssFeedXml(`<?xml version="1.0"?><rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Series</title><itunes:image href="https://example.org/series.jpg"/><item><title>Episode</title><guid>episode-id</guid><itunes:image href="https://example.org/episode.jpg"/><enclosure url="https://example.org/audio.mp3" type="audio/mpeg" length="1000"/></item></channel></rss>`)
    expect(podcast.metadata.image).to.equal('https://example.org/series.jpg')
    expect(podcast.episodes[0].imageUrl).to.equal('https://example.org/episode.jpg')
  })
  it('ignores unsafe or malformed artwork URLs', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'data:image/png;base64,foo', 'https://user:secret@example.org/image.jpg', null, {}]) expect(imageUrl(url)).to.equal(null)
    expect(imageUrl(' https://example.org/image.jpg ')).to.equal('https://example.org/image.jpg')
  })
  it('only serves JPEG files inside the dedicated artwork cache', () => {
    const old = global.MetadataPath
    global.MetadataPath = '/metadata'
    try {
      expect(safeArtworkPath('/etc/passwd')).to.equal(null)
      expect(safeArtworkPath('/metadata/podcast-artwork/../other.jpg')).to.equal(null)
      expect(safeArtworkPath('/metadata/podcast-artwork/x.input')).to.equal(null)
      expect(safeArtworkPath('/metadata/podcast-artwork/x.jpg')).to.equal(Path.resolve('/metadata/podcast-artwork/x.jpg'))
    } finally { global.MetadataPath = old }
  })
  function download() {
    return { rssPodcastEpisode: { imageUrl: 'https://example.org/episode.jpg' }, libraryItem: { media: { coverPath: '/series.jpg' } }, targetPath: '/episode.mp3' }
  }
  it('prefers episode artwork and attaches it to the downloaded file', async () => {
    let attached
    const result = await prepareAndEmbed(download(), { remote: async () => '/cache/episode.jpg', local: async () => { throw new Error('unexpected fallback') }, attach: async (audio, image) => { attached = { audio, image }; return true } })
    expect(result).to.deep.equal({ imagePath: '/cache/episode.jpg', artworkEmbedded: true, artworkSource: 'episode' })
    expect(attached).to.deep.equal({ audio: '/episode.mp3', image: '/cache/episode.jpg' })
  })
  it('falls back to the series cover when episode artwork cannot be fetched', async () => {
    const result = await prepareAndEmbed(download(), { remote: async () => { throw new Error('offline') }, local: async () => '/cache/series.jpg', attach: async () => true })
    expect(result.artworkSource).to.equal('series')
    expect(result.artworkEmbedded).to.equal(true)
  })
  it('does not fail the audio download if every artwork attempt fails', async () => {
    const result = await prepareAndEmbed(download(), { remote: async () => { throw new Error('offline') }, local: async () => { throw new Error('missing') }, attach: async () => { throw new Error('invalid image') } })
    expect(result.artworkEmbedded).to.equal(false)
    expect(result.imagePath).to.equal(null)
  })
})
