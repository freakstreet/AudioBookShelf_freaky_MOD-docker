<template>
  <div class="page" :class="streamLibraryItem ? 'streaming' : ''">
    <app-book-shelf-toolbar page="radiofrance" />
    <div id="bookshelf" class="w-full overflow-y-auto px-4 py-6 md:px-10">
      <div class="rf-panel mx-auto">
        <header class="rf-heading">
          <div>
            <h1>Radio France</h1>
            <p>Retrouvez les archives des émissions et ajoutez leurs flux directement à votre bibliothèque.</p>
          </div>
          <button :disabled="loading || busy" @click="load(true)"><span class="material-symbols">sync</span> Recharger l’OPML</button>
        </header>

        <section class="rf-box">
          <h2>Une émission à ajouter ?</h2>
          <form class="rf-row" @submit.prevent="generateURL">
            <input v-model.trim="showURL" type="url" required placeholder="https://www.radiofrance.fr/franceinter/podcasts/…" aria-label="Page de l’émission Radio France" :disabled="busy" />
            <button class="rf-primary" type="submit" :disabled="busy || !showURL">Générer son flux</button>
          </form>
          <p class="rf-help">Le serveur parcourt les pages de l’émission, conserve les épisodes et leurs illustrations, puis prépare le flux RSS. Aucun fichier audio n’est téléchargé à cette étape.</p>
          <div class="rf-row rf-discover">
            <label for="rf-discover-station">Rechercher des émissions</label>
            <select id="rf-discover-station" v-model="discoverStation" :disabled="busy"><option value="">Toutes les stations</option><option v-for="station in stations" :key="station" :value="station">{{ stationName(station) }}</option></select>
            <button :disabled="busy" @click="act('discover', { station: discoverStation })"><span class="material-symbols">travel_explore</span> Actualiser le catalogue</button>
          </div>
          <p class="rf-help">Les résultats sont conservés au fil du parcours, même après une interruption. Une nouvelle tentative traite d’abord les pages manquantes, puis actualise celles déjà récupérées.</p>
        </section>

        <section v-if="job" class="rf-box rf-job" role="status" aria-live="polite">
          <div class="rf-row"><strong>{{ jobLabel }}</strong><span class="rf-help">{{ jobTime }}</span><button v-if="busy && job.libraryId === libraryId" class="rf-stop" :disabled="job.cancelRequested" @click="act('cancel')">{{ job.cancelRequested ? 'Arrêt en cours…' : 'Interrompre' }}</button></div>
          <p v-if="job.error" class="rf-error">{{ job.error }}</p>
          <p v-if="busy && job.logs.length" class="rf-current">{{ job.logs[job.logs.length - 1] }}</p>
          <details v-if="job.logs.length"><summary>Journal du traitement</summary><pre>{{ job.logs.join('\n') }}</pre></details>
          <details v-if="job.report && (job.report.errors.length || job.report.unavailable)"><summary>Détails du parcours</summary><p v-if="job.report.unavailable" class="rf-help">{{ job.report.unavailable }} épisode(s) sans audio accessible sur le site.</p><p v-for="(problem, index) in job.report.errors" :key="index" class="rf-error">{{ problem.error }} · {{ problem.url }}</p></details>
          <ul v-if="job.kind === 'import' && job.results.length" class="rf-results"><li v-for="result in job.results" :key="result.url"><span :class="result.error ? 'rf-error' : 'rf-good'">{{ resultLabel(result) }}</span> · {{ result.title }} <nuxt-link v-if="result.itemId" :to="`/item/${result.itemId}`">Ouvrir</nuxt-link></li></ul>
        </section>
        <p v-if="error" class="rf-error rf-box" role="alert">{{ error }}</p>

        <section class="rf-box">
          <div class="rf-heading">
            <div><h2>Catalogue des émissions <span class="rf-count">{{ shows.length }}</span></h2><p class="rf-help">{{ readyCount }} flux prêts · {{ episodeCount.toLocaleString('fr-FR') }} épisodes disponibles</p></div>
            <span v-if="generatedAt" class="rf-help">OPML chargé automatiquement · {{ formatDate(generatedAt) }}</span>
          </div>
          <div class="rf-row rf-filters">
            <input v-model="search" type="search" placeholder="Rechercher une émission…" aria-label="Rechercher une émission" />
            <select v-model="filterStation" aria-label="Filtrer par station"><option value="">Toutes les stations</option><option v-for="station in stations" :key="station" :value="station">{{ stationName(station) }}</option></select>
            <select v-model="filterState" aria-label="Filtrer par état"><option value="all">Toutes les émissions</option><option value="ready">Flux prêts</option><option value="linked">Dans la bibliothèque</option><option value="pending">À générer</option></select>
          </div>
          <div class="rf-selection">
            <label><input type="checkbox" :checked="allSelected" :disabled="busy || !filtered.length" @change="toggleAll" /> Sélectionner les résultats ({{ filtered.length }})</label>
            <span>{{ selected.length }} sélectionnée(s)</span>
          </div>
          <div class="rf-actions">
            <button :disabled="busy || !selected.length" @click="act('generate', { urls: selected })"><span class="material-symbols">rss_feed</span> Générer / actualiser les flux</button>
            <select v-model="folderId" aria-label="Dossier de destination" :disabled="busy"><option value="" disabled>Dossier de la bibliothèque</option><option v-for="folder in folders" :key="folder.id" :value="folder.id">{{ folder.path }}</option></select>
            <button class="rf-primary" :disabled="busy || !canImport" @click="act('import', { urls: selected, folderId })"><span class="material-symbols">library_add</span> Ajouter / relier à la bibliothèque</button>
          </div>
          <p class="rf-help">Sélectionnez les émissions, générez leurs flux, puis ajoutez-les. Les émissions déjà présentes sont reliées aux archives Web sans perdre leur historique. Le téléchargement des épisodes reste à votre initiative.</p>
          <p v-if="!shows.length && !loading" class="rf-empty">Collez une page d’émission ci-dessus ou lancez la recherche du catalogue pour commencer.</p>
          <p v-if="loading && !shows.length" class="rf-empty">Chargement du catalogue…</p>
          <div class="rf-shows">
            <article v-for="show in filtered" :key="show.url" class="rf-show" :class="selected.includes(show.url) ? 'rf-selected' : ''">
              <label class="rf-check"><input type="checkbox" :checked="selected.includes(show.url)" :disabled="busy || show.ambiguous" :aria-label="`Sélectionner ${show.title}`" @change="toggle(show.url)" /></label>
              <img v-if="show.image" :src="show.image" alt="" loading="lazy" referrerpolicy="no-referrer" @error="$event.target.style.visibility = 'hidden'" />
              <span v-else class="material-symbols rf-placeholder">podcasts</span>
              <div class="rf-show-info"><h3>{{ show.title }}</h3><p class="rf-help">{{ stationName(show.station) }}<template v-if="show.filename"> · {{ show.episodes.toLocaleString('fr-FR') }} épisodes</template></p><a :href="show.url" target="_blank" rel="noopener noreferrer">Page Radio France <span aria-hidden="true">↗</span></a><p v-if="show.ambiguous" class="rf-error">Plusieurs correspondances dans la bibliothèque : rattachement automatique désactivé.</p></div>
              <div class="rf-show-status"><span v-if="show.linked" class="rf-badge rf-good">Reliée</span><span v-else-if="show.itemId" class="rf-badge">Déjà présente</span><span v-else-if="show.filename" class="rf-badge rf-good">Flux prêt</span><span v-else class="rf-badge">À générer</span><nuxt-link v-if="show.itemId" :to="`/item/${show.itemId}`">Ouvrir</nuxt-link></div>
            </article>
          </div>
          <p v-if="shows.length && !filtered.length" class="rf-empty">Aucune émission ne correspond à ces filtres.</p>
          <p v-if="discovery && !discovery.exhaustive" class="rf-help">Le dernier recensement est partiel. Relancez « Actualiser le catalogue » pour compléter la recherche.</p>
        </section>
      </div>
    </div>
  </div>
