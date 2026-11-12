# Music sources

14 instrumental tracks for the montage, all from Pixabay under the Pixabay Content License.

## License

- License summary: https://pixabay.com/service/license-summary/
- Full terms: https://pixabay.com/service/terms/

The summary states:

> ✓ Use Content for free
> ✓ Use Content without having to attribute the author (although giving credit is always appreciated by our community!)

The full terms grant, for non-CC0 Content:

> we grant you an irrevocable, worldwide, perpetual (or as long as allowed by law), non-exclusive and royalty-free right to download, use, copy, modify or adapt the Content for commercial or non-commercial purposes

Every track page below carries `"license": "https://pixabay.com/service/license-summary/"` in its JSON-LD,
and the track page template displays the "Free for use under the Pixabay Content License" badge.

## Content ID

The shelf is no longer fully clean. On 2026-11-12 the Pixabay catalogue turned out to be almost
entirely marked "Content ID Registered": of about 90 carefully matching candidates checked on their
own pages, only four unregistered tracks were found, and all four are in this set. Ten tracks are
registered. A registered track may still trigger a claim on YouTube or Instagram despite the licence;
the claim can be disputed with the Pixabay licence page.

The check was done per track, on its own page: the page HTML/JSON-LD contains the
`"name": "Content ID Registered", "value": true` property for registered tracks, and no such property
for the four clean ones.

## Tracks

| File | Title | Author | Source page | License | Mood group | Content ID |
|---|---|---|---|---|---|---|
| cinematic-trailer-leberch.mp3 | Cinematic Trailer | leberch | https://pixabay.com/music/main-title-cinematic-trailer-241658/ | Pixabay Content License | trailer | yes |
| cinematic-trailer-nastelbom.mp3 | Cinematic Trailer | NastelBom | https://pixabay.com/music/main-title-cinematic-trailer-341487/ | Pixabay Content License | trailer | yes |
| nostalgic-nastelbom.mp3 | Nostalgic | NastelBom | https://pixabay.com/music/modern-classical-nostalgic-464374/ | Pixabay Content License | warm | yes |
| nostalgic-piano-atlasaudio.mp3 | Nostalgic Piano | AtlasAudio | https://pixabay.com/music/nostalgia-nostalgic-piano-520047/ | Pixabay Content License | warm | yes |
| cinematic-documentary-leberch.mp3 | Cinematic Documentary | leberch | https://pixabay.com/music/solo-piano-cinematic-documentary-614289/ | Pixabay Content License | warm | yes |
| drifting-pines.mp3 | Drifting Pines | Dieu_Anh | https://pixabay.com/music/folk-drifting-pines-acoustic-folk-guitar-instrumental-545147/ | Pixabay Content License | acoustic | no |
| all-over-again.mp3 | All Over Again | Music_for_Creators | https://pixabay.com/music/folk-all-over-again-383370/ | Pixabay Content License | acoustic | no |
| thinking-of-home.mp3 | Thinking of Home | 22941069 | https://pixabay.com/music/solo-guitar-thinking-of-home-acoustic-guitar-piece-11885/ | Pixabay Content License | acoustic | no |
| documentary-subclair.mp3 | Documentary | Sub_Clair | https://pixabay.com/music/ambient-documentary-624919/ | Pixabay Content License | chronicle | yes |
| calm-ambient-dreamscape.mp3 | Calm Ambient Dreamscape | morgan-ambient | https://pixabay.com/music/ambient-calm-ambient-dreamscape-529861/ | Pixabay Content License | atmosphere | no |
| ambient-cinematic-leberch.mp3 | Ambient Cinematic | leberch | https://pixabay.com/music/ambient-ambient-cinematic-628167/ | Pixabay Content License | atmosphere | yes |
| upbeat-documentary.mp3 | Upbeat Documentary | AtlasAudio | https://pixabay.com/music/upbeat-upbeat-documentary-621616/ | Pixabay Content License | energy | yes |
| green-fields-wedding.mp3 | Green Fields (Wedding) | leberch | https://pixabay.com/music/wedding-green-fields-wedding-594956/ | Pixabay Content License | wedding | yes |
| family-music-andriig.mp3 | Family - Family Music | andriig | https://pixabay.com/music/acoustic-group-family-family-music-504413/ | Pixabay Content License | family | yes |

Mood distribution: 2 trailer, 3 warm piano/cinematic, 3 acoustic, 1 chronicle, 2 atmosphere,
1 energy, 1 wedding, 1 family.

## Why these tracks

The old shelf was bright stock: whistles, handclaps, glockenspiel, New Year and wedding signals,
corporate-style "uplifting" beds. These tracks are the opposite register: piano and strings,
fingerstyle and acoustic guitar, ambient pads, cinematic builds. No vocals, no whistling and no
handclaps are described on any of them.

Instrumental evidence per track comes from the page's published genre, tags and description. No track
was auditioned: mood and instrumentation were judged from the source page, not by listening.

The selection was made to cover the seven montage templates: trailer, story, report, chronicle,
atmosphere, quick clip, for parents, and wedding.

## Verification

- Full MP3 files, not previews or streams: 44.1 kHz stereo MP3 at ~256 kbps, 82–222 seconds,
  2.6–7.1 MB each.
- Durations in the manifest come from ffprobe, not from the page.
- The MP3s live under `assets/music/`. The manifest and this file live with the seed in
  `scripts/cicd/seeds/`.

## What changed from the previous set

The previous 16 tracks were cheerful celebration, folk and wedding stock, and all were unregistered.
They were replaced completely because the mood did not fit candid footage from an ordinary evening.
The old analyses in `music.analysis.json` were removed with them: they belonged to tracks that are
no longer in the shelf.
