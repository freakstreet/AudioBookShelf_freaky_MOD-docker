import contextlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
from types import SimpleNamespace
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location('catalog', Path(__file__).parents[1] / 'radiofrance_catalog.py')
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)
SHOW = c.ORIGIN + '/franceinter/podcasts/exemple'
EP = SHOW + '/episode-1234567'


def page(nodes, rest='', url=SHOW):
    return c.Page('<script type="application/ld+json">' + json.dumps({'@graph': nodes}) + '</script>' + rest, url)


def episode_node():
    return {'@type': 'RadioEpisode', 'url': EP, 'name': 'Un titre & une image', 'dateCreated': '2020-05-02T12:00:00Z',
            'description': 'Histoire <animale>', 'image': {'url': 'https://images.example/episode.jpg'},
            'mainEntity': {'@type': 'AudioObject', 'contentUrl': 'https://media.radiofrance-podcast.net/example.mp3', 'duration': 'P0Y0M0DT0H51M9S', 'encodingFormat': 'audio/mpeg'}}


class CatalogTests(unittest.TestCase):
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