</template>

<script>
const names = { franceinter: 'France Inter', franceculture: 'France Culture', franceinfo: 'franceinfo', francemusique: 'France Musique', fip: 'FIP', mouv: 'Mouv’', ici: 'ici', radiofrance: 'Radio France' }
export default {
  async asyncData({ params, redirect, store }) {
    if (!store.getters['user/getIsAdminOrUp']) return redirect(`/library/${params.library}`)
    const data = await store.dispatch('libraries/fetch', params.library)
    if (!data || data.library.mediaType !== 'podcast') return redirect(`/library/${params.library}`)
    return { libraryId: params.library }
  },
  data() {
    return { shows: [], stations: Object.keys(names), folders: [], folderId: '', selected: [], job: null, discovery: null, generatedAt: null, showURL: '', discoverStation: 'franceinter', filterStation: '', filterState: 'all', search: '', loading: false, error: '', pollTimer: null, disposed: false, submitting: false }
  },
  computed: {
    streamLibraryItem() { return this.$store.state.streamLibraryItem },
    busy() { return this.submitting || !!this.job?.running },
    readyCount() { return this.shows.filter((show) => show.filename).length },
    episodeCount() { return this.shows.reduce((sum, show) => sum + (show.episodes || 0), 0) },
    filtered() {
      const search = this.search.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
      return this.shows.filter((show) => (!this.filterStation || show.station === this.filterStation) && (!search || show.title.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().includes(search)) && (this.filterState === 'all' || (this.filterState === 'ready' && show.filename) || (this.filterState === 'linked' && show.itemId) || (this.filterState === 'pending' && !show.filename))).sort((a, b) => Number(!!a.filename) - Number(!!b.filename) || a.title.localeCompare(b.title, 'fr'))
    },
    allSelected() { return this.filtered.length > 0 && this.filtered.every((show) => show.ambiguous || this.selected.includes(show.url)) },
    canImport() { return this.folderId && this.selected.length && this.selected.every((url) => this.shows.some((show) => show.url === url && show.filename && !show.ambiguous)) },
    jobLabel() {
      const kind = { generate: 'Génération des flux', discover: 'Recensement des émissions', import: 'Chargement dans la bibliothèque' }[this.job?.kind] || 'Radio France'
      const state = { running: 'en cours…', completed: 'terminé', partial: 'incomplet', failed: 'échec', cancelled: 'interrompu', interrupted: 'interrompu au redémarrage' }[this.job?.status] || ''
      return `${kind} — ${state}`
    },
    jobTime() { return this.formatDate(this.job?.finishedAt || this.job?.startedAt) }
  },
  methods: {
    stationName(value) { return names[value] || value },
    formatDate(value) { return value ? new Date(value).toLocaleString('fr-FR') : '' },
    resultLabel(result) { return { added: 'Ajoutée', linked: 'Reliée aux archives', already: 'Déjà reliée', error: result.error }[result.action] || result.action },
    toggle(url) { this.selected = this.selected.includes(url) ? this.selected.filter((item) => item !== url) : [...this.selected, url] },
    toggleAll() {
      const urls = this.filtered.filter((show) => !show.ambiguous).map((show) => show.url)
      this.selected = this.allSelected ? this.selected.filter((url) => !urls.includes(url)) : [...new Set([...this.selected, ...urls])]
    },
    schedule() {
      clearTimeout(this.pollTimer)
      if (!this.disposed) this.pollTimer = setTimeout(() => this.load(), this.job?.running ? 2000 : 15000)
    },
    async load(notify = false) {
      this.loading = true
      try {
        const data = await this.$axios.$get(`/api/libraries/${this.libraryId}/radiofrance`)
        if (this.disposed) return
        this.shows = data.shows; this.stations = data.stations; this.folders = data.folders; this.job = data.job; this.discovery = data.discovery; this.generatedAt = data.generatedAt
        if (!this.folderId || !this.folders.some((folder) => folder.id === this.folderId)) this.folderId = this.folders[0]?.id || ''
        if (notify) { this.error = ''; this.$toast.success('Catalogue OPML rechargé.') }
      } catch (_) { if (!this.disposed) this.error = 'Impossible de charger le catalogue Radio France. Nouvelle tentative automatique.' }
      finally { this.loading = false; this.schedule() }
    },
    async act(action, payload = {}) {
      clearTimeout(this.pollTimer)
      this.submitting = true; this.error = ''
      try {
        const data = await this.$axios.$post(`/api/libraries/${this.libraryId}/radiofrance/${action}`, payload)
        this.job = data.job
        if (action === 'import') this.selected = []
        await this.load()
      } catch (error) { this.error = typeof error.response?.data === 'string' ? error.response.data : 'Impossible de lancer ce traitement.' }
      finally { this.submitting = false; this.schedule() }
    },
    generateURL() { this.act('generate', { urls: [this.showURL] }) }
  },
  mounted() { this.load() },
  beforeDestroy() { this.disposed = true; clearTimeout(this.pollTimer) }
}
</script>

