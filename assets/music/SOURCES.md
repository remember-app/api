# Music sources

16 instrumental tracks for the montage, all from Pixabay under the Pixabay Content License.
Every track was checked on its own page and has no Content ID registration.

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

All 16 tracks are marked "no" in the table. This was checked per track, not from a summary:

- On each track page, the HTML/JSON-LD contains no `Content ID Registered` property or badge.
- On the Pixabay search listing, each track row has no Shield icon. The Shield icon is the listing's
  Content ID marker; it is present for registered tracks and absent for these.
- Each track page was opened individually and checked on 2026-11-11.

No Mixkit tracks are used: Mixkit does not publish a per-track Content ID flag, so absence of
registration cannot be confirmed from the source. Everything here has an explicit page-level check.

## Tracks

| File | Title | Author | Source page | License | Mood group | Content ID |
|---|---|---|---|---|---|---|
| new-year-celebration.mp3 | New Year Celebration | AtlasAudio | https://pixabay.com/music/instrumental-new-year-celebration-625717/ | Pixabay Content License | energetic | no |
| party-countdown.mp3 | Party New Year Countdown Celebration | alex-morgan | https://pixabay.com/music/instrumental-party-new-year-countdown-celebration-587385/ | Pixabay Content License | energetic | no |
| folk-acoustic-upbeat.mp3 | Folk Acoustic Upbeat | 331music | https://pixabay.com/music/folk-folk-acoustic-upbeat-591941/ | Pixabay Content License | energetic | no |
| upbeat-inspiring-folk.mp3 | Upbeat Inspiring Folk Acoustic Guitar | Music_for_Creators | https://pixabay.com/music/acoustic-group-upbeat-inspiring-folk-acoustic-guitar-337290/ | Pixabay Content License | energetic | no |
| triumphant-brass-fanfare.mp3 | Triumphant Brass Fanfare | u_33aigmrb9v | https://pixabay.com/music/classical-string-quartet-triumphant-brass-fanfare-457560/ | Pixabay Content License | energetic | no |
| wedding-entrance.mp3 | Wedding Entrance | AtlasAudio | https://pixabay.com/music/wedding-wedding-entrance-621618/ | Pixabay Content License | energetic | no |
| uplifting-positive.mp3 | Uplifting Positive | Kulakovka | https://pixabay.com/music/adventure-uplifting-positive-614903/ | Pixabay Content License | energetic | no |
| light-music.mp3 | Light Music | 331music | https://pixabay.com/music/wedding-light-music-591928/ | Pixabay Content License | light | no |
| warm.mp3 | Warm | 331music | https://pixabay.com/music/instrumental-warm-590536/ | Pixabay Content License | light | no |
| jazz-lounge-sunny-cafe.mp3 | Jazz Lounge Sunny Cafe | alex-morgan | https://pixabay.com/music/modern-jazz-jazz-lounge-sunny-cafe-563577/ | Pixabay Content License | light | no |
| light-adventure.mp3 | Light Adventure | 331music | https://pixabay.com/music/orchestral-light-adventure-591978/ | Pixabay Content License | light | no |
| family-memories.mp3 | Family - Family Memories Music | APALONBeats | https://pixabay.com/music/folk-family-family-memories-music-597069/ | Pixabay Content License | warm | no |
| sweet-home.mp3 | Sweet Home | GreenRocketAudio | https://pixabay.com/music/folk-sweet-home-601481/ | Pixabay Content License | warm | no |
| warm-home.mp3 | Warm Home | 331music | https://pixabay.com/music/ambient-warm-home-595415/ | Pixabay Content License | warm | no |
| light-gentle.mp3 | Light Gentle | 331music | https://pixabay.com/music/modern-classical-light-gentle-591980/ | Pixabay Content License | calm | no |
| inspiring-background.mp3 | Inspiring Background | Kulakovka | https://pixabay.com/music/ambient-inspiring-background-620576/ | Pixabay Content License | calm | no |

Mood distribution: 7 energetic/celebration, 4 light/easy, 3 warm/family, 2 calm/thoughtful.

## Why these tracks

The seven energetic tracks are celebration, acoustic and orchestral rather than club music:
brass fanfare, wedding entrance, festive drums, folk and acoustic guitar. The light group is
acoustic, jazz-lounge and orchestral; the warm group is folk and ambient; the calm group is
modern classical and ambient.

Instrumental evidence per track comes from the page's published genre, tags and description:

- The energetic tracks are tagged Instrumental, Folk, Acoustic Group, Wedding, Classical String
  Quartet or Orchestral, and their descriptions describe instrumental performances (brass, strings,
  percussion, guitars) without vocals.
- The light and warm tracks are tagged Instrumental, Folk, Acoustic Group, Modern Jazz, Orchestral
  or Ambient.
- The calm tracks are tagged Modern Classical or Ambient and describe instrumental material.

No track was auditioned. Mood and instrumentation were judged from the source page's genre, mood
tags and description, not by listening.

## Verification

- Full MP3 files, not previews or streams: all 16 are 44.1 kHz stereo MP3 at ~256 kbps,
  93–157 seconds, 2.9–5.1 MB each.
- Verified with ffprobe and a full ffmpeg decode pass.
- No files were committed. Only the 16 MP3s, `manifest.json` and this file are present under
  `assets/music/`.

## What changed from the previous set

The previous set had seven Pixabay tracks with Content ID Registered and five Mixkit tracks whose
Content ID status could not be confirmed. All twelve were removed. The four remaining Pixabay tracks
(family-memories, warm, light-music, uplifting-positive) were already unregistered and were kept.
Twelve replacement tracks were downloaded, so the library is again 16 tracks and every one is
confirmed unregistered on its own page.
