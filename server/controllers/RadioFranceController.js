const manager = require('../managers/RadioFranceManager')
const Logger = require('../Logger')

module.exports = {
  middleware(req, res, next) {
    if (!req.user.isAdminOrUp) return res.sendStatus(403)
    if (req.library && req.library.mediaType !== 'podcast') return res.status(400).send('Cette bibliothèque ne contient pas de podcasts.')
    res.set('Cache-Control', 'no-store')
    next()
  },
  async view(req, res) {
    try { res.json(await manager.view(req.library)) } catch (error) { Logger.error('[RadioFrance] Catalogue unavailable', error); res.status(500).send('Impossible de charger le catalogue Radio France.') }
  },
  action(req, res) {
    try {
      let job
      if (req.params.action === 'generate') job = manager.generate(req.library.id, req.body.urls)
      else if (req.params.action === 'discover') job = manager.discover(req.library.id, req.body.station)
      else if (req.params.action === 'import') job = manager.import(req.library, req.body.folderId, req.body.urls, this.podcastManager, this.cronManager)
      else if (req.params.action === 'cancel') job = manager.cancel(req.library.id)
      else return res.sendStatus(404)
      res.status(202).json({ job })
    } catch (error) { res.status(error.status || 500).send(error.status ? error.message : 'Impossible de lancer le traitement Radio France.') }
  },
  feed(req, res) {
    const xml = manager.ownedFeed(`${manager.baseURL}/feeds/${req.params.filename}`)
    if (!xml) return res.sendStatus(404)
    res.type('application/rss+xml').send(xml)
  }
}
