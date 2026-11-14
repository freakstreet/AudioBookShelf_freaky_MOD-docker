const Crypto = require('crypto')
const Path = require('path')
const fs = require('fs/promises')
const axios = require('axios')
const ssrfFilter = require('ssrf-req-filter')
const Ffmpeg = require('../libs/fluentFfmpeg')
const Logger = require('../Logger')

function imageUrl(value) {
  if (typeof value !== 'string' || value.length > 4096) return null
  try {
    const url = new URL(value.trim())
    if (['www.radiofrance.fr', 'radiofrance.fr'].includes(url.hostname) && /^\/pikapi\/images\/[0-9a-f-]+\/1200$/i.test(url.pathname)) url.pathname += 'x680'
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch (_) {
    return null
  }
}

function run(command) {
  return new Promise((resolve, reject) => command.on('end', resolve).on('error', reject).run())
}

function probe(file) {
  return new Promise((resolve, reject) => Ffmpeg.ffprobe(file, (error, data) => error ? reject(error) : resolve(data)))
}

function artworkRoot() {
  return Path.resolve(global.MetadataPath, 'podcast-artwork')
}

function safeArtworkPath(file) {
  if (typeof file !== 'string') return null
  const root = artworkRoot()
  const resolved = Path.resolve(file)
  return resolved.startsWith(root + Path.sep) && Path.extname(resolved) === '.jpg' ? resolved : null
}

async function cacheImage(url) {
  const root = artworkRoot()
  await fs.mkdir(root, { recursive: true })
  const name = Crypto.createHash('sha256').update(url).digest('hex')
  const image = Path.join(root, `${name}.jpg`)
  try { await fs.access(image); return image } catch (_) { /* Not cached yet. */ }
  const token = Crypto.randomUUID()
  const input = Path.join(root, `${name}-${token}.input`)
  const temp = Path.join(root, `${name}-${token}.jpg`)
  try {
    const response = await axios({
      url, responseType: 'arraybuffer', timeout: 15000,
      maxContentLength: 8 * 1024 * 1024, maxBodyLength: 8 * 1024 * 1024,
      headers: { Accept: 'image/jpeg,image/png,image/webp,image/*;q=0.8' },
      httpAgent: global.DisableSsrfRequestFilter?.(url) ? null : ssrfFilter(url),
      httpsAgent: global.DisableSsrfRequestFilter?.(url) ? null : ssrfFilter(url)
    })
    if (!String(response.headers['content-type'] || '').startsWith('image/')) throw new Error('Response is not an image')
    await fs.writeFile(input, response.data, { mode: 0o600 })
    // Decode to a known format suitable for MP3 APIC and MP4 covr artwork.
    await run(Ffmpeg({ timeout: 45 }).input(input).outputOptions(['-frames:v 1', '-vf scale=1200:1200:force_original_aspect_ratio=decrease']).output(temp))
    await fs.rename(temp, image)
    return image
  } finally {
    await fs.rm(input, { force: true })
    await fs.rm(temp, { force: true })
  }
}

async function cacheLocalImage(file) {
  const bytes = await fs.readFile(file)
  if (bytes.length > 8 * 1024 * 1024) throw new Error('Series image too large')
  const root = artworkRoot()
  await fs.mkdir(root, { recursive: true })
  const name = Crypto.createHash('sha256').update(bytes).digest('hex')
  const target = Path.join(root, `${name}.jpg`)
  try { await fs.access(target); return target } catch (_) { /* First use. */ }
  const temp = Path.join(root, `${name}-${Crypto.randomUUID()}.jpg`)
  try {
    await run(Ffmpeg({ timeout: 45 }).input(file).outputOptions(['-frames:v 1', '-vf scale=1200:1200:force_original_aspect_ratio=decrease']).output(temp))
    await fs.rename(temp, target)
    return target
  } finally { await fs.rm(temp, { force: true }) }
}

async function embed(audio, image) {
  const ext = Path.extname(audio).toLowerCase()
  if (!['.mp3', '.m4a', '.m4b', '.mp4'].includes(ext)) return false
  const temp = Path.join(Path.dirname(audio), `.${Path.basename(audio, ext)}-artwork-${Crypto.randomUUID()}${ext}`)
  const original = await probe(audio)
  const before = original.streams.find((s) => s.codec_type === 'audio')
  if (!before) throw new Error('No audio stream')
  try {
    const options = ['-map 0:a', '-map 1:v:0', '-map_metadata 0', '-map_chapters 0', '-c:a copy', '-c:v mjpeg', '-disposition:v:0 attached_pic']
    if (ext === '.mp3') options.push('-id3v2_version 3')
    else options.push('-f mp4')
    await run(Ffmpeg({ timeout: 120 }).input(audio).input(image).outputOptions(options).outputOptions('-metadata:s:v', 'title=Episode cover').outputOptions('-metadata:s:v', 'comment=Cover (front)').output(temp))
    const result = await probe(temp)
    const after = result.streams.find((s) => s.codec_type === 'audio')
    const picture = result.streams.some((s) => s.codec_type === 'video' && s.disposition?.attached_pic)
    if (!after || !picture || after.codec_name !== before.codec_name || after.channels !== before.channels || after.sample_rate !== before.sample_rate) throw new Error('Artwork verification failed')
    const beforeDuration = Number(before.duration || original.format.duration)
    const afterDuration = Number(after.duration || result.format.duration)
    if (Number.isFinite(beforeDuration) && Number.isFinite(afterDuration) && Math.abs(beforeDuration - afterDuration) > 0.5) throw new Error('Audio duration changed')
    // Same filesystem, atomic replacement. The original survives every prior
    // error; scanning only happens after this operation completes.
    await fs.rename(temp, audio)
    return true
  } finally { await fs.rm(temp, { force: true }) }
}

async function prepareAndEmbed(download, { remote = cacheImage, local = cacheLocalImage, attach = embed } = {}) {
  const episodeUrl = imageUrl(download.rssPodcastEpisode.imageUrl)
  const series = download.libraryItem.media.coverPath || download.libraryItem.media.imageURL
  const candidates = []
  if (episodeUrl) candidates.push({ kind: 'episode', url: episodeUrl })
  if (series) candidates.push({ kind: 'series', url: imageUrl(series), path: series })
  for (const candidate of candidates) {
    try {
      const path = candidate.url ? await remote(candidate.url) : await local(candidate.path)
      const embedded = await attach(download.targetPath, path)
      return { imagePath: path, artworkEmbedded: embedded, artworkSource: candidate.kind }
    } catch (_) {
      Logger.warn(`[PodcastArtwork] Unable to attach ${candidate.kind} artwork; keeping the downloaded audio`)
    }
  }
  return { imagePath: null, artworkEmbedded: false, artworkSource: null }
}

module.exports = { imageUrl, safeArtworkPath, cacheImage, cacheLocalImage, embed, prepareAndEmbed }
