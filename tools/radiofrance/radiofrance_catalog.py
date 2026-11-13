#!/usr/bin/env python3
"""Build podcast RSS/OPML from Radio France's public paginated HTML pages.

Python 3.10+, standard library only. Never executes the site's JavaScript or
downloads audio. Persistent state must stay outside the served output folder.
"""
from __future__ import annotations

import argparse
import datetime as dt
import email.utils
import fcntl
import functools
from html.parser import HTMLParser
import http.server
import json
import mimetypes
from pathlib import Path
import re
import sqlite3
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs, unquote, urlencode, urljoin, urlsplit, urlunsplit
from urllib.request import build_opener, HTTPRedirectHandler, Request
import xml.etree.ElementTree as ET
import zlib

ORIGIN = 'https://www.radiofrance.fr'
STATIONS = {'franceinter', 'franceculture', 'franceinfo', 'francemusique', 'fip', 'mouv', 'ici', 'radiofrance'}
FETCH_HOSTS = {'www.radiofrance.fr', 'radiofrance.fr', 'radiofrance-podcast.net', 'www.radiofrance-podcast.net'}
ITUNES = 'http://www.itunes.com/dtds/podcast-1.0.dtd'
ATOM = 'http://www.w3.org/2005/Atom'
ET.register_namespace('itunes', ITUNES)
ET.register_namespace('atom', ATOM)


def now():
    return dt.datetime.now(dt.timezone.utc).isoformat()


def canonical(url, base=ORIGIN):
    parsed = urlsplit(urljoin(base, url))
    if parsed.scheme not in ('http', 'https') or parsed.hostname not in {'radiofrance.fr', 'www.radiofrance.fr'} or parsed.username or parsed.password or parsed.port not in (None, 80, 443):
        return None
    return ORIGIN + parsed.path.rstrip('/')


def parts(url):
    return urlsplit(url).path.strip('/').split('/')


def is_show(url):
    p = parts(url)
    return len(p) == 3 and p[0] in STATIONS and p[1] == 'podcasts' and not p[2].startswith(('bouquet-', 'selection-'))


def is_hub(url):
    p = parts(url)
    return (p[0] == 'podcasts' and len(p) <= 2) or (p[0] in STATIONS and len(p) >= 2 and p[1] == 'podcasts' and (len(p) == 2 or (len(p) == 3 and p[2].startswith(('bouquet-', 'selection-')))))


def walk(value):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from walk(child)


def has_type(node, name):
    value = node.get('@type', [])
    return name == value or isinstance(value, list) and name in value


class Page(HTMLParser):
    def __init__(self, html, url):
        super().__init__(convert_charrefs=True)
        self.url, self.html = url, html
        self.links, self.nodes, self.meta = [], [], {}
        self.rss = None
        self.h1, self._h1 = [], False
        self._ld, self._script = [], None
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        a = dict(attrs)
        if tag == 'script':
            self._script = a.get('type') == 'application/ld+json'
            self._ld = []
        elif tag == 'h1':
            self._h1 = True
        elif tag == 'a' and a.get('href'):
            self.links.append(urljoin(self.url, a['href']))
        elif tag == 'link' and a.get('type') == 'application/rss+xml':
            self.rss = urljoin(self.url, a.get('href', ''))
        elif tag == 'meta':
            self.meta[a.get('property', a.get('name', ''))] = a.get('content', '')

    def handle_data(self, data):
        if self._script:
            self._ld.append(data)
        if self._h1:
            self.h1.append(data)

    def handle_endtag(self, tag):
        if tag == 'h1':
            self._h1 = False
        if tag == 'script' and self._script:
            try:
                self.nodes.extend(walk(json.loads(''.join(self._ld))))
            except (ValueError, TypeError):
                pass
            self._script = None

    def of_type(self, kind):
        return [node for node in self.nodes if has_type(node, kind)]

    def episode_links(self):
        # Only the main structured ItemList, never recommendations in HTML.
        urls = []
        for node in self.of_type('ItemList'):
            for entry in node.get('itemListElement', []):
                candidate = entry.get('url') or entry.get('item', {}).get('url')
                u = canonical(candidate, self.url) if candidate else None
                if u and len(parts(u)) == 4 and parts(u)[1] == 'podcasts':
                    urls.append(u)
        return list(dict.fromkeys(urls))

    def last_page(self):
        pages = [1]
        for href in self.links:
            if canonical(href) == canonical(self.url):
                value = parse_qs(urlsplit(href).query).get('p', ['1'])[0]
                if value.isdigit():
                    pages.append(int(value))
        # Svelte exposes a numeric page count even when navigation omits the
        # final page. Extract the number; never evaluate its JavaScript payload.
        pages += [int(v) for v in re.findall(r'pagination\s*:\s*\{\s*lastPage\s*:\s*(\d+)', self.html)]
        return min(max(pages), 100000)

    def metadata(self):
        series = next(iter(self.of_type('RadioSeries') or self.of_type('PodcastSeries')), {})
        title = ' '.join(''.join(self.h1).split()) or series.get('name') or self.meta.get('og:title') or self.url
        return {'url': canonical(self.url), 'title': title, 'description': series.get('abstract') or series.get('description') or self.meta.get('description', ''),
                'image': image_url(series.get('image')) or self.meta.get('og:image', ''), 'station': parts(self.url)[0], 'sourceRss': self.rss}


