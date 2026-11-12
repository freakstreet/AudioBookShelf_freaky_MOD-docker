// Short requests keep download-on-play usable behind a reverse proxy. Leaving
// the player cancels waiting, not the server's download/cache operation.
export async function downloadPodcastEpisode(axios, itemId, episodeId, isActive = () => true) {
  const state = await axios.$post(`/api/podcasts/${itemId}/episode/${episodeId}/download`)
  if (state.downloaded) return state.episodeId
  const id = state.episodeId
  const deadline = Date.now() + 30 * 60 * 1000
  while (isActive()) {
    const episode = await axios.$get(`/api/podcasts/${itemId}/episode/${id}`)
    if (!isActive()) return null
    if (episode.downloaded) return episode.id
    if (episode.downloadError) throw new Error(episode.downloadError)
    if (!episode.downloading || Date.now() > deadline) throw new Error('Téléchargement interrompu. Réessayez.')
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}
