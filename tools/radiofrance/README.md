# Radio France → RSS XML et OPML

Ce script Python parcourt les **pages Web publiques**, leurs listes d’épisodes et leur pagination. Il produit un RSS par émission/série et un catalogue OPML importable dans un lecteur de podcasts. Il n’utilise pas l’API Radio France, n’exécute aucun JavaScript distant et ne télécharge **pas** les fichiers audio.

Python **3.10 ou plus récent**, sous macOS ou Linux/TrueNAS ; aucune bibliothèque supplémentaire.

## Utilisation

Depuis la racine du dépôt :

```sh
python3 tools/radiofrance/radiofrance_catalog.py discover \
  --seed https://www.radiofrance.fr/podcasts \
  --config-out radiofrance-shows.json \
  --state radiofrance-state
```

Ou limiter le recensement à France Inter :

```sh
python3 tools/radiofrance/radiofrance_catalog.py discover \
  --station franceinter --config-out radiofrance-shows.json
```

Le fichier JSON contient les URL des émissions. On peut l’éditer pour conserver uniquement les émissions souhaitées. Un [exemple avec Bestioles et Là-bas si j’y suis](shows.example.json) est fourni. Le recensement suit les liens accessibles depuis les pages choisies : il ne garantit pas de retrouver une émission isolée et non liée au catalogue.

Le JSON est sauvegardé **après chaque page**, avec les résultats des précédents recensements. Une panne, un refus Radio France ou une interruption conserve donc les émissions déjà trouvées. Relancer la même commande traite d’abord les pages manquantes ou en échec, puis les pages déjà récupérées. La progression privée est conservée dans `radiofrance-state/discovery.json`, séparément pour chaque sélection de station et de points de départ. Lors de la première reprise d’un ancien cache, les pages catalogue déjà enregistrées sont relues pour récupérer les résultats qui n’avaient pas été publiés. Une erreur réseau isolée n’empêche pas le parcours des autres pages ; un refus 403/429 interrompt toujours les requêtes.

```sh
python3 tools/radiofrance/radiofrance_catalog.py build \
  --config radiofrance-shows.json \
  --state radiofrance-state \
  --output radiofrance-public \
  --base-url http://ADRESSE-DU-SERVEUR:13400
```

Pour une seule émission :

```sh
python3 tools/radiofrance/radiofrance_catalog.py build \
  --show https://www.radiofrance.fr/franceinter/podcasts/bestioles \
  --state radiofrance-state --output radiofrance-public \
  --base-url http://ADRESSE-DU-SERVEUR:13400
```

Les options `--max-discovery-pages`, `--max-pages` et `--max-episodes` permettent un **essai partiel**. Sans ces options, toutes les pages annoncées par chaque émission sont parcourues. Le rapport indique les parcours incomplets ; aucune ancienne entrée n’est supprimée simplement à cause d’une limite d’essai ou d’une erreur réseau.

## Fichiers produits

- `radiofrance-public/feeds/*.xml` : un RSS 2.0 par émission, contenant les liens audio réellement exposés par ses pages.
- `radiofrance-public/catalog.opml` : catalogue des flux, regroupés par station.
- `radiofrance-public/catalog.json` : inventaire des émissions et nombres d’épisodes.
- `radiofrance-public/report.json` : pages parcourues, épisodes traités, erreurs, indisponibilités, éventuel arrêt anticipé.
- `radiofrance-state/catalog.sqlite` : cache des pages et métadonnées, pour la reprise. **Ne pas servir ce dossier sur le Web.**

Les noms de flux et identifiants restent stables. Lorsque le RSS officiel est encore disponible, il sert uniquement à récupérer les GUID et tailles des épisodes communs, pour limiter les doublons lors d’un changement de flux. Le parcours des archives provient du site Web. Les autres GUID utilisent l’URL stable de l’épisode. Une correspondance parfaite avec tous les anciens flux ne peut pas être garantie.

## Covers et téléchargements

Le RSS contient la cover de l’émission au niveau du canal et l’illustration de chaque épisode dans sa propre balise `itunes:image`, lorsqu’elle existe. Les images et audios restent des **liens** dans le XML.