def image_url(value):
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return value.get('url', '')
    if isinstance(value, list) and value:
        return image_url(value[0])
    return ''


def duration_seconds(value):
    if isinstance(value, (float, int)):
        return max(0, int(value))
    match = re.fullmatch(r'P(?:0Y)?(?:0M)?(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?', value or '')
    if not match:
        return 0
    d, h, m, s = (float(v or 0) for v in match.groups())
    return int(d * 86400 + h * 3600 + m * 60 + s)


def episode_metadata(page):
    nodes = page.of_type('RadioEpisode') or page.of_type('PodcastEpisode')
    target = canonical(page.url)
    node = next((n for n in nodes if canonical(n.get('url') or n.get('@id', '')) == target), None)
    if not node:
        raise ValueError('Métadonnées structurées de l’épisode absentes (page modifiée ou indisponible).')
    audio = next((n for n in walk(node.get('mainEntity', node)) if has_type(n, 'AudioObject') and n.get('contentUrl')), {})
    url = audio.get('contentUrl', '')
    if node.get('isAccessibleForFree') is False or not url or urlsplit(url).scheme not in ('https', 'http'):
        return None
    date = node.get('dateCreated') or node.get('datePublished')
    title = ' '.join(''.join(page.h1).split()) or node.get('name') or page.meta.get('og:title', target)
    return {'url': target, 'title': title, 'description': node.get('description') or '',
            'date': date or '', 'audio': url, 'mime': audio.get('encodingFormat') or mimetypes.guess_type(urlsplit(url).path)[0] or 'audio/mpeg',
            'duration': duration_seconds(audio.get('duration')), 'image': image_url(node.get('image')), 'length': str(audio.get('contentSize') or '0') if str(audio.get('contentSize') or '0').isdigit() else '0'}


class RateLimited(RuntimeError):
    pass


class SafeRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate_fetch(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def validate_fetch(url):
    p = urlsplit(url)
    if p.scheme not in ('https', 'http') or p.hostname not in FETCH_HOSTS or p.username or p.password or p.port not in (None, 80, 443):
        raise ValueError('Adresse de page ou de RSS hors des domaines Radio France autorisés.')


class Store:
    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(path)
        self.db.executescript('''
          CREATE TABLE IF NOT EXISTS http (url TEXT PRIMARY KEY, body BLOB, checked REAL, etag TEXT, modified TEXT);
          CREATE TABLE IF NOT EXISTS shows (url TEXT PRIMARY KEY, data TEXT);
          CREATE TABLE IF NOT EXISTS episodes (show TEXT, url TEXT, data TEXT, active INTEGER, PRIMARY KEY(show,url));
        ''')

    def put_show(self, show):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO shows VALUES (?,?)', (show['url'], json.dumps(show, ensure_ascii=False)))

    def episodes(self, show):
        return {url: json.loads(data) for url, data in self.db.execute('SELECT url,data FROM episodes WHERE show=? AND active=1', (show,))}

    def put_episode(self, show, url, episode):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO episodes VALUES (?,?,?,?)', (show, url, json.dumps(episode, ensure_ascii=False), int(episode is not None)))


class Client:
    def __init__(self, store, delay=0.8, refresh=False):
        self.store, self.delay, self.refresh = store, delay, refresh
        self.last_request = 0
        self.requests = self.cache_hits = 0
        self.opener = build_opener(SafeRedirect())

    def get(self, url, ttl=21600):
        validate_fetch(url)
        row = self.store.db.execute('SELECT body,checked,etag,modified FROM http WHERE url=?', (url,)).fetchone()
        if row and not self.refresh and time.time() - row[1] < ttl:
            self.cache_hits += 1
            return zlib.decompress(row[0])
        headers = {'User-Agent': 'SazosPodcastCatalog/1.0 (personal RSS archive; sequential requests)', 'Accept': 'text/html,application/xml,application/rss+xml'}
        if row:
            if row[2]: headers['If-None-Match'] = row[2]
            if row[3]: headers['If-Modified-Since'] = row[3]
        for attempt in range(3):
            time.sleep(max(0, self.delay - (time.monotonic() - self.last_request)))
            self.last_request = time.monotonic()
            self.requests += 1
            try:
                with self.opener.open(Request(url, headers=headers), timeout=30) as response:
                    body = response.read(12 * 1024 * 1024 + 1)
                    if len(body) > 12 * 1024 * 1024:
                        raise ValueError('Page trop volumineuse.')
                    with self.store.db:
                        self.store.db.execute('INSERT OR REPLACE INTO http VALUES (?,?,?,?,?)', (url, zlib.compress(body), time.time(), response.headers.get('ETag'), response.headers.get('Last-Modified')))
                    return body
            except HTTPError as error:
                if error.code == 304 and row:
                    with self.store.db:
                        self.store.db.execute('UPDATE http SET checked=? WHERE url=?', (time.time(), url))
                    self.cache_hits += 1
                    return zlib.decompress(row[0])
                if error.code in (403, 429):
                    raise RateLimited(f'Radio France répond {error.code}. Arrêt du parcours ; cache conservé, réessayer ultérieurement.') from error
                if error.code < 500 or attempt == 2:
                    raise
            except (URLError, TimeoutError):
                if attempt == 2:
                    raise
            time.sleep(2 ** attempt)

    def page(self, url, ttl=21600):
        return Page(self.get(url, ttl).decode('utf-8'), url)


def audio_key(url):
    return unquote(urlsplit(url).path.rsplit('/', 1)[-1]).casefold()


def rss_reference(client, url, ttl=21600):
    if not url:
        return {}
    root = ET.fromstring(client.get(url, ttl=ttl))
    result = {}
    for item in root.findall('./channel/item'):
        enclosure = item.find('enclosure')
        if enclosure is not None and enclosure.get('url'):
            result[audio_key(enclosure.get('url'))] = {'guid': item.findtext('guid'), 'length': enclosure.get('length', '0')}
    return result


def atomic_write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + '.tmp')
    temp.write_bytes(data)
    temp.replace(path)


def json_write(path, data):
    atomic_write(path, (json.dumps(data, ensure_ascii=False, indent=2) + '\n').encode())


def xml_bytes(root):
    ET.indent(root, space='  ')
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def child(parent, tag, value, **attrs):
    node = ET.SubElement(parent, tag, attrs)
    if value is not None:
        node.text = str(value)
    return node


def feed_name(show):
    return '-'.join(parts(show['url'])).replace('-podcasts-', '-', 1) + '.xml'