<style scoped>
.rf-panel{max-width:1250px;padding-bottom:40px;color:#e5e7eb}.rf-heading{display:flex;align-items:center;justify-content:space-between;gap:18px;flex-wrap:wrap;margin-bottom:18px}.rf-heading h1{font-size:28px;font-weight:700}.rf-heading p{color:#adb1b8;margin-top:6px}.rf-box{padding:22px;background:#191c20;border:1px solid #383c41;border-radius:12px;margin-bottom:20px}.rf-box h2{font-size:18px;font-weight:600;margin-bottom:12px}.rf-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.rf-panel button{display:inline-flex;align-items:center;justify-content:center;gap:8px;min-height:42px;border:1px solid #61666d;background:#30343a;border-radius:7px;padding:8px 14px;line-height:1.3;font-size:14px}.rf-panel button:hover:enabled{background:#424750}.rf-panel button:disabled{opacity:.45;cursor:not-allowed}.rf-panel button.rf-primary{background:#d5a757;border-color:#d5a757;color:#181818;font-weight:600}.rf-panel button.rf-primary:hover:enabled{background:#e4bc76}.rf-panel .material-symbols{font-size:21px}.rf-panel input:not([type=checkbox]),.rf-panel select{background:#25292f;border:1px solid #555c65;color:#f1f1f1;min-height:42px;border-radius:7px;padding:9px 12px;max-width:100%;font-size:14px}.rf-panel input[type=url],.rf-panel input[type=search]{flex:1;min-width:220px}.rf-panel input[type=checkbox]{width:17px;height:17px;accent-color:#d5a757;cursor:pointer}.rf-help{color:#a4aab3;font-size:13px;line-height:1.6}.rf-row+.rf-help,.rf-actions+.rf-help{margin-top:12px}.rf-discover{border-top:1px solid #383c41;padding-top:18px;margin-top:18px}.rf-discover label{font-size:14px}.rf-job strong{font-size:16px}.rf-job .rf-stop{margin-left:auto}.rf-current{font-size:14px;margin-top:12px;color:#e1b96e;overflow-wrap:anywhere}.rf-job details{margin-top:12px;font-size:13px;color:#a4aab3}.rf-job summary{cursor:pointer}.rf-job pre{margin-top:10px;max-height:200px;overflow:auto;background:#111418;padding:12px;border-radius:6px;white-space:pre-wrap}.rf-error{color:#f8a3a3;font-size:14px}.rf-good{color:#86d5bd}.rf-results{margin-top:12px;font-size:14px;line-height:1.9}.rf-panel a{color:#e1b96e}.rf-panel a:hover{text-decoration:underline}.rf-results a{margin-left:10px}.rf-count{font-size:14px;color:#d5a757;margin-left:8px}.rf-filters{margin-bottom:15px}.rf-selection{display:flex;align-items:center;justify-content:space-between;font-size:13px;gap:12px;flex-wrap:wrap;padding:12px 0}.rf-selection label{display:flex;align-items:center;gap:8px}.rf-actions{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 12px}.rf-actions select{max-width:270px}.rf-shows{margin-top:18px}.rf-show{display:flex;align-items:center;gap:15px;padding:15px 10px;border-top:1px solid #363b42}.rf-selected{background:#d5a7570d}.rf-show img,.rf-placeholder{width:66px;height:66px;object-fit:cover;border-radius:6px;flex-shrink:0}.rf-placeholder{display:flex;align-items:center;justify-content:center;background:#30343a;color:#b6a176;font-size:32px!important}.rf-show-info{flex:1;min-width:0}.rf-show h3{font-size:16px;font-weight:600;margin-bottom:4px}.rf-show-info a{font-size:12px}.rf-show-status{display:flex;flex-direction:column;align-items:flex-end;gap:7px;font-size:13px}.rf-badge{border:1px solid #4b5159;padding:4px 9px;border-radius:20px;font-size:12px;white-space:nowrap}.rf-empty{text-align:center;color:#adb1b8;padding:40px 12px}.rf-panel :focus-visible{outline:2px solid #d5a757;outline-offset:3px}@media(max-width:640px){.rf-box{padding:15px}.rf-heading h1{font-size:24px}.rf-row input,.rf-row select,.rf-row button,.rf-actions button,.rf-actions select{width:100%;max-width:100%}.rf-show{gap:10px;padding:14px 0}.rf-show img,.rf-placeholder{width:46px;height:46px}.rf-show h3{font-size:14px}.rf-show-status{max-width:100px}.rf-panel input[type=url],.rf-panel input[type=search]{min-width:0}.rf-job .rf-row button{margin-left:0}}
</style>