Le fork Audiobookshelf Freaky MOD à partir de **v2.37.2-freaky.2** sait afficher ces illustrations individuelles. Lors d’un **nouveau téléchargement MP3/M4A**, il récupère l’image, la conserve dans `/metadata/podcast-artwork`, puis l’intègre au fichier audio sans réencoder le son. L’image est donc également disponible hors de l’application. En cas d’échec de l’image d’épisode, il essaie la cover de l’émission ; en cas d’échec total, le téléchargement audio reste utilisable et l’API indique `artworkEmbedded: false`. Les fichiers déjà téléchargés ne sont pas réécrits automatiquement. Les autres formats peuvent afficher une image, mais l’intégration embarquée n’est garantie ici que pour MP3/M4A.

## Servir les flux

```sh
python3 tools/radiofrance/radiofrance_catalog.py serve \
  --output radiofrance-public --bind 127.0.0.1 --port 13400
```

OPML : `http://localhost:13400/catalog.opml`. Le service est en lecture seule, sans listing de dossiers. Pour un accès LAN depuis TrueNAS ou un autre appareil, utiliser `--bind 0.0.0.0` et une adresse serveur réellement joignable dans `--base-url`. Les ports, chemins et adresses sont configurables ; `--base-url` est l’URL publique **du dossier contenant `catalog.opml`**, sans `/feeds` à la fin.

**Dans un conteneur, `localhost` désigne le conteneur lui-même.** Utiliser une adresse ou un nom réseau joignable depuis Audiobookshelf. Son filtre SSRF bloque normalement les flux sur IP privées ; si le service est interne, la variable officielle `SSRF_REQUEST_FILTER_WHITELIST` permet d’autoriser **le seul nom d’hôte du catalogue**. Ne pas désactiver globalement ce filtre. Cette autorisation n’est pas modifiée automatiquement par le script.

Le script peut aussi être exécuté avec l’image Python officielle, en montant son dossier, le JSON, le dossier d’état et le dossier public. Aucun Docker applicatif ni planification n’est imposé.

## Régénération et limites

Relancer la même commande `build`. Les pages catalogue restent en cache six heures, les pages d’épisodes sept jours. `--refresh` demande une revalidation immédiate ; ETag/Last-Modified sont utilisés lorsqu’ils existent. Les requêtes sont séquentielles, espacées de 0,8 seconde par défaut (`--delay`, minimum 0,5). Un refus 403 ou une limitation 429 arrête le parcours et conserve l’état.

Les flux sont écrits par remplacement atomique. Le cache permet de reprendre après interruption et conserve les épisodes déjà valides si une page ne répond plus. Une page explicitement dépourvue d’audio accessible est signalée et ne crée pas de faux lien de lecture. Le script ne contourne pas de connexion, de protection ou de restriction d’accès. Il ne peut pas récupérer un fichier supprimé par l’éditeur. Le site peut changer de structure : les erreurs de lecture seront conservées dans `report.json`.

La génération republie immédiatement les épisodes en cache, puis met à jour les flux et l’OPML au fil du traitement (premier épisode, tous les 25 épisodes et après chaque émission). Les émissions incomplètes passent avant celles déjà terminées lors d’une nouvelle tentative. Le tri ne modifie ni les identifiants des épisodes ni les téléchargements existants.

Validation :

```sh
python3 -m unittest discover -s tools/radiofrance/tests -v
```

## Panneau intégré à Audiobookshelf

Le menu **Radio France** des bibliothèques de podcasts pilote désormais ce script directement dans le Docker Freaky MOD. L’OPML est chargé automatiquement ; aucun serveur de fichiers ni import manuel n’est nécessaire. Les fichiers et le cache sont persistés dans `/metadata/radiofrance/`. Voir `FREAKY_MOD.md` pour le parcours complet.

L’option `build --refresh-index` revalide les listes d’épisodes et leur RSS de référence, tout en conservant le cache des pages individuelles. Elle est utilisée par le bouton d’actualisation du panneau. `--refresh` reste disponible pour revalider toutes les pages.