def rss_xml(show, episodes, feed_url):
    root = ET.Element('rss', {'version': '2.0'})
    channel = ET.SubElement(root, 'channel')
    for key, value in [('title', show['title']), ('link', show['url']), ('description', show.get('description') or show['title']), ('language', 'fr'), ('generator', 'Sazos Radio France Web Catalogue 1.0'), ('lastBuildDate', email.utils.format_datetime(dt.datetime.now(dt.timezone.utc)))]:
        child(channel, key, value)
    child(channel, f'{{{ATOM}}}link', None, href=feed_url, rel='self', type='application/rss+xml')
    child(channel, f'{{{ITUNES}}}author', show['station'])
    child(channel, f'{{{ITUNES}}}type', 'episodic')
    if show.get('image'):
        child(channel, f'{{{ITUNES}}}image', None, href=show['image'])
        image = child(channel, 'image', None)
        for tag, value in [('url', show['image']), ('title', show['title']), ('link', show['url'])]: child(image, tag, value)
    for episode in sorted(episodes, key=lambda e: (e.get('date', ''), e['url']), reverse=True):
        item = child(channel, 'item', None)
        for tag in ['title', 'description']:
            child(item, tag, episode.get(tag, ''))
        child(item, 'link', episode['url'])
        guid = episode.get('guid') or episode['url']
        child(item, 'guid', guid, isPermaLink='true' if guid == episode['url'] else 'false')
        child(item, 'enclosure', None, url=episode['audio'], type=episode['mime'], length=str(episode.get('length') or '0'))
        if episode.get('date'):
            try:
                date = dt.datetime.fromisoformat(episode['date'].replace('Z', '+00:00'))
                if date.tzinfo is None: date = date.replace(tzinfo=dt.timezone.utc)
                child(item, 'pubDate', email.utils.format_datetime(date))
            except ValueError:
                pass
        child(item, f'{{{ITUNES}}}duration', episode.get('duration', 0))
        if episode.get('image'): child(item, f'{{{ITUNES}}}image', None, href=episode['image'])
    return xml_bytes(root)


def export(store, output, base_url, report):
    summaries = []
    root = ET.Element('opml', {'version': '2.0'})
    head = child(root, 'head', None)
    child(head, 'title', 'Radio France — catalogue depuis les pages Web')
    child(head, 'dateModified', email.utils.format_datetime(dt.datetime.now(dt.timezone.utc)))
    body = child(root, 'body', None)
    groups = {}
    for (raw,) in store.db.execute('SELECT data FROM shows ORDER BY url'):
        show = json.loads(raw)
        episodes = list(store.episodes(show['url']).values())
        if not episodes:
            continue
        filename = feed_name(show)
        feed_url = base_url.rstrip('/') + '/feeds/' + filename
        atomic_write(output / 'feeds' / filename, rss_xml(show, episodes, feed_url))
        if show['station'] not in groups:
            groups[show['station']] = child(body, 'outline', None, text=show['station'], title=show['station'])
        child(groups[show['station']], 'outline', None, type='rss', text=show['title'], title=show['title'], xmlUrl=feed_url, htmlUrl=show['url'])
        summaries.append({**show, 'episodes': len(episodes), 'feed': feed_url})
    atomic_write(output / 'catalog.opml', xml_bytes(root))
    json_write(output / 'catalog.json', {'generatedAt': now(), 'shows': summaries})
    json_write(output / 'report.json', report)
    return summaries


def discover(client, seeds, station, max_pages):
    queue, seen, shows = list(seeds), set(), set()
    while queue and (max_pages is None or len(seen) < max_pages):
        url = queue.pop(0)
        if url in seen: continue
        seen.add(url)
        print(f'Catalogue : {url}', flush=True)
        page = client.page(url)
        for link in page.links:
            u = canonical(link)
            if not u: continue
            if is_show(u):
                if not station or parts(u)[0] == station: shows.add(u)
            elif is_hub(u) and u not in seen and u not in queue:
                if not station or parts(u)[0] in (station, 'podcasts', 'radiofrance'): queue.append(u)
        if page.last_page() > 1:
            for n in range(2, page.last_page() + 1):
                u = canonical(url) + '?' + urlencode({'p': n})
                if u not in seen and u not in queue: queue.append(u)
    return {'title': 'Radio France — sélection Web', 'shows': sorted(shows), 'discovery': {'pages': len(seen), 'remainingPages': len(queue), 'exhaustive': not queue}}


