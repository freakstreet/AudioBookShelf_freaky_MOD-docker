import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import zlib
from types import SimpleNamespace
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('catalog', Path(__file__).parents[1] / 'radiofrance_catalog.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
SHOW = c.ORIGIN + '/franceinter/podcasts/exemple'
EP = SHOW + '/episode-1234567'
HUB = c.ORIGIN + '/franceinter/podcasts'
HUB_A = HUB + '/bouquet-animaux'
HUB_B = HUB + '/bouquet-sciences'
SHOW_B = HUB + '/autre'


def page(nodes, rest='', url=SHOW):
    return c.Page('<script type="application/ld+json">' + json.dumps({'@graph': nodes}) + '</script>' + rest, url)


def episode_node():
    return {'@type': 'RadioEpisode', 'url': EP, 'name': 'Un titre & une image', 'dateCreated': '2020-05-02T12:00:00Z',
            'description': 'Histoire <animale>', 'image': {'url': 'https://images.example/episode.jpg'},
            'mainEntity': {'@type': 'AudioObject', 'contentUrl': 'https://media.radiofrance-podcast.net/example.mp3', 'duration': 'P0Y0M0DT0H51M9S', 'encodingFormat': 'audio/mpeg'}}


class CatalogTests(unittest.TestCase):
    def test_discovery_keeps_live_results_on_rate_limit_and_retries_missing_pages_first(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); config = root/'discovered.json'; state = root/'state'/'discovery.json'
            pages = {HUB: page([], f'<a href="{HUB_A}">A</a><a href="{HUB_B}">B</a>', HUB),
                     HUB_A: page([], f'<a href="{SHOW}">Émission A</a>', HUB_A),
                     HUB_B: page([], f'<a href="{SHOW_B}">Émission B</a>', HUB_B)}
            class Client:
                fail = True
                calls = []
                snapshots = []
                def page(self, url):
                    self.calls.append(url)
                    if url == HUB_B and self.fail:
                        self.snapshots.append(json.loads(config.read_text())['shows'])
                        raise c.RateLimited('HTTP 429')
                    return pages[url]
            client = Client()
            with contextlib.redirect_stdout(io.StringIO()): result = c.discover(client, [HUB], 'franceinter', None, config, state)
            self.assertEqual(result['shows'], [SHOW])
            self.assertEqual(client.snapshots, [[SHOW]])
            self.assertFalse(result['discovery']['exhaustive'])
            self.assertEqual(result['discovery']['remainingPages'], 1)
            self.assertEqual(json.loads(config.read_text())['shows'], [SHOW])
            # New client/process, using only the persistent checkpoint.
            resumed = Client(); resumed.calls = []; resumed.fail = False
            with contextlib.redirect_stdout(io.StringIO()): result = c.discover(resumed, [HUB], 'franceinter', None, config, state)
            self.assertEqual(resumed.calls, [HUB_B, HUB, HUB_A])
            self.assertCountEqual(result['shows'], [SHOW, SHOW_B])
            self.assertTrue(result['discovery']['exhaustive'])
            self.assertNotIn('stopped', result['discovery'])

    def test_discovery_continues_after_one_network_failure_without_erasing_previous_stations(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); config = root/'discovered.json'; state = root/'discovery.json'
            older = c.ORIGIN + '/franceculture/podcasts/ancienne'
            c.json_write(config, {'shows': [older]})
            class Client:
                def page(self, url):
                    if url == HUB: return page([], f'<a href="{HUB_A}">A</a><a href="{HUB_B}">B</a>', HUB)
                    if url == HUB_A: raise OSError('network failed')
                    return page([], f'<a href="{SHOW_B}">B</a>', HUB_B)
            with contextlib.redirect_stdout(io.StringIO()): result = c.discover(Client(), [HUB], 'franceinter', None, config, state)
            self.assertCountEqual(result['shows'], [older, SHOW_B])
            self.assertFalse(result['discovery']['exhaustive'])
            self.assertEqual(result['discovery']['errors'][0]['url'], HUB_A)

    def test_discovery_interrupt_and_maximum_page_limit_leave_a_usable_checkpoint(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); config = root/'discovered.json'; state = root/'discovery.json'
            class Client:
                calls = []
                def page(self, url):
                    self.calls.append(url)
                    if url == HUB: return page([], f'<a href="{SHOW}">Show</a><a href="{HUB_A}">A</a>', HUB)
                    raise KeyboardInterrupt()
            client = Client()
            with contextlib.redirect_stdout(io.StringIO()): result = c.discover(client, [HUB], 'franceinter', 1, config, state)
            self.assertEqual(client.calls, [HUB])
            self.assertEqual(result['shows'], [SHOW])
            self.assertFalse(result['discovery']['exhaustive'])
            client.calls = []
            with contextlib.redirect_stdout(io.StringIO()): result = c.discover(client, [HUB], 'franceinter', None, config, state)
            self.assertEqual(client.calls, [HUB_A])
            self.assertEqual(result['shows'], [SHOW])
            self.assertIn('stopped', result['discovery'])

    def test_discovery_recovers_old_http_cache_even_when_the_first_new_request_is_refused(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); config = root/'discovered.json'; state = root/'discovery.json'
            store = c.Store(root/'cache.sqlite')
            html = f'<a href="{SHOW}">Émission récupérée hier</a><a href="{HUB_A}">Manquant</a>'
            with store.db: store.db.execute('INSERT INTO http VALUES (?,?,?,?,?)', (HUB, zlib.compress(html.encode()), 0, None, None))
            class Client:
                def __init__(self): self.store = store; self.calls = []
                def page(self, url): self.calls.append(url); raise c.RateLimited('HTTP 403')
            client = Client()
            with contextlib.redirect_stdout(io.StringIO()): result = c.discover(client, [HUB], 'franceinter', None, config, state)
            self.assertEqual(client.calls, [HUB_A])
            self.assertEqual(json.loads(config.read_text())['shows'], [SHOW])
            self.assertFalse(result['discovery']['exhaustive'])
            store.db.close()

    def test_generation_publishes_each_show_and_defers_already_completed_shows(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = c.Store(root/'cache.sqlite'); calls = []; snapshots = []
            old = c.episode_metadata(page([episode_node()], url=EP))
            store.put_show({'url': SHOW, 'title': 'Ancienne', 'station': 'franceinter'})
            store.put_episode(SHOW, EP, old)
            other_ep = SHOW_B + '/nouveau-1234567'
            other_node = {**episode_node(), 'url': other_ep}
            class Client:
                requests = cache_hits = 0
                def page(self, url, **kwargs):
                    calls.append(url)
                    if url == SHOW_B:
                        snapshots.append([s['url'] for s in json.loads((root/'public/catalog.json').read_text())['shows']])
                        return page([{'@type': 'RadioSeries', 'name': 'Nouvelle'}, {'@type': 'ItemList', 'itemListElement': [{'url': other_ep}]}], url=SHOW_B)
                    if url == other_ep: return page([other_node], url=other_ep)
                    # The first new show must already be usable before the old
                    # one is refreshed (or a later hard failure occurs).
                    snapshots.append([s['url'] for s in json.loads((root/'public/catalog.json').read_text())['shows']])
                    raise c.RateLimited('HTTP 429')
            args = SimpleNamespace(output=root/'public', base_url='http://example.local', max_pages=None, max_episodes=None)
            with contextlib.redirect_stdout(io.StringIO()): code = c.build(Client(), store, [SHOW, SHOW_B], args)
            self.assertEqual(code, 1)
            self.assertEqual(calls, [SHOW_B, other_ep, SHOW])
            self.assertEqual(snapshots, [[SHOW], [SHOW_B, SHOW]])
            self.assertEqual(len(json.loads((root/'public/catalog.json').read_text())['shows']), 2)
            self.assertTrue(store.completed(SHOW_B))
            self.assertFalse(store.completed(SHOW))
            store.db.close()

    def test_primary_list_excludes_recommendations_and_deduplicates(self):
        p = page([{'@type': 'ItemList', 'itemListElement': [{'url': EP}, {'url': EP}]}], '<a href="/franceinter/podcasts/autre/recommandation-22222">Autre</a>')
        self.assertEqual(p.episode_links(), [EP])

    def test_last_page_not_just_visible_links(self):
        p = page([], '<a href="?p=30">30</a><script>pagination:{lastPage:32}</script>')
        self.assertEqual(p.last_page(), 32)

    def test_separate_episode_art_and_duration(self):
        data = c.episode_metadata(page([episode_node()], url=EP))
        self.assertEqual(data['image'], 'https://images.example/episode.jpg')
        self.assertEqual(data['duration'], 3069)
        self.assertEqual(data['date'], '2020-05-02T12:00:00Z')

    def test_uses_supported_open_graph_image_for_series_and_episode(self):
        broken = c.ORIGIN + '/pikapi/images/e6db8a26-67d2-4f81-b318-8f62579d7ad8/1200'
        og = broken + 'x680'
        n = {**episode_node(), 'image': {'url': broken}}
        ep = page([n], f'<meta property="og:image" content="{og}"/>', EP)
        series = page([{'@type': 'RadioSeries', 'image': {'url': broken}}], f'<meta property="og:image" content="{og}"/>')
        self.assertEqual(c.episode_metadata(ep)['image'], og)
        self.assertEqual(series.metadata()['image'], og)
        self.assertEqual(c.image_url(broken), og)
        self.assertEqual(c.image_url(og), og)
        self.assertEqual(c.image_url('https://example.org/pikapi/images/abc/1200'), 'https://example.org/pikapi/images/abc/1200')

    def test_export_repairs_legacy_cached_images_without_changing_audio_or_guids(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = c.Store(root/'state.sqlite')
            broken = c.ORIGIN + '/pikapi/images/e6db8a26-67d2-4f81-b318-8f62579d7ad8/1200'
            store.put_show({'url': SHOW, 'title': 'Series', 'station': 'franceinter', 'image': broken})
            ep = {**c.episode_metadata(page([episode_node()], url=EP)), 'image': broken, 'guid': 'keep-me'}
            store.put_episode(SHOW, EP, ep)
            result = c.export(store, root/'public', 'http://localhost', {})
            rss = ET.parse(next((root/'public/feeds').glob('*.xml')))
            self.assertEqual(result[0]['image'], broken + 'x680')
            self.assertEqual(rss.find('./channel/item/{' + c.ITUNES + '}image').get('href'), broken + 'x680')
            self.assertEqual(rss.findtext('./channel/item/guid'), 'keep-me')
            self.assertEqual(rss.find('./channel/item/enclosure').get('url'), ep['audio'])
            store.db.close()

    def test_prefers_visible_title_over_search_engine_suffixes(self):
        p = page([episode_node()], '<h1>Le cygne <em>et sa danse</em></h1>', url=EP)
        self.assertEqual(c.episode_metadata(p)['title'], 'Le cygne et sa danse')

    def test_does_not_take_another_episodes_audio(self):
        other = episode_node(); other['url'] = SHOW + '/other-7654321'
        with self.assertRaises(ValueError): c.episode_metadata(page([other], url=EP))

    def test_missing_audio_or_restricted_episode_is_not_fabricated(self):
        n = episode_node(); n['isAccessibleForFree'] = False
        self.assertIsNone(c.episode_metadata(page([n], url=EP)))
        n.pop('isAccessibleForFree'); n['mainEntity'] = {}
        self.assertIsNone(c.episode_metadata(page([n], url=EP)))

    def test_rss_is_valid_with_both_covers_and_stable_guid(self):
        ep = c.episode_metadata(page([episode_node()], url=EP)); ep['guid'] = 'official-episode-id'
        show = {'url': SHOW, 'title': 'Exemple & compagnie', 'station': 'franceinter', 'image': 'https://images.example/series.jpg'}
        root = ET.fromstring(c.rss_xml(show, [ep], 'http://localhost/feed.xml'))
        self.assertEqual(root.find('./channel/{' + c.ITUNES + '}image').get('href'), show['image'])
        self.assertEqual(root.find('./channel/item/{' + c.ITUNES + '}image').get('href'), ep['image'])
        self.assertEqual(root.findtext('./channel/item/title'), ep['title'])
        self.assertEqual(root.find('./channel/item/guid').get('isPermaLink'), 'false')
        self.assertEqual(root.find('./channel/item/enclosure').get('url'), ep['audio'])

    def test_audio_reference_matches_cdn_and_proxy_urls_by_filename(self):
        self.assertEqual(c.audio_key('https://proxycast.radiofrance.fr/a/b/foo.m4a?x=1'), c.audio_key('https://media.radiofrance-podcast.net/podcast09/foo.m4a'))

    def test_state_survives_failed_refresh_and_exports_old_episode(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = c.Store(root / 'state' / 'state.sqlite')
            store.put_show({'url': SHOW, 'title': 'Exemple', 'station': 'franceinter'})
            old = c.episode_metadata(page([episode_node()], url=EP)); old['guid'] = 'stable'
            store.put_episode(SHOW, EP, old)
            class Client:
                requests = cache_hits = 0
                def page(self, url, **kwargs): raise OSError('network failed')
            args = SimpleNamespace(output=root/'public', base_url='http://example.local', max_pages=None, max_episodes=None)
            with contextlib.redirect_stdout(io.StringIO()): code = c.build(Client(), store, [SHOW], args)
            self.assertEqual(code, 1)
            rss = ET.parse(next((root/'public'/'feeds').glob('*.xml')))
            self.assertEqual(rss.findtext('./channel/item/guid'), 'stable')
            opml = ET.parse(root/'public'/'catalog.opml')
            self.assertTrue(opml.find('.//outline[@type="rss"]').get('xmlUrl').startswith('http://example.local/'))
            store.db.close()

    def test_refresh_index_revalidates_lists_without_invalidating_episode_cache(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); store = c.Store(root/'state.sqlite')
            calls = []
            series = page([{'@type': 'RadioSeries', 'name': 'Exemple'}, {'@type': 'ItemList', 'itemListElement': [{'url': EP}]}])
            class Client:
                requests = cache_hits = 0
                def page(self, url, ttl=21600):
                    calls.append((url, ttl))
                    return series if url == SHOW else page([episode_node()], url=EP)
            args = SimpleNamespace(output=root/'public', base_url='http://example.local', max_pages=None, max_episodes=None, refresh_index=True)
            with contextlib.redirect_stdout(io.StringIO()): code = c.build(Client(), store, [SHOW], args)
            self.assertEqual(code, 0)
            self.assertEqual(calls, [(SHOW, 0), (EP, 7 * 86400)])
            store.db.close()

    def test_explicit_unavailability_hides_episode_without_losing_other_records(self):
        with tempfile.TemporaryDirectory() as directory:
            store = c.Store(Path(directory)/'state.sqlite')
            store.put_episode(SHOW, EP, {'url': EP})
            store.put_episode(SHOW, EP, None)
            self.assertEqual(store.episodes(SHOW), {})
            store.db.close()

    def test_rejects_fetches_and_redirects_outside_radiofrance(self):
        for u in ['file:///etc/passwd', 'http://127.0.0.1/a', 'https://example.org', 'https://user:secret@www.radiofrance.fr/a']:
            with self.assertRaises(ValueError): c.validate_fetch(u)
        self.assertIsNone(c.canonical('https://example.org/franceinter/podcasts/foo'))


if __name__ == '__main__': unittest.main()