def build(client, store, urls, args):
    report = {'startedAt': now(), 'shows': [], 'errors': [], 'unavailable': [], 'partial': bool(args.max_pages or args.max_episodes)}
    try:
        for url in urls:
            summary = {'url': url, 'pages': 0, 'found': 0, 'processed': 0, 'completed': False}
            report['shows'].append(summary)
            try:
                first = client.page(url, ttl=0 if getattr(args, 'refresh_index', False) else 21600)
                if not (first.of_type('RadioSeries') or first.of_type('PodcastSeries')):
                    raise ValueError('La page ne décrit pas une émission ou une série de podcasts.')
                show = first.metadata()
                store.put_show(show)
                old = store.episodes(url)
                references = {}
                try:
                    references = rss_reference(client, first.rss, ttl=0 if getattr(args, 'refresh_index', False) else 21600)
                except RateLimited:
                    raise
                except Exception as error:
                    report['errors'].append({'url': first.rss, 'error': f'Enrichissement RSS : {error}'})
                urls_found = list(first.episode_links())
                summary['pages'] = 1
                last = first.last_page()
                stop = min(last, args.max_pages) if args.max_pages else last
                for n in range(2, stop + 1):
                    page_url = url + '?' + urlencode({'p': n})
                    print(f'{show["title"]} : page {n}/{last}', flush=True)
                    try:
                        page = client.page(page_url, ttl=0 if getattr(args, 'refresh_index', False) else 21600)
                        urls_found.extend(page.episode_links())
                        summary['pages'] += 1
                    except RateLimited:
                        raise
                    except Exception as error:
                        report['errors'].append({'url': page_url, 'error': str(error)})
                urls_found = list(dict.fromkeys(urls_found))
                summary['found'] = len(urls_found)
                selected = urls_found[:args.max_episodes] if args.max_episodes else urls_found
                for index, episode_url in enumerate(selected, 1):
                    print(f'{show["title"]} : épisode {index}/{len(selected)}', flush=True)
                    try:
                        episode = episode_metadata(client.page(episode_url, ttl=7 * 86400))
                        if episode:
                            ref = references.get(audio_key(episode['audio']), {})
                            episode['guid'] = old.get(episode_url, {}).get('guid') or ref.get('guid') or episode_url
                            episode['length'] = ref.get('length') or episode['length']
                        else:
                            report['unavailable'].append(episode_url)
                        store.put_episode(url, episode_url, episode)
                        summary['processed'] += 1
                    except RateLimited:
                        raise
                    except Exception as error:
                        report['errors'].append({'url': episode_url, 'error': str(error)})
                summary['completed'] = stop == last and len(selected) == len(urls_found) and summary['pages'] == last and summary['processed'] == len(selected)
            except RateLimited:
                raise
            except Exception as error:
                report['errors'].append({'url': url, 'error': str(error)})
    except (RateLimited, KeyboardInterrupt) as error:
        report['stopped'] = str(error) or 'Interrompu ; relancer pour reprendre.'
    finally:
        report.update(finishedAt=now(), requests=client.requests, cacheHits=client.cache_hits)
        result = export(store, args.output, args.base_url, report)
        print(f'Export : {len(result)} flux, {sum(s["episodes"] for s in result)} épisodes. {len(report["errors"])} erreurs, {len(report["unavailable"])} sans audio disponible.', flush=True)
    return 1 if report['errors'] or report.get('stopped') else 0


class ReadOnlyHandler(http.server.SimpleHTTPRequestHandler):
    def list_directory(self, path):
        self.send_error(404, 'Use /catalog.opml or /catalog.json')
        return None

    def translate_path(self, path):
        candidate = Path(super().translate_path(path))
        root = Path(self.directory).resolve()
        if not candidate.resolve().is_relative_to(root):
            return str(root / '__not_found__')
        return str(candidate)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest='command', required=True)
    crawl = commands.add_parser('discover', help='Recenser les émissions liées aux pages catalogue.')
    crawl.add_argument('--seed', action='append', default=[])
    crawl.add_argument('--station', choices=sorted(STATIONS))
    crawl.add_argument('--max-discovery-pages', type=int, help='Limiter volontairement le recensement pour un essai.')
    crawl.add_argument('--config-out', type=Path, default=Path('radiofrance-shows.json'))
    generate = commands.add_parser('build', help='Parcourir les émissions et régénérer les XML et OPML.')
    generate.add_argument('--config', type=Path)
    generate.add_argument('--refresh-index', action='store_true', help='Revalider les listes et le RSS source en conservant le cache des épisodes.')
    generate.add_argument('--show', action='append', default=[])
    generate.add_argument('--output', type=Path, default=Path('radiofrance-public'))
    generate.add_argument('--base-url', default='http://localhost:13400')
    generate.add_argument('--max-pages', type=int, help='Validation limitée, ne supprime pas les anciens épisodes.')
    generate.add_argument('--max-episodes', type=int, help='Validation limitée, ne supprime pas les anciens épisodes.')
    for command in (crawl, generate):
        command.add_argument('--state', type=Path, default=Path('radiofrance-state'))
        command.add_argument('--delay', type=float, default=0.8, help='Délai minimum entre requêtes réseau, secondes (minimum 0.5).')
        command.add_argument('--refresh', action='store_true', help='Revalider les pages même encore en cache.')
    serve = commands.add_parser('serve', help='Servir uniquement les fichiers publics générés, en lecture seule.')
    serve.add_argument('--output', type=Path, default=Path('radiofrance-public'))
    serve.add_argument('--bind', default='127.0.0.1')
    serve.add_argument('--port', type=int, default=13400)
    args = parser.parse_args(argv)
    if args.command == 'serve':
        if not args.output.is_dir(): parser.error('Le dossier public n’existe pas ; lancer build auparavant.')
        handler = functools.partial(ReadOnlyHandler, directory=str(args.output.resolve()))
        print(f'Catalogue : http://{args.bind}:{args.port}/catalog.opml', flush=True)
        http.server.ThreadingHTTPServer((args.bind, args.port), handler).serve_forever()
        return 0
    if args.delay < 0.5: parser.error('--delay doit être au moins 0.5 seconde.')
    for key in ('max_pages', 'max_episodes', 'max_discovery_pages'):
        value = getattr(args, key, None)
        if value is not None and value < 1: parser.error(f'--{key.replace("_", "-")} doit être positif.')
    args.state = args.state.resolve()
    if args.command == 'build':
        args.output = args.output.resolve()
        if args.state.is_relative_to(args.output) or args.output.is_relative_to(args.state): parser.error('Les dossiers publics et d’état doivent être séparés, sans imbrication.')
        base = urlsplit(args.base_url)
        if base.scheme not in ('https', 'http') or not base.netloc or base.username or base.password or base.query or base.fragment: parser.error('--base-url doit être une URL HTTP(S) absolue sans identifiants, requête ni fragment.')
    args.state.mkdir(parents=True, exist_ok=True)
    with (args.state / 'run.lock').open('w') as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            parser.error('Une autre génération utilise déjà ce dossier d’état.')
        store = Store(args.state / 'catalog.sqlite')
        client = Client(store, args.delay, args.refresh)
        try:
            if args.command == 'discover':
                seeds = args.seed or [ORIGIN + (f'/{args.station}/podcasts' if args.station else '/podcasts')]
                for seed in seeds:
                    if not canonical(seed): parser.error('Point de départ hors radiofrance.fr.')
                config = discover(client, seeds, args.station, args.max_discovery_pages)
                json_write(args.config_out, config)
                print(f'{len(config["shows"])} émissions recensées ; configuration : {args.config_out}', flush=True)
                return 0
            urls = list(args.show)
            if args.config:
                urls.extend(json.loads(args.config.read_text())['shows'])
            urls = list(dict.fromkeys(urls))
            if not urls: parser.error('Indiquer --show ou --config.')
            urls = [canonical(u) for u in urls]
            if any(not u or not is_show(u) for u in urls): parser.error('Les émissions doivent avoir une URL radiofrance.fr/<station>/podcasts/<émission>.')
            return build(client, store, urls, args)
        finally:
            store.db.close()


if __name__ == '__main__':
    sys.exit(main())
